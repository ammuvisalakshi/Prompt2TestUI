import { useState, useEffect, useCallback } from 'react'
import { fetchAuthSession } from '@aws-amplify/auth'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, QueryCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb'
import { useEnv } from '../context/EnvContext'
import { useTeam } from '../context/TeamContext'

const AWS_REGION = import.meta.env.VITE_AWS_REGION as string
const TABLE      = 'prompt2test-config'

type ParamRow   = { key: string; value: string }
type Account    = { id: string; name: string; code: string }
type PayloadDef = { name: string; body: string }  // payload template: name + JSON body with {param.KEY}

// ── DynamoDB helpers ──────────────────────────────────────────────────────────

async function getDB() {
  const s = await fetchAuthSession()
  const client = new DynamoDBClient({ region: AWS_REGION, credentials: s.credentials })
  return DynamoDBDocumentClient.from(client)
}

function svcPK(team: string, env: string)  { return `SERVICE#${team}#${env}` }
function acctPK(env: string)               { return `ACCOUNT#${env}` }
function payloadPK(team: string, env: string)                  { return `PAYLOAD#${team}#${env}` }
function companyPK(team: string, env: string, code: string)    { return `COMPANY#${team}#${env}#${code}` }

async function loadServices(team: string, env: string): Promise<Record<string, ParamRow[]>> {
  const db = await getDB()
  const resp = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': svcPK(team, env) } }))
  const map: Record<string, ParamRow[]> = {}
  for (const item of resp.Items ?? []) {
    const [svc, ...rest] = (item.sk as string).split('#')
    const key = rest.join('#')
    if (!map[svc]) map[svc] = []
    map[svc].push({ key, value: item.val as string })
  }
  return map
}

async function saveServiceParam(team: string, env: string, svc: string, key: string, value: string) {
  const db = await getDB()
  await db.send(new PutCommand({ TableName: TABLE, Item: { pk: svcPK(team, env), sk: `${svc}#${key}`, val: value, svc, env, team } }))
}

async function deleteServiceParam(team: string, env: string, svc: string, key: string) {
  const db = await getDB()
  await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: svcPK(team, env), sk: `${svc}#${key}` } }))
}

async function loadAccounts(env: string): Promise<Account[]> {
  const db = await getDB()
  const resp = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': acctPK(env) } }))
  const map: Record<string, Record<string, string>> = {}
  for (const item of resp.Items ?? []) {
    const [id, field] = (item.sk as string).split('#')
    if (!map[id]) map[id] = {}
    map[id][field] = item.val as string
  }
  return Object.entries(map).map(([id, f]) => ({ id, name: f['NAME'] ?? '', code: f['CODE'] ?? '' }))
}

async function saveAccount(env: string, id: string, name: string, code: string) {
  const db = await getDB()
  await Promise.all([
    db.send(new PutCommand({ TableName: TABLE, Item: { pk: acctPK(env), sk: `${id}#NAME`, val: name } })),
    db.send(new PutCommand({ TableName: TABLE, Item: { pk: acctPK(env), sk: `${id}#CODE`, val: code } })),
  ])
}

async function deleteAccount(env: string, id: string) {
  const db = await getDB()
  await Promise.all([
    db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: acctPK(env), sk: `${id}#NAME` } })),
    db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: acctPK(env), sk: `${id}#CODE` } })),
  ])
}

// ── Payload helpers ──────────────────────────────────────────────────────────

async function loadPayloads(team: string, env: string): Promise<Record<string, PayloadDef[]>> {
  const db = await getDB()
  const resp = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': payloadPK(team, env) } }))
  const map: Record<string, PayloadDef[]> = {}
  for (const item of resp.Items ?? []) {
    const [svc, ...rest] = (item.sk as string).split('#')
    const name = rest.join('#')
    if (!map[svc]) map[svc] = []
    map[svc].push({ name, body: item.val as string })
  }
  return map
}

async function savePayload(team: string, env: string, svc: string, name: string, body: string) {
  const db = await getDB()
  await db.send(new PutCommand({ TableName: TABLE, Item: { pk: payloadPK(team, env), sk: `${svc}#${name}`, val: body, svc, env, team } }))
}

async function deletePayload(team: string, env: string, svc: string, name: string) {
  const db = await getDB()
  await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: payloadPK(team, env), sk: `${svc}#${name}` } }))
}

