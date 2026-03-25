import { useState, useEffect, useCallback } from 'react'
import { useEnv } from '../context/EnvContext'
import { listTestCases, listRunRecords, type TestCase, type RunRecord } from '../lib/lambdaClient'

type Tab = 'cases' | 'runs'

export default function InventoryPage() {
  const { env } = useEnv()
  const [tab, setTab] = useState<Tab>('cases')
  const [cases, setCases] = useState<TestCase[]>([])
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (tab === 'cases') {
        setCases(await listTestCases(env))
      } else {
        setRuns(await listRunRecords(env))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [env, tab])

  useEffect(() => { load() }, [load])

  const smoke    = cases.filter(tc => tc.tags.includes('Smoke')).length
  const failures = cases.filter(tc => tc.lastResult === 'FAIL').length

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#F5F7FA]">
      <div className="flex-1 overflow-y-auto p-5">

        {/* Stats (test cases tab only) */}
        {tab === 'cases' && (
          <div className="grid grid-cols-4 gap-3 mb-5">
            {[
              { label: 'Total TCs',    value: cases.length,                                  color: 'text-slate-900' },
              { label: 'Services',     value: [...new Set(cases.map(t => t.service))].length, color: 'text-[#7C3AED]' },
              { label: 'Smoke tagged', value: smoke,                                          color: 'text-green-700' },
              { label: failures > 0 ? 'Failures' : 'All passing', value: failures > 0 ? failures : '✓', color: failures > 0 ? 'text-red-700' : 'text-green-700' },
            ].map(s => (
              <div key={s.label} className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
                <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
                <div className="text-[13px] text-slate-400 mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Tab bar */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
            <div className="flex gap-1">
              {(['cases', 'runs'] as Tab[]).map(t => (
                <button key={t} onClick={() => setTab(t)}
                  className={`px-3 py-1.5 rounded-lg text-[13px] font-semibold transition-colors cursor-pointer ${
                    tab === t ? 'bg-[#EDE9FE] text-[#7C3AED]' : 'text-slate-500 hover:bg-slate-50'
                  }`}>
                  {t === 'cases' ? `Test Cases — ${env.toUpperCase()}` : 'Run Records'}
                </button>
              ))}
            </div>
            <button onClick={load} disabled={loading}
              className="text-[12px] text-slate-400 hover:text-[#7C3AED] transition-colors cursor-pointer disabled:opacity-40">
              {loading ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>

          {error && (
            <div className="px-4 py-3 text-[13px] text-red-600 bg-red-50 border-b border-red-100">{error}</div>
          )}

          {tab === 'cases' ? (
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="text-left px-4 py-2.5 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Test Case</th>
                  <th className="text-left px-4 py-2.5 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Service</th>
                  <th className="text-left px-4 py-2.5 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Tags</th>
                  <th className="text-left px-4 py-2.5 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Last Result</th>
                  <th className="text-left px-4 py-2.5 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Created By</th>
                </tr>
              </thead>
              <tbody>
                {cases.length === 0 && !loading && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-[14px] text-slate-400">No test cases yet for {env.toUpperCase()}</td></tr>
                )}
                {cases.map((tc, i) => (
                  <tr key={tc.id} className={`border-b border-slate-50 hover:bg-slate-50 ${i % 2 === 1 ? 'bg-slate-50/50' : ''}`}>
                    <td className="px-4 py-3 text-[14px] text-slate-700 font-medium max-w-xs truncate" title={tc.description}>{tc.description}</td>
                    <td className="px-4 py-3">
                      {tc.service && <span className="text-[12px] px-2 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 rounded-full font-medium">{tc.service}</span>}
                    </td>
                    <td className="px-4 py-3">
                      {tc.tags.map(tag => (
                        <span key={tag} className="text-[12px] px-2 py-0.5 bg-green-50 text-green-700 border border-green-200 rounded-full font-medium mr-1">{tag}</span>
                      ))}
                    </td>
                    <td className="px-4 py-3">
                      {tc.lastResult ? (
                        <span className={`text-[12px] px-2 py-0.5 rounded-full font-semibold ${tc.lastResult === 'PASS' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                          {tc.lastResult}
                        </span>
                      ) : <span className="text-[12px] text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-3 text-[13px] text-slate-500">{tc.createdBy || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="text-left px-4 py-2.5 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Test Case</th>
                  <th className="text-left px-4 py-2.5 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Result</th>
                  <th className="text-left px-4 py-2.5 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Summary</th>
                  <th className="text-left px-4 py-2.5 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Run By</th>
                  <th className="text-left px-4 py-2.5 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Run At</th>
                </tr>
              </thead>
              <tbody>
                {runs.length === 0 && !loading && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-[14px] text-slate-400">No run records yet for {env.toUpperCase()}</td></tr>
                )}
                {runs.map((r, i) => (
                  <tr key={r.id} className={`border-b border-slate-50 hover:bg-slate-50 ${i % 2 === 1 ? 'bg-slate-50/50' : ''}`}>
                    <td className="px-4 py-3 text-[14px] text-slate-700 font-medium max-w-xs truncate" title={r.description}>{r.description}</td>
                    <td className="px-4 py-3">
                      <span className={`text-[12px] px-2 py-0.5 rounded-full font-semibold ${r.result === 'PASS' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                        {r.result}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[13px] text-slate-500 max-w-xs truncate" title={r.summary}>{r.summary || '—'}</td>
                    <td className="px-4 py-3 text-[13px] text-slate-500">{r.runBy || '—'}</td>
                    <td className="px-4 py-3 text-[13px] text-slate-400">{r.runAt ? new Date(r.runAt).toLocaleString() : '—'}</td>
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
