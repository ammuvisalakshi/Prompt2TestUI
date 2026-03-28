import { useState, useEffect, useCallback } from 'react'
import { fetchAuthSession } from '@aws-amplify/auth'
import { SSMClient, GetParametersByPathCommand, PutParameterCommand, DeleteParameterCommand } from '@aws-sdk/client-ssm'
import { useEnv } from '../context/EnvContext'

const AWS_REGION = import.meta.env.VITE_AWS_REGION as string
const SSM_PREFIX = '/prompt2test/config'

type ParamRow = { key: string; value: string }
type Account  = { id: string; name: string; code: string }

// ── SSM helpers ────────────────────────────────────────────────────────────

async function getSSMClient() {
  const session = await fetchAuthSession()
  return new SSMClient({ region: AWS_REGION, credentials: session.credentials })
}

async function loadParamsForPath(path: string, recursive = false): Promise<Record<string, string>> {
  const client = await getSSMClient()
  const result: Record<string, string> = {}
  let nextToken: string | undefined
  do {
    const cmd = new GetParametersByPathCommand({ Path: path, Recursive: recursive, NextToken: nextToken })
    const resp = await client.send(cmd)
    for (const p of resp.Parameters ?? []) {
      const key = p.Name!.slice(path.length + 1)
      result[key] = p.Value ?? ''
    }
    nextToken = resp.NextToken
  } while (nextToken)
  return result
}

async function saveParam(name: string, value: string) {
  const client = await getSSMClient()
  await client.send(new PutParameterCommand({ Name: name, Value: value, Type: 'String', Overwrite: true }))
}

async function deleteParam(name: string) {
  const client = await getSSMClient()
  await client.send(new DeleteParameterCommand({ Name: name }))
}

// ── Component ──────────────────────────────────────────────────────────────

