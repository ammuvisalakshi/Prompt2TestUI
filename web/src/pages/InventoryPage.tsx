import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useEnv } from '../context/EnvContext'
import { listTestCases, listRunRecords, deleteTestCase, getTestCase, updateTestCaseService, type TestCase, type RunRecord } from '../lib/lambdaClient'

type Tab = 'cases' | 'runs'

type Step = { stepNumber: number; type: string; tool?: string; action: string; detail: string }

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
  const [viewTc, setViewTc] = useState<(TestCase & { steps: Step[] }) | null>(null)
  const [viewLoading, setViewLoading] = useState(false)
  const [assignTc, setAssignTc] = useState<TestCase | null>(null)
  const [assignService, setAssignService] = useState('')
  const [assignSaving, setAssignSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (tab === 'cases') setCases(await listTestCases(env))
      else setRuns(await listRunRecords(env))
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

  async function handleView(tc: TestCase) {
    setViewLoading(true)
    try {
      const full = await getTestCase(tc.id)
      setViewTc(full as TestCase & { steps: Step[] })
    } catch {
      setError('Failed to load test case details')
    } finally {
      setViewLoading(false)
    }
  }

  function handleRun(tc: TestCase) {
    navigate(`/agent?tcId=${tc.id}&tcDesc=${encodeURIComponent(tc.description)}`)
  }

  async function handleAssignService() {
    if (!assignTc || !assignService.trim()) return
    setAssignSaving(true)
    try {
      await updateTestCaseService(assignTc.id, assignService.trim())
      setCases(prev => prev.map(tc => tc.id === assignTc.id ? { ...tc, service: assignService.trim() } : tc))
      setAssignTc(null)
      setAssignService('')
    } catch {
      setError('Failed to update service')
    } finally {
      setAssignSaving(false)
    }
  }

  // Group test cases by service
  const grouped = cases.reduce<Record<string, TestCase[]>>((acc, tc) => {
    const svc = tc.service || 'Uncategorized'
    if (!acc[svc]) acc[svc] = []
    acc[svc].push(tc)
    return acc
  }, {})
  const services = Object.keys(grouped).sort()

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

      {/* Assign service modal */}
      {assignTc && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" onClick={() => { setAssignTc(null); setAssignService('') }} />
          <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
            <div className="bg-white rounded-2xl shadow-2xl p-5 w-96 pointer-events-auto">
              <div className="text-[15px] font-semibold text-slate-800 mb-1">Assign Service</div>
              <div className="text-[13px] text-slate-500 mb-4 line-clamp-1">{assignTc.description}</div>

              {/* Existing service quick-picks */}
              {services.filter(s => s !== 'Uncategorized').length > 0 && (
                <div className="mb-3">
                  <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Existing services</div>
                  <div className="flex flex-wrap gap-1.5">
                    {services.filter(s => s !== 'Uncategorized').map(svc => (
                      <button key={svc} onClick={() => setAssignService(svc)}
                        className={`px-2.5 py-1 rounded-full text-[12px] font-semibold border cursor-pointer transition-colors ${
                          assignService === svc
                            ? 'bg-[#7C3AED] text-white border-[#7C3AED]'
                            : 'bg-slate-50 text-slate-600 border-slate-200 hover:border-[#7C3AED] hover:text-[#7C3AED]'
                        }`}>
                        {svc}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <input
                value={assignService}
                onChange={e => setAssignService(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAssignService() }}
                placeholder="Or type a new service name…"
                autoFocus
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-[13px] outline-none focus:border-[#7C3AED] transition-colors mb-3"
              />
              <div className="flex gap-2">
                <button onClick={handleAssignService} disabled={assignSaving || !assignService.trim()}
                  className="flex-1 py-2 rounded-xl bg-[#7C3AED] hover:bg-[#5B21B6] text-white text-[13px] font-semibold cursor-pointer disabled:opacity-50 transition-colors">
                  {assignSaving ? 'Saving…' : 'Assign'}
                </button>
                <button onClick={() => { setAssignTc(null); setAssignService('') }}
                  className="flex-1 py-2 rounded-xl border border-slate-200 text-slate-600 text-[13px] font-semibold hover:bg-slate-50 cursor-pointer transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* View test case modal */}
      {(viewTc || viewLoading) && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setViewTc(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none p-6">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col pointer-events-auto">
              <div className="flex items-start justify-between px-5 py-4 border-b border-slate-100">
                <div>
                  <div className="text-[15px] font-semibold text-slate-800">{viewTc?.description ?? 'Loading…'}</div>
                  {viewTc?.service && (
                    <span className="text-[12px] px-2 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 rounded-full font-medium mt-1 inline-block">{viewTc.service}</span>
                  )}
                </div>
                <button onClick={() => setViewTc(null)} className="text-slate-400 hover:text-slate-600 cursor-pointer ml-4 flex-shrink-0">
                  <svg viewBox="0 0 24 24" className="w-5 h-5 stroke-current fill-none stroke-2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {viewLoading && <div className="text-[14px] text-slate-400 text-center py-8">Loading steps…</div>}
                {viewTc?.steps?.length === 0 && (
                  <div className="text-[13px] text-slate-400 text-center py-4">No steps recorded for this test case.</div>
                )}
                {viewTc?.steps?.map((step, i) => (
                  <div key={i} className="flex gap-3 bg-slate-50 border border-slate-100 rounded-xl px-3 py-2.5">
                    <div className="w-5 h-5 rounded-full bg-[#7C3AED] text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                      {step.stepNumber ?? i + 1}
                    </div>
                    <div>
                      <div className="text-[13px] font-semibold text-slate-800">{step.action}</div>
                      <div className="text-[12px] text-slate-500 mt-0.5">{step.detail}</div>
                      <div className="text-[11px] text-[#7C3AED] mt-0.5 font-medium uppercase tracking-wide">{step.type} {step.tool ? `· ${step.tool}` : ''}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      <div className="flex-1 overflow-y-auto p-5">
        {/* Stats */}
        {tab === 'cases' && (
          <div className="grid grid-cols-4 gap-3 mb-5">
            {[
              { label: 'Total TCs',    value: cases.length,                                   color: 'text-slate-900' },
              { label: 'Services',     value: services.filter(s => s !== 'Uncategorized').length || cases.length > 0 ? services.length : 0, color: 'text-[#7C3AED]' },
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

        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          {/* Tab bar */}
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
            cases.length === 0 && !loading ? (
              <div className="px-4 py-8 text-center text-[14px] text-slate-400">No test cases yet for {env.toUpperCase()}</div>
            ) : (
              <div>
                {services.map(svc => (
                  <div key={svc}>
                    {/* Service group header */}
                    <div className="flex items-center gap-2 px-4 py-2 bg-slate-50 border-b border-slate-100">
                      <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">{svc}</span>
                      <span className="text-[11px] text-slate-400">({grouped[svc].length})</span>
                    </div>

                    {/* Rows */}
                    {grouped[svc].map((tc) => {
                      const isAutomated = (tc as TestCase & { stepCount?: number }).stepCount ?? 0 > 0
                      return (
                        <div key={tc.id} className="flex items-center gap-3 px-4 py-3 border-b border-slate-50 hover:bg-slate-50 transition-colors">
                          {/* Description */}
                          <div className="flex-1 min-w-0">
                            <div className="text-[14px] text-slate-700 font-medium truncate" title={tc.description}>{tc.description}</div>
                            <div className="flex items-center gap-2 mt-1">
                              {tc.tags.map(tag => (
                                <span key={tag} className="text-[11px] px-1.5 py-0.5 bg-green-50 text-green-700 border border-green-200 rounded-full font-medium">{tag}</span>
                              ))}
                              {tc.lastResult && (
                                <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-semibold ${tc.lastResult === 'PASS' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                                  {tc.lastResult}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Automation status */}
                          <span className={`flex-shrink-0 text-[11px] px-2 py-1 rounded-full font-semibold border ${
                            isAutomated
                              ? 'bg-purple-50 text-[#7C3AED] border-purple-200'
                              : 'bg-slate-50 text-slate-400 border-slate-200'
                          }`}>
                            {isAutomated ? '⚡ Automated' : 'Manual'}
                          </span>

                          {/* Actions */}
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            {/* Assign service */}
                            <button onClick={() => { setAssignTc(tc); setAssignService(tc.service) }}
                              title="Assign service"
                              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px] font-medium text-slate-600 hover:bg-slate-100 border border-slate-200 transition-colors cursor-pointer">
                              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                              {tc.service || 'Assign'}
                            </button>

                            {/* View */}
                            <button onClick={() => handleView(tc)} disabled={viewLoading}
                              title="View test case steps"
                              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px] font-medium text-slate-600 hover:bg-slate-100 border border-slate-200 transition-colors cursor-pointer disabled:opacity-40">
                              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                              View
                            </button>

                            {/* Run (only if automated) */}
                            {isAutomated && (
                              <button onClick={() => handleRun(tc)}
                                title="Run this test"
                                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px] font-semibold bg-[#EDE9FE] text-[#7C3AED] hover:bg-[#DDD6FE] border border-[#DDD6FE] transition-colors cursor-pointer">
                                <svg viewBox="0 0 24 24" className="w-3 h-3 stroke-current fill-none stroke-2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                                Run
                              </button>
                            )}

                            {/* Delete */}
                            <button onClick={() => setConfirmDeleteId(tc.id)}
                              title="Delete test case"
                              className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer">
                              <svg viewBox="0 0 24 24" className="w-4 h-4 stroke-current fill-none stroke-2">
                                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
                              </svg>
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            )
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
