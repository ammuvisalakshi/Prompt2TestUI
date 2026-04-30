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
type PayloadDef = { name: string; body: string }

// ── DynamoDB helpers ──────────────────────────────────────────────────────────

async function getDB() {
  const s = await fetchAuthSession()
  const client = new DynamoDBClient({ region: AWS_REGION, credentials: s.credentials })
  return DynamoDBDocumentClient.from(client)
}

function svcPK(team: string, env: string)  { return `SERVICE#${team}#${env}` }
function acctPK(env: string)               { return `ACCOUNT#${env}` }
function companyPK(team: string, env: string, code: string) { return `COMPANY#${team}#${env}#${code}` }

async function loadServices(team: string, env: string): Promise<Record<string, ParamRow[]>> {
  const db = await getDB()
  const resp = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': svcPK(team, env) } }))
  const map: Record<string, ParamRow[]> = {}
  for (const item of resp.Items ?? []) {
    const [svc, ...rest] = (item.sk as string).split('#')
    if (!map[svc]) map[svc] = []
    map[svc].push({ key: rest.join('#'), value: item.val as string })
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
async function loadPayloads(team: string, env: string, companyCode: string): Promise<Record<string, PayloadDef[]>> {
  const db = await getDB()
  const pk = `PAYLOAD#${team}#${env}#${companyCode}`
  const resp = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': pk } }))
  const map: Record<string, PayloadDef[]> = {}
  for (const item of resp.Items ?? []) {
    const [svc, ...rest] = (item.sk as string).split('#')
    if (!map[svc]) map[svc] = []
    map[svc].push({ name: rest.join('#'), body: item.val as string })
  }
  return map
}
async function savePayload(team: string, env: string, companyCode: string, svc: string, name: string, body: string) {
  const db = await getDB()
  await db.send(new PutCommand({ TableName: TABLE, Item: { pk: `PAYLOAD#${team}#${env}#${companyCode}`, sk: `${svc}#${name}`, val: body, svc, env, team } }))
}
async function deletePayload(team: string, env: string, companyCode: string, svc: string, name: string) {
  const db = await getDB()
  await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `PAYLOAD#${team}#${env}#${companyCode}`, sk: `${svc}#${name}` } }))
}
async function loadCompanyCodes(team: string, env: string): Promise<string[]> {
  const db = await getDB()
  // Company codes stored as: PK=COMPANYCODES#{team}#{env}, SK={code}
  const resp = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': `COMPANYCODES#${team}#${env}` } }))
  return (resp.Items ?? []).map(item => item.sk as string).sort()
}

async function registerCompanyCode(team: string, env: string, code: string) {
  const db = await getDB()
  await db.send(new PutCommand({ TableName: TABLE, Item: { pk: `COMPANYCODES#${team}#${env}`, sk: code, val: code, team, env } }))
}

