import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useEnv } from '../context/EnvContext'
import { listTestCases, listRunRecords, deleteTestCase, type TestCase, type RunRecord } from '../lib/lambdaClient'

type Tab = 'cases' | 'runs'

export default function InventoryPage() {
  const { env } = useEnv()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('cases')
  const [cases, setCases] = useState<TestCase[]>([])
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

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

  async function handleDelete(id: string) {
    setDeletingId(id)
    try {
      await deleteTestCase(id)
      setCases(prev => prev.filter(tc => tc.id !== id))
    } catch {
      setError('Failed to delete test case')
    } finally {
      setDeletingId(null)
      setConfirmDeleteId(null)
    }
  }

  function handleRun(tc: TestCase) {
    navigate(`/agent?tcId=${tc.id}&tcDesc=${encodeURIComponent(tc.description)}`)
  }

  const smoke    = cases.filter(tc => tc.tags.includes('Smoke')).length
  const failures = cases.filter(tc => tc.lastResult === 'FAIL').length

  const confirmTc = cases.find(tc => tc.id === confirmDeleteId)

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#F5F7FA]">
      {/* Delete confirm modal */}
      {confirmDeleteId && confirmTc && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setConfirmDeleteId(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
            <div className="bg-white rounded-2xl shadow-2xl p-5 w-80 pointer-events-auto">
              <div className="text-[15px] font-semibold text-slate-800 mb-1">Delete test case?</div>
              <div className="text-[13px] text-slate-500 mb-4 line-clamp-2">{confirmTc.description}</div>
              <p className="text-[12px] text-slate-400 mb-4">This will also delete all run records for this test case.</p>
              <div className="flex gap-2">
                <button onClick={() => handleDelete(confirmDeleteId)} disabled={deletingId === confirmDeleteId}
                  className="flex-1 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-[13px] font-semibold cursor-pointer disabled:opacity-50 transition-colors">
                  {deletingId === confirmDeleteId ? 'Deleting…' : 'Delete'}
                </button>
                <button onClick={() => setConfirmDeleteId(null)}
                  className="flex-1 py-2 rounded-xl border border-slate-200 text-slate-600 text-[13px] font-semibold hover:bg-slate-50 cursor-pointer transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="flex-1 overflow-y-auto p-5">
        {/* Stats (test cases tab only) */}
        {tab === 'cases' && (
          <div className="grid grid-cols-4 gap-3 mb-5">
            {[
              { label: 'Total TCs',    value: cases.length,                                   color: 'text-slate-900' },
              { label: 'Services',     value: [...new Set(cases.map(t => t.service))].length,  color: 'text-[#7C3AED]' },
              { label: 'Smoke tagged', value: smoke,                                           color: 'text-green-700' },
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
            <table className="w-full table-fixed">
              <colgroup>
                <col className="w-[35%]" />
                <col className="w-[12%]" />
                <col className="w-[13%]" />
                <col className="w-[11%]" />
                <col className="w-[15%]" />
                <col className="w-[14%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="text-left px-4 py-2.5 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Test Case</th>
                  <th className="text-left px-4 py-2.5 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Service</th>
                  <th className="text-left px-4 py-2.5 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Tags</th>
                  <th className="text-left px-4 py-2.5 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Last Result</th>
                  <th className="text-left px-4 py-2.5 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Created By</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {cases.length === 0 && !loading && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-[14px] text-slate-400">No test cases yet for {env.toUpperCase()}</td></tr>
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
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 justify-end relative">
                        {/* Run button */}
                        <button onClick={() => handleRun(tc)}
                          title="Run this test"
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-semibold bg-[#EDE9FE] text-[#7C3AED] hover:bg-[#DDD6FE] border border-[#DDD6FE] transition-colors cursor-pointer">
                          <svg viewBox="0 0 24 24" className="w-3 h-3 stroke-current fill-none stroke-2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                          Run
                        </button>

                        {/* Delete button */}
                        <button onClick={() => setConfirmDeleteId(tc.id)}
                          title="Delete test case"
                          className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer">
                          <svg viewBox="0 0 24 24" className="w-4 h-4 stroke-current fill-none stroke-2">
                            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
                          </svg>
                        </button>
                      </div>
                    </td>
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
