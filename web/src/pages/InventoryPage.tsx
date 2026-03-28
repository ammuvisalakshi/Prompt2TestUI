import { useState, useEffect, useCallback } from 'react'
import { fetchAuthSession } from '@aws-amplify/auth'
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm'
import { useEnv } from '../context/EnvContext'
import { listTestCases, listRunRecords, deleteTestCase, updateTestCaseService, type TestCase, type RunRecord } from '../lib/lambdaClient'

const AWS_REGION = import.meta.env.VITE_AWS_REGION as string

async function loadServiceNames(env: string): Promise<string[]> {
  const session = await fetchAuthSession()
  const client = new SSMClient({ region: AWS_REGION, credentials: session.credentials })
  const path = `/prompt2test/config/${env}/services`
  const names = new Set<string>()
  let nextToken: string | undefined
  do {
    const resp = await client.send(new GetParametersByPathCommand({ Path: path, Recursive: true, NextToken: nextToken }))
    for (const p of resp.Parameters ?? []) {
      const rel = p.Name!.slice(path.length + 1)
      const slash = rel.indexOf('/')
      if (slash > 0) names.add(rel.slice(0, slash))
    }
    nextToken = resp.NextToken
  } while (nextToken)
  return [...names].sort()
}

type Tab = 'cases' | 'runs'