// ── Company code helpers ────────────────────────────────────────────────────

async function loadCompanyCodes(team: string, env: string): Promise<string[]> {
  // Scan for all COMPANY#{team}#{env}#* PKs to find unique company codes
  const db = await getDB()
  const prefix = `COMPANY#${team}#${env}#`
  // Use a scan with filter — not ideal but company codes are small (5-10)
  const { ScanCommand } = await import('@aws-sdk/lib-dynamodb')
  const resp = await db.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: 'begins_with(pk, :prefix)',
    ExpressionAttributeValues: { ':prefix': prefix },
    ProjectionExpression: 'pk',
  }))
  const codes = new Set<string>()
  for (const item of resp.Items ?? []) {
    const pk = item.pk as string
    const code = pk.replace(prefix, '')
    if (code) codes.add(code)
  }
  return Array.from(codes).sort()
}

async function loadCompanyParams(team: string, env: string, code: string): Promise<Record<string, ParamRow[]>> {
  const db = await getDB()
  const resp = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': companyPK(team, env, code) } }))
  const map: Record<string, ParamRow[]> = {}
  for (const item of resp.Items ?? []) {
    const [svc, ...rest] = (item.sk as string).split('#')
    const key = rest.join('#')
    if (!map[svc]) map[svc] = []
    map[svc].push({ key, value: item.val as string })
  }
  return map
}

async function saveCompanyParam(team: string, env: string, code: string, svc: string, key: string, value: string) {
  const db = await getDB()
  await db.send(new PutCommand({ TableName: TABLE, Item: { pk: companyPK(team, env, code), sk: `${svc}#${key}`, val: value, svc, env, team, companyCode: code } }))
}

