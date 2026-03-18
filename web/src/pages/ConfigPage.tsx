import { useState } from 'react'

const ENVS = ['dev', 'qa', 'uat', 'prod'] as const
type Env = typeof ENVS[number]

const SERVICES = ['Billing', 'Payment', 'Auth', 'User', 'Notification']

const ACCOUNTS = [
  { id: 'acme', name: 'Acme Corp', plan: 'Enterprise', user: 'admin@acme.com', envs: ['dev', 'qa', 'uat', 'prod'] },
  { id: 'beta', name: 'Beta Corp', plan: 'Starter', user: 'admin@beta.com', envs: ['dev', 'qa'] },
  { id: 'corp3', name: 'Corp 3', plan: 'Pro', user: 'admin@corp3.com', envs: ['dev', 'qa', 'uat'] },
]

export default function ConfigPage() {
  const [env, setEnv] = useState<Env>('dev')
  const [tab, setTab] = useState<'base' | 'services' | 'accounts'>('base')

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#F5F7FA]">
      {/* Env tabs */}
      <div className="flex items-center gap-1 px-5 pt-4 pb-0 flex-shrink-0">
        {ENVS.map(e => (
          <button
            key={e}
            onClick={() => setEnv(e)}
            className={`px-4 py-1.5 rounded-t-lg text-[12px] font-semibold border border-b-0 cursor-pointer transition-colors ${
              env === e
                ? 'text-[#0C7B8E] bg-[#F0F9FC] border-[#0C7B8E]'
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
          {(['base', 'services', 'accounts'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-[13px] font-medium cursor-pointer border-b-2 -mb-px transition-colors capitalize ${
                tab === t
                  ? 'text-[#0C7B8E] border-[#0C7B8E]'
                  : 'text-slate-400 border-transparent hover:text-slate-600'
              }`}
            >
              {t === 'base' ? 'Base Config' : t === 'services' ? 'Services' : 'Test Accounts'}
            </button>
          ))}
        </div>

        {tab === 'base' && (
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5">
            <div className="text-[14px] font-bold text-slate-900 mb-4">L1 Base Config — {env.toUpperCase()}</div>
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: 'API Base URL', placeholder: `https://api.${env}.company.com` },
                { label: 'OAuth Token URL', placeholder: `https://auth.${env}.company.com/token` },
                { label: 'Default Timeout (ms)', placeholder: '5000' },
                { label: 'Retry Attempts', placeholder: '3' },
              ].map(f => (
                <div key={f.label}>
                  <label className="block text-[12px] font-medium text-slate-600 mb-1">{f.label}</label>
                  <input
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[13px] text-slate-700 outline-none focus:border-[#0C7B8E] transition-colors"
                    placeholder={f.placeholder}
                  />
                </div>
              ))}
            </div>
            <button className="mt-5 px-4 py-2 bg-[#0C7B8E] text-white rounded-lg text-[13px] font-medium cursor-pointer hover:bg-[#0A6577]">
              Save to SSM
            </button>
          </div>
        )}

        {tab === 'services' && (
          <div className="space-y-3">
            {SERVICES.map(svc => (
              <div key={svc} className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[13px] font-bold text-slate-900">{svc}</div>
                  <span className="text-[11px] px-2 py-0.5 bg-green-50 text-green-700 border border-green-200 rounded-full">active</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">Service URL</label>
                    <input className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-[12px] outline-none focus:border-[#0C7B8E]" placeholder={`https://${svc.toLowerCase()}.${env}.company.com`} />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">Swagger URL</label>
                    <input className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-[12px] outline-none focus:border-[#0C7B8E]" placeholder={`https://${svc.toLowerCase()}.${env}.company.com/openapi.json`} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'accounts' && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="text-[13px] font-semibold text-slate-600">Test accounts available in {env.toUpperCase()}</div>
              {env === 'dev' && (
                <button className="px-3 py-1.5 bg-[#0C7B8E] text-white rounded-lg text-[12px] font-medium cursor-pointer hover:bg-[#0A6577]">
                  + Add account
                </button>
              )}
            </div>
            <div className="space-y-3">
              {ACCOUNTS.filter(a => a.envs.includes(env)).map(acc => (
                <div key={acc.id} className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 flex items-center gap-4">
                  <div className="w-9 h-9 rounded-lg bg-[#E0F2F7] text-[#0C7B8E] flex items-center justify-center text-[12px] font-bold flex-shrink-0">
                    {acc.name.split(' ').map(w => w[0]).join('')}
                  </div>
                  <div>
                    <div className="text-[13px] font-semibold text-slate-900">{acc.name}</div>
                    <div className="text-[12px] text-slate-400">{acc.user}</div>
                  </div>
                  <span className="ml-auto text-[11px] px-2 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 rounded-full font-medium">{acc.plan}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
