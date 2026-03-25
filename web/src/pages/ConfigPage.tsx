import { useState, useEffect, useCallback } from 'react'
import { fetchAuthSession } from '@aws-amplify/auth'
import { SSMClient, GetParametersByPathCommand, PutParameterCommand, DeleteParameterCommand } from '@aws-sdk/client-ssm'

const AWS_REGION = import.meta.env.VITE_AWS_REGION as string
const SSM_PREFIX = '/prompt2test/config'

const ENVS = ['dev', 'qa', 'uat', 'prod'] as const
type Env = typeof ENVS[number]

const BASE_FIELDS = [
  { key: 'BASE_URL',        label: 'API Base URL',         placeholder: 'https://api.dev.company.com' },
  { key: 'OAUTH_TOKEN_URL', label: 'OAuth Token URL',      placeholder: 'https://auth.dev.company.com/token' },
  { key: 'DEFAULT_TIMEOUT', label: 'Default Timeout (ms)', placeholder: '5000' },
  { key: 'RETRY_ATTEMPTS',  label: 'Retry Attempts',       placeholder: '3' },
]

const SERVICES = ['Billing', 'Payment', 'Auth', 'User', 'Notification']

type Account = { id: string; name: string; code: string }

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
      const key = p.Name!.replace(path + '/', '')
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
  const [env, setEnv] = useState<Env>('dev')
  const [tab, setTab] = useState<'base' | 'services' | 'accounts'>('base')

  // Base config
  const [baseValues, setBaseValues]   = useState<Record<string, string>>({})
  const [baseLoading, setBaseLoading] = useState(false)
  const [baseSaving, setBaseSaving]   = useState(false)
  const [baseStatus, setBaseStatus]   = useState<{ type: 'idle' | 'saved' | 'error'; msg?: string }>({ type: 'idle' })

  // Services
  const [svcValues, setSvcValues]   = useState<Record<string, Record<string, string>>>({})
  const [svcSaving, setSvcSaving]   = useState<Record<string, boolean>>({})
  const [svcStatus, setSvcStatus]   = useState<Record<string, { type: 'idle' | 'saved' | 'error'; msg?: string }>>({})

  // Accounts
  const [accounts, setAccounts]         = useState<Account[]>([])
  const [acctLoading, setAcctLoading]   = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)

  // ── Load helpers ──────────────────────────────────────────────────────────

  const loadBase = useCallback(async () => {
    setBaseLoading(true)
    setBaseStatus({ type: 'idle' })
    try {
      setBaseValues(await loadParamsForPath(`${SSM_PREFIX}/${env}/base`))
    } catch (e) { console.error('Load base config failed:', e) }
    finally { setBaseLoading(false) }
  }, [env])

  const loadServices = useCallback(async () => {
    try {
      const newVals: Record<string, Record<string, string>> = {}
      await Promise.all(SERVICES.map(async svc => {
        newVals[svc] = await loadParamsForPath(`${SSM_PREFIX}/${env}/services/${svc.toLowerCase()}`)
      }))
      setSvcValues(newVals)
    } catch (e) { console.error('Load services failed:', e) }
  }, [env])

  const loadAccounts = useCallback(async () => {
    setAcctLoading(true)
    try {
      // All account params: /prompt2test/config/accounts/{id}/{FIELD}
      const flat = await loadParamsForPath(`${SSM_PREFIX}/accounts`, true)
      // flat keys look like: "{id}/NAME", "{id}/EMAIL", etc.
      const map: Record<string, Record<string, string>> = {}
      for (const [k, v] of Object.entries(flat)) {
        const [id, field] = k.split('/')
        if (!id || !field) continue
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
  }, [])

  useEffect(() => {
    if (tab === 'base')     loadBase()
    if (tab === 'services') loadServices()
    if (tab === 'accounts') loadAccounts()
  }, [env, tab, loadBase, loadServices, loadAccounts])

  // ── Save handlers ─────────────────────────────────────────────────────────

  async function saveBase() {
    setBaseSaving(true)
    setBaseStatus({ type: 'idle' })
    try {
      const toSave = BASE_FIELDS.filter(f => (baseValues[f.key] ?? '').trim())
      if (!toSave.length) { setBaseStatus({ type: 'error', msg: 'Enter at least one value to save' }); return }
      await Promise.all(toSave.map(f => saveParam(`${SSM_PREFIX}/${env}/base/${f.key}`, baseValues[f.key].trim())))
      setBaseStatus({ type: 'saved' })
      setTimeout(() => setBaseStatus({ type: 'idle' }), 3000)
    } catch (e: unknown) {
      setBaseStatus({ type: 'error', msg: e instanceof Error ? e.message : String(e) })
    } finally { setBaseSaving(false) }
  }

  async function saveService(svc: string) {
    setSvcSaving(p => ({ ...p, [svc]: true }))
    setSvcStatus(p => ({ ...p, [svc]: { type: 'idle' } }))
    try {
      const vals = svcValues[svc] ?? {}
      const toSave: [string, string][] = []
      if ((vals['URL'] ?? '').trim())         toSave.push([`${SSM_PREFIX}/${env}/services/${svc.toLowerCase()}/URL`, vals['URL'].trim()])
      if ((vals['SWAGGER_URL'] ?? '').trim()) toSave.push([`${SSM_PREFIX}/${env}/services/${svc.toLowerCase()}/SWAGGER_URL`, vals['SWAGGER_URL'].trim()])
      if (!toSave.length) { setSvcStatus(p => ({ ...p, [svc]: { type: 'error', msg: 'Enter at least one value' } })); return }
      await Promise.all(toSave.map(([n, v]) => saveParam(n, v)))
      setSvcStatus(p => ({ ...p, [svc]: { type: 'saved' } }))
      setTimeout(() => setSvcStatus(p => ({ ...p, [svc]: { type: 'idle' } })), 3000)
    } catch (e: unknown) {
      setSvcStatus(p => ({ ...p, [svc]: { type: 'error', msg: e instanceof Error ? e.message : String(e) } }))
    } finally { setSvcSaving(p => ({ ...p, [svc]: false })) }
  }

  async function deleteAccount(id: string) {
    try {
      await Promise.all(['NAME', 'CODE'].map(f =>
        deleteParam(`${SSM_PREFIX}/accounts/${id}/${f}`).catch(() => {/* ignore missing */})
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
              env === e ? 'text-[#7C3AED] bg-[#F5F3FF] border-[#7C3AED]' : 'text-slate-400 bg-white border-slate-200 hover:text-slate-600'
            }`}
          >{e.toUpperCase()}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {/* Sub tabs */}
        <div className="flex gap-1 mb-5 border-b border-slate-200">
          {(['base', 'services', 'accounts'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-[14px] font-medium cursor-pointer border-b-2 -mb-px transition-colors ${
                tab === t ? 'text-[#7C3AED] border-[#7C3AED]' : 'text-slate-400 border-transparent hover:text-slate-600'
              }`}
            >{t === 'base' ? 'Base Config' : t === 'services' ? 'Services' : 'Test Accounts'}</button>
          ))}
        </div>

        {/* ── Base Config ───────────────────────────────────────────────── */}
        {tab === 'base' && (
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5">
            <div className="text-[16px] font-bold text-slate-900 mb-1">Base Config — {env.toUpperCase()}</div>
            <div className="text-[12px] text-slate-400 mb-4">Saved to <code className="bg-slate-100 px-1 rounded">/prompt2test/config/{env}/base/*</code></div>
            {baseLoading ? (
              <div className="text-[13px] text-slate-400 py-6 text-center">Loading from SSM…</div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                {BASE_FIELDS.map(f => (
                  <div key={f.key}>
                    <label className="block text-[13px] font-medium text-slate-600 mb-1">{f.label}</label>
                    <input
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[14px] text-slate-700 outline-none focus:border-[#7C3AED] transition-colors"
                      placeholder={f.placeholder}
                      value={baseValues[f.key] ?? ''}
                      onChange={e => setBaseValues(p => ({ ...p, [f.key]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
            )}
            <div className="mt-5 flex items-center gap-3">
              <button onClick={saveBase} disabled={baseSaving || baseLoading}
                className="px-4 py-2 bg-[#7C3AED] text-white rounded-lg text-[14px] font-medium cursor-pointer hover:bg-[#5B21B6] disabled:opacity-50 disabled:cursor-not-allowed">
                {baseSaving ? 'Saving…' : 'Save to SSM'}
              </button>
              {baseStatus.type === 'saved' && <span className="text-[13px] text-green-600 font-medium">✓ Saved</span>}
              {baseStatus.type === 'error' && <span className="text-[13px] text-red-500 font-medium">✗ {baseStatus.msg}</span>}
            </div>
          </div>
        )}

        {/* ── Services ──────────────────────────────────────────────────── */}
        {tab === 'services' && (
          <div className="space-y-3">
            {SERVICES.map(svc => (
              <div key={svc} className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[15px] font-bold text-slate-900">{svc}</div>
                  <span className="text-[11px] text-slate-400 font-mono">/…/services/{svc.toLowerCase()}/*</span>
                </div>
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <label className="block text-[12px] font-medium text-slate-500 mb-1">Service URL</label>
                    <input className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-[13px] outline-none focus:border-[#7C3AED]"
                      placeholder={`https://${svc.toLowerCase()}.${env}.company.com`}
                      value={svcValues[svc]?.['URL'] ?? ''}
                      onChange={e => setSvcValues(p => ({ ...p, [svc]: { ...p[svc], URL: e.target.value } }))} />
                  </div>
                  <div>
                    <label className="block text-[12px] font-medium text-slate-500 mb-1">Swagger URL</label>
                    <input className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-[13px] outline-none focus:border-[#7C3AED]"
                      placeholder={`https://${svc.toLowerCase()}.${env}.company.com/openapi.json`}
                      value={svcValues[svc]?.['SWAGGER_URL'] ?? ''}
                      onChange={e => setSvcValues(p => ({ ...p, [svc]: { ...p[svc], SWAGGER_URL: e.target.value } }))} />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button onClick={() => saveService(svc)} disabled={svcSaving[svc]}
                    className="px-3 py-1.5 bg-[#7C3AED] text-white rounded-lg text-[13px] font-medium cursor-pointer hover:bg-[#5B21B6] disabled:opacity-50 disabled:cursor-not-allowed">
                    {svcSaving[svc] ? 'Saving…' : 'Save'}
                  </button>
                  {svcStatus[svc]?.type === 'saved' && <span className="text-[12px] text-green-600 font-medium">✓ Saved</span>}
                  {svcStatus[svc]?.type === 'error' && <span className="text-[12px] text-red-500 font-medium">✗ {svcStatus[svc].msg}</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Test Accounts ─────────────────────────────────────────────── */}
        {tab === 'accounts' && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="text-[14px] font-semibold text-slate-600">
                {accounts.length} test account{accounts.length !== 1 ? 's' : ''}
              </div>
              <button onClick={() => setShowAddModal(true)}
                className="px-3 py-1.5 bg-[#7C3AED] text-white rounded-lg text-[13px] font-medium cursor-pointer hover:bg-[#5B21B6]">
                + Add account
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
                      className="ml-2 text-slate-300 hover:text-red-400 transition-colors cursor-pointer text-[16px]" title="Delete">
                      ×
                    </button>
                  </div>
                ))}
                {accounts.length === 0 && !acctLoading && (
                  <div className="text-center py-10 text-slate-400 text-[13px]">
                    No test accounts yet. Click <strong>+ Add account</strong> to add one.
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Add Account Modal ─────────────────────────────────────────────── */}
      {showAddModal && (
        <AddAccountModal
          onClose={() => setShowAddModal(false)}
          onSaved={() => { setShowAddModal(false); loadAccounts() }}
        />
      )}
    </div>
  )
}

// ── Add Account Modal ──────────────────────────────────────────────────────

function AddAccountModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name,   setName]   = useState('')
  const [code,   setCode]   = useState('')
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  async function handleSave() {
    if (!name.trim() || !code.trim()) {
      setError('Name and code are required')
      return
    }
    setSaving(true)
    setError('')
    try {
      const id = Date.now().toString(36)
      const base = `${SSM_PREFIX}/accounts/${id}`
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
          <div className="text-[16px] font-bold text-slate-900">Add Test Account</div>
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
          <button onClick={onClose} className="px-4 py-2 border border-slate-200 rounded-lg text-[14px] text-slate-600 cursor-pointer hover:bg-slate-50">
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
