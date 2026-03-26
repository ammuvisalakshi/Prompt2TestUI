import { useState, useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { getTestCase, saveRunRecord } from '../lib/lambdaClient'
import { callAgent } from '../lib/agentClient'

type PlanStep = { step: number; action: string; expected: string }
type AutoStep = { stepNumber: number; type: string; tool?: string; action: string; detail: string }
type RunPhase = 'idle' | 'starting' | 'running' | 'done' | 'error'

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

export default function TestCasePage() {
  const { id } = useParams<{ id: string }>()
  const [tc, setTc] = useState<Awaited<ReturnType<typeof getTestCase>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'plan' | 'automated'>('plan')

  const [runPhase, setRunPhase] = useState<RunPhase>('idle')
  const [runResult, setRunResult] = useState<{ passed: boolean; summary: string } | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const popupRef = useRef<Window | null>(null)
  const sessionId = useRef(crypto.randomUUID())

  useEffect(() => {
    if (!id) return
    getTestCase(id)
      .then(data => { setTc(data); setLoading(false) })
      .catch(() => { setError('Failed to load test case.'); setLoading(false) })
  }, [id])

  async function runTest() {
    if (!tc) return
    const steps = (tc.steps ?? []) as AutoStep[]
    if (!steps.length) return

    setRunPhase('starting')
    setRunResult(null)
    setRunError(null)

    // Open loading page in new tab immediately (user gesture)
    const tabTitle = `${tc.id} — ${tc.title || tc.description}`
    const loadingHtmlWithTitle = loadingHtml.replace(
      '<title>Prompt2Test — Starting…</title>',
      `<title>${tabTitle} | Starting…</title>`
    )
    const loadingBlob = new Blob([loadingHtmlWithTitle], { type: 'text/html' })
    const loadingUrl = URL.createObjectURL(loadingBlob)
    const tab = window.open(loadingUrl, '_blank')
    popupRef.current = tab

    try {
      const sessionRaw = await callAgent(
        { inputText: tc.title || tc.description, mode: 'start_session', sessionId: sessionId.current },
        sessionId.current
      )
      const session = JSON.parse(sessionRaw)
      if (session.error) throw new Error(session.error as string)

      URL.revokeObjectURL(loadingUrl)

      // Wrapper page keeps tab title and embeds noVNC full-screen
      const novncSrc = `${session.novnc_url}?autoconnect=true&resize=scale`
      const wrapperHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${tabTitle} | Live Browser</title>
<style>*{margin:0;padding:0}html,body,iframe{width:100%;height:100%;border:none;display:block}</style></head>
<body><iframe src="${novncSrc}" allowfullscreen></iframe></body></html>`
      const wrapperBlob = new Blob([wrapperHtml], { type: 'text/html' })
      const wrapperUrl = URL.createObjectURL(wrapperBlob)
      if (tab) tab.location.href = wrapperUrl
      setRunPhase('running')

      const plan = { summary: tc.title || tc.description, steps, mcpCalls: 0 }
      const raw = await callAgent({
        inputText: tc.title || tc.description,
        mode: 'automate',
        plan,
        sessionId: sessionId.current,
        task_arn: session.task_arn,
        cluster: session.cluster,
        mcp_endpoint: session.mcp_endpoint,
      }, sessionId.current)

      const result = JSON.parse(raw)
      URL.revokeObjectURL(wrapperUrl)
      if (result.error) throw new Error(result.error as string)

      const passed = result.result?.passed ?? result.passed
      const summary = result.result?.summary ?? result.summary ?? ''

      saveRunRecord({ testCaseId: tc.id, env: tc.env, result: passed ? 'PASS' : 'FAIL', summary }).catch(() => {})
      setRunResult({ passed, summary })
      setRunPhase('done')
      popupRef.current?.close()
      popupRef.current = null
    } catch (err) {
      URL.revokeObjectURL(loadingUrl)
      popupRef.current?.close()
      popupRef.current = null
      setRunError(err instanceof Error ? err.message : String(err))
      setRunPhase('error')
    }
  }

  if (loading) return (
    <div className="min-h-screen bg-[#F5F7FA] flex items-center justify-center">
      <div className="flex items-center gap-3 text-slate-400">
        <div className="w-4 h-4 border-2 border-[#7C3AED] border-t-transparent rounded-full animate-spin" />
        <span className="text-[14px]">Loading test case…</span>
      </div>
    </div>
  )

  if (error || !tc) return (
    <div className="min-h-screen bg-[#F5F7FA] flex items-center justify-center">
      <div className="text-[14px] text-red-500">{error ?? 'Test case not found.'}</div>
    </div>
  )

  const planSteps = (tc.planSteps ?? []) as PlanStep[]
  const autoSteps = (tc.steps ?? []) as AutoStep[]
  const isAutomated = autoSteps.length > 0
  const isRunning = runPhase === 'starting' || runPhase === 'running'

  return (
    <div className="h-screen bg-[#F5F7FA] flex flex-col font-sans overflow-hidden">

      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-5 py-3 flex items-center gap-3 flex-shrink-0">
        <button onClick={() => window.close()}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer transition-colors flex-shrink-0">
          <svg viewBox="0 0 24 24" className="w-4 h-4 stroke-current fill-none stroke-2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {tc.service && (
              <span className="text-[11px] px-2 py-0.5 bg-[#EDE9FE] text-[#7C3AED] border border-[#DDD6FE] rounded-full font-semibold flex-shrink-0">{tc.service}</span>
            )}
            <h1 className="text-[15px] font-semibold text-slate-800 truncate">{tc.title || tc.description}</h1>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[11px] text-slate-400 font-mono">{tc.id}</span>
            {tc.lastResult && (
              <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold border ${tc.lastResult === 'PASS' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
                {tc.lastResult}
              </span>
            )}
            <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold border ${isAutomated ? 'bg-purple-50 text-[#7C3AED] border-purple-200' : 'bg-slate-50 text-slate-400 border-slate-200'}`}>
              {isAutomated ? '⚡ Automated' : 'Manual'}
            </span>
          </div>
        </div>

        {isAutomated && (
          <button onClick={runTest} disabled={isRunning}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#7C3AED] hover:bg-[#5B21B6] disabled:opacity-60 text-white text-[13px] font-semibold cursor-pointer transition-colors flex-shrink-0">
            {isRunning ? (
              <><div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />{runPhase === 'starting' ? 'Starting…' : 'Running…'}</>
            ) : (
              <><svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2"><polygon points="5 3 19 12 5 21 5 3"/></svg>Run Test</>
            )}
          </button>
        )}
      </div>

      {/* Status bar — shown while running or after result */}
      {runPhase !== 'idle' && (
        <div className={`px-5 py-2.5 flex items-center gap-3 text-[13px] border-b flex-shrink-0 ${
          runPhase === 'done' && runResult?.passed ? 'bg-green-50 border-green-200 text-green-800' :
          runPhase === 'done' ? 'bg-red-50 border-red-200 text-red-800' :
          runPhase === 'error' ? 'bg-red-50 border-red-200 text-red-800' :
          'bg-[#EDE9FE] border-purple-200 text-[#7C3AED]'
        }`}>
          {isRunning && <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin flex-shrink-0" />}
          <span className="font-medium">
            {runPhase === 'starting' && 'Launching browser… (~60s for Fargate task)'}
            {runPhase === 'running' && 'Test is running — watch it in the browser window'}
            {runPhase === 'done' && (runResult?.passed ? '✅ Test Passed' : '❌ Test Failed')}
            {runPhase === 'error' && '⚠️ Execution failed'}
          </span>
          {runResult?.summary && <span className="text-[12px] opacity-75 truncate">— {runResult.summary}</span>}
          {runError && <span className="text-[12px] opacity-75 font-mono truncate">— {runError}</span>}
          <button onClick={() => { setRunPhase('idle'); setRunResult(null); setRunError(null) }}
            className="ml-auto opacity-50 hover:opacity-100 cursor-pointer text-[12px]">✕</button>
        </div>
      )}

      {/* Tabs */}
      <div className="bg-white border-b border-slate-200 px-5 flex flex-shrink-0">
        {(['plan', 'automated'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-3 text-[13px] font-semibold border-b-2 transition-colors cursor-pointer ${
              tab === t ? 'border-[#7C3AED] text-[#7C3AED]' : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}>
            {t === 'plan' ? '📋 Plan Steps' : `⚡ Automated Steps${autoSteps.length > 0 ? ` (${autoSteps.length})` : ''}`}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-5">

          {/* Plan Steps */}
          {tab === 'plan' && (
            planSteps.length > 0 ? (
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="py-2.5 px-3 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider w-10">#</th>
                      <th className="py-2.5 px-4 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider w-[46%]">Action</th>
                      <th className="py-2.5 px-4 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Expected Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {planSteps.map((s, i) => (
                      <tr key={s.step} className={`border-b border-slate-100 last:border-0 ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}`}>
                        <td className="py-3 px-3 text-center align-top">
                          <span className="w-6 h-6 inline-flex items-center justify-center rounded-full bg-[#EDE9FE] text-[#7C3AED] text-[11px] font-bold">{s.step}</span>
                        </td>
                        <td className="py-3 px-4 text-slate-700 leading-relaxed align-top">{s.action}</td>
                        <td className="py-3 px-4 text-slate-500 leading-relaxed align-top">{s.expected}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-slate-200 py-14 text-center shadow-sm">
                <div className="text-[28px] mb-3">📋</div>
                <div className="text-[14px] font-medium text-slate-600 mb-1">No plan steps yet</div>
                <div className="text-[13px] text-slate-400">Go to Author Agent → Plan mode to generate them.</div>
              </div>
            )
          )}

          {/* Automated Steps */}
          {tab === 'automated' && (
            autoSteps.length > 0 ? (
              <div className="space-y-2">
                {autoSteps.map((step, i) => (
                  <div key={i} className="flex gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-sm">
                    <div className="w-6 h-6 rounded-full bg-[#7C3AED] text-white text-[11px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                      {step.stepNumber ?? i + 1}
                    </div>
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-slate-800">{step.action}</div>
                      <div className="text-[12px] text-slate-500 mt-0.5 leading-relaxed">{step.detail}</div>
                      <div className="text-[11px] text-[#7C3AED] mt-0.5 font-medium uppercase tracking-wide">
                        {step.type}{step.tool ? ` · ${step.tool}` : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-slate-200 py-14 text-center shadow-sm">
                <div className="text-[28px] mb-3">⚡</div>
                <div className="text-[14px] font-medium text-slate-600 mb-1">Not automated yet</div>
                <div className="text-[13px] text-slate-400">Run this test case from the Author Agent to generate automated steps.</div>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  )
}