export default function ConfigPage() {
  const { env } = useEnv()
  const [tab, setTab] = useState<'services' | 'accounts'>('services')

  const [svcRows,   setSvcRows]   = useState<Record<string, ParamRow[]>>({})
  const [svcLoading, setSvcLoading] = useState(false)
  const [svcSaving,  setSvcSaving]  = useState<Record<string, boolean>>({})
  const [svcStatus,  setSvcStatus]  = useState<Record<string, { type: 'idle' | 'saved' | 'error'; msg?: string }>>({})
  const [showRegisterModal, setShowRegisterModal] = useState(false)

  const [accounts,    setAccounts]    = useState<Account[]>([])
  const [acctLoading, setAcctLoading] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)

  const loadServices = useCallback(async () => {
    setSvcLoading(true)
    try {
      const flat = await loadParamsForPath(`${SSM_PREFIX}/${env}/services`, true)
      const map: Record<string, Record<string, string>> = {}
      for (const [k, v] of Object.entries(flat)) {
        const slash = k.indexOf('/')
        if (slash < 0) continue
        const svc   = k.slice(0, slash)
        const field = k.slice(slash + 1)
        if (!map[svc]) map[svc] = {}
        map[svc][field] = v
      }
      const rows: Record<string, ParamRow[]> = {}
      for (const [svc, fields] of Object.entries(map)) {
        rows[svc] = Object.entries(fields).map(([key, value]) => ({ key, value }))
      }
      setSvcRows(rows)
    } catch (e) { console.error('Load services failed:', e) }
    finally { setSvcLoading(false) }
  }, [env])

  const loadAccounts = useCallback(async () => {
    setAcctLoading(true)
    try {
      const flat = await loadParamsForPath(`${SSM_PREFIX}/accounts/${env}`, true)
      const map: Record<string, Record<string, string>> = {}
      for (const [k, v] of Object.entries(flat)) {
        const slash = k.indexOf('/')
        if (slash < 0) continue
        const id    = k.slice(0, slash)
        const field = k.slice(slash + 1)
        if (!map[id]) map[id] = {}
        map[id][field] = v
      }
      const list: Account[] = Object.entries(map).map(([id, fields]) => ({
        id,
        name: fields['NAME'] ?? '',
        code: fields['CODE'] ?? '',
      }))
      setAccounts(list)
    } catch (e) { console.error('Load accounts failed:', e) }
    finally { setAcctLoading(false) }
  }, [env])

  useEffect(() => {
    if (tab === 'services') loadServices()
    if (tab === 'accounts') loadAccounts()
  }, [env, tab, loadServices, loadAccounts])

  async function saveService(svc: string) {
    setSvcSaving(p => ({ ...p, [svc]: true }))
    setSvcStatus(p => ({ ...p, [svc]: { type: 'idle' } }))
    try {
      const rows = svcRows[svc] ?? []
      const toSave = rows.filter(r => r.key.trim() && r.value.trim())
      if (!toSave.length) {
        setSvcStatus(p => ({ ...p, [svc]: { type: 'error', msg: 'Add at least one parameter with key and value' } }))
        return
      }
      await Promise.all(toSave.map(r =>
        saveParam(`${SSM_PREFIX}/${env}/services/${svc}/${r.key.trim().toUpperCase()}`, r.value.trim())
      ))
      setSvcStatus(p => ({ ...p, [svc]: { type: 'saved' } }))
      setTimeout(() => setSvcStatus(p => ({ ...p, [svc]: { type: 'idle' } })), 3000)
    } catch (e: unknown) {
      setSvcStatus(p => ({ ...p, [svc]: { type: 'error', msg: e instanceof Error ? e.message : String(e) } }))
    } finally {
      setSvcSaving(p => ({ ...p, [svc]: false }))
    }
  }

  async function deleteService(svc: string) {
    if (!confirm(`Delete service "${svc}" and all its parameters?`)) return
    try {
      const rows = svcRows[svc] ?? []
      await Promise.all(rows.map(r =>
        deleteParam(`${SSM_PREFIX}/${env}/services/${svc}/${r.key.trim().toUpperCase()}`).catch(() => {})
      ))
      setSvcRows(p => { const next = { ...p }; delete next[svc]; return next })
    } catch (e) { console.error('Delete service failed:', e) }
  }

  async function deleteAccount(id: string) {
    if (!confirm('Delete this test account?')) return
    try {
      await Promise.all(['NAME', 'CODE'].map(f =>
        deleteParam(`${SSM_PREFIX}/accounts/${env}/${id}/${f}`).catch(() => {})
      ))
      setAccounts(prev => prev.filter(a => a.id !== id))
    } catch (e) { console.error('Delete account failed:', e) }
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 20, background: 'transparent' }}>
      {/* Sub tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        {(['services', 'accounts'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              padding: '8px 16px', fontSize: 14, fontWeight: 500, cursor: 'pointer',
              background: 'none', border: 'none', borderBottom: `2px solid ${tab === t ? '#A855F7' : 'transparent'}`,
              color: tab === t ? '#C084FC' : 'rgba(255,255,255,0.35)',
              marginBottom: -1, transition: 'all 0.15s',
            }}>
            {t === 'services' ? 'Services' : 'Test Accounts'}
          </button>
        ))}
      </div>

      {/* ── Services ──────────────────────────────────────────────────── */}
      {tab === 'services' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.6)' }}>
              {svcLoading ? 'Loading…' : `${Object.keys(svcRows).length} service${Object.keys(svcRows).length !== 1 ? 's' : ''} · ${env.toUpperCase()}`}
            </div>
            <button onClick={() => setShowRegisterModal(true)}
              style={{ padding: '6px 14px', background: '#7C3AED', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer', boxShadow: '0 0 12px rgba(139,92,246,0.3)' }}>
              + Register Service
            </button>
          </div>

          {svcLoading ? (
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.3)', padding: '24px 0', textAlign: 'center' }}>Loading from SSM…</div>
          ) : Object.keys(svcRows).length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'rgba(255,255,255,0.3)', fontSize: 13 }}>
              No services registered for {env.toUpperCase()} yet.{' '}
              Click <strong style={{ color: 'rgba(255,255,255,0.5)' }}>+ Register Service</strong> to add one.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {Object.keys(svcRows).sort().map(svc => (
                <ServiceCard
                  key={svc}
                  svc={svc}
                  env={env}
                  rows={svcRows[svc]}
                  saving={svcSaving[svc] ?? false}
                  status={svcStatus[svc] ?? { type: 'idle' }}
                  onChange={rows => setSvcRows(p => ({ ...p, [svc]: rows }))}
                  onSave={() => saveService(svc)}
                  onDelete={() => deleteService(svc)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Test Accounts ─────────────────────────────────────────────── */}
      {tab === 'accounts' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.6)' }}>
              {acctLoading ? 'Loading…' : `${accounts.length} account${accounts.length !== 1 ? 's' : ''} · ${env.toUpperCase()}`}
            </div>
            <button onClick={() => setShowAddModal(true)}
              style={{ padding: '6px 14px', background: '#7C3AED', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer', boxShadow: '0 0 12px rgba(139,92,246,0.3)' }}>
              + Add Account
            </button>
          </div>

          {acctLoading ? (
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.3)', padding: '24px 0', textAlign: 'center' }}>Loading from SSM…</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {accounts.map(acc => (
                <div key={acc.id} style={{ background: 'rgba(255,255,255,0.04)', backdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: 16, display: 'flex', alignItems: 'center', gap: 16 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 8, background: 'rgba(139,92,246,0.25)', border: '1px solid rgba(139,92,246,0.4)', color: '#C084FC', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
                    {acc.name.split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>{acc.name}</div>
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', fontFamily: 'monospace' }}>{acc.code}</div>
                  </div>
                  <button onClick={() => deleteAccount(acc.id)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.2)', fontSize: 16, lineHeight: 1, padding: 0 }}
                    title="Delete"
                    onMouseEnter={e => (e.currentTarget.style.color = '#F87171')}
                    onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.2)')}>
                    ×
                  </button>
                </div>
              ))}
              {accounts.length === 0 && !acctLoading && (
                <div style={{ textAlign: 'center', padding: '40px 0', color: 'rgba(255,255,255,0.3)', fontSize: 13 }}>
                  No test accounts for {env.toUpperCase()} yet.{' '}
                  Click <strong style={{ color: 'rgba(255,255,255,0.5)' }}>+ Add Account</strong> to add one.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {showRegisterModal && (
        <RegisterServiceModal
          existingNames={Object.keys(svcRows)}
          onClose={() => setShowRegisterModal(false)}
          onRegister={name => {
            setSvcRows(p => ({ ...p, [name]: [{ key: '', value: '' }] }))
            setShowRegisterModal(false)
          }}
        />
      )}

      {showAddModal && (
        <AddAccountModal
          env={env}
          onClose={() => setShowAddModal(false)}
          onSaved={() => { setShowAddModal(false); loadAccounts() }}
        />
      )}
    </div>
  )
}

// ── Service Card ───────────────────────────────────────────────────────────

function ServiceCard({
  svc, env, rows, saving, status, onChange, onSave, onDelete,
}: {
  svc: string
  env: string
  rows: ParamRow[]
  saving: boolean
  status: { type: 'idle' | 'saved' | 'error'; msg?: string }
  onChange: (rows: ParamRow[]) => void
  onSave: () => void
  onDelete: () => void
}) {
  const inputStyle: React.CSSProperties = {
    padding: '6px 12px', background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8,
    fontSize: 13, color: 'white', outline: 'none',
  }

  function updateRow(i: number, field: 'key' | 'value', val: string) {
    onChange(rows.map((r, idx) => idx === i ? { ...r, [field]: val } : r))
  }

  return (
    <div style={{ background: 'rgba(255,255,255,0.04)', backdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'rgba(255,255,255,0.85)', textTransform: 'capitalize' }}>{svc}</div>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)', fontFamily: 'monospace' }}>/…/{env}/services/{svc}/*</span>
        </div>
        <button onClick={onDelete}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.2)', fontSize: 18, lineHeight: 1, padding: 0 }}
          title="Delete service"
          onMouseEnter={e => (e.currentTarget.style.color = '#F87171')}
          onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.2)')}>
          ×
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
        {rows.map((row, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              style={{ ...inputStyle, width: 180, flexShrink: 0, fontFamily: 'monospace' }}
              placeholder="PARAM_KEY"
              value={row.key}
              onChange={e => updateRow(i, 'key', e.target.value.toUpperCase().replace(/\s+/g, '_'))}
            />
            <input
              style={{ ...inputStyle, flex: 1 }}
              placeholder="value"
              value={row.value}
              onChange={e => updateRow(i, 'value', e.target.value)}
            />
            <button onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.2)', fontSize: 16, flexShrink: 0, lineHeight: 1, padding: 0 }}
              onMouseEnter={e => (e.currentTarget.style.color = '#F87171')}
              onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.2)')}>
              ×
            </button>
          </div>
        ))}
        {rows.length === 0 && (
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)', fontStyle: 'italic' }}>No parameters yet — click + Add param below.</div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={() => onChange([...rows, { key: '', value: '' }])}
          style={{ padding: '6px 12px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 13, color: 'rgba(255,255,255,0.5)', cursor: 'pointer' }}>
          + Add param
        </button>
        <button onClick={onSave} disabled={saving}
          style={{ padding: '6px 12px', background: '#7C3AED', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1 }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {status.type === 'saved' && <span style={{ fontSize: 12, color: '#6EE7B7', fontWeight: 500 }}>✓ Saved</span>}
        {status.type === 'error' && <span style={{ fontSize: 12, color: '#F87171', fontWeight: 500 }}>✗ {status.msg}</span>}
      </div>
    </div>
  )
}

// ── Register Service Modal ─────────────────────────────────────────────────

function RegisterServiceModal({
  existingNames, onClose, onRegister,
}: {
  existingNames: string[]
  onClose: () => void
  onRegister: (name: string) => void
}) {
  const [name,  setName]  = useState('')
  const [error, setError] = useState('')

  function handleRegister() {
    const n = name.trim().toLowerCase()
    if (!n) { setError('Service name is required'); return }
    if (existingNames.includes(n)) { setError('Service already exists'); return }
    onRegister(n)
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px',
    background: 'rgba(255,255,255,0.07)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 8, fontSize: 14, color: 'white', outline: 'none',
    boxSizing: 'border-box',
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={onClose}>
      <div style={{ background: 'rgba(20,10,50,0.95)', backdropFilter: 'blur(24px)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 16, padding: 28, width: 380, boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'white' }}>Register Service</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', fontSize: 20, lineHeight: 1, padding: 0 }}>×</button>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>Service Name</label>
          <input
            style={inputStyle}
            placeholder="e.g. billing, payment, auth"
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleRegister()}
          />
          {error && <div style={{ marginTop: 8, fontSize: 12, color: '#F87171' }}>✗ {error}</div>}
          <div style={{ marginTop: 8, fontSize: 11, color: 'rgba(255,255,255,0.25)' }}>Parameters can be added after registering.</div>
        </div>
        <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <button onClick={onClose}
            style={{ padding: '8px 16px', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 14, color: 'rgba(255,255,255,0.6)', cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={handleRegister}
            style={{ padding: '8px 16px', background: '#7C3AED', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
            Register
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Add Account Modal ──────────────────────────────────────────────────────

function AddAccountModal({ env, onClose, onSaved }: { env: string; onClose: () => void; onSaved: () => void }) {
  const [name,   setName]   = useState('')
  const [code,   setCode]   = useState('')
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  async function handleSave() {
    if (!name.trim() || !code.trim()) { setError('Name and code are required'); return }
    setSaving(true)
    setError('')
    try {
      const id   = Date.now().toString(36)
      const base = `${SSM_PREFIX}/accounts/${env}/${id}`
      await Promise.all([
        saveParam(`${base}/NAME`, name.trim()),
        saveParam(`${base}/CODE`, code.trim()),
      ])
      onSaved()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px',
    background: 'rgba(255,255,255,0.07)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 8, fontSize: 14, color: 'white', outline: 'none',
    boxSizing: 'border-box',
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={onClose}>
      <div style={{ background: 'rgba(20,10,50,0.95)', backdropFilter: 'blur(24px)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 16, padding: 28, width: 400, boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'white' }}>Add Test Account · {env.toUpperCase()}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', fontSize: 20, lineHeight: 1, padding: 0 }}>×</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>Name</label>
            <input style={inputStyle} placeholder="Acme Corp" autoFocus value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>Code</label>
            <input style={{ ...inputStyle, fontFamily: 'monospace' }} placeholder="ACME001" value={code} onChange={e => setCode(e.target.value.toUpperCase())} />
          </div>
        </div>
        {error && <div style={{ marginTop: 12, fontSize: 12, color: '#F87171' }}>✗ {error}</div>}
        <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <button onClick={onClose}
            style={{ padding: '8px 16px', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 14, color: 'rgba(255,255,255,0.6)', cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            style={{ padding: '8px 16px', background: '#7C3AED', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving…' : 'Save Account'}
          </button>
        </div>
      </div>
    </div>
  )
}
