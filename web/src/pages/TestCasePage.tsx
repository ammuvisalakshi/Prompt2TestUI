import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { fetchAuthSession } from '@aws-amplify/auth'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { getTestCase, saveRunRecord, updateReplayScript, updateTestCaseSteps } from '../lib/lambdaClient'
import { callAgent } from '../lib/agentClient'
import { useEnv } from '../context/EnvContext'
import { useTeam } from '../context/TeamContext'
import CdpViewer from '../components/CdpViewer'

const AWS_REGION = import.meta.env.VITE_AWS_REGION as string
const CONFIG_TABLE = 'prompt2test-config'

async function loadServiceConfig(team: string, env: string, service: string): Promise<{ key: string; value: string }[]> {
  if (!service) return []
  const session = await fetchAuthSession()
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION, credentials: session.credentials as never }))
  const resp = await db.send(new QueryCommand({
    TableName: CONFIG_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :svc)',
    ExpressionAttributeValues: { ':pk': `SERVICE#${team}#${env}`, ':svc': `${service}#` },
  }))
  return (resp.Items ?? []).map(item => {
    const [, ...rest] = (item.sk as string).split('#')
    return { key: rest.join('#'), value: item.val as string }
  })
}

type PlanStep = { step: number; action: string; expected: string }
type PlaywrightCall = { tool: string; params: Record<string, unknown> }
type AutoStep = { stepNumber: number; type: string; tool?: string; action: string; detail: string; status?: string; playwright_calls?: PlaywrightCall[] }
type RunPhase = 'idle' | 'starting' | 'running' | 'done' | 'error'
type ExecMode = 'automate' | 'smart_replay' | 'resume' | null
type TokenCall = { call_number: number; input_tokens: number; output_tokens: number; cumulative_input: number; cumulative_output: number }
type TokenInfo = { llm_calls: number; input_tokens: number; output_tokens: number }

function fmtNum(n: number): string {
  return n.toLocaleString()
}

function fmtCost(input: number, output: number, model: 'sonnet' | 'haiku' = 'sonnet'): string {
  const rates = model === 'haiku'
    ? { input: 0.80, output: 4.00 }   // Haiku pricing per 1M tokens
    : { input: 3.00, output: 15.00 }  // Sonnet pricing per 1M tokens
  const cost = (input / 1_000_000) * rates.input + (output / 1_000_000) * rates.output
  return cost < 0.005 ? '<$0.01' : `~$${cost.toFixed(2)}`
}


