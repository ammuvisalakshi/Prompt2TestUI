import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchAuthSession, fetchUserAttributes } from '@aws-amplify/auth'
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm'
import { useEnv } from '../context/EnvContext'
import { listTestCases, listRunRecords, deleteTestCase, getTestCase, updateTestCaseService, saveRunRecord, type TestCase, type RunRecord } from '../lib/lambdaClient'
import { callAgent } from '../lib/agentClient'
import type { RunEntry } from '../layouts/PlatformLayout'

const AWS_REGION = import.meta.env.VITE_AWS_REGION as string

const loadingHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Prompt2Test — Starting…</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0f1117;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e2e8f0;gap:0}
.icon{font-size:40px;margin-bottom:20px}h2{font-size:18px;font-weight:600;margin-bottom:8px}p{font-size:13px;color:#64748b;margin-bottom:28px}
.track{width:320px;height:6px;background:#1e293b;border-radius:3px;overflow:hidden}
.bar{height:100%;width:0%;background:linear-gradient(90deg,#7c3aed,#a855f7);border-radius:3px;animation:fill 55s cubic-bezier(0.4,0,0.2,1) forwards}
@keyframes fill{0%{width:0%}60%{width:75%}90%{width:90%}100%{width:92%}}
.steps{margin-top:20px;display:flex;flex-direction:column;gap:6px;width:320px}
.step{font-size:11px;color:#475569;display:flex;align-items:center;gap:8px}
.dot{width:6px;height:6px;border-radius:50%;background:#334155;flex-shrink:0}
.dot.done{background:#7c3aed}.dot.active{background:#a855f7;animation:pulse 1s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}</style></head>
<body><div class="icon">🎭</div><h2>Launching browser…</h2><p>Starting a dedicated Fargate task for your session</p>
<div class="track"><div class="bar"></div></div>
<div class="steps">
<div class="step"><div class="dot done"></div>ECS task scheduled</div>
<div class="step"><div class="dot active"></div>Pulling container image &amp; starting Chromium</div>
<div class="step"><div class="dot"></div>noVNC ready — connecting live view</div>
</div></body></html>`

function saveRun(entry: Omit<RunEntry, 'id'>) {
  try {
    const raw = localStorage.getItem('p2t_run_history')
    const runs: RunEntry[] = raw ? JSON.parse(raw) : []
    runs.push({ id: Date.now().toString(36), ...entry })
    if (runs.length > 50) runs.splice(0, runs.length - 50)
    localStorage.setItem('p2t_run_history', JSON.stringify(runs))
    window.dispatchEvent(new Event('p2t_run_saved'))
  } catch { /* ignore */ }
}

async function loadServiceNames(env: string): Promise<string[]> {
  const session = await fetchAuthSession()
  const client = new SSMClient({ region: AWS_REGION, credentials: session.credentials })
  const path = `/prompt2test/config/${env}/services`
  const names = new Set<string>()
  let nextToken: string | undefined
  do {
    const resp = await client.send(new GetParametersByPathCommand({ Path: path, Recursive: true, NextToken: nextToken }))
    for (const p of resp.Parameters ?? []) {
      const rel = p.Name!.slice(path.length + 1)
      const slash = rel.indexOf('/')
      if (slash > 0) names.add(rel.slice(0, slash))
    }
    nextToken = resp.NextToken
  } while (nextToken)
  return [...names].sort()
}

type Tab = 'cases' | 'runs'
type Step = { stepNumber: number; type: string; tool?: string; action: string; detail: string }
type PlanStep = { step: number; action: string; expected: string }
type RunPhase = 'idle' | 'loading-tc' | 'starting-session' | 'automating' | 'done' | 'error'

export default function InventoryPage() {
  const { env } = useEnv()
  const [tab, setTab] = useState<Tab>('cases')
  const [cases, setCases] = useState<TestCase[]>([])
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [viewTc, setViewTc] = useState<(TestCase & { steps: Step[]; planSteps: PlanStep[] }) | null>(null)
  const [viewTab, setViewTab] = useState<'plan' | 'automated'>('plan')
  const [viewLoading, setViewLoading] = useState(false)
  const [assignTc, setAssignTc] = useState<TestCase | null>(null)
  const [openKebab, setOpenKebab] = useState<string | null>(null)
  const [assignService, setAssignService] = useState('')
  const [assignSaving, setAssignSaving] = useState(false)
  const [availableServices, setAvailableServices] = useState<string[]>([])
  const [servicesLoading, setServicesLoading] = useState(false)

  // Inline execution state
  const [runningTc, setRunningTc] = useState<TestCase | null>(null)
  const [runPhase, setRunPhase] = useState<RunPhase>('idle')
  const [runStatusMsg, setRunStatusMsg] = useState('')
  const [runResult, setRunResult] = useState<{ passed: boolean; summary: string } | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [novncUrl, setNovncUrl] = useState<string | null>(null)
  const popupRef = useRef<Window | null>(null)
  const [userName, setUserName] = useState('')

  useEffect(() => {
    fetchUserAttributes().then(attrs => {
      setUserName(attrs.name || attrs.email?.split('@')[0] || '')
    }).catch(() => {})
  }, [])

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
    setViewTab('plan')
    try {
      const full = await getTestCase(tc.id)
      setViewTc(full as TestCase & { steps: Step[]; planSteps: PlanStep[] })
    } catch {
      setError('Failed to load test case details')
    } finally {
      setViewLoading(false)
    }
  }

  function openAssign(tc: TestCase) {
    setAssignTc(tc)
    setAssignService(tc.service)
    setAvailableServices([])
    setServicesLoading(true)
    loadServiceNames(env).then(names => setAvailableServices(names)).catch(() => {}).finally(() => setServicesLoading(false))
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

  function handleRun(tc: TestCase) {
    // Open popup synchronously (user gesture) — shows loading animation while Fargate boots
    const loadingBlob = new Blob([loadingHtml], { type: 'text/html' })
    const loadingUrl = URL.createObjectURL(loadingBlob)
    const popup = window.open(loadingUrl, 'novnc-popup', 'width=1280,height=820,toolbar=0,menubar=0,location=0')
    popupRef.current = popup

    setRunningTc(tc)
    setRunPhase('loading-tc')
    setRunStatusMsg('Loading test case…')
    setRunResult(null)
    setRunError(null)
    setNovncUrl(null)

    const sessionId = crypto.randomUUID()

    ;(async () => {
      try {
        // Load full TC to get steps
        const full = await getTestCase(tc.id)
        const plan = {
          summary: full.description,
          steps: (full.steps ?? []) as Step[],
          mcpCalls: 0,
        }

        setRunPhase('starting-session')
        setRunStatusMsg('Starting browser session… (~60s for Fargate task)')

        const sessionRaw = await callAgent({ inputText: tc.description, mode: 'start_session', sessionId }, sessionId)
        const resolvedSession = JSON.parse(sessionRaw)
        if (resolvedSession.error) throw new Error(resolvedSession.error as string)

        URL.revokeObjectURL(loadingUrl)
        const url = resolvedSession.novnc_url as string
        setNovncUrl(url)
        if (popup) popup.location.href = `${url}?autoconnect=true&resize=scale`

        setRunPhase('automating')
        setRunStatusMsg('Browser is live — running test steps…')

        const raw = await callAgent({
          inputText: tc.description,
          mode: 'automate',
          plan,
          sessionId,
          task_arn: resolvedSession.task_arn,
          cluster: resolvedSession.cluster,
          mcp_endpoint: resolvedSession.mcp_endpoint,
        }, sessionId)

        const result = JSON.parse(raw)
        if (result.error) throw new Error(result.error as string)

        const passed = result.result?.passed ?? result.passed
        const summary = result.result?.summary ?? result.summary ?? ''

        saveRun({ description: tc.description, passed, timestamp: new Date().toISOString() })
        saveRunRecord({ testCaseId: tc.id, env, result: passed ? 'PASS' : 'FAIL', summary, runBy: userName }).catch(() => {})

        // Update lastResult in local state
        setCases(prev => prev.map(c => c.id === tc.id ? { ...c, lastResult: passed ? 'PASS' : 'FAIL', lastRunAt: new Date().toISOString() } : c))

        setRunResult({ passed, summary })
        setRunPhase('done')
        setRunStatusMsg(passed ? '✅ Test passed' : '❌ Test failed')

        // Close popup when done
        window.open('', 'novnc-popup')?.close()
        popupRef.current = null
      } catch (err) {
        URL.revokeObjectURL(loadingUrl)
        window.open('', 'novnc-popup')?.close()
        popupRef.current = null
        setRunError(err instanceof Error ? err.message : String(err))
        setRunPhase('error')
        setRunStatusMsg('Execution failed')
      }
    })()
  }

  function closeRunModal() {
    setRunningTc(null)
    setRunPhase('idle')
    setRunResult(null)
    setRunError(null)
    setNovncUrl(null)
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
  const runIsActive = runPhase !== 'idle'

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
              {servicesLoading ? (
                <div className="text-[13px] text-slate-400 py-4 text-center">Loading services…</div>
              ) : availableServices.length === 0 ? (
                <div className="text-[13px] text-slate-400 py-2">No services configured for {env.toUpperCase()} yet. Add them in Config &amp; Accounts.</div>
              ) : (
                <div className="flex flex-wrap gap-2 mb-3">
                  {availableServices.map(svc => (
                    <button key={svc} onClick={() => setAssignService(svc)}
                      className={`px-3 py-1.5 rounded-full text-[13px] font-semibold border cursor-pointer transition-colors ${
                        assignService === svc
                          ? 'bg-[#7C3AED] text-white border-[#7C3AED]'
                          : 'bg-slate-50 text-slate-600 border-slate-200 hover:border-[#7C3AED] hover:text-[#7C3AED]'
                      }`}>
                      {svc}
                    </button>
                  ))}
                </div>
              )}
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
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col pointer-events-auto">
              {/* Header */}
              <div className="flex items-start justify-between px-5 py-4 border-b border-slate-100">
                <div>
                  <div className="text-[15px] font-semibold text-slate-800">{viewTc?.title ?? viewTc?.description ?? 'Loading…'}</div>
                  <div className="flex items-center gap-2 mt-1">
                    {viewTc?.service && (
                      <span className="text-[11px] px-2 py-0.5 bg-[#EDE9FE] text-[#7C3AED] border border-[#DDD6FE] rounded-full font-semibold">{viewTc.service}</span>
                    )}
                    {viewTc?.id && (
                      <span className="text-[11px] text-slate-400 font-mono">{viewTc.id}</span>
                    )}
                  </div>
                </div>
                <button onClick={() => setViewTc(null)} className="text-slate-400 hover:text-slate-600 cursor-pointer ml-4 flex-shrink-0">
                  <svg viewBox="0 0 24 24" className="w-5 h-5 stroke-current fill-none stroke-2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>

              {/* Tabs */}
              <div className="flex border-b border-slate-100 px-5 gap-0">
                {(['plan', 'automated'] as const).map(t => (
                  <button key={t} onClick={() => setViewTab(t)}
                    className={`px-4 py-2.5 text-[13px] font-semibold border-b-2 transition-colors cursor-pointer ${
                      viewTab === t ? 'border-[#7C3AED] text-[#7C3AED]' : 'border-transparent text-slate-400 hover:text-slate-600'
                    }`}>
                    {t === 'plan' ? '📋 Plan Steps' : '⚡ Automated Steps'}
                  </button>
                ))}
              </div>

              {/* Body */}
              <div className="flex-1 overflow-y-auto p-4">
                {viewLoading && <div className="text-[14px] text-slate-400 text-center py-8">Loading…</div>}

                {/* Plan Steps — MTM table */}
                {!viewLoading && viewTab === 'plan' && (
                  viewTc?.planSteps?.length ? (
                    <table className="w-full border-collapse text-[13px]">
                      <thead>
                        <tr className="bg-slate-50">
                          <th className="py-2 px-2.5 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider w-8 border-b border-slate-200">#</th>
                          <th className="py-2 px-3 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-200">Action</th>
                          <th className="py-2 px-3 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-200">Expected Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {viewTc.planSteps.map((s, i) => (
                          <tr key={s.step} className={`border-b border-slate-100 ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}`}>
                            <td className="py-2.5 px-2.5 text-center align-top">
                              <span className="w-5 h-5 inline-flex items-center justify-center rounded-full bg-[#EDE9FE] text-[#7C3AED] text-[10px] font-bold">{s.step}</span>
                            </td>
                            <td className="py-2.5 px-3 text-slate-700 leading-relaxed align-top">{s.action}</td>
                            <td className="py-2.5 px-3 text-slate-500 leading-relaxed align-top">{s.expected}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="text-[13px] text-slate-400 text-center py-8">No plan steps saved yet.</div>
                  )
                )}

                {/* Automated Steps */}
                {!viewLoading && viewTab === 'automated' && (
                  viewTc?.steps?.length ? (
                    <div className="space-y-2">
                      {viewTc.steps.map((step, i) => (
                        <div key={i} className="flex gap-3 bg-slate-50 border border-slate-100 rounded-xl px-3 py-2.5">
                          <div className="w-5 h-5 rounded-full bg-[#7C3AED] text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                            {step.stepNumber ?? i + 1}
                          </div>
                          <div>
                            <div className="text-[13px] font-semibold text-slate-800">{step.action}</div>
                            <div className="text-[12px] text-slate-500 mt-0.5">{step.detail}</div>
                            <div className="text-[11px] text-[#7C3AED] mt-0.5 font-medium uppercase tracking-wide">{step.type}{step.tool ? ` · ${step.tool}` : ''}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[13px] text-slate-400 text-center py-8">Not automated yet — run this test case to generate automated steps.</div>
                  )
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* Execution modal */}
      {runIsActive && runningTc && (
        <>
          <div className="fixed inset-0 z-40 bg-black/40" />
          <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none p-6">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md pointer-events-auto">
              {/* Header */}
              <div className="flex items-start justify-between px-5 py-4 border-b border-slate-100">
                <div>
                  <div className="text-[15px] font-semibold text-slate-800">Running Test</div>
                  <div className="text-[13px] text-slate-500 mt-0.5 line-clamp-1">{runningTc.description}</div>
                </div>
                {(runPhase === 'done' || runPhase === 'error') && (
                  <button onClick={closeRunModal} className="text-slate-400 hover:text-slate-600 cursor-pointer ml-4 flex-shrink-0">
                    <svg viewBox="0 0 24 24" className="w-5 h-5 stroke-current fill-none stroke-2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                )}
              </div>

              {/* Body */}
              <div className="px-5 py-5">
                {/* Progress / status */}
                {(runPhase === 'loading-tc' || runPhase === 'starting-session' || runPhase === 'automating') && (
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-5 h-5 border-2 border-[#7C3AED] border-t-transparent rounded-full animate-spin flex-shrink-0" />
                    <div className="text-[14px] text-slate-700">{runStatusMsg}</div>
                  </div>
                )}

                {/* Phase steps */}
                <div className="space-y-2 mb-4">
                  {[
                    { phase: 'loading-tc',        label: 'Load test case' },
                    { phase: 'starting-session',   label: 'Start browser session (~60s)' },
                    { phase: 'automating',         label: 'Execute test steps' },
                    { phase: 'done',               label: 'Complete' },
                  ].map(({ phase, label }) => {
                    const phases: RunPhase[] = ['loading-tc', 'starting-session', 'automating', 'done']
                    const currentIdx = phases.indexOf(runPhase as RunPhase)
                    const stepIdx = phases.indexOf(phase as RunPhase)
                    const isDone = runPhase === 'done' ? true : currentIdx > stepIdx
                    const isActive = currentIdx === stepIdx && runPhase !== 'done' && runPhase !== 'error'
                    return (
                      <div key={phase} className="flex items-center gap-2.5">
                        <div className={`w-4 h-4 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-bold ${
                          isDone ? 'bg-[#7C3AED] text-white' :
                          isActive ? 'border-2 border-[#7C3AED] border-t-transparent rounded-full animate-spin' :
                          'bg-slate-100 text-slate-300'
                        }`}>
                          {isDone && !isActive ? '✓' : ''}
                        </div>
                        <span className={`text-[13px] ${isDone ? 'text-slate-700 font-medium' : isActive ? 'text-[#7C3AED] font-semibold' : 'text-slate-400'}`}>
                          {label}
                        </span>
                      </div>
                    )
                  })}
                </div>

                {/* Watch live link (once novnc is ready) */}
                {novncUrl && runPhase === 'automating' && (
                  <button
                    onClick={() => {
                      const p = window.open(`${novncUrl}?autoconnect=true&resize=scale`, 'novnc-popup', 'width=1280,height=820,toolbar=0,menubar=0,location=0')
                      if (p) popupRef.current = p
                    }}
                    className="w-full mb-4 py-2 rounded-xl bg-slate-900 text-white text-[13px] font-semibold hover:bg-slate-700 transition-colors cursor-pointer flex items-center justify-center gap-2">
                    <svg viewBox="0 0 24 24" className="w-4 h-4 stroke-current fill-none stroke-2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
                    Watch Live
                  </button>
                )}

                {/* Result */}
                {runPhase === 'done' && runResult && (
                  <div className={`rounded-xl p-4 ${runResult.passed ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                    <div className={`text-[15px] font-bold mb-1 ${runResult.passed ? 'text-green-700' : 'text-red-700'}`}>
                      {runResult.passed ? '✅ PASS' : '❌ FAIL'}
                    </div>
                    {runResult.summary && (
                      <div className="text-[13px] text-slate-600 leading-relaxed">{runResult.summary}</div>
                    )}
                  </div>
                )}

                {/* Error */}
                {runPhase === 'error' && runError && (
                  <div className="rounded-xl p-4 bg-red-50 border border-red-200">
                    <div className="text-[13px] font-semibold text-red-700 mb-1">Execution error</div>
                    <div className="text-[12px] text-red-600 font-mono break-all">{runError}</div>
                  </div>
                )}
              </div>

              {/* Footer */}
              {(runPhase === 'done' || runPhase === 'error') && (
                <div className="px-5 pb-5">
                  <button onClick={closeRunModal}
                    className="w-full py-2.5 rounded-xl bg-[#7C3AED] hover:bg-[#5B21B6] text-white text-[13px] font-semibold cursor-pointer transition-colors">
                    Close
                  </button>
                </div>
              )}
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
                            {isAutomated ? '⚡ Automated' : 'Not automated yet'}
                          </span>

                          {/* Actions */}
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            {/* View */}
                            <button onClick={() => handleView(tc)} disabled={viewLoading}
                              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px] font-medium text-slate-600 hover:bg-slate-100 border border-slate-200 transition-colors cursor-pointer disabled:opacity-40">
                              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                              View
                            </button>

                            {/* Run (only if automated) */}
                            {isAutomated && (
                              <button onClick={() => handleRun(tc)} disabled={runIsActive}
                                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px] font-semibold bg-[#EDE9FE] text-[#7C3AED] hover:bg-[#DDD6FE] border border-[#DDD6FE] transition-colors cursor-pointer disabled:opacity-40">
                                <svg viewBox="0 0 24 24" className="w-3 h-3 stroke-current fill-none stroke-2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                                Run
                              </button>
                            )}

                            {/* Kebab menu */}
                            <div className="relative">
                              <button
                                onClick={() => setOpenKebab(openKebab === tc.id ? null : tc.id)}
                                className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
                              >
                                <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                              </button>
                              {openKebab === tc.id && (
                                <>
                                  <div className="fixed inset-0 z-40" onClick={() => setOpenKebab(null)} />
                                  <div className="absolute right-0 top-full mt-1 z-50 w-44 bg-white border border-slate-200 rounded-xl shadow-xl py-1 overflow-hidden">
                                    <button
                                      onClick={() => { openAssign(tc); setOpenKebab(null) }}
                                      className="w-full text-left px-3 py-2 text-[13px] text-slate-700 hover:bg-slate-50 flex items-center gap-2.5 cursor-pointer">
                                      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2 flex-shrink-0"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                      Move to service
                                    </button>
                                    <div className="h-px bg-slate-100 mx-2 my-1" />
                                    <button
                                      onClick={() => { setConfirmDeleteId(tc.id); setOpenKebab(null) }}
                                      className="w-full text-left px-3 py-2 text-[13px] text-red-600 hover:bg-red-50 flex items-center gap-2.5 cursor-pointer">
                                      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2 flex-shrink-0"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                                      Delete
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
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
