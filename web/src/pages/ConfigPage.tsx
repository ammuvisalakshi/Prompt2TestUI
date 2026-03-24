import { useState, useEffect, useCallback } from 'react'
import { fetchAuthSession } from '@aws-amplify/auth'
import { SSMClient, GetParametersByPathCommand, PutParameterCommand } from '@aws-sdk/client-ssm'

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

async function getSSMClient() {
  const session = await fetchAuthSession()
  return new SSMClient({ region: AWS_REGION, credentials: session.credentials })
}

async function loadParamsForPath(path: string): Promise<Record<string, string>> {
  const client = await getSSMClient()
  const result: Record<string, string> = {}
  let nextToken: string | undefined

  do {
    const cmd = new GetParametersByPathCommand({ Path: path, Recursive: false, NextToken: nextToken })
    const resp = await client.send(cmd)
    for (const p of resp.Parameters ?? []) {
      const key = p.Name!.split('/').pop()!
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

export default function ConfigPage() {
  const [env, setEnv] = useState<Env>('dev')
  const [tab, setTab] = useState<'base' | 'services'>('base')

  // Base config state
  const [baseValues, setBaseValues] = useState<Record<string, string>>({})
  const [baseLoading, setBaseLoading] = useState(false)
  const [baseSaving, setBaseSaving] = useState(false)
  const [baseStatus, setBaseStatus] = useState<'idle' | 'saved' | 'error'>('idle')

  // Services state — keyed by service name
  const [svcValues, setSvcValues] = useState<Record<string, Record<string, string>>>({})
  const [svcSaving, setSvcSaving] = useState<Record<string, boolean>>({})
  const [svcStatus, setSvcStatus] = useState<Record<string, 'idle' | 'saved' | 'error'>>({})

  const loadBase = useCallback(async () => {
    setBaseLoading(true)
    setBaseStatus('idle')
    try {
      const params = await loadParamsForPath(`${SSM_PREFIX}/${env}/base`)
      setBaseValues(params)
    } catch {
      setBaseValues({})
    } finally {
      setBaseLoading(false)
    }
  }, [env])

  const loadServices = useCallback(async () => {
    try {
      const newVals: Record<string, Record<string, string>> = {}
      await Promise.all(SERVICES.map(async svc => {
        newVals[svc] = await loadParamsForPath(`${SSM_PREFIX}/${env}/services/${svc.toLowerCase()}`)
      }))
      setSvcValues(newVals)
    } catch { /* ignore */ }
  }, [env])

  useEffect(() => {
    if (tab === 'base') loadBase()
    else loadServices()
  }, [env, tab, loadBase, loadServices])

  async function saveBase() {
    setBaseSaving(true)
    setBaseStatus('idle')
    try {
      await Promise.all(
        BASE_FIELDS.map(f =>
          saveParam(`${SSM_PREFIX}/${env}/base/${f.key}`, baseValues[f.key] ?? '')
        )
      )
      setBaseStatus('saved')
      setTimeout(() => setBaseStatus('idle'), 3000)
    } catch {
      setBaseStatus('error')
    } finally {
      setBaseSaving(false)
    }
  }

  async function saveService(svc: string) {
    setSvcSaving(p => ({ ...p, [svc]: true }))
    setSvcStatus(p => ({ ...p, [svc]: 'idle' }))
    try {
      const vals = svcValues[svc] ?? {}
      await Promise.all([
        saveParam(`${SSM_PREFIX}/${env}/services/${svc.toLowerCase()}/URL`, vals['URL'] ?? ''),
        saveParam(`${SSM_PREFIX}/${env}/services/${svc.toLowerCase()}/SWAGGER_URL`, vals['SWAGGER_URL'] ?? ''),
      ])
      setSvcStatus(p => ({ ...p, [svc]: 'saved' }))
      setTimeout(() => setSvcStatus(p => ({ ...p, [svc]: 'idle' })), 3000)
    } catch {
      setSvcStatus(p => ({ ...p, [svc]: 'error' }))
    } finally {
      setSvcSaving(p => ({ ...p, [svc]: false }))
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#F5F7FA]">
      {/* Env tabs */}
      <div className="flex items-center gap-1 px-5 pt-4 pb-0 flex-shrink-0">
        {ENVS.map(e => (
          <button
            key={e}
            onClick={() => setEnv(e)}
            className={`px-4 py-1.5 rounded-t-lg text-[13px] font-semibold border border-b-0 cursor-pointer transition-colors ${
              env === e
                ? 'text-[#7C3AED] bg-[#F5F3FF] border-[#7C3AED]'
                : 'text-slate-400 bg-white border-slate-200 hover:text-slate-600'
            }`}
          >
            {e.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {/* Sub tabs */}
        <div className="flex gap-1 mb-5 border-b border-slate-200">
          {(['base', 'services'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-[14px] font-medium cursor-pointer border-b-2 -mb-px transition-colors capitalize ${
                tab === t
                  ? 'text-[#7C3AED] border-[#7C3AED]'
                  : 'text-slate-400 border-transparent hover:text-slate-600'
              }`}
            >
              {t === 'base' ? 'Base Config' : 'Services'}
            </button>
          ))}
        </div>

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
              <button
                onClick={saveBase}
                disabled={baseSaving || baseLoading}
                className="px-4 py-2 bg-[#7C3AED] text-white rounded-lg text-[14px] font-medium cursor-pointer hover:bg-[#5B21B6] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {baseSaving ? 'Saving…' : 'Save to SSM'}
              </button>
              {baseStatus === 'saved' && <span className="text-[13px] text-green-600 font-medium">✓ Saved</span>}
              {baseStatus === 'error' && <span className="text-[13px] text-red-500 font-medium">✗ Save failed</span>}
            </div>
          </div>
        )}

        {tab === 'services' && (
          <div className="space-y-3">
            {SERVICES.map(svc => (
              <div key={svc} className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[15px] font-bold text-slate-900">{svc}</div>
                  <span className="text-[11px] text-slate-400 font-mono">/prompt2test/config/{env}/services/{svc.toLowerCase()}/*</span>
                </div>
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <label className="block text-[12px] font-medium text-slate-500 mb-1">Service URL</label>
                    <input
                      className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-[13px] outline-none focus:border-[#7C3AED]"
                      placeholder={`https://${svc.toLowerCase()}.${env}.company.com`}
                      value={svcValues[svc]?.['URL'] ?? ''}
                      onChange={e => setSvcValues(p => ({ ...p, [svc]: { ...p[svc], URL: e.target.value } }))}
                    />
                  </div>
                  <div>
                    <label className="block text-[12px] font-medium text-slate-500 mb-1">Swagger URL</label>
                    <input
                      className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-[13px] outline-none focus:border-[#7C3AED]"
                      placeholder={`https://${svc.toLowerCase()}.${env}.company.com/openapi.json`}
                      value={svcValues[svc]?.['SWAGGER_URL'] ?? ''}
                      onChange={e => setSvcValues(p => ({ ...p, [svc]: { ...p[svc], SWAGGER_URL: e.target.value } }))}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => saveService(svc)}
                    disabled={svcSaving[svc]}
                    className="px-3 py-1.5 bg-[#7C3AED] text-white rounded-lg text-[13px] font-medium cursor-pointer hover:bg-[#5B21B6] disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {svcSaving[svc] ? 'Saving…' : 'Save'}
                  </button>
                  {svcStatus[svc] === 'saved' && <span className="text-[12px] text-green-600 font-medium">✓ Saved</span>}
                  {svcStatus[svc] === 'error' && <span className="text-[12px] text-red-500 font-medium">✗ Save failed</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