export default function TestCasePage() {
  const { id } = useParams<{ id: string }>()
  const { env } = useEnv()
  const { team } = useTeam()
  const [tc, setTc] = useState<Awaited<ReturnType<typeof getTestCase>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [serviceConfig, setServiceConfig] = useState<{ key: string; value: string }[]>([])

  // Unified execution state (replaces separate run/automate states)
  const [phase, setPhase] = useState<RunPhase>('idle')
  const [execMode, setExecMode] = useState<ExecMode>(null)
  const [result, setResult] = useState<{ passed: boolean; summary: string } | null>(null)
  const [execError, setExecError] = useState<string | null>(null)
  const [stepsSaveState, setStepsSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [showStartFreshConfirm, setShowStartFreshConfirm] = useState(false)
  const [, setTokenUsage] = useState<TokenInfo | null>(null)
  const [liveStepStatuses, setLiveStepStatuses] = useState<Record<number, string>>({}) // stepNumber → status during execution
  const [tokenCalls, setTokenCalls] = useState<TokenCall[]>([])
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set())
  const [tokenPanelWidth, setTokenPanelWidth] = useState(280)
  const isDragging = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const [cdpWsUrl, setCdpWsUrl] = useState<string | null>(null)
  const sessionId = useRef(crypto.randomUUID())
  const replayScriptRef = useRef<object[]>([])
  const resultStepsRef = useRef<AutoStep[]>([])
  const abortedRef = useRef(false)
  const sessionInfoRef = useRef<{ task_arn?: string; cluster?: string }>({})
  const stepEventQueue = useRef<{ step: number; status: string }[]>([])
  const stepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onMouseDown = useCallback(() => {
    isDragging.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const newWidth = Math.max(200, Math.min(500, rect.right - e.clientX))
      setTokenPanelWidth(newWidth)
    }
    const onMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  useEffect(() => {
    if (!id) return
    getTestCase(id)
      .then(async (data) => {
        setTc(data)
        if (data.service) {
          try {
            const cfg = await loadServiceConfig(team, env, data.service)
            setServiceConfig(cfg)
          } catch { /* ignore */ }
        }
        setLoading(false)
      })
      .catch(() => { setError('Failed to load test case.'); setLoading(false) })
  }, [id, env, team])

  function stopExecution() {
    abortedRef.current = true
    setCdpWsUrl(null)
    setPhase('idle')
    setResult(null)
    setExecError(null)
    setExecMode(null)
    const si = sessionInfoRef.current
    if (si.task_arn && si.cluster) {
      callAgent({ inputText: '', mode: 'stop_session', task_arn: si.task_arn, cluster: si.cluster }, sessionId.current).catch(() => {})
    }
  }

  // ── Unified execution function ─────────────────────────────────────────────
  async function executeTest(forceFromScratch?: boolean) {
    if (!tc || phase === 'starting' || phase === 'running') return
    const planSteps = (tc.planSteps ?? []) as PlanStep[]
    if (!planSteps.length) return

    // Build or load replay script
    let existingReplay = ((tc as any).replayScript ?? []) as PlaywrightCall[]
    const savedSteps = (tc.steps ?? []) as AutoStep[]

    // Fallback: rebuild replay script from saved steps' playwright_calls
    if (existingReplay.length === 0 && savedSteps.length > 0) {
      const rebuilt: PlaywrightCall[] = []
      for (const s of savedSteps) {
        for (const call of (s.playwright_calls ?? [])) {
          rebuilt.push(call)
        }
      }
      if (rebuilt.length > 0) existingReplay = rebuilt
    }

    // Determine execution mode
    const passedSaved = savedSteps.filter(s => s.status === 'passed')
    const failedSaved = savedSteps.filter(s => s.status === 'failed')
    const hasPartialProgress = !forceFromScratch && passedSaved.length > 0 && failedSaved.length > 0 && existingReplay.length > 0
    const resumeFromStep = hasPartialProgress ? Math.min(...failedSaved.map(s => s.stepNumber)) : undefined

    let mode: ExecMode
    if (forceFromScratch || existingReplay.length === 0) {
      mode = 'automate'
    } else if (resumeFromStep) {
      mode = 'resume'
    } else {
      mode = 'smart_replay'
    }

    // Reset state
    setPhase('starting')
    setExecMode(mode)
    setResult(null)
    setExecError(null)
    setStepsSaveState('idle')
    setTokenUsage(null)
    setTokenCalls([])
    setLiveStepStatuses({})
    stepEventQueue.current = []
    if (stepTimerRef.current) { clearTimeout(stepTimerRef.current); stepTimerRef.current = null }
    replayScriptRef.current = []
    abortedRef.current = false

    const label = tc.title || tc.description
    setCdpWsUrl(null)  // reset viewer while session starts

    // Open loading page in new tab immediately (before async, avoids popup blocker)
    const loadingPage = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Live Browser — ${label}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0f172a;display:flex;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,sans-serif;color:#e2e8f0}
div{display:flex;flex-direction:column;align-items:center;gap:8px}
h2{font-size:18px;font-weight:600}p{font-size:13px;color:#64748b}
.track{width:320px;height:6px;background:#1e293b;border-radius:3px;overflow:hidden}
.bar{height:100%;width:0%;background:linear-gradient(90deg,#7c3aed,#a855f7);border-radius:3px;animation:fill 65s cubic-bezier(0.4,0,0.2,1) forwards}
@keyframes fill{0%{width:0%}60%{width:75%}90%{width:90%}100%{width:95%}}</style></head>
<body><div><h2>Launching browser...</h2><p>Starting a dedicated Fargate task (~60s)</p>
<div class="track"><div class="bar"></div></div></div></body></html>`
    const viewerBlob = new Blob([loadingPage], { type: 'text/html' })
    const viewerTab = window.open(URL.createObjectURL(viewerBlob), '_blank')

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
      console.log('[P2T] start_session response:', JSON.stringify(session, null, 2))
      if (session.error) throw new Error(session.error as string)
      sessionInfo = { task_arn: session.task_arn, cluster: session.cluster }
      sessionInfoRef.current = sessionInfo

      setCdpWsUrl(session.cdp_ws_url ?? null)

      // DEBUG: show what we got
      const debugMsg = `cdp_ws_url: ${session.cdp_ws_url}\nviewerTab: ${viewerTab ? 'exists' : 'null'}\nclosed: ${viewerTab?.closed}`
      console.log('[P2T] DEBUG:', debugMsg)
      if (viewerTab && !viewerTab.closed) {
        try {
          viewerTab.document.title = 'Connecting...'
        } catch (e) { /* cross-origin */ }
      }

      // Navigate the viewer tab to the CDP proxy viewer page
      if (session.cdp_ws_url && viewerTab && !viewerTab.closed) {
        const httpsUrl = session.cdp_ws_url.replace('wss://', 'https://').replace('ws://', 'http://')
        console.log('[P2T] Navigating tab to:', httpsUrl)
        viewerTab.location = httpsUrl
      } else {
        console.log('[P2T] SKIP navigation:', { url: session.cdp_ws_url, tab: !!viewerTab, closed: viewerTab?.closed })
      }

      setPhase('running')

      // Build agent payload based on mode
      let agentPayload: Record<string, unknown>
      if (mode === 'resume' && resumeFromStep) {
        agentPayload = {
          inputText: label, mode: 'automate', plan: derivedPlan,
          resume_from_step: resumeFromStep, resume_script: existingReplay,
          sessionId: sessionId.current, task_arn: session.task_arn,
          cluster: session.cluster, mcp_endpoint: session.mcp_endpoint, serviceConfig,
        }
      } else if (mode === 'smart_replay') {
        agentPayload = {
          inputText: label, mode: 'smart_replay',
          replay_script: existingReplay,
          plan_steps: planSteps.map(s => ({ action: s.action, expected: s.expected, detail: s.expected })),
          sessionId: sessionId.current, task_arn: session.task_arn,
          cluster: session.cluster, mcp_endpoint: session.mcp_endpoint, serviceConfig,
        }
      } else {
        agentPayload = {
          inputText: label, mode: 'automate', plan: derivedPlan,
          sessionId: sessionId.current, task_arn: session.task_arn,
          cluster: session.cluster, mcp_endpoint: session.mcp_endpoint, serviceConfig,
        }
      }

      const raw = await callAgent(agentPayload, sessionId.current, (ev) => {
        if (ev.event === 'token_usage') {
          const t: TokenCall = {
            call_number: ev.call_number as number,
            input_tokens: ev.input_tokens as number,
            output_tokens: ev.output_tokens as number,
            cumulative_input: ev.cumulative_input as number,
            cumulative_output: ev.cumulative_output as number,
          }
          setTokenCalls(prev => [...prev, t])
        }
        // Live step-by-step updates — verified replay sends plan step numbers directly
        if (ev.event === 'step_result') {
          const stepNum = ev.step as number
          const status = ev.status as string
          if (stepNum > 0) {  // skip step 0 (noVNC wait event)
            setLiveStepStatuses(prev => ({ ...prev, [stepNum]: status }))
          }
        }
      })

      // Brief pause to let final step status render before showing result
      while (stepEventQueue.current.length > 0 || stepTimerRef.current) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }

      const parsed = JSON.parse(raw)
      if (parsed.error) throw new Error(parsed.error as string)
      if (parsed.result?.error) throw new Error(parsed.result.error as string)
      if (abortedRef.current) return

      const passed = parsed.result?.passed ?? parsed.passed
      const summary = parsed.result?.summary ?? parsed.summary ?? ''
      const tu = parsed.result?.token_usage ?? parsed.token_usage
      if (tu) setTokenUsage(tu as TokenInfo)

      // Process replay script
      const rawScript = parsed.result?.replay_script ?? parsed.replay_script ?? []
      if (serviceConfig.length > 0) {
        const replacements = serviceConfig
          .filter(c => c.key && c.value && c.value.length > 1)
          .sort((a, b) => b.value.length - a.value.length)
        replayScriptRef.current = JSON.parse(
          replacements.reduce(
            (json, c) => json.replaceAll(c.value, `{service.${c.key}}`),
            JSON.stringify(rawScript)
          )
        )
      } else {
        replayScriptRef.current = rawScript
      }

      resultStepsRef.current = (parsed.result?.steps ?? parsed.steps ?? []).map((s: any, i: number) => {
        const stepNum = s.stepNumber ?? i + 1
        // Preserve playwright_calls from previously saved steps if new result doesn't have them
        const savedStep = savedSteps.find(ss => ss.stepNumber === stepNum)
        const calls = (s.playwright_calls && s.playwright_calls.length > 0)
          ? s.playwright_calls
          : (savedStep?.playwright_calls ?? [])
        return {
          stepNumber: stepNum,
          type: 'browser',
          action: s.action || savedStep?.action || '',
          detail: s.detail || savedStep?.detail || '',
          status: s.status ?? 'passed',
          playwright_calls: calls,
        }
      })

      saveRunRecord({ testCaseId: tc.id, env: tc.env, result: passed ? 'PASS' : 'FAIL', summary }).catch(() => {})

      // Auto-save on PASS
      if (passed && replayScriptRef.current.length > 0) {
        updateReplayScript(tc.id, replayScriptRef.current).catch(() => {})
        if (resultStepsRef.current.length > 0) {
          updateTestCaseSteps(tc.id, resultStepsRef.current as object[]).catch(() => {})
        }
        setTc(prev => prev ? { ...prev, steps: resultStepsRef.current, replayScript: replayScriptRef.current, lastResult: 'PASS' } as any : prev)
        setStepsSaveState('saved')
      }

      // Progressive save on FAIL — save passed steps for resume
      if (!passed && resultStepsRef.current.length > 0) {
        const passedSteps = resultStepsRef.current.filter(s => s.status === 'passed')
        if (passedSteps.length > 0) {
          const partialScript: object[] = []
          for (const s of passedSteps) {
            for (const call of (s.playwright_calls ?? [])) {
              partialScript.push(call)
            }
          }
          let scriptToSave = partialScript
          if (serviceConfig.length > 0 && partialScript.length > 0) {
            const reps = serviceConfig
              .filter(c => c.key && c.value && c.value.length > 1)
              .sort((a, b) => b.value.length - a.value.length)
            scriptToSave = JSON.parse(
              reps.reduce(
                (json, c) => json.replaceAll(c.value, `{service.${c.key}}`),
                JSON.stringify(partialScript)
              )
            )
          }
          updateTestCaseSteps(tc.id, resultStepsRef.current as object[]).catch(() => {})
          updateReplayScript(tc.id, scriptToSave).catch(() => {})
          setTc(prev => prev ? { ...prev, steps: resultStepsRef.current, replayScript: scriptToSave, lastResult: 'FAIL' } as any : prev)
          setStepsSaveState('saved')
        }
      }

      setResult({ passed, summary })
      setPhase('done')
      setCdpWsUrl(null)
    } catch (err) {
      setCdpWsUrl(null)
      setExecError(err instanceof Error ? err.message : String(err))
      setPhase('error')
    } finally {
      if (sessionInfo.task_arn && sessionInfo.cluster) {
        callAgent({ inputText: '', mode: 'stop_session', task_arn: sessionInfo.task_arn, cluster: sessionInfo.cluster }, sessionId.current).catch(() => {})
      }
    }
  }

  // ── Loading / Error states ─────────────────────────────────────────────────
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

  // ── Derived state ──────────────────────────────────────────────────────────
  const planSteps = (tc.planSteps ?? []) as PlanStep[]
  const autoSteps = (tc.steps ?? []) as AutoStep[]
  const replaySteps = ((tc as any).replayScript ?? []) as PlaywrightCall[]
  const isAutomated = autoSteps.length > 0 || replaySteps.length > 0
  const isActive = phase === 'starting' || phase === 'running'

  // Compute smart action button state
  const passedSteps = autoSteps.filter(s => s.status === 'passed')
  const failedSteps = autoSteps.filter(s => s.status === 'failed')
  const hasReplay = replaySteps.length > 0 || autoSteps.some(s => (s.playwright_calls ?? []).length > 0)
  const firstFailedStep = failedSteps.length > 0 ? Math.min(...failedSteps.map(s => s.stepNumber)) : null

  // Build unified step list: plan steps + automation overlay
  const liveStepNumbers = Object.keys(liveStepStatuses).map(Number)
  // Only show "running" indicator after at least one live event has arrived
  // (means execution has actually started, not just "Starting..." phase)
  const hasLiveEvents = liveStepNumbers.length > 0
  const currentRunningStep = isActive && hasLiveEvents
    ? Math.max(...liveStepNumbers) + 1
    : null

  const unifiedSteps = planSteps.map(ps => {
    const auto = autoSteps.find(a => a.stepNumber === ps.step)
    const liveStatus = liveStepStatuses[ps.step]
    const isRunningNow = currentRunningStep === ps.step
    let status: string
    if (isActive && !hasLiveEvents) {
      // Execution starting but no events yet — show all as pending
      status = 'pending'
    } else if (liveStatus) {
      status = liveStatus
    } else if (isRunningNow) {
      status = 'running'
    } else if (isActive) {
      // During execution, steps without live events are pending (not saved status)
      status = 'pending'
    } else {
      status = auto?.status ?? 'pending'
    }
    return {
      stepNumber: ps.step,
      action: ps.action,
      expected: ps.expected,
      status: status as 'passed' | 'failed' | 'skipped' | 'fixed' | 'running' | 'pending',
      playwrightCalls: (auto?.playwright_calls ?? []) as PlaywrightCall[],
    }
  })

  // Status bar colors
  const statusBg =
    phase === 'done' && result?.passed ? '#F0FDF4' :
    phase === 'done' ? '#FEF2F2' :
    phase === 'error' ? '#FEF2F2' : '#FFFBEB'
  const statusBorder =
    phase === 'done' && result?.passed ? '#BBF7D0' :
    phase === 'done' ? '#FECACA' :
    phase === 'error' ? '#FECACA' : '#FDE68A'
  const statusColor =
    phase === 'done' && result?.passed ? '#166534' :
    phase === 'done' ? '#991B1B' :
    phase === 'error' ? '#991B1B' : '#92400E'

  // Smart action button config
  let actionLabel: string
  let actionGradient: string
  let actionShadow: string
  let showDropdown = false

  if (isActive) {
    actionLabel = phase === 'starting' ? 'Starting…' : 'Running…'
    actionGradient = '#DC2626'
    actionShadow = '0 2px 8px rgba(220,38,38,0.35)'
  } else if (!isAutomated) {
    actionLabel = 'Automate'
    actionGradient = 'linear-gradient(135deg, #7C3AED, #4F46E5)'
    actionShadow = '0 2px 8px rgba(124,58,237,0.35)'
  } else if (passedSteps.length > 0 && failedSteps.length > 0 && hasReplay) {
    actionLabel = `Resume from Step ${firstFailedStep}`
    actionGradient = 'linear-gradient(135deg, #059669, #10B981)'
    actionShadow = '0 2px 8px rgba(5,150,105,0.35)'
    showDropdown = true
  } else {
    actionLabel = 'Run Test'
    actionGradient = 'linear-gradient(135deg, #059669, #10B981)'
    actionShadow = '0 2px 8px rgba(5,150,105,0.35)'
    showDropdown = true
  }

  return (
    <div style={{ height: '100vh', background: '#FAFBFF', display: 'flex', flexDirection: 'column', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', overflow: 'hidden' }}>

      {/* Top nav bar */}
      <div style={{ background: 'white', borderBottom: '1px solid #E8EBF0', padding: '0 20px', height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <a href="/" style={{ display: 'flex', alignItems: 'center', gap: 6, marginRight: 4, textDecoration: 'none' }}>
            <img src="/favicon.svg" width="24" height="24" alt="Prompt2Test" />
            <span style={{ fontSize: 13, fontWeight: 700, color: '#0F172A', letterSpacing: '-0.3px' }}>Prompt2Test</span>
          </a>
          <svg viewBox="0 0 24 24" style={{ width: 14, height: 14, stroke: '#94A3B8', fill: 'none', strokeWidth: 2 }}><polyline points="9 18 15 12 9 6"/></svg>
          <span style={{ fontSize: 13, color: '#64748B' }}>Test Case</span>
        </div>
      </div>

      {/* Hero */}
      <div style={{ background: 'linear-gradient(135deg, #7C3AED 0%, #4F46E5 50%, #0EA5E9 100%)', padding: '16px 24px', flexShrink: 0 }}>
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
        <div style={{ fontSize: 18, fontWeight: 700, color: 'white', lineHeight: 1.3, letterSpacing: '-0.3px' }}>
          {tc.title || tc.description}
        </div>
      </div>

      {/* Unified status bar */}
      {phase !== 'idle' && (
        <div style={{ padding: '10px 24px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, background: statusBg, borderBottom: `1px solid ${statusBorder}`, color: statusColor, flexShrink: 0 }}>
          {isActive && <div style={{ width: 13, height: 13, border: `2px solid ${statusColor}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite', flexShrink: 0 }} />}
          <span style={{ fontWeight: 600 }}>
            {phase === 'starting' && 'Launching browser… (~60s for Fargate cold start)'}
            {phase === 'running' && execMode === 'automate' && 'AI is automating — watch it live in the browser tab'}
            {phase === 'running' && execMode === 'smart_replay' && (tokenCalls.length === 0
              ? 'Running test (replaying saved steps) — watch it live'
              : 'AI fixing a step — watch it live in the browser tab')}
            {phase === 'running' && execMode === 'resume' && (tokenCalls.length === 0
              ? `Replaying passed steps, then AI from step ${firstFailedStep}…`
              : 'AI automating remaining steps — watch it live')}
            {phase === 'done' && result?.passed && (stepsSaveState === 'saved' ? '✅ Test Passed — steps auto-saved' : '✅ Test Passed')}
            {phase === 'done' && !result?.passed && (stepsSaveState === 'saved'
              ? '❌ Test Failed — passed steps saved (you can resume)'
              : '❌ Test Failed')}
            {phase === 'error' && '⚠️ Execution failed'}
          </span>
          {result?.summary && <span style={{ fontSize: 12, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>— {result.summary}</span>}
          {execError && <span style={{ fontSize: 12, opacity: 0.7, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>— {execError}</span>}
          {isActive && (
            <button onClick={stopExecution}
              style={{ marginLeft: 'auto', padding: '3px 10px', borderRadius: 6, background: statusBg, border: `1px solid ${statusBorder}`, color: statusColor, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
            >Stop</button>
          )}
          {(phase === 'done' || phase === 'error') && (
            <button
              onClick={() => { setPhase('idle'); setResult(null); setExecError(null); setExecMode(null) }}
              style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: statusColor, opacity: 0.5, fontSize: 16, padding: '0 2px', lineHeight: 1 }}
            >×</button>
          )}
        </div>
      )}

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>

      {/* CDP live browser viewer — shown during execution */}
      {cdpWsUrl && phase === 'running' && (
        <div style={{ padding: '8px 24px', borderBottom: '1px solid #E8EBF0', background: '#f8fafc' }}>
          <CdpViewer wsUrl={cdpWsUrl} width={1280} height={720} />
        </div>
      )}

      {/* Main content: steps (left) + resizer + token panel (right) */}
      <div ref={containerRef} style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

      {/* Left: Steps */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Section header with action button */}
      <div style={{ background: 'white', borderBottom: '1px solid #E8EBF0', padding: '10px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#64748B' }}>
          Test Steps
          {isAutomated && <span style={{ marginLeft: 8, fontSize: 11, color: '#94A3B8' }}>
            {unifiedSteps.filter(s => s.status === 'passed' || s.status === 'fixed').length}/{planSteps.length} passed
          </span>}
        </div>

        {/* Smart action button */}
        {planSteps.length > 0 && (tc.env || env) === 'dev' && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {/* Dropdown: Start Fresh */}
            {showDropdown && !isActive && (
              <button
                onClick={() => setShowStartFreshConfirm(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '7px 12px', borderRadius: 8, background: 'white', color: '#64748B', border: '1px solid #E2E8F0', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                onMouseEnter={e => (e.currentTarget.style.background = '#F8FAFC')}
                onMouseLeave={e => (e.currentTarget.style.background = 'white')}
                title="Start fresh — full LLM re-automation from scratch"
              >
                <svg viewBox="0 0 24 24" style={{ width: 13, height: 13, stroke: '#64748B', fill: 'none', strokeWidth: 2 }}><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>
                Start Fresh
              </button>
            )}

            {/* Primary action */}
            <button
              onClick={isActive ? stopExecution : () => executeTest()}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8,
                background: actionGradient, color: 'white', border: 'none',
                cursor: 'pointer',
                fontSize: 13, fontWeight: 600,
                boxShadow: actionShadow,
              }}
            >
              {isActive ? (
                <>
                  <div style={{ width: 13, height: 13, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: 'white', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                  {actionLabel}
                </>
              ) : isAutomated ? (
                <>
                  <svg viewBox="0 0 24 24" style={{ width: 13, height: 13, stroke: 'white', fill: 'white' }}><polygon points="5 3 19 12 5 21 5 3"/></svg>
                  {actionLabel}
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" style={{ width: 13, height: 13, stroke: 'white', fill: 'none', strokeWidth: 2 }}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                  {actionLabel}
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Step list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', background: '#FAFBFF' }}>
        <div style={{ maxWidth: 860, margin: '0 auto' }}>
          {planSteps.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {unifiedSteps.map((step) => {
                const isPassed = step.status === 'passed' || step.status === 'fixed'
                const isFailed = step.status === 'failed'
                const isSkipped = step.status === 'skipped'
                const isRunningStep = step.status === 'running'
                const isPending = step.status === 'pending'
                const hasCalls = step.playwrightCalls.length > 0
                const isExpanded = expandedSteps.has(step.stepNumber)

                // Badge colors
                const badgeBg = isPassed ? '#DCFCE7' : isFailed ? '#FEE2E2' : isSkipped ? '#FFFBEB' : isRunningStep ? '#EDE9FE' : '#EDE9FE'
                const badgeColor = isPassed ? '#166534' : isFailed ? '#991B1B' : isSkipped ? '#92400E' : isRunningStep ? '#7C3AED' : '#7C3AED'
                const badgeBorder = isPassed ? '#BBF7D0' : isFailed ? '#FECACA' : isSkipped ? '#FDE68A' : isRunningStep ? '#C4B5FD' : '#DDD6FE'
                const cardBorder = isFailed ? '#FECACA' : isRunningStep ? '#C4B5FD' : '#E8EBF0'

                return (
                  <div
                    key={step.stepNumber}
                    ref={el => { if (el && isRunningStep) el.scrollIntoView({ behavior: 'smooth', block: 'center' }) }}
                    style={{
                      background: isPassed && liveStepStatuses[step.stepNumber] ? '#F0FDF4' : 'white',
                      borderRadius: 12, border: `1px solid ${cardBorder}`, overflow: 'hidden',
                      boxShadow: isRunningStep ? '0 0 0 1px #C4B5FD, 0 4px 16px rgba(124,58,237,0.12)' : '0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04)',
                      transition: 'all 0.3s ease',
                    }}
                  >
                    {/* Step header */}
                    <div
                      style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 18px', background: '#FAFBFF', cursor: hasCalls ? 'pointer' : 'default' }}
                      onClick={() => {
                        if (!hasCalls) return
                        setExpandedSteps(prev => {
                          const next = new Set(prev)
                          next.has(step.stepNumber) ? next.delete(step.stepNumber) : next.add(step.stepNumber)
                          return next
                        })
                      }}
                    >
                      {/* Step number badge */}
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 26, height: 26, borderRadius: '50%',
                        background: badgeBg, color: badgeColor, border: `1px solid ${badgeBorder}`,
                        fontSize: 12, fontWeight: 700, flexShrink: 0, marginTop: 1,
                      }}>{step.stepNumber}</span>

                      {/* Action + Expected */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A', marginBottom: 4 }}>{step.action}</div>
                        <div style={{ fontSize: 12, color: '#64748B', lineHeight: 1.5 }}>{step.expected}</div>
                      </div>

                      {/* Status + expand indicator */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                        {isRunningStep && (
                          <span style={{
                            fontSize: 11, fontWeight: 700, color: '#7C3AED',
                            background: '#EDE9FE', border: '1px solid #C4B5FD',
                            borderRadius: 6, padding: '2px 8px',
                            display: 'flex', alignItems: 'center', gap: 5,
                          }}>
                            <div style={{ width: 10, height: 10, border: '2px solid #7C3AED', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                            RUNNING
                          </span>
                        )}
                        {!isPending && !isRunningStep && (
                          <span style={{
                            fontSize: 11, fontWeight: 700, color: badgeColor,
                            background: badgeBg, border: `1px solid ${badgeBorder}`,
                            borderRadius: 6, padding: '2px 8px',
                            textTransform: 'uppercase', letterSpacing: '0.05em',
                          }}>{step.status}</span>
                        )}
                        {hasCalls && (
                          <svg viewBox="0 0 24 24" style={{ width: 14, height: 14, stroke: '#94A3B8', fill: 'none', strokeWidth: 2, transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                            <polyline points="6 9 12 15 18 9"/>
                          </svg>
                        )}
                      </div>
                    </div>

                    {/* Collapsible Playwright MCP calls */}
                    {hasCalls && isExpanded && (
                      <div style={{ padding: '10px 18px 12px 18px', borderTop: '1px solid #E8EBF0' }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Playwright MCP Calls</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {step.playwrightCalls.map((call, j) => {
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
          ) : (
            <div style={{ background: 'white', borderRadius: 12, border: '1px solid #E8EBF0', padding: '56px 24px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04)' }}>
              <div style={{ fontSize: 28, marginBottom: 12 }}>📋</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#64748B', marginBottom: 4 }}>No plan steps yet</div>
              <div style={{ fontSize: 13, color: '#94A3B8' }}>Go to Author Agent → Plan mode to generate them.</div>
            </div>
          )}
        </div>
      </div>

      {/* Start Fresh confirmation dialog */}
      {showStartFreshConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'white', border: '1px solid #E8EBF0', borderRadius: 14, padding: '28px 28px 22px', maxWidth: 420, width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }}>
            <div style={{ fontSize: 22, marginBottom: 10 }}>⚠️</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', marginBottom: 8 }}>Start fresh automation?</div>
            <div style={{ fontSize: 13, color: '#64748B', lineHeight: 1.6, marginBottom: 22 }}>
              This will run a <strong style={{ color: '#0F172A' }}>full LLM-driven automation from scratch</strong>, ignoring any previously saved steps. Use this if the test plan changed or saved steps are outdated.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowStartFreshConfirm(false)}
                style={{ padding: '7px 16px', borderRadius: 8, background: 'white', color: '#64748B', border: '1px solid #E2E8F0', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
              >Cancel</button>
              <button
                onClick={() => { setShowStartFreshConfirm(false); executeTest(true) }}
                style={{ padding: '7px 16px', borderRadius: 8, background: '#D97706', color: 'white', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
              >Yes, Start Fresh</button>
            </div>
          </div>
        </div>
      )}

      </div>{/* end left: steps */}

      {/* Draggable resizer */}
      <div
        onMouseDown={onMouseDown}
        style={{
          width: 6, flexShrink: 0, cursor: 'col-resize', background: '#E8EBF0',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = '#C7D2FE')}
        onMouseLeave={e => { if (!isDragging.current) e.currentTarget.style.background = '#E8EBF0' }}
      >
        <div style={{ width: 2, height: 32, borderRadius: 1, background: '#94A3B8', opacity: 0.5 }} />
      </div>

      {/* Right: Token Usage Panel */}
      <div style={{ width: tokenPanelWidth, flexShrink: 0, background: '#FAFBFF', overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Token Usage
          {phase === 'running' && <span style={{ color: '#7C3AED', animation: 'pulse 1.5s ease-in-out infinite' }}> (live)</span>}
        </div>

        {tokenCalls.length > 0 ? (() => {
          const last = tokenCalls[tokenCalls.length - 1]
          return (
            <>
              <div style={{ background: 'white', border: '1px solid #E8EBF0', borderRadius: 10, padding: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#94A3B8', marginBottom: 8 }}>SESSION TOTALS</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span style={{ color: '#64748B' }}>Model</span>
                    <span style={{ fontWeight: 600, color: '#0F172A', fontSize: 11 }}>{execMode === 'smart_replay' ? 'Haiku' : 'Sonnet'}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span style={{ color: '#64748B' }}>LLM Calls</span>
                    <span style={{ fontWeight: 600, color: '#0F172A' }}>{last.call_number}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span style={{ color: '#64748B' }}>Input Tokens</span>
                    <span style={{ color: '#0F172A' }}>{fmtNum(last.cumulative_input)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span style={{ color: '#64748B' }}>Output Tokens</span>
                    <span style={{ color: '#0F172A' }}>{fmtNum(last.cumulative_output)}</span>
                  </div>
                  <div style={{ borderTop: '1px solid #E8EBF0', paddingTop: 6, marginTop: 2, display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span style={{ color: '#64748B' }}>Est. Cost</span>
                    <span style={{ fontWeight: 600, color: '#7C3AED' }}>{fmtCost(last.cumulative_input, last.cumulative_output, execMode === 'smart_replay' ? 'haiku' : 'sonnet')}</span>
                  </div>
                </div>
              </div>

              <div style={{ background: 'white', border: '1px solid #E8EBF0', borderRadius: 10, padding: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#94A3B8', marginBottom: 8 }}>PER-CALL BREAKDOWN</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {tokenCalls.map(t => (
                    <div key={t.call_number} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 8px', borderRadius: 6, background: '#F8FAFC', border: '1px solid #F1F5F9', fontSize: 12 }}>
                      <span style={{ fontWeight: 600, color: '#64748B', fontFamily: 'monospace' }}>#{t.call_number}</span>
                      <span>
                        <span style={{ color: '#2563EB' }}>{fmtNum(t.input_tokens)}</span>
                        <span style={{ color: '#94A3B8' }}> / </span>
                        <span style={{ color: '#059669' }}>{fmtNum(t.output_tokens)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )
        })() : (
          <div style={{ fontSize: 13, color: '#94A3B8', textAlign: 'center', marginTop: 24 }}>
            Token stats will appear here during automation.
          </div>
        )}
      </div>

      </div>{/* end flex row */}

      <style>{`@keyframes spin { to { transform: rotate(360deg) } } @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>
    </div>
  )
}