async function deleteCompanyParam(team: string, env: string, code: string, svc: string, key: string) {
  const db = await getDB()
  await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: companyPK(team, env, code), sk: `${svc}#${key}` } }))
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ConfigPage() {
  const { env }  = useEnv()
  const { team } = useTeam()
  const [tab, setTab] = useState<'services' | 'payloads' | 'companies' | 'accounts'>('services')

  const [svcRows,   setSvcRows]   = useState<Record<string, ParamRow[]>>({})
  const [svcLoading, setSvcLoading] = useState(false)
  const [svcSaving,  setSvcSaving]  = useState<Record<string, boolean>>({})
  const [svcStatus,  setSvcStatus]  = useState<Record<string, { type: 'idle' | 'saved' | 'error'; msg?: string }>>({})
  const [showRegisterModal, setShowRegisterModal] = useState(false)

  const [accounts,     setAccounts]     = useState<Account[]>([])
  const [acctLoading,  setAcctLoading]  = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)

  // Payloads
  const [payloads, setPayloads] = useState<Record<string, PayloadDef[]>>({})
  const [payloadsLoading, setPayloadsLoading] = useState(false)
  const [payloadSvc, setPayloadSvc] = useState('')  // selected service for payloads tab
  const [showAddPayloadModal, setShowAddPayloadModal] = useState(false)

  // Company codes
  const [companyCodes, setCompanyCodes] = useState<string[]>([])
  const [companyLoading, setCompanyLoading] = useState(false)
  const [selectedCompany, setSelectedCompany] = useState('')
  const [companyParams, setCompanyParams] = useState<Record<string, ParamRow[]>>({})
  const [companyParamsLoading, setCompanyParamsLoading] = useState(false)
  const [showAddCompanyModal, setShowAddCompanyModal] = useState(false)

  const fetchServices = useCallback(async () => {
    if (!team) return
    setSvcLoading(true)
    try { setSvcRows(await loadServices(team, env)) }
    catch (e) { console.error('Load services failed:', e) }
    finally { setSvcLoading(false) }
  }, [env, team])

  const fetchAccounts = useCallback(async () => {
    setAcctLoading(true)
    try { setAccounts(await loadAccounts(env)) }
    catch (e) { console.error('Load accounts failed:', e) }
    finally { setAcctLoading(false) }
  }, [env])

  const fetchPayloads = useCallback(async () => {
    if (!team) return
    setPayloadsLoading(true)
    try { setPayloads(await loadPayloads(team, env)) }
    catch (e) { console.error('Load payloads failed:', e) }
    finally { setPayloadsLoading(false) }
  }, [env, team])

  const fetchCompanyCodes = useCallback(async () => {
    if (!team) return
    setCompanyLoading(true)
    try { setCompanyCodes(await loadCompanyCodes(team, env)) }
    catch (e) { console.error('Load company codes failed:', e) }
    finally { setCompanyLoading(false) }
  }, [env, team])

  const fetchCompanyParams = useCallback(async (code: string) => {
    if (!team || !code) return
    setCompanyParamsLoading(true)
    try { setCompanyParams(await loadCompanyParams(team, env, code)) }
    catch (e) { console.error('Load company params failed:', e) }
    finally { setCompanyParamsLoading(false) }
  }, [env, team])

  useEffect(() => {
    if (tab === 'services') fetchServices()
    if (tab === 'accounts') fetchAccounts()
    if (tab === 'payloads') { fetchPayloads(); fetchServices() }
    if (tab === 'companies') fetchCompanyCodes()
  }, [env, tab, fetchServices, fetchAccounts, fetchPayloads, fetchCompanyCodes])

  useEffect(() => {
    if (selectedCompany) fetchCompanyParams(selectedCompany)
  }, [selectedCompany, fetchCompanyParams])

  async function handleSaveService(svc: string) {
    setSvcSaving(p => ({ ...p, [svc]: true }))
    setSvcStatus(p => ({ ...p, [svc]: { type: 'idle' } }))
    try {
      const rows = (svcRows[svc] ?? []).filter(r => r.key.trim() && r.value.trim())
      if (!rows.length) { setSvcStatus(p => ({ ...p, [svc]: { type: 'error', msg: 'Add at least one parameter' } })); return }
      await Promise.all(rows.map(r => saveServiceParam(team, env, svc, r.key.trim().toUpperCase(), r.value.trim())))
      setSvcStatus(p => ({ ...p, [svc]: { type: 'saved' } }))
      setTimeout(() => setSvcStatus(p => ({ ...p, [svc]: { type: 'idle' } })), 3000)
    } catch (e: unknown) {
      setSvcStatus(p => ({ ...p, [svc]: { type: 'error', msg: e instanceof Error ? e.message : String(e) } }))
    } finally { setSvcSaving(p => ({ ...p, [svc]: false })) }
  }

  async function handleDeleteService(svc: string) {
    if (!confirm(`Delete service "${svc}" and all its parameters?`)) return
    try {
      await Promise.all((svcRows[svc] ?? []).map(r => deleteServiceParam(team, env, svc, r.key.trim().toUpperCase()).catch(() => {})))
      setSvcRows(p => { const n = { ...p }; delete n[svc]; return n })
    } catch (e) { console.error(e) }
  }

  async function handleDeleteAccount(id: string) {
    if (!confirm('Delete this test account?')) return
    try {
      await deleteAccount(env, id)
      setAccounts(prev => prev.filter(a => a.id !== id))
    } catch (e) { console.error(e) }
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: '#FAFBFF', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div style={{ background: 'linear-gradient(135deg, #7C3AED 0%, #4F46E5 50%, #0EA5E9 100%)', padding: '24px 28px 20px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'white', marginBottom: 4, letterSpacing: '-0.3px' }}>Config &amp; Accounts</div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>{env.toUpperCase()} environment</div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {([
              { id: 'services' as const, label: 'Services' },
              { id: 'payloads' as const, label: 'Test Payloads' },
              { id: 'companies' as const, label: 'Company Codes' },
              { id: 'accounts' as const, label: 'Test Accounts' },
            ]).map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                padding: '6px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', borderRadius: 20,
                border: tab === t.id ? '1px solid rgba(255,255,255,0.5)' : '1px solid rgba(255,255,255,0.25)',
                background: tab === t.id ? 'rgba(255,255,255,0.2)' : 'transparent', color: 'white',
              }}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ padding: 24 }}>
        {tab === 'services' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#64748B' }}>
                {svcLoading ? 'Loading…' : `${Object.keys(svcRows).length} service${Object.keys(svcRows).length !== 1 ? 's' : ''} · ${env.toUpperCase()}`}
              </div>
              <button onClick={() => setShowRegisterModal(true)}
                style={{ padding: '6px 14px', background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer', boxShadow: '0 2px 8px rgba(124,58,237,0.35)' }}>
                + Register Service
              </button>
            </div>
            {svcLoading ? (
              <div style={{ fontSize: 13, color: '#94A3B8', padding: '24px 0', textAlign: 'center' }}>Loading…</div>
            ) : Object.keys(svcRows).length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: '#94A3B8', fontSize: 13 }}>
                No services for {env.toUpperCase()} yet. Click <strong style={{ color: '#64748B' }}>+ Register Service</strong> to add one.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {Object.keys(svcRows).sort().map(svc => (
                  <ServiceCard
                    key={svc} svc={svc} env={env} team={team}
                    rows={svcRows[svc]}
                    saving={svcSaving[svc] ?? false}
                    status={svcStatus[svc] ?? { type: 'idle' }}
                    onChange={rows => setSvcRows(p => ({ ...p, [svc]: rows }))}
                    onSave={() => handleSaveService(svc)}
                    onDelete={() => handleDeleteService(svc)}
                    onDeleteRow={key => { if (key.trim()) deleteServiceParam(team, env, svc, key.trim().toUpperCase()).catch(console.error) }}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'accounts' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#64748B' }}>
                {acctLoading ? 'Loading…' : `${accounts.length} account${accounts.length !== 1 ? 's' : ''} · ${env.toUpperCase()}`}
              </div>
              <button onClick={() => setShowAddModal(true)}
                style={{ padding: '6px 14px', background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer', boxShadow: '0 2px 8px rgba(124,58,237,0.35)' }}>
                + Add Account
              </button>
            </div>
            {acctLoading ? (
              <div style={{ fontSize: 13, color: '#94A3B8', padding: '24px 0', textAlign: 'center' }}>Loading…</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {accounts.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px 0', color: '#94A3B8', fontSize: 13 }}>
                    No test accounts for {env.toUpperCase()} yet. Click <strong style={{ color: '#64748B' }}>+ Add Account</strong>.
                  </div>
                ) : accounts.map(acc => (
                  <div key={acc.id} style={{ background: 'white', border: '1px solid #E8EBF0', borderRadius: 12, padding: 16, display: 'flex', alignItems: 'center', gap: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                    <div style={{ width: 36, height: 36, borderRadius: 8, background: '#EDE9FE', border: '1px solid #DDD6FE', color: '#6D28D9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
                      {acc.name.split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#0F172A' }}>{acc.name}</div>
                      <div style={{ fontSize: 12, color: '#94A3B8', fontFamily: 'monospace' }}>{acc.code}</div>
                    </div>
                    <button onClick={() => handleDeleteAccount(acc.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: 16, lineHeight: 1, padding: 0 }}
                      onMouseEnter={e => (e.currentTarget.style.color = '#EF4444')}
                      onMouseLeave={e => (e.currentTarget.style.color = '#94A3B8')}>×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Test Payloads Tab ──────────────────────────────────────── */}
        {tab === 'payloads' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#64748B' }}>
                  {payloadsLoading ? 'Loading...' : 'Test Payloads'}
                </div>
                {Object.keys(svcRows).length > 0 && (
                  <select value={payloadSvc} onChange={e => setPayloadSvc(e.target.value)}
                    style={{ padding: '4px 8px', fontSize: 13, borderRadius: 6, border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#0F172A' }}>
                    <option value="">All services</option>
                    {Object.keys(svcRows).sort().map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                )}
              </div>
              <button onClick={() => setShowAddPayloadModal(true)}
                style={{ padding: '6px 14px', background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer', boxShadow: '0 2px 8px rgba(124,58,237,0.35)' }}>
                + Add Payload
              </button>
            </div>
            {payloadsLoading ? (
              <div style={{ fontSize: 13, color: '#94A3B8', padding: '24px 0', textAlign: 'center' }}>Loading...</div>
            ) : Object.keys(payloads).length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: '#94A3B8', fontSize: 13 }}>
                No payload templates yet. Click <strong style={{ color: '#64748B' }}>+ Add Payload</strong> to create one.
                <div style={{ marginTop: 8, fontSize: 12 }}>Payloads use <code style={{ background: '#F1F5F9', padding: '1px 4px', borderRadius: 3 }}>{'{param.KEY}'}</code> placeholders that resolve per company code.</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {Object.entries(payloads).filter(([svc]) => !payloadSvc || svc === payloadSvc).sort().map(([svc, defs]) => (
                  <div key={svc} style={{ background: 'white', border: '1px solid #E8EBF0', borderRadius: 12, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginBottom: 12, textTransform: 'capitalize' }}>{svc}</div>
                    {defs.map(p => (
                      <div key={p.name} style={{ marginBottom: 10, padding: 10, background: '#F8FAFC', borderRadius: 8, border: '1px solid #E2E8F0' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: '#7C3AED', fontFamily: 'monospace' }}>{p.name}</span>
                          <button onClick={async () => { await deletePayload(team, env, svc, p.name); fetchPayloads() }}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: 14 }}
                            onMouseEnter={e => (e.currentTarget.style.color = '#EF4444')} onMouseLeave={e => (e.currentTarget.style.color = '#94A3B8')}>x</button>
                        </div>
                        <textarea value={p.body} rows={3}
                          onChange={e => setPayloads(prev => ({
                            ...prev, [svc]: prev[svc].map(d => d.name === p.name ? { ...d, body: e.target.value } : d)
                          }))}
                          style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, padding: 8, border: '1px solid #E2E8F0', borderRadius: 6, background: 'white', resize: 'vertical', boxSizing: 'border-box' }} />
                        <button onClick={async () => { await savePayload(team, env, svc, p.name, p.body); }}
                          style={{ marginTop: 4, padding: '3px 10px', fontSize: 11, background: '#7C3AED', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>Save</button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Company Codes Tab ─────────────────────────────────────── */}
        {tab === 'companies' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#64748B' }}>
                  {companyLoading ? 'Loading...' : `${companyCodes.length} company code${companyCodes.length !== 1 ? 's' : ''}`}
                </div>
                {companyCodes.length > 0 && (
                  <select value={selectedCompany} onChange={e => setSelectedCompany(e.target.value)}
                    style={{ padding: '4px 8px', fontSize: 13, borderRadius: 6, border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#0F172A', fontWeight: 600 }}>
                    <option value="">Select company code</option>
                    {companyCodes.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                )}
              </div>
              <button onClick={() => setShowAddCompanyModal(true)}
                style={{ padding: '6px 14px', background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer', boxShadow: '0 2px 8px rgba(124,58,237,0.35)' }}>
                + Add Company Code
              </button>
            </div>
            {!selectedCompany ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: '#94A3B8', fontSize: 13 }}>
                {companyCodes.length === 0
                  ? <>No company codes yet. Click <strong style={{ color: '#64748B' }}>+ Add Company Code</strong> to register one.</>
                  : 'Select a company code to manage its parameters.'}
              </div>
            ) : companyParamsLoading ? (
              <div style={{ fontSize: 13, color: '#94A3B8', padding: '24px 0', textAlign: 'center' }}>Loading parameters...</div>
            ) : (
              <div>
                <div style={{ fontSize: 13, color: '#94A3B8', marginBottom: 12 }}>
                  Parameters for <strong style={{ color: '#7C3AED' }}>{selectedCompany}</strong> — these override <code style={{ background: '#F1F5F9', padding: '1px 4px', borderRadius: 3 }}>{'{param.KEY}'}</code> in payload templates.
                </div>
                {Object.keys(svcRows).length === 0 ? (
                  <div style={{ fontSize: 13, color: '#94A3B8', padding: '20px 0', textAlign: 'center' }}>Register services first in the Services tab.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {Object.keys(svcRows).sort().map(svc => {
                      const rows = companyParams[svc] || []
                      return (
                        <div key={svc} style={{ background: 'white', border: '1px solid #E8EBF0', borderRadius: 12, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginBottom: 10, textTransform: 'capitalize' }}>{svc}</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {rows.map((row, i) => (
                              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <input style={{ padding: '5px 10px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 12, fontFamily: 'monospace', width: 160 }}
                                  placeholder="param_key" value={row.key}
                                  onChange={e => setCompanyParams(prev => ({ ...prev, [svc]: rows.map((r, idx) => idx === i ? { ...r, key: e.target.value.toLowerCase().replace(/\s+/g, '_') } : r) }))} />
                                <input style={{ padding: '5px 10px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 12, flex: 1 }}
                                  placeholder="value" value={row.value}
                                  onChange={e => setCompanyParams(prev => ({ ...prev, [svc]: rows.map((r, idx) => idx === i ? { ...r, value: e.target.value } : r) }))} />
                                <button onClick={async () => {
                                  if (row.key.trim()) await deleteCompanyParam(team, env, selectedCompany, svc, row.key.trim()).catch(() => {})
                                  setCompanyParams(prev => ({ ...prev, [svc]: rows.filter((_, idx) => idx !== i) }))
                                }}
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: 14 }}
                                  onMouseEnter={e => (e.currentTarget.style.color = '#EF4444')} onMouseLeave={e => (e.currentTarget.style.color = '#94A3B8')}>x</button>
                              </div>
                            ))}
                          </div>
                          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                            <button onClick={() => setCompanyParams(prev => ({ ...prev, [svc]: [...rows, { key: '', value: '' }] }))}
                              style={{ padding: '4px 10px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 12, color: '#64748B', cursor: 'pointer' }}>+ Add param</button>
                            <button onClick={async () => {
                              const valid = rows.filter(r => r.key.trim() && r.value.trim())
                              await Promise.all(valid.map(r => saveCompanyParam(team, env, selectedCompany, svc, r.key.trim(), r.value.trim())))
                            }}
                              style={{ padding: '4px 10px', background: '#7C3AED', color: 'white', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>Save</button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>  {/* end padding: 24 */}

      {showAddPayloadModal && (
        <AddPayloadModal
          services={Object.keys(svcRows).sort()}
          onClose={() => setShowAddPayloadModal(false)}
          onSaved={async (svc, name, body) => {
            await savePayload(team, env, svc, name, body)
            setShowAddPayloadModal(false)
            fetchPayloads()
          }}
        />
      )}
      {showAddCompanyModal && (
        <AddCompanyCodeModal
          onClose={() => setShowAddCompanyModal(false)}
          onSaved={async (code) => {
            // Create a dummy param to register the company code
            const firstSvc = Object.keys(svcRows)[0] || 'default'
            await saveCompanyParam(team, env, code, firstSvc, '_registered', 'true')
            setShowAddCompanyModal(false)
            fetchCompanyCodes()
            setSelectedCompany(code)
          }}
        />
      )}
      {showRegisterModal && (
        <RegisterServiceModal
          existingNames={Object.keys(svcRows)}
          onClose={() => setShowRegisterModal(false)}
          onRegister={name => { setSvcRows(p => ({ ...p, [name]: [{ key: '', value: '' }] })); setShowRegisterModal(false) }}
        />
      )}
      {showAddModal && (
        <AddAccountModal env={env} onClose={() => setShowAddModal(false)} onSaved={() => { setShowAddModal(false); fetchAccounts() }} />
      )}
    </div>
  )
}

// ── Service Card ──────────────────────────────────────────────────────────────

function ServiceCard({ svc, env, team, rows, saving, status, onChange, onSave, onDelete, onDeleteRow }: {
  svc: string; env: string; team: string; rows: ParamRow[]
  saving: boolean; status: { type: 'idle' | 'saved' | 'error'; msg?: string }
  onChange: (rows: ParamRow[]) => void; onSave: () => void; onDelete: () => void; onDeleteRow: (key: string) => void
}) {
  const inp: React.CSSProperties = { padding: '6px 12px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 13, color: '#0F172A', outline: 'none' }

  return (
    <div style={{ background: 'white', border: '1px solid #E8EBF0', borderRadius: 12, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', textTransform: 'capitalize' }}>{svc}</div>
          <span style={{ fontSize: 11, color: '#94A3B8' }}>{team} · {env.toUpperCase()}</span>
        </div>
        <button onClick={onDelete} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: 18, lineHeight: 1, padding: 0 }}
          onMouseEnter={e => (e.currentTarget.style.color = '#EF4444')} onMouseLeave={e => (e.currentTarget.style.color = '#94A3B8')}>×</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
        {rows.map((row, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input style={{ ...inp, width: 180, flexShrink: 0, fontFamily: 'monospace' }} placeholder="PARAM_KEY"
              value={row.key} onChange={e => onChange(rows.map((r, idx) => idx === i ? { ...r, key: e.target.value.toUpperCase().replace(/\s+/g, '_') } : r))} />
            <input style={{ ...inp, flex: 1 }} placeholder="value"
              value={row.value} onChange={e => onChange(rows.map((r, idx) => idx === i ? { ...r, value: e.target.value } : r))} />
            <button onClick={() => { onDeleteRow(row.key); onChange(rows.filter((_, idx) => idx !== i)) }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: 16, flexShrink: 0, lineHeight: 1, padding: 0 }}
              onMouseEnter={e => (e.currentTarget.style.color = '#EF4444')} onMouseLeave={e => (e.currentTarget.style.color = '#94A3B8')}>×</button>
          </div>
        ))}
        {rows.length === 0 && <div style={{ fontSize: 12, color: '#94A3B8', fontStyle: 'italic' }}>No parameters yet.</div>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={() => onChange([...rows, { key: '', value: '' }])}
          style={{ padding: '6px 12px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 13, color: '#64748B', cursor: 'pointer' }}>
          + Add param
        </button>
        <button onClick={onSave} disabled={saving}
          style={{ padding: '6px 12px', background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1, boxShadow: '0 2px 8px rgba(124,58,237,0.35)' }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {status.type === 'saved' && <span style={{ fontSize: 12, color: '#166534', fontWeight: 500 }}>✓ Saved</span>}
        {status.type === 'error' && <span style={{ fontSize: 12, color: '#991B1B', fontWeight: 500 }}>✗ {status.msg}</span>}
      </div>
    </div>
  )
}

// ── Register Service Modal ────────────────────────────────────────────────────

function RegisterServiceModal({ existingNames, onClose, onRegister }: { existingNames: string[]; onClose: () => void; onRegister: (name: string) => void }) {
  const [name, setName]   = useState('')
  const [error, setError] = useState('')
  const inp: React.CSSProperties = { width: '100%', padding: '8px 12px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 14, color: '#0F172A', outline: 'none', boxSizing: 'border-box' }

  function handleRegister() {
    const n = name.trim().toLowerCase()
    if (!n) { setError('Service name is required'); return }
    if (existingNames.includes(n)) { setError('Service already exists'); return }
    onRegister(n)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={onClose}>
      <div style={{ background: 'white', border: '1px solid #E8EBF0', borderRadius: 16, padding: 28, width: 380, boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A' }}>Register Service</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: 20, lineHeight: 1, padding: 0 }}>×</button>
        </div>
        <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#64748B', marginBottom: 4 }}>Service Name</label>
        <input style={inp} placeholder="e.g. billing, payment, auth" autoFocus value={name}
          onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleRegister()} />
        {error && <div style={{ marginTop: 8, fontSize: 12, color: '#991B1B' }}>✗ {error}</div>}
        <div style={{ marginTop: 8, fontSize: 11, color: '#94A3B8' }}>Parameters can be added after registering.</div>
        <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', background: 'white', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 14, color: '#64748B', cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleRegister} style={{ padding: '8px 16px', background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: 'pointer', boxShadow: '0 2px 8px rgba(124,58,237,0.35)' }}>Register</button>
        </div>
      </div>
    </div>
  )
}

// ── Add Account Modal ─────────────────────────────────────────────────────────

function AddAccountModal({ env, onClose, onSaved }: { env: string; onClose: () => void; onSaved: () => void }) {
  const [name, setName]     = useState('')
  const [code, setCode]     = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')
  const inp: React.CSSProperties = { width: '100%', padding: '8px 12px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 14, color: '#0F172A', outline: 'none', boxSizing: 'border-box' }

  async function handleSave() {
    if (!name.trim() || !code.trim()) { setError('Name and code are required'); return }
    setSaving(true); setError('')
    try {
      await saveAccount(env, Date.now().toString(36), name.trim(), code.trim())
      onSaved()
    } catch (e: unknown) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={onClose}>
      <div style={{ background: 'white', border: '1px solid #E8EBF0', borderRadius: 16, padding: 28, width: 400, boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A' }}>Add Test Account · {env.toUpperCase()}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: 20, lineHeight: 1, padding: 0 }}>×</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#64748B', marginBottom: 4 }}>Name</label>
            <input style={inp} placeholder="Acme Corp" autoFocus value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#64748B', marginBottom: 4 }}>Code</label>
            <input style={{ ...inp, fontFamily: 'monospace' }} placeholder="ACME001" value={code} onChange={e => setCode(e.target.value.toUpperCase())} />
          </div>
        </div>
        {error && <div style={{ marginTop: 12, fontSize: 12, color: '#991B1B' }}>✗ {error}</div>}
        <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', background: 'white', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 14, color: '#64748B', cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleSave} disabled={saving}
            style={{ padding: '8px 16px', background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1, boxShadow: '0 2px 8px rgba(124,58,237,0.35)' }}>
            {saving ? 'Saving…' : 'Save Account'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Add Payload Modal ────────────────────────────────────────────────────────

function AddPayloadModal({ services, onClose, onSaved }: { services: string[]; onClose: () => void; onSaved: (svc: string, name: string, body: string) => void }) {
  const [svc, setSvc]   = useState(services[0] || '')
  const [name, setName] = useState('')
  const [body, setBody] = useState('{\n  \n}')
  const [error, setError] = useState('')
  const inp: React.CSSProperties = { width: '100%', padding: '8px 12px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 14, color: '#0F172A', outline: 'none', boxSizing: 'border-box' }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={onClose}>
      <div style={{ background: 'white', border: '1px solid #E8EBF0', borderRadius: 16, padding: 28, width: 480, boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A' }}>Add Payload Template</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: 20, lineHeight: 1, padding: 0 }}>x</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#64748B', marginBottom: 4 }}>Service</label>
            <select style={{ ...inp, cursor: 'pointer' }} value={svc} onChange={e => setSvc(e.target.value)}>
              {services.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#64748B', marginBottom: 4 }}>Payload Name</label>
            <input style={{ ...inp, fontFamily: 'monospace' }} placeholder="e.g. create_user, update_order" value={name}
              onChange={e => setName(e.target.value.toLowerCase().replace(/\s+/g, '_'))} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#64748B', marginBottom: 4 }}>
              JSON Body <span style={{ color: '#94A3B8', fontWeight: 400 }}>— use {'{param.KEY}'} for company-specific values</span>
            </label>
            <textarea style={{ ...inp, fontFamily: 'monospace', fontSize: 12, height: 120, resize: 'vertical' }} value={body}
              onChange={e => setBody(e.target.value)} />
          </div>
        </div>
        {error && <div style={{ marginTop: 8, fontSize: 12, color: '#991B1B' }}>{error}</div>}
        <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', background: 'white', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 14, color: '#64748B', cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => {
            if (!svc) { setError('Select a service'); return }
            if (!name.trim()) { setError('Payload name is required'); return }
            onSaved(svc, name.trim(), body)
          }} style={{ padding: '8px 16px', background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: 'pointer', boxShadow: '0 2px 8px rgba(124,58,237,0.35)' }}>Save Payload</button>
        </div>
      </div>
    </div>
  )
}

// ── Add Company Code Modal ───────────────────────────────────────────────────

function AddCompanyCodeModal({ onClose, onSaved }: { onClose: () => void; onSaved: (code: string) => void }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const inp: React.CSSProperties = { width: '100%', padding: '8px 12px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 14, color: '#0F172A', outline: 'none', boxSizing: 'border-box' }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={onClose}>
      <div style={{ background: 'white', border: '1px solid #E8EBF0', borderRadius: 16, padding: 28, width: 380, boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A' }}>Add Company Code</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: 20, lineHeight: 1, padding: 0 }}>x</button>
        </div>
        <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#64748B', marginBottom: 4 }}>Company Code</label>
        <input style={{ ...inp, fontFamily: 'monospace', textTransform: 'uppercase' }} placeholder="e.g. ACME, GLOBEX" autoFocus value={code}
          onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ''))}
          onKeyDown={e => { if (e.key === 'Enter') { if (code.trim()) onSaved(code.trim()); else setError('Code is required') } }} />
        {error && <div style={{ marginTop: 8, fontSize: 12, color: '#991B1B' }}>{error}</div>}
        <div style={{ marginTop: 8, fontSize: 11, color: '#94A3B8' }}>Company codes are shared across all team members.</div>
        <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', background: 'white', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 14, color: '#64748B', cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => { if (!code.trim()) { setError('Code is required'); return }; onSaved(code.trim()) }}
            style={{ padding: '8px 16px', background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: 'pointer', boxShadow: '0 2px 8px rgba(124,58,237,0.35)' }}>Add</button>
        </div>
      </div>
    </div>
  )
}
