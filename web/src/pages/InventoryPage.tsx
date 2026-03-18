import { useState } from 'react'

const ENVS = ['dev', 'qa', 'uat', 'prod'] as const
type Env = typeof ENVS[number]

const ENV_COLORS: Record<Env, string> = {
  dev: 'text-green-700 bg-green-50 border-green-200',
  qa: 'text-blue-700 bg-blue-50 border-blue-200',
  uat: 'text-amber-700 bg-amber-50 border-amber-200',
  prod: 'text-red-700 bg-red-50 border-red-200',
}

const TEST_CASES = [
  { id: 'tc1', name: 'Billing plan shows Enterprise for Acme Corp', service: 'Billing', tags: ['Smoke'], status: 'pass', envs: ['dev', 'qa', 'uat', 'prod'] },
  { id: 'tc2', name: 'Export button visible for Enterprise plan', service: 'Billing', tags: ['Smoke'], status: 'pass', envs: ['dev', 'qa', 'uat'] },
  { id: 'tc3', name: 'Max user limit 5 for Starter plan', service: 'Billing', tags: [], status: 'fail', envs: ['dev', 'qa'] },
  { id: 'tc4', name: 'Payment charge succeeds for valid card', service: 'Payment', tags: ['Smoke'], status: 'pass', envs: ['dev', 'qa', 'uat', 'prod'] },
  { id: 'tc5', name: 'CVV mismatch returns 422', service: 'Payment', tags: [], status: 'pass', envs: ['dev', 'qa'] },
  { id: 'tc6', name: 'OAuth token refresh succeeds', service: 'Auth', tags: ['Smoke'], status: 'pass', envs: ['dev', 'qa', 'uat', 'prod'] },
]

export default function InventoryPage() {
  const [env, setEnv] = useState<Env>('dev')

  const filtered = TEST_CASES.filter(tc => tc.envs.includes(env))
  const smoke = filtered.filter(tc => tc.tags.includes('Smoke')).length
  const failures = filtered.filter(tc => tc.status === 'fail').length

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
                ? `${ENV_COLORS[e]} border-current`
                : 'text-slate-400 bg-white border-slate-200 hover:text-slate-600'
            }`}
          >
            {e.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {/* Stats */}
        <div className="grid grid-cols-4 gap-3 mb-5">
          {[
            { label: 'Total TCs', value: filtered.length, color: 'text-slate-900' },
            { label: 'Services', value: [...new Set(filtered.map(t => t.service))].length, color: 'text-[#0C7B8E]' },
            { label: 'Smoke tagged', value: smoke, color: 'text-green-700' },
            { label: failures > 0 ? 'Failures' : 'All passing', value: failures > 0 ? failures : '✓', color: failures > 0 ? 'text-red-700' : 'text-green-700' },
          ].map(s => (
            <div key={s.label} className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
              <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
              <div className="text-[13px] text-slate-400 mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>

        {/* TC table */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="flex items-center px-4 py-3 border-b border-slate-100">
            <div className="text-[15px] font-bold text-slate-900">Test Cases — {env.toUpperCase()}</div>
            {env === 'dev' && (
              <button className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-[#0C7B8E] text-white rounded-lg text-[13px] font-medium cursor-pointer hover:bg-[#0A6577]">
                + Author TC
              </button>
            )}
          </div>
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="text-left px-4 py-2.5 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Test Case</th>
                <th className="text-left px-4 py-2.5 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Service</th>
                <th className="text-left px-4 py-2.5 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Tags</th>
                <th className="text-left px-4 py-2.5 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((tc, i) => (
                <tr key={tc.id} className={`border-b border-slate-50 hover:bg-slate-50 ${i % 2 === 1 ? 'bg-slate-50/50' : ''}`}>
                  <td className="px-4 py-3 text-[14px] text-slate-700 font-medium">{tc.name}</td>
                  <td className="px-4 py-3">
                    <span className="text-[12px] px-2 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 rounded-full font-medium">{tc.service}</span>
                  </td>
                  <td className="px-4 py-3">
                    {tc.tags.map(tag => (
                      <span key={tag} className="text-[12px] px-2 py-0.5 bg-green-50 text-green-700 border border-green-200 rounded-full font-medium mr-1">{tag}</span>
                    ))}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-[12px] px-2 py-0.5 rounded-full font-semibold ${tc.status === 'pass' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                      {tc.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
