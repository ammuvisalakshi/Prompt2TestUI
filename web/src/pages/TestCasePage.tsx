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
  const [activeTab, setActiveTab] = useState<'plan' | 'automated'>('plan')

  const [runPhase, setRunPhase] = useState<RunPhase>('idle')
  const [runResult, setRunResult] = useState<{ passed: boolean; summary: string } | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const tabRef = useRef<Window | null>(null)
  const sessionId = useRef(crypto.randomUUID())
  const isReplayMode = useRef(false)

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

    try {
      const sessionRaw = await callAgent(
        { inputText: tc.title || tc.description, mode: 'start_session', sessionId: sessionId.current },
        sessionId.current
      )
      const session = JSON.parse(sessionRaw)
      if (session.error) throw new Error(session.error as string)

      URL.revokeObjectURL(loadingUrl)
      if (newTab) newTab.location.href = `${session.novnc_url}?autoconnect=true&resize=scale`
      setRunPhase('running')

      const replayScript = (tc as any).replayScript
      const useReplay = Array.isArray(replayScript) && replayScript.length > 0
      isReplayMode.current = useReplay

      if (useReplay) {
        setRunPhase('running')
      }

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
      if (result.error) throw new Error(result.error as string)

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
    }
  }

  if (loading) return (
    <div style={{ minHeight: '100vh', background: '#F5F7FA', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#94A3B8' }}>
        <div style={{ width: 16, height: 16, border: '2px solid #7C3AED', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
        <span style={{ fontSize: 14 }}>Loading test case…</span>
      </div>
    </div>
  )

  if (error || !tc) return (
    <div style={{ minHeight: '100vh', background: '#F5F7FA', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div style={{ fontSize: 14, color: '#EF4444' }}>{error ?? 'Test case not found.'}</div>
    </div>
  )

  const planSteps = (tc.planSteps ?? []) as PlanStep[]
  const autoSteps = (tc.steps ?? []) as AutoStep[]
  const isAutomated = autoSteps.length > 0
  const isRunning = runPhase === 'starting' || runPhase === 'running'

  // Status bar colors
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
    <div style={{ height: '100vh', background: '#F1F5F9', display: 'flex', flexDirection: 'column', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', overflow: 'hidden' }}>

      {/* Top nav bar */}
      <div style={{ background: 'white', borderBottom: '1px solid #E2E8F0', padding: '0 20px', height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Logo */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginRight: 4 }}>
            <div style={{ width: 24, height: 24, borderRadius: 6, background: 'linear-gradient(135deg, #7C3AED, #A855F7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg viewBox="0 0 24 24" style={{ width: 13, height: 13, stroke: 'white', fill: 'none', strokeWidth: 2.5 }}><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#1E293B', letterSpacing: '-0.3px' }}>Prompt2Test</span>
          </div>
          <svg viewBox="0 0 24 24" style={{ width: 14, height: 14, stroke: '#CBD5E1', fill: 'none', strokeWidth: 2 }}><polyline points="9 18 15 12 9 6"/></svg>
          <span style={{ fontSize: 13, color: '#64748B' }}>Test Case</span>
        </div>

        {/* Run button */}
        {isAutomated && (
          <button
            onClick={runTest}
            disabled={isRunning}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 16px', borderRadius: 8,
              background: isRunning ? '#7C3AED' : '#7C3AED',
              color: 'white', border: 'none', cursor: isRunning ? 'default' : 'pointer',
              fontSize: 13, fontWeight: 600, opacity: isRunning ? 0.75 : 1,
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => { if (!isRunning) (e.currentTarget as HTMLButtonElement).style.background = '#5B21B6' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#7C3AED' }}
          >
            {isRunning ? (
              <>
                <div style={{ width: 13, height: 13, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: 'white', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                {runPhase === 'starting' ? 'Starting…' : 'Running…'}
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" style={{ width: 13, height: 13, stroke: 'white', fill: 'white' }}><polygon points="5 3 19 12 5 21 5 3"/></svg>
                Run Test
              </>
            )}
          </button>
        )}
      </div>

      {/* Hero — TC metadata */}
      <div style={{ background: 'white', borderBottom: '1px solid #E2E8F0', padding: '16px 24px', flexShrink: 0 }}>
        {/* Badges row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#94A3B8', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 4, padding: '2px 6px' }}>{tc.id}</span>
          {tc.service && (
            <span style={{ fontSize: 11, fontWeight: 600, color: '#7C3AED', background: '#EDE9FE', border: '1px solid #DDD6FE', borderRadius: 20, padding: '2px 8px' }}>{tc.service}</span>
          )}
          {tc.env && (
            <span style={{ fontSize: 11, fontWeight: 600, color: '#0369A1', background: '#E0F2FE', border: '1px solid #BAE6FD', borderRadius: 20, padding: '2px 8px' }}>{tc.env.toUpperCase()}</span>
          )}
          {tc.lastResult && (
            <span style={{
              fontSize: 11, fontWeight: 700, borderRadius: 20, padding: '2px 8px',
              color: tc.lastResult === 'PASS' ? '#166534' : '#991B1B',
              background: tc.lastResult === 'PASS' ? '#F0FDF4' : '#FEF2F2',
              border: `1px solid ${tc.lastResult === 'PASS' ? '#BBF7D0' : '#FECACA'}`,
            }}>
              {tc.lastResult === 'PASS' ? '✓' : '✕'} {tc.lastResult}
            </span>
          )}
          <span style={{
            fontSize: 11, fontWeight: 600, borderRadius: 20, padding: '2px 8px',
            color: isAutomated ? '#7C3AED' : '#94A3B8',
            background: isAutomated ? '#EDE9FE' : '#F8FAFC',
            border: `1px solid ${isAutomated ? '#DDD6FE' : '#E2E8F0'}`,
          }}>
            {isAutomated ? '⚡ Automated' : 'Manual'}
          </span>
        </div>

        {/* Title */}
        <div style={{ fontSize: 18, fontWeight: 700, color: '#0F172A', lineHeight: 1.3, letterSpacing: '-0.3px' }}>
          {tc.title || tc.description}
        </div>
      </div>

      {/* Status bar */}
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

      {/* Tabs */}
      <div style={{ background: 'white', borderBottom: '1px solid #E2E8F0', padding: '0 24px', display: 'flex', flexShrink: 0 }}>
        {(['plan', 'automated'] as const).map(t => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            style={{
              padding: '12px 4px', marginRight: 24, fontSize: 13, fontWeight: 600, cursor: 'pointer',
              background: 'none', border: 'none', borderBottom: `2px solid ${activeTab === t ? '#7C3AED' : 'transparent'}`,
              color: activeTab === t ? '#7C3AED' : '#94A3B8',
              transition: 'all 0.15s',
            }}
          >
            {t === 'plan' ? '📋 Plan Steps' : `⚡ Automated Steps${autoSteps.length > 0 ? ` (${autoSteps.length})` : ''}`}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
        <div style={{ maxWidth: 860, margin: '0 auto' }}>

          {/* Plan Steps */}
          {activeTab === 'plan' && (
            planSteps.length > 0 ? (
              <div style={{ background: 'white', borderRadius: 12, border: '1px solid #E2E8F0', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#F8FAFC', borderBottom: '1px solid #E2E8F0' }}>
                      <th style={{ padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', width: 40 }}>#</th>
                      <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', width: '46%' }}>Action</th>
                      <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Expected Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {planSteps.map((s, i) => (
                      <tr key={s.step} style={{ borderBottom: i < planSteps.length - 1 ? '1px solid #F1F5F9' : 'none', background: i % 2 === 0 ? 'white' : '#FAFAFA' }}>
                        <td style={{ padding: '12px', textAlign: 'center', verticalAlign: 'top' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', background: '#EDE9FE', color: '#7C3AED', fontSize: 11, fontWeight: 700 }}>{s.step}</span>
                        </td>
                        <td style={{ padding: '12px 16px', color: '#334155', lineHeight: 1.6, verticalAlign: 'top' }}>{s.action}</td>
                        <td style={{ padding: '12px 16px', color: '#64748B', lineHeight: 1.6, verticalAlign: 'top' }}>{s.expected}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ background: 'white', borderRadius: 12, border: '1px solid #E2E8F0', padding: '56px 24px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                <div style={{ fontSize: 28, marginBottom: 12 }}>📋</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#475569', marginBottom: 4 }}>No plan steps yet</div>
                <div style={{ fontSize: 13, color: '#94A3B8' }}>Go to Author Agent → Plan mode to generate them.</div>
              </div>
            )
          )}

          {/* Automated Steps */}
          {activeTab === 'automated' && (
            autoSteps.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {autoSteps.map((step, i) => (
                  <div key={i} style={{ display: 'flex', gap: 12, background: 'white', border: '1px solid #E2E8F0', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                    <div style={{ width: 26, height: 26, borderRadius: '50%', background: '#7C3AED', color: 'white', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
                      {step.stepNumber ?? i + 1}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#1E293B', marginBottom: 3 }}>{step.action}</div>
                      <div style={{ fontSize: 12, color: '#64748B', lineHeight: 1.5, marginBottom: 4 }}>{step.detail}</div>
                      <div style={{ fontSize: 11, color: '#7C3AED', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        {step.type}{step.tool ? ` · ${step.tool}` : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ background: 'white', borderRadius: 12, border: '1px solid #E2E8F0', padding: '56px 24px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                <div style={{ fontSize: 28, marginBottom: 12 }}>⚡</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#475569', marginBottom: 4 }}>Not automated yet</div>
                <div style={{ fontSize: 13, color: '#94A3B8' }}>Run this test case from the Author Agent to generate automated steps.</div>
              </div>
            )
          )}
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