async function deleteCompanyCode(team: string, env: string, code: string) {
  const db = await getDB()
  await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `COMPANYCODES#${team}#${env}`, sk: code } }))
}
async function loadCompanyParams(team: string, env: string, code: string): Promise<Record<string, ParamRow[]>> {
  const db = await getDB()
  const resp = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': companyPK(team, env, code) } }))
  const map: Record<string, ParamRow[]> = {}
  for (const item of resp.Items ?? []) {
    const [svc, ...rest] = (item.sk as string).split('#')
    if (!map[svc]) map[svc] = []
    map[svc].push({ key: rest.join('#'), value: item.val as string })
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

// ── Styles ──────────────────────────────────────────────────────────────────
const inp: React.CSSProperties = { padding: '6px 12px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 13, color: '#0F172A', outline: 'none' }
const btnPrimary: React.CSSProperties = { padding: '6px 14px', background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer', boxShadow: '0 2px 8px rgba(124,58,237,0.35)' }
const btnSecondary: React.CSSProperties = { padding: '4px 10px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 12, color: '#64748B', cursor: 'pointer' }
const card: React.CSSProperties = { background: 'white', border: '1px solid #E8EBF0', borderRadius: 12, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }

// ── Component ───────────────────────────────────────────────────────────────

export default function ConfigPage() {
  const { env } = useEnv()
  const { team } = useTeam()
  const [tab, setTab] = useState<'base' | 'company' | 'accounts'>('base')

  // Base services
  const [svcRows, setSvcRows] = useState<Record<string, ParamRow[]>>({})
  const [svcLoading, setSvcLoading] = useState(false)
  const [showRegisterModal, setShowRegisterModal] = useState(false)
  const [baseExpandedSvc, setBaseExpandedSvc] = useState('')
  const [baseSubTab, setBaseSubTab] = useState<'configs' | 'payloads'>('configs')
  const [basePayloads, setBasePayloads] = useState<Record<string, PayloadDef[]>>({})
  const [showBasePayloadModal, setShowBasePayloadModal] = useState(false)
  const [basePayloadSvc, setBasePayloadSvc] = useState('')

  // Company codes
  const [companyCodes, setCompanyCodes] = useState<string[]>([])
  const [selectedCode, setSelectedCode] = useState('')
  const [companyParams, setCompanyParams] = useState<Record<string, ParamRow[]>>({})
  const [companyPayloads, setCompanyPayloads] = useState<Record<string, PayloadDef[]>>({})
  const [companyLoading, setCompanyLoading] = useState(false)
  const [expandedSvc, setExpandedSvc] = useState<string>('')
  const [svcSubTab, setSvcSubTab] = useState<'configs' | 'payloads'>('configs')
  const [showAddCodeModal, setShowAddCodeModal] = useState(false)
  const [showAddPayloadModal, setShowAddPayloadModal] = useState(false)
  const [payloadModalSvc, setPayloadModalSvc] = useState('')

  // Accounts
  const [accounts, setAccounts] = useState<Account[]>([])
  const [acctLoading, setAcctLoading] = useState(false)
  const [showAddAcctModal, setShowAddAcctModal] = useState(false)

  const fetchServices = useCallback(async () => {
    if (!team) return; setSvcLoading(true)
    try { setSvcRows(await loadServices(team, env)) } catch { /* */ }
    finally { setSvcLoading(false) }
  }, [env, team])

  const fetchCompanyCodes = useCallback(async () => {
    if (!team) return
    try { setCompanyCodes(await loadCompanyCodes(team, env)) } catch { /* */ }
  }, [env, team])

  const fetchCompanyData = useCallback(async (code: string) => {
    if (!team || !code) return; setCompanyLoading(true)
    try {
      const [params, payloads] = await Promise.all([
        loadCompanyParams(team, env, code),
        loadPayloads(team, env, code),
      ])
      setCompanyParams(params)
      setCompanyPayloads(payloads)
    } catch { /* */ }
    finally { setCompanyLoading(false) }
  }, [env, team])

  const fetchAccounts = useCallback(async () => {
    setAcctLoading(true)
    try { setAccounts(await loadAccounts(env)) } catch { /* */ }
    finally { setAcctLoading(false) }
  }, [env])

  useEffect(() => {
    if (tab === 'base') fetchServices()
    if (tab === 'company') { fetchServices(); fetchCompanyCodes() }
    if (tab === 'accounts') fetchAccounts()
  }, [env, tab, fetchServices, fetchCompanyCodes, fetchAccounts])

  useEffect(() => {
    if (selectedCode) fetchCompanyData(selectedCode)
  }, [selectedCode, fetchCompanyData])

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: '#FAFBFF', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      {/* Header */}
      <div style={{ background: 'linear-gradient(135deg, #7C3AED 0%, #4F46E5 50%, #0EA5E9 100%)', padding: '24px 28px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'white', marginBottom: 4 }}>Config &amp; Accounts</div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>{env.toUpperCase()} environment</div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {([
              { id: 'base' as const, label: 'Base Services' },
              { id: 'company' as const, label: 'Company Codes' },
              { id: 'accounts' as const, label: 'Test Accounts' },
            ]).map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                padding: '6px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', borderRadius: 20,
                border: tab === t.id ? '1px solid rgba(255,255,255,0.5)' : '1px solid rgba(255,255,255,0.25)',
                background: tab === t.id ? 'rgba(255,255,255,0.2)' : 'transparent', color: 'white',
              }}>{t.label}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ padding: 24 }}>

        {/* ══ BASE SERVICES TAB ══════════════════════════════════════════ */}
        {tab === 'base' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#64748B' }}>
                {svcLoading ? 'Loading...' : `${Object.keys(svcRows).length} service${Object.keys(svcRows).length !== 1 ? 's' : ''} · ${env.toUpperCase()}`}
              </div>
              <button onClick={() => setShowRegisterModal(true)} style={btnPrimary}>+ Register Service</button>
            </div>
            {Object.keys(svcRows).length === 0 && !svcLoading ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: '#94A3B8', fontSize: 13 }}>
                No services yet. Click <strong>+ Register Service</strong> to add one.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {Object.keys(svcRows).sort().map(svc => (
                  <div key={svc} style={card}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', textTransform: 'capitalize' }}>{svc}
                        <span style={{ fontSize: 11, color: '#94A3B8', marginLeft: 8 }}>{team} · {env.toUpperCase()}</span>
                      </div>
                      <button onClick={() => { if (confirm(`Delete "${svc}"?`)) { Promise.all((svcRows[svc]??[]).map(r=>deleteServiceParam(team,env,svc,r.key).catch(()=>{}))); setSvcRows(p=>{const n={...p};delete n[svc];return n}) } }}
                        style={{ background:'none',border:'none',cursor:'pointer',color:'#94A3B8',fontSize:18 }}
                        onMouseEnter={e=>(e.currentTarget.style.color='#EF4444')} onMouseLeave={e=>(e.currentTarget.style.color='#94A3B8')}>x</button>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                      {(svcRows[svc]??[]).map((row, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <input style={{ ...inp, width: 180, fontFamily: 'monospace' }} placeholder="PARAM_KEY" value={row.key}
                            onChange={e => setSvcRows(p => ({ ...p, [svc]: p[svc].map((r,idx) => idx===i ? { ...r, key: e.target.value.toUpperCase().replace(/\s+/g,'_') } : r) }))} />
                          <input style={{ ...inp, flex: 1 }} placeholder="value" value={row.value}
                            onChange={e => setSvcRows(p => ({ ...p, [svc]: p[svc].map((r,idx) => idx===i ? { ...r, value: e.target.value } : r) }))} />
                          <button onClick={() => { if(row.key.trim()) deleteServiceParam(team,env,svc,row.key.trim().toUpperCase()).catch(()=>{}); setSvcRows(p=>({...p,[svc]:p[svc].filter((_,idx)=>idx!==i)})) }}
                            style={{ background:'none',border:'none',cursor:'pointer',color:'#94A3B8',fontSize:14 }}>x</button>
                        </div>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => setSvcRows(p => ({ ...p, [svc]: [...(p[svc]||[]), { key: '', value: '' }] }))} style={btnSecondary}>+ Add param</button>
                      <button onClick={async () => {
                        const rows = (svcRows[svc]??[]).filter(r=>r.key.trim()&&r.value.trim())
                        await Promise.all(rows.map(r => saveServiceParam(team,env,svc,r.key.trim().toUpperCase(),r.value.trim())))
                      }} style={btnPrimary}>Save</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ══ COMPANY CODES TAB ══════════════════════════════════════════ */}
        {tab === 'company' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#64748B' }}>Company Code:</div>
                <select value={selectedCode} onChange={e => { setSelectedCode(e.target.value); setExpandedSvc('') }}
                  style={{ padding: '5px 10px', fontSize: 13, borderRadius: 8, border: '1px solid #E2E8F0', background: '#F8FAFC', fontWeight: 600, color: '#0F172A' }}>
                  <option value="">Select...</option>
                  {companyCodes.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <button onClick={() => setShowAddCodeModal(true)} style={btnPrimary}>+ Add Company Code</button>
            </div>

            {!selectedCode ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: '#94A3B8', fontSize: 13 }}>
                {companyCodes.length === 0 ? <>No company codes yet. Click <strong>+ Add Company Code</strong>.</> : 'Select a company code to manage its services.'}
              </div>
            ) : companyLoading ? (
              <div style={{ textAlign: 'center', padding: '24px 0', color: '#94A3B8', fontSize: 13 }}>Loading...</div>
            ) : Object.keys(svcRows).length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: '#94A3B8', fontSize: 13 }}>Register services in the Base Services tab first.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {Object.keys(svcRows).sort().map(svc => {
                  const isExpanded = expandedSvc === svc
                  const params = companyParams[svc] || []
                  const payloads = companyPayloads[svc] || []
                  return (
                    <div key={svc} style={card}>
                      {/* Service header — click to expand */}
                      <div onClick={() => { setExpandedSvc(isExpanded ? '' : svc); setSvcSubTab('configs') }}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 12, color: '#94A3B8' }}>{isExpanded ? '▼' : '▶'}</span>
                          <span style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', textTransform: 'capitalize' }}>{svc}</span>
                          <span style={{ fontSize: 11, color: '#94A3B8' }}>{params.length} params · {payloads.length} payloads</span>
                        </div>
                      </div>

                      {/* Expanded: sub-tabs (Configs | Test Payloads) */}
                      {isExpanded && (
                        <div style={{ marginTop: 12 }}>
                          <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
                            {(['configs', 'payloads'] as const).map(st => (
                              <button key={st} onClick={() => setSvcSubTab(st)} style={{
                                padding: '4px 12px', fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: 'pointer',
                                background: svcSubTab === st ? '#7C3AED' : '#F1F5F9',
                                color: svcSubTab === st ? 'white' : '#64748B',
                                border: svcSubTab === st ? '1px solid #7C3AED' : '1px solid #E2E8F0',
                              }}>{st === 'configs' ? 'Configs' : 'Test Payloads'}</button>
                            ))}
                          </div>

                          {/* ── Configs sub-tab ── */}
                          {svcSubTab === 'configs' && (
                            <div>
                              {params.map((row, i) => (
                                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                                  <input style={{ ...inp, width: 160, fontFamily: 'monospace', fontSize: 12 }} placeholder="param_key" value={row.key}
                                    onChange={e => setCompanyParams(p => ({ ...p, [svc]: params.map((r,idx) => idx===i ? { ...r, key: e.target.value.toLowerCase().replace(/\s+/g,'_') } : r) }))} />
                                  <input style={{ ...inp, flex: 1, fontSize: 12 }} placeholder="value" value={row.value}
                                    onChange={e => setCompanyParams(p => ({ ...p, [svc]: params.map((r,idx) => idx===i ? { ...r, value: e.target.value } : r) }))} />
                                  <button onClick={async () => {
                                    if (row.key.trim()) await deleteCompanyParam(team,env,selectedCode,svc,row.key.trim()).catch(()=>{})
                                    setCompanyParams(p => ({ ...p, [svc]: params.filter((_,idx) => idx!==i) }))
                                  }} style={{ background:'none',border:'none',cursor:'pointer',color:'#94A3B8',fontSize:14 }}>x</button>
                                </div>
                              ))}
                              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                                <button onClick={() => setCompanyParams(p => ({ ...p, [svc]: [...params, { key: '', value: '' }] }))} style={btnSecondary}>+ Add param</button>
                                <button onClick={async () => {
                                  const valid = params.filter(r => r.key.trim() && r.value.trim())
                                  await Promise.all(valid.map(r => saveCompanyParam(team,env,selectedCode,svc,r.key.trim(),r.value.trim())))
                                }} style={btnPrimary}>Save</button>
                              </div>
                            </div>
                          )}

                          {/* ── Test Payloads sub-tab ── */}
                          {svcSubTab === 'payloads' && (
                            <div>
                              {payloads.length === 0 ? (
                                <div style={{ fontSize: 12, color: '#94A3B8', marginBottom: 8 }}>No payloads yet for {svc}.</div>
                              ) : payloads.map(p => (
                                <div key={p.name} style={{ marginBottom: 10, padding: 10, background: '#F8FAFC', borderRadius: 8, border: '1px solid #E2E8F0' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                                    <span style={{ fontSize: 13, fontWeight: 600, color: '#7C3AED', fontFamily: 'monospace' }}>{p.name}</span>
                                    <button onClick={async () => { await deletePayload(team,env,selectedCode,svc,p.name); fetchCompanyData(selectedCode) }}
                                      style={{ background:'none',border:'none',cursor:'pointer',color:'#94A3B8',fontSize:14 }}>x</button>
                                  </div>
                                  <textarea value={p.body} rows={3}
                                    onChange={e => setCompanyPayloads(prev => ({ ...prev, [svc]: (prev[svc]||[]).map(d => d.name===p.name ? { ...d, body: e.target.value } : d) }))}
                                    style={{ width: '100%', fontFamily: 'monospace', fontSize: 11, padding: 8, border: '1px solid #E2E8F0', borderRadius: 6, background: 'white', resize: 'vertical', boxSizing: 'border-box' }} />
                                  <button onClick={async () => await savePayload(team,env,selectedCode,svc,p.name,p.body)}
                                    style={{ marginTop: 4, padding: '3px 10px', fontSize: 11, background: '#7C3AED', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>Save</button>
                                </div>
                              ))}
                              <button onClick={() => { setPayloadModalSvc(svc); setShowAddPayloadModal(true) }} style={btnSecondary}>+ Add Payload</button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ══ TEST ACCOUNTS TAB ══════════════════════════════════════════ */}
        {tab === 'accounts' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#64748B' }}>
                {acctLoading ? 'Loading...' : `${accounts.length} account${accounts.length !== 1 ? 's' : ''}`}
              </div>
              <button onClick={() => setShowAddAcctModal(true)} style={btnPrimary}>+ Add Account</button>
            </div>
            {accounts.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: '#94A3B8', fontSize: 13 }}>No test accounts yet.</div>
            ) : accounts.map(acc => (
              <div key={acc.id} style={{ ...card, display: 'flex', alignItems: 'center', gap: 16, marginBottom: 8 }}>
                <div style={{ width: 36, height: 36, borderRadius: 8, background: '#EDE9FE', border: '1px solid #DDD6FE', color: '#6D28D9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
                  {acc.name.split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2)}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#0F172A' }}>{acc.name}</div>
                  <div style={{ fontSize: 12, color: '#94A3B8', fontFamily: 'monospace' }}>{acc.code}</div>
                </div>
                <button onClick={() => { if (confirm('Delete?')) { deleteAccount(env,acc.id); setAccounts(p=>p.filter(a=>a.id!==acc.id)) } }}
                  style={{ background:'none',border:'none',cursor:'pointer',color:'#94A3B8',fontSize:16 }}>x</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Modals ──────────────────────────────────────────────────────── */}

      {showRegisterModal && <Modal title="Register Service" onClose={() => setShowRegisterModal(false)}>
        {(close) => {
          const [name, setName] = useState('')
          return (<div>
            <label style={{ display:'block',fontSize:13,fontWeight:500,color:'#64748B',marginBottom:4 }}>Service Name</label>
            <input style={{ ...inp, width: '100%', boxSizing: 'border-box' }} placeholder="e.g. user-api, order-api" autoFocus value={name}
              onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key==='Enter'&&name.trim()) { setSvcRows(p=>({...p,[name.trim().toLowerCase()]:[{key:'',value:''}]})); close() } }} />
            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={close} style={btnSecondary}>Cancel</button>
              <button onClick={() => { if (name.trim()) { setSvcRows(p=>({...p,[name.trim().toLowerCase()]:[{key:'',value:''}]})); close() } }} style={btnPrimary}>Register</button>
            </div>
          </div>)
        }}
      </Modal>}

      {showAddCodeModal && <Modal title="Add Company Code" onClose={() => setShowAddCodeModal(false)}>
        {(close) => {
          const [code, setCode] = useState('')
          return (<div>
            <label style={{ display:'block',fontSize:13,fontWeight:500,color:'#64748B',marginBottom:4 }}>Company Code</label>
            <input style={{ ...inp, width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', textTransform: 'uppercase' }} placeholder="e.g. ACME, GLOBEX" autoFocus value={code}
              onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g,''))}
              onKeyDown={e => { if (e.key==='Enter'&&code.trim()) { registerCompanyCode(team,env,code.trim()).then(()=>{fetchCompanyCodes();setSelectedCode(code.trim());close()}) } }} />
            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={close} style={btnSecondary}>Cancel</button>
              <button onClick={() => { if (code.trim()) registerCompanyCode(team,env,code.trim()).then(()=>{fetchCompanyCodes();setSelectedCode(code.trim());close()}) }} style={btnPrimary}>Add</button>
            </div>
          </div>)
        }}
      </Modal>}

      {showAddPayloadModal && <Modal title={`Add Payload — ${payloadModalSvc}`} onClose={() => setShowAddPayloadModal(false)}>
        {(close) => {
          const [name, setName] = useState('')
          const [body, setBody] = useState('{\n  \n}')
          return (<div>
            <label style={{ display:'block',fontSize:13,fontWeight:500,color:'#64748B',marginBottom:4 }}>Payload Name</label>
            <input style={{ ...inp, width: '100%', boxSizing: 'border-box', fontFamily: 'monospace' }} placeholder="e.g. create_user" value={name}
              onChange={e => setName(e.target.value.toLowerCase().replace(/\s+/g,'_'))} />
            <label style={{ display:'block',fontSize:13,fontWeight:500,color:'#64748B',marginBottom:4,marginTop:12 }}>JSON Body</label>
            <textarea style={{ ...inp, width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 12, height: 120, resize: 'vertical' }} value={body}
              onChange={e => setBody(e.target.value)} />
            <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>Use {'{param.KEY}'} for company-specific values.</div>
            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={close} style={btnSecondary}>Cancel</button>
              <button onClick={async () => { if (name.trim()) { await savePayload(team,env,selectedCode,payloadModalSvc,name.trim(),body); fetchCompanyData(selectedCode); close() } }} style={btnPrimary}>Save Payload</button>
            </div>
          </div>)
        }}
      </Modal>}

      {showAddAcctModal && <Modal title={`Add Test Account · ${env.toUpperCase()}`} onClose={() => setShowAddAcctModal(false)}>
        {(close) => {
          const [name, setName] = useState('')
          const [code, setCode] = useState('')
          return (<div>
            <label style={{ display:'block',fontSize:13,fontWeight:500,color:'#64748B',marginBottom:4 }}>Name</label>
            <input style={{ ...inp, width: '100%', boxSizing: 'border-box' }} placeholder="Acme Corp" autoFocus value={name} onChange={e => setName(e.target.value)} />
            <label style={{ display:'block',fontSize:13,fontWeight:500,color:'#64748B',marginBottom:4,marginTop:12 }}>Code</label>
            <input style={{ ...inp, width: '100%', boxSizing: 'border-box', fontFamily: 'monospace' }} placeholder="ACME001" value={code} onChange={e => setCode(e.target.value.toUpperCase())} />
            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={close} style={btnSecondary}>Cancel</button>
              <button onClick={async () => { if (name.trim()&&code.trim()) { await saveAccount(env,Date.now().toString(36),name.trim(),code.trim()); fetchAccounts(); close() } }} style={btnPrimary}>Save</button>
            </div>
          </div>)
        }}
      </Modal>}
    </div>
  )
}

// ── Generic Modal ────────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: (close: () => void) => React.ReactNode }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={onClose}>
      <div style={{ background: 'white', border: '1px solid #E8EBF0', borderRadius: 16, padding: 28, width: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A' }}>{title}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: 20, lineHeight: 1, padding: 0 }}>x</button>
        </div>
        {children(onClose)}
      </div>
    </div>
  )
}