export default function InventoryPage() {
  const { env } = useEnv()
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

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (tab === 'cases') setCases(await listTestCases(env))
      else setRuns(await listRunRecords(env))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [env, tab])

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
    loadServiceNames(env).then(names => setAvailableServices(names)).catch(() => {}).finally(() => setServicesLoading(false))
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
    <div className="flex flex-col h-full overflow-hidden" style={{ background: 'transparent' }}>

      {/* Delete confirm modal */}
      {confirmDeleteId && confirmTc && (
        <>
          <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={() => setConfirmDeleteId(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
            <div className="rounded-2xl shadow-2xl p-5 w-80 pointer-events-auto" style={{ background: 'rgba(15,8,33,0.95)', border: '1px solid rgba(255,255,255,0.12)', backdropFilter: 'blur(20px)' }}>
              <div className="text-[15px] font-semibold text-white mb-1">Delete test case?</div>
              <div className="text-[13px] text-slate-400 mb-4 line-clamp-2">{confirmTc.description}</div>
              <p className="text-[12px] text-slate-600 mb-4">This will also delete all run records for this test case.</p>
              <div className="flex gap-2">
                <button onClick={() => handleDelete(confirmDeleteId)} disabled={deletingId === confirmDeleteId}
                  className="flex-1 py-2 rounded-xl text-white text-[13px] font-semibold cursor-pointer disabled:opacity-50 transition-colors" style={{ background: 'rgba(239,68,68,0.8)', border: '1px solid rgba(239,68,68,0.5)' }}>
                  {deletingId === confirmDeleteId ? 'Deleting…' : 'Delete'}
                </button>
                <button onClick={() => setConfirmDeleteId(null)}
                  className="flex-1 py-2 rounded-xl text-slate-300 text-[13px] font-semibold hover:text-white cursor-pointer transition-colors" style={{ border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)' }}>
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
          <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={() => { setAssignTc(null); setAssignService('') }} />
          <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
            <div className="rounded-2xl shadow-2xl p-5 w-96 pointer-events-auto" style={{ background: 'rgba(15,8,33,0.95)', border: '1px solid rgba(255,255,255,0.12)', backdropFilter: 'blur(20px)' }}>
              <div className="text-[15px] font-semibold text-white mb-1">Assign Service</div>
              <div className="text-[13px] text-slate-400 mb-4 line-clamp-1">{assignTc.description}</div>
              {servicesLoading ? (
                <div className="text-[13px] text-slate-500 py-4 text-center">Loading services…</div>
              ) : availableServices.length === 0 ? (
                <div className="text-[13px] text-slate-500 py-2">No services configured for {env.toUpperCase()} yet. Add them in Config &amp; Accounts.</div>
              ) : (
                <div className="flex flex-wrap gap-2 mb-3">
                  {availableServices.map(svc => (
                    <button key={svc} onClick={() => setAssignService(svc)}
                      className="px-3 py-1.5 rounded-full text-[13px] font-semibold cursor-pointer transition-all"
                      style={assignService === svc
                        ? { background: 'rgba(139,92,246,0.3)', border: '1px solid rgba(139,92,246,0.6)', color: '#c4b5fd' }
                        : { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8' }}>
                      {svc}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <button onClick={handleAssignService} disabled={assignSaving || !assignService.trim()}
                  className="flex-1 py-2 rounded-xl text-white text-[13px] font-semibold cursor-pointer disabled:opacity-50 transition-all"
                  style={{ background: 'rgba(139,92,246,0.5)', border: '1px solid rgba(139,92,246,0.6)', boxShadow: '0 0 16px rgba(139,92,246,0.3)' }}>
                  {assignSaving ? 'Saving…' : 'Assign'}
                </button>
                <button onClick={() => { setAssignTc(null); setAssignService('') }}
                  className="flex-1 py-2 rounded-xl text-slate-300 text-[13px] font-semibold hover:text-white cursor-pointer transition-colors"
                  style={{ border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)' }}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="flex-1 overflow-y-auto p-5 pb-8">
        {/* Stats */}
        {tab === 'cases' && (
          <div className="grid grid-cols-4 gap-3 mb-5">
            {[
              { label: 'Total TCs',    value: cases.length,      color: 'text-white',        glow: 'rgba(139,92,246,0.3)' },
              { label: 'Services',     value: services.length,   color: 'text-purple-300',   glow: 'rgba(139,92,246,0.2)' },
              { label: 'Smoke tagged', value: smoke,             color: 'text-emerald-400',  glow: 'rgba(52,211,153,0.2)' },
              { label: failures > 0 ? 'Failures' : 'All passing', value: failures > 0 ? failures : '✓', color: failures > 0 ? 'text-red-400' : 'text-emerald-400', glow: failures > 0 ? 'rgba(239,68,68,0.2)' : 'rgba(52,211,153,0.15)' },
            ].map(s => (
              <div key={s.label} className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.05)', backdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,0.09)', boxShadow: `0 0 20px ${s.glow}` }}>
                <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
                <div className="text-[13px] text-slate-500 mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        <div className="rounded-xl overflow-visible" style={{ background: 'rgba(255,255,255,0.04)', backdropFilter: 'blur(20px)', border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 8px 32px rgba(0,0,0,0.3)' }}>
          {/* Tab bar */}
          <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
            <div className="flex gap-1 flex-shrink-0">
              {(['cases', 'runs'] as Tab[]).map(t => (
                <button key={t} onClick={() => setTab(t)}
                  className={`px-3 py-1.5 rounded-lg text-[13px] font-semibold transition-all cursor-pointer ${
                    tab === t ? 'text-purple-300' : 'text-slate-500 hover:text-slate-300'
                  }`}
                  style={tab === t ? { background: 'rgba(139,92,246,0.18)', border: '1px solid rgba(139,92,246,0.3)' } : {}}>
                  {t === 'cases' ? `Test Cases — ${env.toUpperCase()}` : 'Run Records'}
                </button>
              ))}
            </div>
            {tab === 'cases' && (
              <div className="relative flex-1 max-w-xs">
                <svg viewBox="0 0 24 24" className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 stroke-current fill-none stroke-2 text-slate-500 pointer-events-none"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input type="text" placeholder="Search by ID, title…" value={search} onChange={e => setSearch(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 text-[13px] rounded-lg text-slate-200 placeholder-slate-600 focus:outline-none transition-all"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
                  onFocus={e => { e.currentTarget.style.border = '1px solid rgba(139,92,246,0.5)'; e.currentTarget.style.boxShadow = '0 0 0 2px rgba(139,92,246,0.15)' }}
                  onBlur={e => { e.currentTarget.style.border = '1px solid rgba(255,255,255,0.1)'; e.currentTarget.style.boxShadow = 'none' }}
                />
              </div>
            )}
            {search && <button onClick={() => setSearch('')} className="text-[12px] text-slate-500 hover:text-slate-300 cursor-pointer flex-shrink-0">Clear</button>}
          </div>

          {/* Table toolbar */}
          {(tab === 'cases' || tab === 'runs') && (
            <div className="flex items-center justify-end gap-2 px-4 py-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.15)' }}>
              {tab === 'cases' && services.length > 0 && (
                <button
                  onClick={() => {
                    const allCollapsed = services.every(s => collapsedServices.has(s))
                    setCollapsedServices(allCollapsed ? new Set() : new Set(services))
                  }}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-semibold text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
                >
                  {services.every(s => collapsedServices.has(s)) ? (
                    <><svg viewBox="0 0 24 24" className="w-3 h-3 stroke-current fill-none stroke-2"><polyline points="6 9 12 15 18 9"/></svg>Expand all</>
                  ) : (
                    <><svg viewBox="0 0 24 24" className="w-3 h-3 stroke-current fill-none stroke-2"><polyline points="18 15 12 9 6 15"/></svg>Collapse all</>
                  )}
                </button>
              )}
              <button onClick={load} disabled={loading}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[12px] font-semibold text-slate-400 hover:text-purple-300 transition-colors cursor-pointer disabled:opacity-40"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <svg viewBox="0 0 24 24" className={`w-3 h-3 stroke-current fill-none stroke-2 ${loading ? 'animate-spin' : ''}`}><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                {loading ? 'Loading…' : 'Refresh'}
              </button>
            </div>
          )}

          {error && (
            <div className="px-4 py-3 text-[13px] text-red-600 bg-red-50 border-b border-red-100">{error}</div>
          )}

          {tab === 'cases' ? (
            cases.length === 0 && !loading ? (
              <div className="px-4 py-8 text-center text-[14px] text-slate-500">No test cases yet for {env.toUpperCase()}</div>
            ) : (
              <table className="w-full border-collapse">
                {/* Sticky header */}
                <thead className="sticky top-0 z-10">
                  <tr style={{ background: 'rgba(0,0,0,0.3)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    <th className="text-left px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-28">ID</th>
                    <th className="text-left px-3 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Title</th>
                    <th className="text-left px-3 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-32">Created By</th>
                    <th className="text-left px-3 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-32">Last Run By</th>
                    <th className="text-left px-3 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-24">Result</th>
                    <th className="text-center px-3 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-20">State</th>
                    <th className="w-12"></th>
                  </tr>
                </thead>
                <tbody>
                  {services.map(svc => (
                    <>
                      {/* Service group header */}
                      <tr key={`hdr-${svc}`}>
                        <td colSpan={7} className="p-0">
                          <button
                            onClick={() => toggleService(svc)}
                            className="w-full flex items-center gap-2.5 px-4 py-2.5 cursor-pointer text-left group/hdr transition-all"
                            style={{ background: 'rgba(139,92,246,0.08)', borderTop: '1px solid rgba(139,92,246,0.15)', borderBottom: '1px solid rgba(139,92,246,0.15)' }}
                            onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = 'rgba(139,92,246,0.15)'}
                            onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = 'rgba(139,92,246,0.08)'}
                          >
                            <svg viewBox="0 0 24 24" className={`w-3.5 h-3.5 stroke-current fill-none stroke-2 text-purple-500 transition-all flex-shrink-0 ${collapsedServices.has(svc) ? '-rotate-90' : ''}`}><polyline points="6 9 12 15 18 9"/></svg>
                            <span className="text-[11px] font-bold text-purple-400 uppercase tracking-widest">{svc}</span>
                            <span className="text-[11px] text-slate-500 font-medium">{grouped[svc].length} test{grouped[svc].length !== 1 ? 's' : ''}</span>
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
                            className="cursor-pointer transition-all group"
                            style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: idx % 2 === 1 ? 'rgba(255,255,255,0.02)' : 'transparent' }}
                            onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(139,92,246,0.1)'; (e.currentTarget as HTMLTableRowElement).style.boxShadow = 'inset 3px 0 0 rgba(139,92,246,0.6)' }}
                            onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = idx % 2 === 1 ? 'rgba(255,255,255,0.02)' : 'transparent'; (e.currentTarget as HTMLTableRowElement).style.boxShadow = 'none' }}
                          >
                            {/* ID */}
                            <td className="px-4 py-3.5 align-middle">
                              <span className="font-mono text-[11px] text-slate-500 rounded-md px-1.5 py-0.5 whitespace-nowrap transition-all" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}>{tc.id}</span>
                            </td>

                            {/* Title */}
                            <td className="px-3 py-3.5 align-middle">
                              <div className="text-[13px] text-slate-200 font-semibold truncate max-w-lg leading-snug" title={tc.title || tc.description}>
                                {tc.title || tc.description}
                              </div>
                              {tc.tags.length > 0 && (
                                <div className="flex items-center gap-1 mt-1">
                                  {tc.tags.map(tag => (
                                    <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: 'rgba(52,211,153,0.15)', border: '1px solid rgba(52,211,153,0.25)', color: '#6ee7b7' }}>{tag}</span>
                                  ))}
                                </div>
                              )}
                            </td>

                            {/* Created By */}
                            <td className="px-3 py-3.5 align-middle">
                              <span className="text-[12px] text-slate-500 truncate block max-w-[110px]" title={tc.createdBy}>{tc.createdBy || <span className="text-slate-700">—</span>}</span>
                            </td>

                            {/* Last Run By */}
                            <td className="px-3 py-3.5 align-middle">
                              <span className="text-[12px] text-slate-500 truncate block max-w-[110px]" title={lastRunBy}>{lastRunBy || <span className="text-slate-700">—</span>}</span>
                            </td>

                            {/* Result */}
                            <td className="px-3 py-3.5 align-middle">
                              {tc.lastResult ? (
                                <span className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-full ${
                                  tc.lastResult === 'PASS'
                                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                    : 'bg-red-50 text-red-600 border border-red-200'
                                }`}>
                                  {tc.lastResult === 'PASS' ? '✓' : '✕'} {tc.lastResult}
                                </span>
                              ) : (
                                <span className="text-[12px] text-slate-300">—</span>
                              )}
                            </td>

                            {/* State icon */}
                            <td className="px-3 py-3.5 align-middle text-center">
                              {isAutomated ? (
                                <span title="Automated" className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-purple-50 text-[#7C3AED] border border-purple-200">
                                  <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 fill-current"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                                </span>
                              ) : (
                                <span title="Not automated — click to automate" className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-slate-100 border border-slate-200 opacity-40">
                                  <img src="/favicon.svg" width="16" height="16" alt="Not automated" />
                                </span>
                              )}
                            </td>

                            {/* Kebab */}
                            <td className="px-2 py-3.5 align-middle" onClick={e => e.stopPropagation()}>
                              <div className="relative flex justify-end">
                                <button
                                  onClick={() => setOpenKebab(openKebab === tc.id ? null : tc.id)}
                                  className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-300 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer opacity-0 group-hover:opacity-100"
                                >
                                  <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                                </button>
                                {openKebab === tc.id && (
                                  <>
                                    <div className="fixed inset-0 z-40" onClick={() => setOpenKebab(null)} />
                                    <div className="absolute right-0 top-full mt-1 z-50 w-44 rounded-xl shadow-2xl py-1 overflow-hidden" style={{ background: 'rgba(15,8,33,0.95)', border: '1px solid rgba(255,255,255,0.12)', backdropFilter: 'blur(16px)' }}>
                                      <button
                                        onClick={() => { openAssign(tc); setOpenKebab(null) }}
                                        className="w-full text-left px-3 py-2 text-[13px] text-slate-300 hover:text-white hover:bg-white/8 flex items-center gap-2.5 cursor-pointer transition-colors">
                                        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2 flex-shrink-0"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                        Move to service
                                      </button>
                                      <div className="h-px mx-2 my-1" style={{ background: 'rgba(255,255,255,0.08)' }} />
                                      <button
                                        onClick={() => { setConfirmDeleteId(tc.id); setOpenKebab(null) }}
                                        className="w-full text-left px-3 py-2 text-[13px] text-red-400 hover:text-red-300 hover:bg-red-500/10 flex items-center gap-2.5 cursor-pointer transition-colors">
                                        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2 flex-shrink-0"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
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
            <table className="w-full">
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)', background: 'rgba(0,0,0,0.3)' }}>
                  <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Test Case</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Result</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Summary</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Run By</th>
                  <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Run At</th>
                </tr>
              </thead>
              <tbody>
                {runs.length === 0 && !loading && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-[14px] text-slate-500">No run records yet for {env.toUpperCase()}</td></tr>
                )}
                {runs.map((r, i) => (
                  <tr key={r.id} className="transition-colors" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: i % 2 === 1 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                    <td className="px-4 py-3 text-[13px] text-slate-300 font-medium max-w-xs truncate" title={r.description}>{r.description}</td>
                    <td className="px-4 py-3">
                      <span className={`text-[11px] px-2 py-0.5 rounded-full font-bold ${r.result === 'PASS' ? 'text-emerald-400' : 'text-red-400'}`} style={{ background: r.result === 'PASS' ? 'rgba(52,211,153,0.15)' : 'rgba(239,68,68,0.15)', border: `1px solid ${r.result === 'PASS' ? 'rgba(52,211,153,0.3)' : 'rgba(239,68,68,0.3)'}` }}>
                        {r.result}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[13px] text-slate-500 max-w-xs truncate" title={r.summary}>{r.summary || '—'}</td>
                    <td className="px-4 py-3 text-[13px] text-slate-500">{r.runBy || '—'}</td>
                    <td className="px-4 py-3 text-[13px] text-slate-600">{r.runAt ? new Date(r.runAt).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
