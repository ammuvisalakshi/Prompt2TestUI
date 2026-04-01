import { useState, useEffect, useCallback } from 'react'
import { fetchAuthSession } from '@aws-amplify/auth'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { useEnv } from '../context/EnvContext'
import { useTeam } from '../context/TeamContext'
import { listTestCases, listRunRecords, deleteTestCase, updateTestCaseService, promoteTestCase, type TestCase, type RunRecord } from '../lib/lambdaClient'

const AWS_REGION = import.meta.env.VITE_AWS_REGION as string
const TABLE = 'prompt2test-config'

async function loadServiceNames(team: string, env: string): Promise<string[]> {
  const session = await fetchAuthSession()
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION, credentials: session.credentials as never }))
  const resp = await db.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': `SERVICE#${team}#${env}` },
    ProjectionExpression: 'svc',
  }))
  const names = new Set<string>((resp.Items ?? []).map(i => i.svc as string).filter(Boolean))
  return [...names].sort()
}

type Tab = 'cases' | 'runs'

export default function InventoryPage() {
  const { env } = useEnv()
  const { team } = useTeam()
  const [tab, setTab] = useState<Tab>('cases')
  const [cases, setCases] = useState<TestCase[]>([])
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [assignTc, setAssignTc] = useState<TestCase | null>(null)
  const [openKebab, setOpenKebab] = useState<string | null>(null)
  const [assignService, setAssignService] = useState('')
  const [assignSaving, setAssignSaving] = useState(false)
  const [availableServices, setAvailableServices] = useState<string[]>([])
  const [servicesLoading, setServicesLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [collapsedServices, setCollapsedServices] = useState<Set<string>>(new Set())
  const [promoteTc, setPromoteTc] = useState<TestCase | null>(null)
  const [promoteTarget, setPromoteTarget] = useState('')
  const [promoting, setPromoting] = useState(false)
  const [promoteResult, setPromoteResult] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (tab === 'cases') setCases(await listTestCases(env, team))
      else setRuns(await listRunRecords(env, team))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [env, tab, team])

  useEffect(() => { load() }, [load])

  async function handleDelete(id: string) {
    setDeletingId(id)
    try {
      await deleteTestCase(id)
      setCases(prev => prev.filter(tc => tc.id !== id))
    } catch {
      setError('Failed to delete test case')
    } finally {
      setDeletingId(null)
      setConfirmDeleteId(null)
    }
  }

  function openAssign(tc: TestCase) {
    setAssignTc(tc)
    setAssignService(tc.service)
    setAvailableServices([])
    setServicesLoading(true)
    loadServiceNames(team, env).then(names => setAvailableServices(names)).catch(() => {}).finally(() => setServicesLoading(false))
  }

  async function handleAssignService() {
    if (!assignTc || !assignService.trim()) return
    setAssignSaving(true)
    try {
      await updateTestCaseService(assignTc.id, assignService.trim())
      setCases(prev => prev.map(tc => tc.id === assignTc.id ? { ...tc, service: assignService.trim() } : tc))
      setAssignTc(null)
      setAssignService('')
    } catch {
      setError('Failed to update service')
    } finally {
      setAssignSaving(false)
    }
  }

  // Filter + group test cases by service
  const q = search.trim().toLowerCase()
  const filtered = q
    ? cases.filter(tc =>
        tc.id.toLowerCase().includes(q) ||
        (tc.title || '').toLowerCase().includes(q) ||
        tc.description.toLowerCase().includes(q)
      )
    : cases
  const grouped = filtered.reduce<Record<string, TestCase[]>>((acc, tc) => {
    const svc = tc.service || 'Uncategorized'
    if (!acc[svc]) acc[svc] = []
    acc[svc].push(tc)
    return acc
  }, {})
  const services = Object.keys(grouped).sort()

  function toggleService(svc: string) {
    setCollapsedServices(prev => {
      const next = new Set(prev)
      next.has(svc) ? next.delete(svc) : next.add(svc)
      return next
    })
  }

  const smoke    = cases.filter(tc => tc.tags.includes('Smoke')).length
  const failures = cases.filter(tc => tc.lastResult === 'FAIL').length
  const confirmTc = cases.find(tc => tc.id === confirmDeleteId)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: '#FAFBFF' }}>

      {/* Delete confirm modal */}
      {confirmDeleteId && confirmTc && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(4px)' }} onClick={() => setConfirmDeleteId(null)} />
          <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <div style={{ background: 'white', borderRadius: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.15)', padding: 20, width: 320, pointerEvents: 'auto', border: '1px solid #E8EBF0' }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: '#0F172A', marginBottom: 4 }}>Delete test case?</div>
              <div style={{ fontSize: 13, color: '#64748B', marginBottom: 8, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{confirmTc.description}</div>
              <p style={{ fontSize: 12, color: '#94A3B8', marginBottom: 16 }}>This will also delete all run records for this test case.</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => handleDelete(confirmDeleteId)} disabled={deletingId === confirmDeleteId}
                  style={{ flex: 1, padding: '8px 0', borderRadius: 10, background: '#EF4444', border: 'none', color: 'white', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: deletingId === confirmDeleteId ? 0.5 : 1 }}>
                  {deletingId === confirmDeleteId ? 'Deleting…' : 'Delete'}
                </button>
                <button onClick={() => setConfirmDeleteId(null)}
                  style={{ flex: 1, padding: '8px 0', borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0', color: '#64748B', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Assign service modal */}
      {assignTc && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(4px)' }} onClick={() => { setAssignTc(null); setAssignService('') }} />
          <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <div style={{ background: 'white', borderRadius: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.15)', padding: 20, width: 384, pointerEvents: 'auto', border: '1px solid #E8EBF0' }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: '#0F172A', marginBottom: 4 }}>Assign Service</div>
              <div style={{ fontSize: 13, color: '#64748B', marginBottom: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{assignTc.description}</div>
              {servicesLoading ? (
                <div style={{ fontSize: 13, color: '#94A3B8', padding: '16px 0', textAlign: 'center' }}>Loading services…</div>
              ) : availableServices.length === 0 ? (
                <div style={{ fontSize: 13, color: '#94A3B8', paddingBottom: 8 }}>No services configured for {env.toUpperCase()} yet. Add them in Config &amp; Accounts.</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                  {availableServices.map(svc => (
                    <button key={svc} onClick={() => setAssignService(svc)}
                      style={{
                        padding: '6px 12px', borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
                        ...(assignService === svc
                          ? { background: '#EDE9FE', border: '1px solid #DDD6FE', color: '#6D28D9' }
                          : { background: '#F8FAFC', border: '1px solid #E2E8F0', color: '#64748B' }),
                      }}>
                      {svc}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleAssignService} disabled={assignSaving || !assignService.trim()}
                  style={{ flex: 1, padding: '8px 0', borderRadius: 10, background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', border: 'none', color: 'white', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: assignSaving || !assignService.trim() ? 0.5 : 1, boxShadow: '0 2px 8px rgba(124,58,237,0.35)' }}>
                  {assignSaving ? 'Saving…' : 'Assign'}
                </button>
                <button onClick={() => { setAssignTc(null); setAssignService('') }}
                  style={{ flex: 1, padding: '8px 0', borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0', color: '#64748B', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Promote to env modal */}
      {promoteTc && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(4px)' }} onClick={() => setPromoteTc(null)} />
          <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <div style={{ background: 'white', borderRadius: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.15)', padding: 20, width: 384, pointerEvents: 'auto', border: '1px solid #E8EBF0' }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: '#0F172A', marginBottom: 4 }}>Promote Test Case</div>
              <div style={{ fontSize: 13, color: '#64748B', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{promoteTc.title || promoteTc.description}</div>
              <div style={{ fontSize: 12, color: '#94A3B8', marginBottom: 16 }}>
                From <strong style={{ color: '#4F46E5' }}>{env.toUpperCase()}</strong> — select target environment. Config keys will be created in the target (with empty values for admin to fill in).
              </div>

              {promoteResult ? (
                <div style={{ fontSize: 13, color: '#15803d', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10, padding: '10px 14px', marginBottom: 12 }}>
                  {promoteResult}
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                    {[({ dev: 'qa', qa: 'uat', uat: 'prod' } as Record<string, string>)[env]].filter((e): e is string => !!e).map(e => (
                      <button key={e} onClick={() => setPromoteTarget(e)}
                        style={{
                          flex: 1, padding: '8px 0', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', textTransform: 'uppercase',
                          ...(promoteTarget === e
                            ? { background: '#DCFCE7', border: '1.5px solid #16A34A', color: '#15803D' }
                            : { background: '#F8FAFC', border: '1px solid #E2E8F0', color: '#64748B' }),
                        }}>
                        {e}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={async () => {
                        if (!promoteTarget || promoting) return
                        setPromoting(true)
                        try {
                          const res = await promoteTestCase({ id: promoteTc.id, targetEnv: promoteTarget, sourceEnv: env, team })
                          setPromoteResult(`Promoted to ${promoteTarget.toUpperCase()} as ${res.id}. Config keys created — fill in values on the Config page.`)
                        } catch (err) {
                          setPromoteResult(`Error: ${err instanceof Error ? err.message : String(err)}`)
                        } finally {
                          setPromoting(false)
                        }
                      }}
                      disabled={!promoteTarget || promoting}
                      style={{ flex: 1, padding: '8px 0', borderRadius: 10, background: '#16A34A', border: 'none', color: 'white', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: !promoteTarget || promoting ? 0.5 : 1, boxShadow: '0 2px 8px rgba(22,163,74,0.35)' }}>
                      {promoting ? 'Promoting...' : `Promote to ${promoteTarget ? promoteTarget.toUpperCase() : '...'}`}
                    </button>
                    <button onClick={() => setPromoteTc(null)}
                      style={{ flex: 1, padding: '8px 0', borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0', color: '#64748B', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                      Cancel
                    </button>
                  </div>
                </>
              )}

              {promoteResult && (
                <button onClick={() => setPromoteTc(null)}
                  style={{ width: '100%', padding: '8px 0', borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0', color: '#64748B', fontSize: 13, fontWeight: 600, cursor: 'pointer', marginTop: 8 }}>
                  Close
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {/* Hero strip */}
      <div style={{ background: 'linear-gradient(135deg, #7C3AED 0%, #4F46E5 50%, #0EA5E9 100%)', padding: '20px 24px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 800, color: 'white', margin: 0, letterSpacing: '-0.3px' }}>Test Inventory</h1>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', marginTop: 2 }}>Manage test cases and run records · {env.toUpperCase()}</div>
          </div>
          {tab === 'cases' && (
            <div style={{ display: 'flex', gap: 8 }}>
              {[
                { label: 'Total TCs', value: cases.length },
                { label: 'Services', value: services.length },
                { label: 'Smoke', value: smoke },
                { label: failures > 0 ? 'Failures' : 'All passing', value: failures > 0 ? failures : '✓' },
              ].map(s => (
                <div key={s.label} style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 10, padding: '8px 14px', textAlign: 'center', minWidth: 64 }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: 'white', lineHeight: 1 }}>{s.value}</div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginTop: 2 }}>{s.label}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 20px 32px' }}>
        <div style={{ background: 'white', borderRadius: 12, border: '1px solid #E8EBF0', boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04)', overflow: 'visible' }}>

          {/* Tab bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid #F1F5F9' }}>
            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
              {(['cases', 'runs'] as Tab[]).map(t => (
                <button key={t} onClick={() => setTab(t)}
                  style={{
                    padding: '6px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
                    ...(tab === t
                      ? { background: '#EEF2FF', color: '#4F46E5', border: '1px solid #C7D2FE' }
                      : { background: 'transparent', border: '1px solid transparent', color: '#94A3B8' }),
                  }}>
                  {t === 'cases' ? `Test Cases — ${env.toUpperCase()}` : 'Run Records'}
                </button>
              ))}
            </div>
            {tab === 'cases' && (
              <div style={{ position: 'relative', flex: 1, maxWidth: 280 }}>
                <svg viewBox="0 0 24 24" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, stroke: '#94A3B8', fill: 'none', strokeWidth: 2, pointerEvents: 'none' }}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input type="text" placeholder="Search by ID, title…" value={search} onChange={e => setSearch(e.target.value)}
                  style={{ width: '100%', paddingLeft: 32, paddingRight: 12, paddingTop: 6, paddingBottom: 6, fontSize: 13, borderRadius: 8, color: '#334155', background: '#F8FAFC', border: '1px solid #E2E8F0', outline: 'none', boxSizing: 'border-box' }}
                  onFocus={e => { e.currentTarget.style.border = '1px solid #A5B4FC'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.1)' }}
                  onBlur={e => { e.currentTarget.style.border = '1px solid #E2E8F0'; e.currentTarget.style.boxShadow = 'none' }}
                />
              </div>
            )}
            {search && (
              <button onClick={() => setSearch('')} style={{ fontSize: 12, color: '#94A3B8', background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}>Clear</button>
            )}
          </div>

          {/* Table toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '8px 16px', borderBottom: '1px solid #F1F5F9', background: '#FAFBFF' }}>
            {tab === 'cases' && services.length > 0 && (
              <button
                onClick={() => {
                  const allCollapsed = services.every(s => collapsedServices.has(s))
                  setCollapsedServices(allCollapsed ? new Set() : new Set(services))
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, color: '#64748B', background: 'white', border: '1px solid #E2E8F0', cursor: 'pointer' }}
              >
                {services.every(s => collapsedServices.has(s)) ? (
                  <><svg viewBox="0 0 24 24" style={{ width: 12, height: 12, stroke: 'currentColor', fill: 'none', strokeWidth: 2 }}><polyline points="6 9 12 15 18 9"/></svg>Expand all</>
                ) : (
                  <><svg viewBox="0 0 24 24" style={{ width: 12, height: 12, stroke: 'currentColor', fill: 'none', strokeWidth: 2 }}><polyline points="18 15 12 9 6 15"/></svg>Collapse all</>
                )}
              </button>
            )}
            <button onClick={load} disabled={loading}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, color: '#64748B', background: 'white', border: '1px solid #E2E8F0', cursor: 'pointer', opacity: loading ? 0.5 : 1 }}>
              <svg viewBox="0 0 24 24" style={{ width: 12, height: 12, stroke: 'currentColor', fill: 'none', strokeWidth: 2, animation: loading ? 'spin 1s linear infinite' : 'none' }}><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>

          {error && (
            <div style={{ padding: '10px 16px', fontSize: 13, color: '#DC2626', background: '#FEF2F2', borderBottom: '1px solid #FECACA' }}>{error}</div>
          )}

          {tab === 'cases' ? (
            cases.length === 0 && !loading ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 14, color: '#94A3B8' }}>No test cases yet for {env.toUpperCase()}</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead style={{ position: 'sticky', top: 0, zIndex: 10 }}>
                  <tr style={{ background: '#F8FAFC', borderBottom: '1px solid #E8EBF0' }}>
                    <th style={{ textAlign: 'left', padding: '10px 16px', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em', width: 112 }}>ID</th>
                    <th style={{ textAlign: 'left', padding: '10px 12px', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Title</th>
                    <th style={{ textAlign: 'left', padding: '10px 12px', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em', width: 128 }}>Created By</th>
                    <th style={{ textAlign: 'left', padding: '10px 12px', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em', width: 128 }}>Last Run By</th>
                    <th style={{ textAlign: 'left', padding: '10px 12px', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em', width: 96 }}>Result</th>
                    <th style={{ textAlign: 'center', padding: '10px 12px', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em', width: 80 }}>State</th>
                    <th style={{ width: 48 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {services.map(svc => (
                    <>
                      {/* Service group header */}
                      <tr key={`hdr-${svc}`}>
                        <td colSpan={7} style={{ padding: 0 }}>
                          <button
                            onClick={() => toggleService(svc)}
                            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', cursor: 'pointer', textAlign: 'left', background: '#EEF2FF', borderTop: '1px solid #C7D2FE', borderBottom: '1px solid #C7D2FE', border: 'none' }}
                            onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = '#E0E7FF'}
                            onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = '#EEF2FF'}
                          >
                            <svg viewBox="0 0 24 24" style={{ width: 14, height: 14, stroke: '#4F46E5', fill: 'none', strokeWidth: 2, flexShrink: 0, transform: collapsedServices.has(svc) ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s' }}><polyline points="6 9 12 15 18 9"/></svg>
                            <span style={{ fontSize: 11, fontWeight: 700, color: '#4F46E5', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{svc}</span>
                            <span style={{ fontSize: 11, color: '#94A3B8', fontWeight: 500 }}>{grouped[svc].length} test{grouped[svc].length !== 1 ? 's' : ''}</span>
                          </button>
                        </td>
                      </tr>

                      {/* Test case rows */}
                      {!collapsedServices.has(svc) && grouped[svc].map((tc, idx) => {
                        const isAutomated = (tc as TestCase & { stepCount?: number }).stepCount ?? 0 > 0
                        const lastRunBy = tc.runs?.[tc.runs.length - 1]?.runBy
                        return (
                          <tr
                            key={tc.id}
                            onClick={() => window.open(`/test-case/${tc.id}`, '_blank')}
                            style={{ borderBottom: '1px solid #F1F5F9', background: idx % 2 === 1 ? '#FAFBFF' : 'white', cursor: 'pointer', transition: 'background 0.1s' }}
                            onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = '#EEF2FF'; (e.currentTarget as HTMLTableRowElement).style.boxShadow = 'inset 3px 0 0 #4F46E5' }}
                            onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = idx % 2 === 1 ? '#FAFBFF' : 'white'; (e.currentTarget as HTMLTableRowElement).style.boxShadow = 'none' }}
                          >
                            {/* ID */}
                            <td style={{ padding: '12px 16px', verticalAlign: 'middle' }}>
                              <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#64748B', background: '#F1F5F9', border: '1px solid #E2E8F0', borderRadius: 6, padding: '2px 6px', whiteSpace: 'nowrap' }}>{tc.id}</span>
                            </td>

                            {/* Title */}
                            <td style={{ padding: '12px', verticalAlign: 'middle' }}>
                              <div style={{ fontSize: 13, color: '#0F172A', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 480, lineHeight: 1.4 }} title={tc.title || tc.description}>
                                {tc.title || tc.description}
                              </div>
                              {tc.tags.length > 0 && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                                  {tc.tags.map(tag => (
                                    <span key={tag} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 20, fontWeight: 600, background: '#DCFCE7', border: '1px solid #BBF7D0', color: '#166534' }}>{tag}</span>
                                  ))}
                                </div>
                              )}
                              {/* Promotion Pipeline */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 6 }}>
                                {(['dev', 'qa', 'uat', 'prod'] as const).map((e, i) => {
                                  const isCurrent = e === env
                                  const isPromoted = (tc.promotedTo ?? []).includes(e)
                                  const isOriginEnv = !tc.promotedFromEnv // originated in current env view
                                  const isActive = isCurrent || isPromoted
                                  const nextEnv = ({ dev: 'qa', qa: 'uat', uat: 'prod' } as Record<string, string>)[env]
                                  const isNextPromotable = e === nextEnv && !isPromoted && isOriginEnv && isCurrent === false

                                  return (
                                    <div key={e} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                                      {i > 0 && <div style={{ width: 12, height: 2, background: isActive ? '#7C3AED' : '#E2E8F0', borderRadius: 1 }} />}
                                      <div
                                        onClick={isNextPromotable ? (ev) => { ev.stopPropagation(); setPromoteTc(tc); setPromoteTarget(nextEnv); setPromoteResult(null) } : undefined}
                                        title={isActive ? `${e.toUpperCase()}` : isNextPromotable ? `Promote to ${e.toUpperCase()}` : e.toUpperCase()}
                                        style={{
                                          width: 18, height: 18, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                          fontSize: 8, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.02em',
                                          cursor: isNextPromotable ? 'pointer' : 'default',
                                          ...(isCurrent
                                            ? { background: '#7C3AED', color: 'white', border: '2px solid #7C3AED' }
                                            : isPromoted
                                              ? { background: '#DCFCE7', color: '#15803D', border: '2px solid #16A34A' }
                                              : isNextPromotable
                                                ? { background: 'white', color: '#F97316', border: '2px dashed #F97316' }
                                                : { background: '#F8FAFC', color: '#CBD5E1', border: '2px solid #E2E8F0' }),
                                        }}
                                      >
                                        {e[0]}
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            </td>

                            {/* Created By */}
                            <td style={{ padding: '12px', verticalAlign: 'middle' }}>
                              <span style={{ fontSize: 12, color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', maxWidth: 110 }} title={tc.createdBy}>{tc.createdBy || '—'}</span>
                            </td>

                            {/* Last Run By */}
                            <td style={{ padding: '12px', verticalAlign: 'middle' }}>
                              <span style={{ fontSize: 12, color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', maxWidth: 110 }} title={lastRunBy}>{lastRunBy || '—'}</span>
                            </td>

                            {/* Result */}
                            <td style={{ padding: '12px', verticalAlign: 'middle' }}>
                              {tc.lastResult ? (
                                <span style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 20,
                                  ...(tc.lastResult === 'PASS'
                                    ? { background: '#DCFCE7', color: '#166534', border: '1px solid #BBF7D0' }
                                    : { background: '#FEE2E2', color: '#991B1B', border: '1px solid #FECACA' }),
                                }}>
                                  {tc.lastResult === 'PASS' ? '✓' : '✕'} {tc.lastResult}
                                </span>
                              ) : (
                                <span style={{ fontSize: 12, color: '#CBD5E1' }}>—</span>
                              )}
                            </td>

                            {/* State icon */}
                            <td style={{ padding: '12px', verticalAlign: 'middle', textAlign: 'center' }}>
                              {isAutomated ? (
                                <span title="Automated" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: '50%', background: '#EDE9FE', color: '#7C3AED', border: '1px solid #DDD6FE' }}>
                                  <svg viewBox="0 0 24 24" style={{ width: 14, height: 14, fill: 'currentColor' }}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                                </span>
                              ) : (
                                <span title="Not automated — click to automate" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: '50%', background: '#F1F5F9', border: '1px solid #E2E8F0', opacity: 0.5 }}>
                                  <img src="/favicon.svg" width="16" height="16" alt="Not automated" />
                                </span>
                              )}
                            </td>

                            {/* Kebab */}
                            <td style={{ padding: '12px 8px', verticalAlign: 'middle' }} onClick={e => e.stopPropagation()}>
                              <div style={{ position: 'relative', display: 'flex', justifyContent: 'flex-end' }}>
                                <button
                                  onClick={() => setOpenKebab(openKebab === tc.id ? null : tc.id)}
                                  style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, color: '#94A3B8', background: 'none', border: 'none', cursor: 'pointer' }}
                                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#F1F5F9'; (e.currentTarget as HTMLButtonElement).style.color = '#334155' }}
                                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'none'; (e.currentTarget as HTMLButtonElement).style.color = '#94A3B8' }}
                                >
                                  <svg viewBox="0 0 24 24" style={{ width: 16, height: 16, fill: 'currentColor' }}><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                                </button>
                                {openKebab === tc.id && (
                                  <>
                                    <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setOpenKebab(null)} />
                                    <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 50, width: 176, borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', padding: '4px 0', overflow: 'hidden', background: 'white', border: '1px solid #E8EBF0' }}>
                                      <button
                                        onClick={() => { openAssign(tc); setOpenKebab(null) }}
                                        style={{ width: '100%', textAlign: 'left', padding: '8px 12px', fontSize: 13, color: '#334155', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}
                                        onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = '#F8FAFC'}
                                        onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = 'none'}
                                      >
                                        <svg viewBox="0 0 24 24" style={{ width: 14, height: 14, stroke: 'currentColor', fill: 'none', strokeWidth: 2, flexShrink: 0 }}><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                        Move to service
                                      </button>
                                      {env !== 'prod' && (
                                      <button
                                        onClick={() => { setPromoteTc(tc); setPromoteTarget(''); setPromoteResult(null); setOpenKebab(null) }}
                                        style={{ width: '100%', textAlign: 'left', padding: '8px 12px', fontSize: 13, color: '#15803d', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}
                                        onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = '#F0FDF4'}
                                        onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = 'none'}
                                      >
                                        <svg viewBox="0 0 24 24" style={{ width: 14, height: 14, stroke: 'currentColor', fill: 'none', strokeWidth: 2, flexShrink: 0 }}><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/></svg>
                                        Promote to {{ dev: 'QA', qa: 'UAT', uat: 'PROD' }[env] || 'next env'}
                                      </button>
                                      )}
                                      <div style={{ height: 1, margin: '4px 8px', background: '#F1F5F9' }} />
                                      <button
                                        onClick={() => { setConfirmDeleteId(tc.id); setOpenKebab(null) }}
                                        style={{ width: '100%', textAlign: 'left', padding: '8px 12px', fontSize: 13, color: '#DC2626', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}
                                        onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = '#FEF2F2'}
                                        onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = 'none'}
                                      >
                                        <svg viewBox="0 0 24 24" style={{ width: 14, height: 14, stroke: 'currentColor', fill: 'none', strokeWidth: 2, flexShrink: 0 }}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                                        Delete
                                      </button>
                                    </div>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </>
                  ))}
                </tbody>
              </table>
            )
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #E8EBF0', background: '#F8FAFC' }}>
                  <th style={{ textAlign: 'left', padding: '10px 16px', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Test Case</th>
                  <th style={{ textAlign: 'left', padding: '10px 16px', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Result</th>
                  <th style={{ textAlign: 'left', padding: '10px 16px', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Summary</th>
                  <th style={{ textAlign: 'left', padding: '10px 16px', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Run By</th>
                  <th style={{ textAlign: 'left', padding: '10px 16px', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Run At</th>
                </tr>
              </thead>
              <tbody>
                {runs.length === 0 && !loading && (
                  <tr><td colSpan={5} style={{ padding: '32px 16px', textAlign: 'center', fontSize: 14, color: '#94A3B8' }}>No run records yet for {env.toUpperCase()}</td></tr>
                )}
                {runs.map((r, i) => (
                  <tr key={r.id} style={{ borderBottom: '1px solid #F1F5F9', background: i % 2 === 1 ? '#FAFBFF' : 'white' }}>
                    <td style={{ padding: '12px 16px', fontSize: 13, color: '#334155', fontWeight: 500, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.description}>{r.description}</td>
                    <td style={{ padding: '12px 16px' }}>
                      <span style={{
                        fontSize: 11, padding: '3px 8px', borderRadius: 20, fontWeight: 700,
                        ...(r.result === 'PASS'
                          ? { background: '#DCFCE7', color: '#166534', border: '1px solid #BBF7D0' }
                          : { background: '#FEE2E2', color: '#991B1B', border: '1px solid #FECACA' }),
                      }}>
                        {r.result}
                      </span>
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13, color: '#64748B', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.summary}>{r.summary || '—'}</td>
                    <td style={{ padding: '12px 16px', fontSize: 13, color: '#64748B' }}>{r.runBy || '—'}</td>
                    <td style={{ padding: '12px 16px', fontSize: 13, color: '#94A3B8' }}>{r.runAt ? new Date(r.runAt).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
