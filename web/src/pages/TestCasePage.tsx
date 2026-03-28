import { useState, useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { getTestCase, saveRunRecord, updateReplayScript, updateTestCaseSteps } from '../lib/lambdaClient'
import { callAgent } from '../lib/agentClient'

type PlanStep = { step: number; action: string; expected: string }
type PlaywrightCall = { tool: string; params: Record<string, unknown> }
type AutoStep = { stepNumber: number; type: string; tool?: string; action: string; detail: string; status?: string; playwright_calls?: PlaywrightCall[] }
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
  const [activeTab, setActiveTab] = useState<'plan' | 'automated'>('plan')

  const [runPhase, setRunPhase] = useState<RunPhase>('idle')
  const [runResult, setRunResult] = useState<{ passed: boolean; summary: string } | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const tabRef = useRef<Window | null>(null)
  const sessionId = useRef(crypto.randomUUID())
  const isReplayMode = useRef(false)

  // Automate flow (for non-automated test cases)
  const [automatePhase, setAutomatePhase] = useState<RunPhase>('idle')
  const [automateResult, setAutomateResult] = useState<{ passed: boolean; summary: string } | null>(null)
  const [automateError, setAutomateError] = useState<string | null>(null)
  const [stepsSaveState, setStepsSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [showReAutomateConfirm, setShowReAutomateConfirm] = useState(false)
  const replayScriptRef = useRef<object[]>([])
  const resultStepsRef = useRef<AutoStep[]>([])
  const automateAbortedRef = useRef(false)
  const sessionInfoRef = useRef<{ task_arn?: string; cluster?: string }>({})

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

    const tabTitle = `${tc.id} — ${tc.title || tc.description}`
    const loadingHtmlWithTitle = loadingHtml.replace(
      '<title>Prompt2Test — Starting…</title>',
      `<title>${tabTitle} | Starting…</title>`
    )
    const loadingBlob = new Blob([loadingHtmlWithTitle], { type: 'text/html' })
    const loadingUrl = URL.createObjectURL(loadingBlob)
    const newTab = window.open(loadingUrl, '_blank')
    tabRef.current = newTab

    let runSessionInfo: { task_arn?: string; cluster?: string } = {}
    try {
      const sessionRaw = await callAgent(
        { inputText: tc.title || tc.description, mode: 'start_session', sessionId: sessionId.current },
        sessionId.current
      )
      const session = JSON.parse(sessionRaw)
      if (session.error) throw new Error(session.error as string)
      runSessionInfo = { task_arn: session.task_arn, cluster: session.cluster }

      URL.revokeObjectURL(loadingUrl)
      if (newTab) newTab.location.href = `${session.novnc_url}?autoconnect=true&resize=scale`
      setRunPhase('running')

      const replayScript = (tc as any).replayScript
      const useReplay = Array.isArray(replayScript) && replayScript.length > 0
      isReplayMode.current = useReplay

      const plan = { summary: tc.title || tc.description, steps, mcpCalls: 0 }
      const raw = await callAgent(
        useReplay
          ? {
              inputText: tc.title || tc.description,
              mode: 'replay',
              replay_script: replayScript,
              sessionId: sessionId.current,
              task_arn: session.task_arn,
              cluster: session.cluster,
              mcp_endpoint: session.mcp_endpoint,
            }
          : {
              inputText: tc.title || tc.description,
              mode: 'automate',
              plan,
              sessionId: sessionId.current,
              task_arn: session.task_arn,
              cluster: session.cluster,
              mcp_endpoint: session.mcp_endpoint,
            },
        sessionId.current
      )

      const result = JSON.parse(raw)
      // Check both top-level error (from main.py exception handler) and nested result error
      const topError = result.error
      const innerError = result.result?.error
      if (topError) throw new Error(topError as string)
      if (innerError) throw new Error(innerError as string)

      const passed = result.result?.passed ?? result.passed
      const summary = result.result?.summary ?? result.summary ?? ''

      saveRunRecord({ testCaseId: tc.id, env: tc.env, result: passed ? 'PASS' : 'FAIL', summary }).catch(() => {})
      setRunResult({ passed, summary })
      setRunPhase('done')
      tabRef.current?.close()
      tabRef.current = null
    } catch (err) {
      URL.revokeObjectURL(loadingUrl)
      tabRef.current?.close()
      tabRef.current = null
      setRunError(err instanceof Error ? err.message : String(err))
      setRunPhase('error')
    } finally {
      // Always stop the ECS task — prevents zombie tasks on failure, abort, or error
      if (runSessionInfo.task_arn && runSessionInfo.cluster) {
        callAgent({ inputText: '', mode: 'stop_session', task_arn: runSessionInfo.task_arn, cluster: runSessionInfo.cluster }, sessionId.current).catch(() => {})
      }
    }
  }

  async function automateTest() {
    if (!tc || automatePhase === 'starting' || automatePhase === 'running') return
    const planSteps = (tc.planSteps ?? []) as PlanStep[]
    if (!planSteps.length) return

    setAutomatePhase('starting')
    setAutomateResult(null)
    setAutomateError(null)
    setStepsSaveState('idle')
    replayScriptRef.current = []
    automateAbortedRef.current = false

    const label = tc.title || tc.description
    const tabTitle = `${tc.id} — ${label}`
    const loadingHtmlWithTitle = loadingHtml.replace(
      '<title>Prompt2Test — Starting…</title>',
      `<title>${tabTitle} | Automating…</title>`
    )
    const loadingBlob = new Blob([loadingHtmlWithTitle], { type: 'text/html' })
    const loadingUrl = URL.createObjectURL(loadingBlob)
    const newTab = window.open(loadingUrl, '_blank')
    tabRef.current = newTab

    const derivedPlan = {
      summary: label,
      steps: planSteps.map(s => ({ stepNumber: s.step, type: 'browser', action: s.action, detail: s.expected })),
      mcpCalls: planSteps.length,
    }

    let sessionInfo: { task_arn?: string; cluster?: string } = {}
    try {
      const sessionRaw = await callAgent(
        { inputText: label, mode: 'start_session', sessionId: sessionId.current },
        sessionId.current
      )
      const session = JSON.parse(sessionRaw)
      if (session.error) throw new Error(session.error as string)
      sessionInfo = { task_arn: session.task_arn, cluster: session.cluster }
      sessionInfoRef.current = sessionInfo

      URL.revokeObjectURL(loadingUrl)
      if (newTab) newTab.location.href = `${session.novnc_url}?autoconnect=true&resize=scale`
      setAutomatePhase('running')

      const raw = await callAgent({
        inputText: label,
        mode: 'automate',
        plan: derivedPlan,
        sessionId: sessionId.current,
        task_arn: session.task_arn,
        cluster: session.cluster,
        mcp_endpoint: session.mcp_endpoint,
      }, sessionId.current)

      const result = JSON.parse(raw)
      // Check both top-level error (from main.py exception handler) and nested result error
      const topError = result.error
      const innerError = result.result?.error
      if (topError) throw new Error(topError as string)
      if (innerError) throw new Error(innerError as string)

      if (automateAbortedRef.current) return
      const passed = result.result?.passed ?? result.passed
      const summary = result.result?.summary ?? result.summary ?? ''
      replayScriptRef.current = result.result?.replay_script ?? result.replay_script ?? []
      resultStepsRef.current = (result.result?.steps ?? result.steps ?? []).map((s: any, i: number) => ({
        stepNumber: s.stepNumber ?? i + 1,
        type: 'browser',
        action: s.action ?? '',
        detail: s.detail ?? '',
        status: s.status ?? 'passed',
        playwright_calls: s.playwright_calls ?? [],
      }))

      saveRunRecord({ testCaseId: tc.id, env: tc.env, result: passed ? 'PASS' : 'FAIL', summary }).catch(() => {})
      setAutomateResult({ passed, summary })
      setAutomatePhase('done')
      tabRef.current?.close()
      tabRef.current = null
    } catch (err) {
      URL.revokeObjectURL(loadingUrl)
      tabRef.current?.close()
      tabRef.current = null
      setAutomateError(err instanceof Error ? err.message : String(err))
      setAutomatePhase('error')
    } finally {
      // Always stop the ECS task — prevents zombie tasks on failure, abort, or error
      if (sessionInfo.task_arn && sessionInfo.cluster) {
        callAgent({ inputText: '', mode: 'stop_session', task_arn: sessionInfo.task_arn, cluster: sessionInfo.cluster }, sessionId.current).catch(() => {})
      }
    }
  }

  if (loading) return (
    <div style={{ minHeight: '100vh', background: '#FAFBFF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#64748B' }}>
        <div style={{ width: 16, height: 16, border: '2px solid #7C3AED', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
        <span style={{ fontSize: 14 }}>Loading test case…</span>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )

  if (error || !tc) return (
    <div style={{ minHeight: '100vh', background: '#FAFBFF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div style={{ fontSize: 14, color: '#991B1B' }}>{error ?? 'Test case not found.'}</div>
    </div>
  )

  const planSteps = (tc.planSteps ?? []) as PlanStep[]
  const autoSteps = (tc.steps ?? []) as AutoStep[]
  const replaySteps = ((tc as any).replayScript ?? []) as { tool: string; params: Record<string, unknown> }[]
  const isAutomated = autoSteps.length > 0 || replaySteps.length > 0
  const isRunning = runPhase === 'starting' || runPhase === 'running'

  // Status bar colors — light theme tokens
  const statusBg =
    runPhase === 'done' && runResult?.passed ? '#F0FDF4' :
    runPhase === 'done' ? '#FEF2F2' :
    runPhase === 'error' ? '#FEF2F2' : '#EDE9FE'
  const statusBorder =
    runPhase === 'done' && runResult?.passed ? '#BBF7D0' :
    runPhase === 'done' ? '#FECACA' :
    runPhase === 'error' ? '#FECACA' : '#DDD6FE'
  const statusColor =
    runPhase === 'done' && runResult?.passed ? '#166534' :
    runPhase === 'done' ? '#991B1B' :
    runPhase === 'error' ? '#991B1B' : '#6D28D9'

  return (
    <div style={{ height: '100vh', background: '#FAFBFF', display: 'flex', flexDirection: 'column', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', overflow: 'hidden' }}>

      {/* Top nav bar */}
      <div style={{ background: 'white', borderBottom: '1px solid #E8EBF0', padding: '0 20px', height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Logo — click to go home */}
          <a href="/" style={{ display: 'flex', alignItems: 'center', gap: 6, marginRight: 4, textDecoration: 'none' }}>
            <img src="/favicon.svg" width="24" height="24" alt="Prompt2Test" />
            <span style={{ fontSize: 13, fontWeight: 700, color: '#0F172A', letterSpacing: '-0.3px' }}>Prompt2Test</span>
          </a>
          <svg viewBox="0 0 24 24" style={{ width: 14, height: 14, stroke: '#94A3B8', fill: 'none', strokeWidth: 2 }}><polyline points="9 18 15 12 9 6"/></svg>
          <span style={{ fontSize: 13, color: '#64748B' }}>Test Case</span>
        </div>
      </div>

      {/* Hero — gradient strip with TC metadata */}
      <div style={{ background: 'linear-gradient(135deg, #7C3AED 0%, #4F46E5 50%, #0EA5E9 100%)', padding: '16px 24px', flexShrink: 0 }}>
        {/* Badges row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'rgba(255,255,255,0.7)', background: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 4, padding: '2px 6px' }}>{tc.id}</span>
          {tc.service && (
            <span style={{ fontSize: 11, fontWeight: 600, color: 'white', background: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 20, padding: '2px 8px' }}>{tc.service}</span>
          )}
          {tc.env && (
            <span style={{ fontSize: 11, fontWeight: 600, color: 'white', background: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 20, padding: '2px 8px' }}>{tc.env.toUpperCase()}</span>
          )}
          {tc.lastResult && (
            <span style={{
              fontSize: 11, fontWeight: 700, borderRadius: 20, padding: '2px 8px',
              color: tc.lastResult === 'PASS' ? '#166534' : '#991B1B',
              background: tc.lastResult === 'PASS' ? '#DCFCE7' : '#FEE2E2',
              border: `1px solid ${tc.lastResult === 'PASS' ? '#BBF7D0' : '#FECACA'}`,
            }}>
              {tc.lastResult === 'PASS' ? '✓' : '✕'} {tc.lastResult}
            </span>
          )}
          <span style={{
            fontSize: 11, fontWeight: 600, borderRadius: 20, padding: '2px 8px',
            color: isAutomated ? 'white' : 'rgba(255,255,255,0.7)',
            background: 'rgba(255,255,255,0.2)',
            border: '1px solid rgba(255,255,255,0.3)',
          }}>
            {isAutomated ? '⚡ Automated' : 'Manual'}
          </span>
        </div>

        {/* Title */}
        <div style={{ fontSize: 18, fontWeight: 700, color: 'white', lineHeight: 1.3, letterSpacing: '-0.3px' }}>
          {tc.title || tc.description}
        </div>
      </div>

      {/* Run status bar */}
      {runPhase !== 'idle' && (
        <div style={{ padding: '10px 24px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, background: statusBg, borderBottom: `1px solid ${statusBorder}`, color: statusColor, flexShrink: 0 }}>
          {isRunning && <div style={{ width: 13, height: 13, border: `2px solid ${statusColor}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite', flexShrink: 0 }} />}
          <span style={{ fontWeight: 600 }}>
            {runPhase === 'starting' && 'Launching browser… (~60s for Fargate cold start)'}
            {runPhase === 'running' && (isReplayMode.current ? 'Test is running (no LLM — direct replay)' : 'Test is running — watch it in the browser tab')}
            {runPhase === 'done' && (runResult?.passed ? '✅ Test Passed' : '❌ Test Failed')}
            {runPhase === 'error' && '⚠️ Execution failed'}
          </span>
          {runResult?.summary && <span style={{ fontSize: 12, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>— {runResult.summary}</span>}
          {runError && <span style={{ fontSize: 12, opacity: 0.7, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>— {runError}</span>}
          <button
            onClick={() => { setRunPhase('idle'); setRunResult(null); setRunError(null) }}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: statusColor, opacity: 0.5, fontSize: 16, padding: '0 2px', lineHeight: 1 }}
          >×</button>
        </div>
      )}

      {/* Automate status bar */}
      {automatePhase !== 'idle' && (
        <div style={{
          padding: '10px 24px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, flexShrink: 0,
          background: automatePhase === 'done' && automateResult?.passed ? '#F0FDF4' : automatePhase === 'done' ? '#FEF2F2' : automatePhase === 'error' ? '#FEF2F2' : '#FFFBEB',
          borderBottom: `1px solid ${automatePhase === 'done' && automateResult?.passed ? '#BBF7D0' : automatePhase === 'done' ? '#FECACA' : automatePhase === 'error' ? '#FECACA' : '#FDE68A'}`,
          color: automatePhase === 'done' && automateResult?.passed ? '#166534' : automatePhase === 'done' ? '#991B1B' : automatePhase === 'error' ? '#991B1B' : '#92400E',
        }}>
          {(automatePhase === 'starting' || automatePhase === 'running') && (
            <div style={{ width: 13, height: 13, border: '2px solid #92400E', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite', flexShrink: 0 }} />
          )}
          <span style={{ fontWeight: 600 }}>
            {automatePhase === 'starting' && 'Launching browser… (~60s for Fargate cold start)'}
            {automatePhase === 'running' && 'Automating test — watch it live in the browser tab'}
            {automatePhase === 'done' && (automateResult?.passed ? '✅ Test Passed — save automated steps?' : '❌ Test Failed')}
            {automatePhase === 'error' && '⚠️ Automation failed'}
          </span>
          {(automatePhase === 'starting' || automatePhase === 'running') && (
            <button
              onClick={() => {
                automateAbortedRef.current = true
                tabRef.current?.close()
                tabRef.current = null
                setAutomatePhase('idle')
                setAutomateResult(null)
                setAutomateError(null)
                const si = sessionInfoRef.current
                if (si.task_arn && si.cluster) {
                  callAgent({ inputText: '', mode: 'stop_session', task_arn: si.task_arn, cluster: si.cluster }, sessionId.current).catch(() => {})
                }
              }}
              style={{ marginLeft: 'auto', padding: '3px 10px', borderRadius: 6, background: '#FFFBEB', border: '1px solid #FDE68A', color: '#92400E', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
            >Stop</button>
          )}
          {automateResult?.summary && <span style={{ fontSize: 12, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>— {automateResult.summary}</span>}
          {automateError && <span style={{ fontSize: 12, opacity: 0.7, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>— {automateError}</span>}
          {automatePhase === 'done' && automateResult?.passed && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
              {stepsSaveState === 'saved' ? (
                <span style={{ fontSize: 12, fontWeight: 600, color: '#166534' }}>✓ Steps saved</span>
              ) : (
                <>
                  <button
                    onClick={async () => {
                      if (!tc || stepsSaveState === 'saving') return
                      setStepsSaveState('saving')
                      try {
                        const stepsToSave = resultStepsRef.current.length > 0
                          ? resultStepsRef.current
                          : ((tc.planSteps ?? []) as PlanStep[]).map((s: PlanStep) => ({ stepNumber: s.step, type: 'browser', action: s.action, detail: s.expected, playwright_calls: [] }))
                        await updateTestCaseSteps(tc.id, stepsToSave)
                        if (replayScriptRef.current.length > 0) {
                          await updateReplayScript(tc.id, replayScriptRef.current)
                        }
                        setStepsSaveState('saved')
                        setTc(prev => prev ? { ...prev, steps: stepsToSave, replayScript: replayScriptRef.current } as any : prev)
                      } catch {
                        setStepsSaveState('idle')
                      }
                    }}
                    disabled={stepsSaveState === 'saving'}
                    style={{ padding: '4px 12px', borderRadius: 6, background: '#D97706', color: 'white', border: 'none', cursor: stepsSaveState === 'saving' ? 'default' : 'pointer', fontSize: 12, fontWeight: 600, opacity: stepsSaveState === 'saving' ? 0.7 : 1 }}
                  >
                    {stepsSaveState === 'saving' ? 'Saving…' : 'Save Steps'}
                  </button>
                  <button
                    onClick={() => setAutomatePhase('idle')}
                    style={{ padding: '4px 10px', borderRadius: 6, background: '#FFFBEB', color: '#92400E', border: '1px solid #FDE68A', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                  >
                    Discard
                  </button>
                </>
              )}
            </div>
          )}
          {(automatePhase === 'done' && !automateResult?.passed || automatePhase === 'error') && (
            <button
              onClick={() => { setAutomatePhase('idle'); setAutomateResult(null); setAutomateError(null) }}
              style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#991B1B', opacity: 0.6, fontSize: 16, padding: '0 2px', lineHeight: 1 }}
            >×</button>
          )}
        </div>
      )}

      {/* Tabs */}
      <div style={{ background: 'white', borderBottom: '1px solid #E8EBF0', padding: '0 24px', display: 'flex', flexShrink: 0 }}>
        {(['plan', 'automated'] as const).map(t => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            style={{
              padding: '12px 4px', marginRight: 24, fontSize: 13, fontWeight: 600, cursor: 'pointer',
              background: 'none', border: 'none', borderBottom: `2px solid ${activeTab === t ? '#4F46E5' : 'transparent'}`,
              color: activeTab === t ? '#4F46E5' : '#64748B',
              transition: 'all 0.15s',
            }}
          >
            {t === 'plan' ? '📋 Plan Steps' : `⚡ Automated Steps${autoSteps.length > 0 ? ` (${autoSteps.length})` : ''}`}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', background: '#FAFBFF' }}>
        <div style={{ maxWidth: 860, margin: '0 auto' }}>

          {/* Plan Steps */}
          {activeTab === 'plan' && (
            planSteps.length > 0 ? (
              <>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12, gap: 8 }}>
                {(automatePhase === 'starting' || automatePhase === 'running') && (
                  <button
                    onClick={() => {
                      automateAbortedRef.current = true
                      tabRef.current?.close()
                      tabRef.current = null
                      setAutomatePhase('idle')
                      setAutomateResult(null)
                      setAutomateError(null)
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, background: 'white', color: '#64748B', border: '1px solid #E2E8F0', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                  >
                    <svg viewBox="0 0 24 24" style={{ width: 13, height: 13, fill: '#64748B' }}><rect x="3" y="3" width="18" height="18" rx="2"/></svg>Stop
                  </button>
                )}
                {isAutomated ? (
                  <button
                    onClick={() => setShowReAutomateConfirm(true)}
                    disabled={automatePhase === 'starting' || automatePhase === 'running'}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, background: 'white', color: '#D97706', border: '1px solid #FCD34D', cursor: (automatePhase === 'starting' || automatePhase === 'running') ? 'default' : 'pointer', fontSize: 13, fontWeight: 600, opacity: (automatePhase === 'starting' || automatePhase === 'running') ? 0.5 : 1 }}
                    onMouseEnter={e => { if (automatePhase === 'idle') { (e.currentTarget as HTMLButtonElement).style.background = '#FFFBEB' } }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'white' }}
                  >
                    <svg viewBox="0 0 24 24" style={{ width: 13, height: 13, stroke: '#D97706', fill: 'none', strokeWidth: 2 }}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                    Re-Automate
                  </button>
                ) : (
                  <button onClick={automateTest} disabled={automatePhase === 'starting' || automatePhase === 'running'}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', cursor: (automatePhase === 'starting' || automatePhase === 'running') ? 'default' : 'pointer', fontSize: 13, fontWeight: 600, opacity: (automatePhase === 'starting' || automatePhase === 'running') ? 0.75 : 1, boxShadow: '0 2px 8px rgba(124,58,237,0.35)' }}
                    onMouseEnter={e => { if (automatePhase === 'idle') (e.currentTarget as HTMLButtonElement).style.opacity = '0.9' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = (automatePhase === 'starting' || automatePhase === 'running') ? '0.75' : '1' }}
                  >
                    {automatePhase === 'starting' || automatePhase === 'running' ? (
                      <><div style={{ width: 13, height: 13, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: 'white', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />{automatePhase === 'starting' ? 'Starting…' : 'Automating…'}</>
                    ) : (
                      <><svg viewBox="0 0 24 24" style={{ width: 13, height: 13, stroke: 'white', fill: 'none', strokeWidth: 2 }}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>Automate</>
                    )}
                  </button>
                )}
              </div>
              <div style={{ borderRadius: 12, overflow: 'hidden', background: 'white', border: '1px solid #E8EBF0', boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#F8FAFC', borderBottom: '1px solid #E8EBF0' }}>
                      <th style={{ padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em', width: 40 }}>#</th>
                      <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em', width: '46%' }}>Action</th>
                      <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Expected Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {planSteps.map((s, i) => (
                      <tr key={s.step} style={{ borderBottom: i < planSteps.length - 1 ? '1px solid #E8EBF0' : 'none', background: i % 2 === 0 ? 'transparent' : '#FAFBFF' }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#F8FAFC')}
                        onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : '#FAFBFF')}
                      >
                        <td style={{ padding: '12px', textAlign: 'center', verticalAlign: 'top' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', background: '#EDE9FE', color: '#7C3AED', fontSize: 11, fontWeight: 700 }}>{s.step}</span>
                        </td>
                        <td style={{ padding: '12px 16px', color: '#0F172A', lineHeight: 1.6, verticalAlign: 'top' }}>{s.action}</td>
                        <td style={{ padding: '12px 16px', color: '#64748B', lineHeight: 1.6, verticalAlign: 'top' }}>{s.expected}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>) : (
              <div style={{ background: 'white', borderRadius: 12, border: '1px solid #E8EBF0', padding: '56px 24px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04)' }}>
                <div style={{ fontSize: 28, marginBottom: 12 }}>📋</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#64748B', marginBottom: 4 }}>No plan steps yet</div>
                <div style={{ fontSize: 13, color: '#94A3B8' }}>Go to Author Agent → Plan mode to generate them.</div>
              </div>
            )
          )}

          {/* Automated Steps */}
          {activeTab === 'automated' && (
            (autoSteps.length > 0 || replaySteps.length > 0) ? (
              <>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                <button onClick={runTest} disabled={isRunning}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', cursor: isRunning ? 'default' : 'pointer', fontSize: 13, fontWeight: 600, opacity: isRunning ? 0.75 : 1, boxShadow: '0 2px 8px rgba(124,58,237,0.35)' }}
                  onMouseEnter={e => { if (!isRunning) (e.currentTarget as HTMLButtonElement).style.opacity = '0.9' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = isRunning ? '0.75' : '1' }}
                >
                  {isRunning ? (
                    <><div style={{ width: 13, height: 13, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: 'white', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />{runPhase === 'starting' ? 'Starting…' : 'Running…'}</>
                  ) : (
                    <><svg viewBox="0 0 24 24" style={{ width: 13, height: 13, stroke: 'white', fill: 'white' }}><polygon points="5 3 19 12 5 21 5 3"/></svg>Run Test</>
                  )}
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {autoSteps.map((step, i) => {
                    const stepStatusColor = step.status === 'failed' ? '#991B1B' : step.status === 'skipped' ? '#92400E' : '#166534'
                    const stepStatusBadgeBg = step.status === 'failed' ? '#FEE2E2' : step.status === 'skipped' ? '#FFFBEB' : '#DCFCE7'
                    const stepStatusBadgeBorder = step.status === 'failed' ? '#FECACA' : step.status === 'skipped' ? '#FDE68A' : '#BBF7D0'
                    const calls = step.playwright_calls ?? []
                    return (
                      <div key={i} style={{ background: 'white', borderRadius: 12, border: '1px solid #E8EBF0', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04)' }}>
                        {/* Step header */}
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 18px', borderBottom: calls.length > 0 ? '1px solid #E8EBF0' : 'none', background: '#FAFBFF' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: '50%', background: '#EDE9FE', color: '#7C3AED', fontSize: 12, fontWeight: 700, flexShrink: 0, marginTop: 1 }}>{step.stepNumber}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A', marginBottom: step.detail ? 4 : 0 }}>{step.action}</div>
                            {step.detail && <div style={{ fontSize: 12, color: '#64748B', lineHeight: 1.5 }}>{step.detail}</div>}
                          </div>
                          {step.status && (
                            <span style={{ fontSize: 11, fontWeight: 700, color: stepStatusColor, background: stepStatusBadgeBg, border: `1px solid ${stepStatusBadgeBorder}`, borderRadius: 6, padding: '2px 8px', flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{step.status}</span>
                          )}
                        </div>
                        {/* Playwright MCP calls for this step */}
                        {calls.length > 0 && (
                          <div style={{ padding: '10px 18px 12px 18px' }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Playwright MCP Calls</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {calls.map((call, j) => {
                                const friendlyName = call.tool.replace(/^(playwright_|browser_)/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                                const paramEntries = Object.entries(call.params).filter(([k, v]) => k !== 'ref' && v !== undefined && v !== null && v !== '')
                                return (
                                  <div key={j} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 12px', background: '#F8FAFC', borderRadius: 8, border: '1px solid #E2E8F0' }}>
                                    <div style={{ minWidth: 180, flexShrink: 0 }}>
                                      <div style={{ fontSize: 12, fontWeight: 700, color: '#0F172A', marginBottom: 3 }}>{friendlyName}</div>
                                      <code style={{ fontSize: 10, color: '#7C3AED', background: '#EDE9FE', padding: '1px 6px', borderRadius: 4, fontFamily: 'monospace' }}>{call.tool}</code>
                                    </div>
                                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
                                      {paramEntries.length === 0 ? (
                                        <span style={{ fontSize: 12, color: '#94A3B8', fontStyle: 'italic' }}>no parameters</span>
                                      ) : paramEntries.map(([key, val]) => (
                                        <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                                          <span style={{ fontSize: 11, fontWeight: 600, color: '#64748B', minWidth: 64, flexShrink: 0, paddingTop: 1 }}>{key}</span>
                                          <span style={{ fontSize: 11, color: '#334155', fontFamily: 'monospace', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 4, padding: '1px 6px', wordBreak: 'break-all', lineHeight: 1.5 }}>{typeof val === 'object' ? JSON.stringify(val) : String(val)}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
            </>) : (
              <div style={{ background: 'white', borderRadius: 12, border: '1px solid #E8EBF0', padding: '56px 24px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04)' }}>
                <div style={{ fontSize: 28, marginBottom: 12 }}>⚡</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#64748B', marginBottom: 4 }}>Not automated yet</div>
                <div style={{ fontSize: 13, color: '#94A3B8' }}>Switch to Plan Steps tab and click Automate to record and save automation steps.</div>
              </div>
            )
          )}
        </div>
      </div>

      {/* Re-Automate confirmation dialog */}
      {showReAutomateConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', border: '1px solid #E8EBF0', borderRadius: 14, padding: '28px 28px 22px', maxWidth: 420, width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }}>
            <div style={{ fontSize: 22, marginBottom: 10 }}>⚠️</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', marginBottom: 8 }}>Re-automate this test?</div>
            <div style={{ fontSize: 13, color: '#64748B', lineHeight: 1.6, marginBottom: 22 }}>
              This will run a new LLM-driven automation session and <strong style={{ color: '#0F172A' }}>erase the previously saved steps and replay script</strong>. You'll need to save the new steps again after it completes.
              <br/><br/>Do you want to proceed?
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowReAutomateConfirm(false)}
                style={{ padding: '7px 16px', borderRadius: 8, background: 'white', color: '#64748B', border: '1px solid #E2E8F0', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
              >Cancel</button>
              <button
                onClick={() => { setShowReAutomateConfirm(false); automateTest() }}
                style={{ padding: '7px 16px', borderRadius: 8, background: 'white', color: '#D97706', border: '1px solid #FCD34D', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
              >Yes, Re-Automate</button>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
