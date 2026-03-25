import { useState, useEffect, useCallback } from 'react'
import { fetchAuthSession } from '@aws-amplify/auth'
import { SSMClient, GetParametersByPathCommand, PutParameterCommand, DeleteParameterCommand } from '@aws-sdk/client-ssm'

const AWS_REGION = import.meta.env.VITE_AWS_REGION as string
const SSM_PREFIX = '/prompt2test/config'

const ENVS = ['dev', 'qa', 'uat', 'prod'] as const
type Env = typeof ENVS[number]

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
  const [env, setEnv]   = useState<Env>('dev')
  const [tab, setTab]   = useState<'services' | 'accounts'>('services')

  // Services: svcName -> param rows
  const [svcRows, setSvcRows]   = useState<Record<string, ParamRow[]>>({})
  const [svcLoading, setSvcLoading] = useState(false)
  const [svcSaving,  setSvcSaving]  = useState<Record<string, boolean>>({})
  const [svcStatus,  setSvcStatus]  = useState<Record<string, { type: 'idle' | 'saved' | 'error'; msg?: string }>>({})
  const [showRegisterModal, setShowRegisterModal] = useState(false)

  // Accounts (per env)
  const [accounts,    setAccounts]    = useState<Account[]>([])
  const [acctLoading, setAcctLoading] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)

  // ── Loaders ───────────────────────────────────────────────────────────────

  const loadServices = useCallback(async () => {
    setSvcLoading(true)
    try {
      const flat = await loadParamsForPath(`${SSM_PREFIX}/${env}/services`, true)
      // keys: "{svcname}/{FIELD}"
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
      // keys: "{id}/NAME", "{id}/CODE"
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

  // ── Service actions ───────────────────────────────────────────────────────

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

  // ── Account actions ───────────────────────────────────────────────────────

  async function deleteAccount(id: string) {
    if (!confirm('Delete this test account?')) return
    try {
      await Promise.all(['NAME', 'CODE'].map(f =>
        deleteParam(`${SSM_PREFIX}/accounts/${env}/${id}/${f}`).catch(() => {})
      ))
      setAccounts(prev => prev.filter(a => a.id !== id))
    } catch (e) { console.error('Delete account failed:', e) }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#F5F7FA]">
      {/* Env tabs */}
      <div className="flex items-center gap-1 px-5 pt-4 pb-0 flex-shrink-0">
        {ENVS.map(e => (
          <button key={e} onClick={() => setEnv(e)}
            className={`px-4 py-1.5 rounded-t-lg text-[13px] font-semibold border border-b-0 cursor-pointer transition-colors ${
              env === e
                ? 'text-[#7C3AED] bg-[#F5F3FF] border-[#7C3AED]'
                : 'text-slate-400 bg-white border-slate-200 hover:text-slate-600'
            }`}
          >{e.toUpperCase()}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {/* Sub tabs */}
        <div className="flex gap-1 mb-5 border-b border-slate-200">
          {(['services', 'accounts'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-[14px] font-medium cursor-pointer border-b-2 -mb-px transition-colors ${
                tab === t ? 'text-[#7C3AED] border-[#7C3AED]' : 'text-slate-400 border-transparent hover:text-slate-600'
              }`}
            >{t === 'services' ? 'Services' : 'Test Accounts'}</button>
          ))}
        </div>

        {/* ── Services ──────────────────────────────────────────────────── */}
        {tab === 'services' && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="text-[14px] font-semibold text-slate-600">
                {svcLoading ? 'Loading…' : `${Object.keys(svcRows).length} service${Object.keys(svcRows).length !== 1 ? 's' : ''} · ${env.toUpperCase()}`}
              </div>
              <button onClick={() => setShowRegisterModal(true)}
                className="px-3 py-1.5 bg-[#7C3AED] text-white rounded-lg text-[13px] font-medium cursor-pointer hover:bg-[#5B21B6]">
                + Register Service
              </button>
            </div>

            {svcLoading ? (
              <div className="text-[13px] text-slate-400 py-6 text-center">Loading from SSM…</div>
            ) : Object.keys(svcRows).length === 0 ? (
              <div className="text-center py-10 text-slate-400 text-[13px]">
                No services registered for {env.toUpperCase()} yet.{' '}
                Click <strong>+ Register Service</strong> to add one.
              </div>
            ) : (
              <div className="space-y-3">
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
            <div className="flex items-center justify-between mb-4">
              <div className="text-[14px] font-semibold text-slate-600">
                {acctLoading ? 'Loading…' : `${accounts.length} account${accounts.length !== 1 ? 's' : ''} · ${env.toUpperCase()}`}
              </div>
              <button onClick={() => setShowAddModal(true)}
                className="px-3 py-1.5 bg-[#7C3AED] text-white rounded-lg text-[13px] font-medium cursor-pointer hover:bg-[#5B21B6]">
                + Add Account
              </button>
            </div>

            {acctLoading ? (
              <div className="text-[13px] text-slate-400 py-6 text-center">Loading from SSM…</div>
            ) : (
              <div className="space-y-3">
                {accounts.map(acc => (
                  <div key={acc.id} className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 flex items-center gap-4">
                    <div className="w-9 h-9 rounded-lg bg-[#EDE9FE] text-[#7C3AED] flex items-center justify-center text-[13px] font-bold flex-shrink-0">
                      {acc.name.split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[14px] font-semibold text-slate-900">{acc.name}</div>
                      <div className="text-[12px] text-slate-400 font-mono">{acc.code}</div>
                    </div>
                    <button onClick={() => deleteAccount(acc.id)}
                      className="text-slate-300 hover:text-red-400 transition-colors cursor-pointer text-[16px]" title="Delete">
                      ×
                    </button>
                  </div>
                ))}
                {accounts.length === 0 && !acctLoading && (
                  <div className="text-center py-10 text-slate-400 text-[13px]">
                    No test accounts for {env.toUpperCase()} yet.{' '}
                    Click <strong>+ Add Account</strong> to add one.
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

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
  function updateRow(i: number, field: 'key' | 'value', val: string) {
    onChange(rows.map((r, idx) => idx === i ? { ...r, [field]: val } : r))
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="text-[15px] font-bold text-slate-900 capitalize">{svc}</div>
          <span className="text-[11px] text-slate-400 font-mono">/…/{env}/services/{svc}/*</span>
        </div>
        <button onClick={onDelete}
          className="text-slate-300 hover:text-red-400 transition-colors cursor-pointer text-[18px] leading-none" title="Delete service">
          ×
        </button>
      </div>

      <div className="space-y-2 mb-3">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className="w-[180px] flex-shrink-0 px-3 py-1.5 border border-slate-200 rounded-lg text-[13px] font-mono outline-none focus:border-[#7C3AED]"
              placeholder="PARAM_KEY"
              value={row.key}
              onChange={e => updateRow(i, 'key', e.target.value.toUpperCase().replace(/\s+/g, '_'))}
            />
            <input
              className="flex-1 px-3 py-1.5 border border-slate-200 rounded-lg text-[13px] outline-none focus:border-[#7C3AED]"
              placeholder="value"
              value={row.value}
              onChange={e => updateRow(i, 'value', e.target.value)}
            />
            <button onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
              className="text-slate-300 hover:text-red-400 transition-colors cursor-pointer text-[16px] flex-shrink-0 leading-none">
              ×
            </button>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="text-[12px] text-slate-400 italic">No parameters yet — click + Add param below.</div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button onClick={() => onChange([...rows, { key: '', value: '' }])}
          className="px-3 py-1.5 border border-slate-200 rounded-lg text-[13px] text-slate-500 cursor-pointer hover:bg-slate-50">
          + Add param
        </button>
        <button onClick={onSave} disabled={saving}
          className="px-3 py-1.5 bg-[#7C3AED] text-white rounded-lg text-[13px] font-medium cursor-pointer hover:bg-[#5B21B6] disabled:opacity-50 disabled:cursor-not-allowed">
          {saving ? 'Saving…' : 'Save'}
        </button>
        {status.type === 'saved' && <span className="text-[12px] text-green-600 font-medium">✓ Saved</span>}
        {status.type === 'error' && <span className="text-[12px] text-red-500 font-medium">✗ {status.msg}</span>}
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

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-[380px] p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <div className="text-[16px] font-bold text-slate-900">Register Service</div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-[20px] cursor-pointer leading-none">×</button>
        </div>
        <div>
          <label className="block text-[13px] font-medium text-slate-600 mb-1">Service Name</label>
          <input
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[14px] outline-none focus:border-[#7C3AED]"
            placeholder="e.g. billing, payment, auth"
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleRegister()}
          />
          {error && <div className="mt-2 text-[12px] text-red-500">✗ {error}</div>}
          <div className="mt-2 text-[11px] text-slate-400">Parameters can be added after registering.</div>
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onClose}
            className="px-4 py-2 border border-slate-200 rounded-lg text-[14px] text-slate-600 cursor-pointer hover:bg-slate-50">
            Cancel
          </button>
          <button onClick={handleRegister}
            className="px-4 py-2 bg-[#7C3AED] text-white rounded-lg text-[14px] font-medium cursor-pointer hover:bg-[#5B21B6]">
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

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-[400px] p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <div className="text-[16px] font-bold text-slate-900">Add Test Account · {env.toUpperCase()}</div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-[20px] cursor-pointer leading-none">×</button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-[13px] font-medium text-slate-600 mb-1">Name</label>
            <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[14px] outline-none focus:border-[#7C3AED]"
              placeholder="Acme Corp" autoFocus value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-slate-600 mb-1">Code</label>
            <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[14px] outline-none focus:border-[#7C3AED] font-mono"
              placeholder="ACME001" value={code} onChange={e => setCode(e.target.value.toUpperCase())} />
          </div>
        </div>
        {error && <div className="mt-3 text-[12px] text-red-500">✗ {error}</div>}
        <div className="mt-5 flex justify-end gap-3">
          <button onClick={onClose}
            className="px-4 py-2 border border-slate-200 rounded-lg text-[14px] text-slate-600 cursor-pointer hover:bg-slate-50">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 bg-[#7C3AED] text-white rounded-lg text-[14px] font-medium cursor-pointer hover:bg-[#5B21B6] disabled:opacity-50 disabled:cursor-not-allowed">
            {saving ? 'Saving…' : 'Save Account'}
          </button>
        </div>
      </div>
    </div>
  )
}
