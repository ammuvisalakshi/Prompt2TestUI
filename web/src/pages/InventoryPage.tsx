import { useEnv } from '../context/EnvContext'

const TEST_CASES: { id: string; name: string; service: string; tags: string[]; status: string; envs: string[] }[] = []

export default function InventoryPage() {
  const { env } = useEnv()

  const filtered = TEST_CASES.filter(tc => tc.envs.includes(env))
  const smoke    = filtered.filter(tc => tc.tags.includes('Smoke')).length
  const failures = filtered.filter(tc => tc.status === 'fail').length

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#F5F7FA]">
      <div className="flex-1 overflow-y-auto p-5">
        {/* Stats */}
        <div className="grid grid-cols-4 gap-3 mb-5">
          {[
            { label: 'Total TCs',    value: filtered.length,                                   color: 'text-slate-900' },
            { label: 'Services',     value: [...new Set(filtered.map(t => t.service))].length, color: 'text-[#7C3AED]' },
            { label: 'Smoke tagged', value: smoke,                                             color: 'text-green-700' },
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
              <button className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-[#7C3AED] text-white rounded-lg text-[13px] font-medium cursor-pointer hover:bg-[#5B21B6]">
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
