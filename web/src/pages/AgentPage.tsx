import { useState, useRef, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { fetchUserAttributes, fetchAuthSession } from '@aws-amplify/auth'
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm'

import type { RunEntry } from '../layouts/PlatformLayout'
import { useEnv } from '../context/EnvContext'
import { saveTestCase, saveRunRecord, getTestCase, updateTestCasePlanSteps, updateTestCaseSteps } from '../lib/lambdaClient'
import { callAgent } from '../lib/agentClient'

const AWS_REGION = import.meta.env.VITE_AWS_REGION as string

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

function saveRun(entry: Omit<RunEntry, 'id'>) {
  try {
    const raw = localStorage.getItem('p2t_run_history')
    const runs: RunEntry[] = raw ? JSON.parse(raw) : []
    runs.push({ id: Date.now().toString(36), ...entry })
    // keep last 50
    if (runs.length > 50) runs.splice(0, runs.length - 50)
    localStorage.setItem('p2t_run_history', JSON.stringify(runs))
    window.dispatchEvent(new Event('p2t_run_saved'))
  } catch { /* ignore */ }
}

type Message = { role: 'user' | 'agent'; text: string }
type StepItem = { step: number; action: string; expected: string }

function parseAgentResponse(text: string): { steps: StepItem[]; note: string; isFinal: boolean; summary: string } {
  const trimmed = text.trim()
  // Final generation: starts with SUMMARY:
  if (trimmed.startsWith('SUMMARY:')) {
    const summaryMatch = trimmed.match(/^SUMMARY:\s*(.+)/m)
    const stepsMatch = trimmed.match(/STEPS:\s*(\[[\s\S]*\])/)
    return {
      isFinal: true,
      summary: summaryMatch?.[1]?.trim() ?? '',
      steps: stepsMatch ? (() => { try { return JSON.parse(stepsMatch[1]) } catch { return [] } })() : [],
      note: '',
    }
  }
  // Regular turn: NOTE: ... STEPS: [...]
  const noteMatch = trimmed.match(/NOTE:\s*([\s\S]*?)(?=\nSTEPS:|\nsteps:)/i)
  const stepsMatch = trimmed.match(/STEPS:\s*(\[[\s\S]*\])/i)
  const steps = stepsMatch ? (() => { try { return JSON.parse(stepsMatch[1]) } catch { return [] } })() : []
  const note = noteMatch?.[1]?.trim() ?? (steps.length === 0 ? trimmed : '')
  return { isFinal: false, summary: '', steps, note }
}

type Plan = {
  confirmationMessage?: string
  summary?: string
  steps?: { stepNumber: number; type: string; tool?: string; action: string; detail: string }[]
  configNeeded?: string[]
  estimatedTokens?: number
  mcpCalls?: number
  raw?: string
}



export default function AgentPage() {

  const [messages, setMessages] = useState<Message[]>([
    { role: 'agent', text: "Hi! Ready to author tests.\n\nPaste a scenario below, pick a service, and I'll enrich it with your real config values." },
  ])
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<'plan' | 'auto'>('plan')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [loading, setLoading] = useState(false)
  const [novncUrl, setNovncUrl] = useState<string | null>(null)
  const popupRef = useRef<Window | null>(null)
  const [sessionId] = useState(() => crypto.randomUUID())
  const [userName, setUserName] = useState('')
  const savedTcId = useRef<string | null>(null)
  const [tcSaved, setTcSaved] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [tcService, setTcService] = useState('')
  const [tcName, setTcName] = useState('')
  const [availableServices, setAvailableServices] = useState<string[]>([])
  const [servicesLoading, setServicesLoading] = useState(false)
  const [autoRunReady, setAutoRunReady] = useState(false)
  // Plan Scenario mode state
  const [planScenario, setPlanScenario] = useState('')
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [saveTitleInput, setSaveTitleInput] = useState('')
  const [saveTcIdInput, setSaveTcIdInput] = useState('')
  const [saveService, setSaveService] = useState('')  // locked-in service at dialog-open time
  const [planSteps, setPlanSteps] = useState<StepItem[]>([])
  const { env } = useEnv()
  const [modeOpen, setModeOpen] = useState(false)
  const [automatePhase, setAutomatePhase] = useState<'idle' | 'starting' | 'running' | 'done' | 'error'>('idle')
  const [automateResult, setAutomateResult] = useState<{ passed: boolean; summary: string } | null>(null)
  const [automateError, setAutomateError] = useState<string | null>(null)
  const [stepsSaveState, setStepsSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const chatRef = useRef<HTMLDivElement>(null)
  const [searchParams, setSearchParams] = useSearchParams()

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight
  }, [messages])

  useEffect(() => {
    fetchUserAttributes().then(attrs => {
      const name = attrs.name || attrs.email?.split('@')[0] || ''
      setUserName(name)
    }).catch(() => {})
  }, [])

  // Pre-load service list whenever env changes
  useEffect(() => {
    setServicesLoading(true)
    loadServiceNames(env).then(setAvailableServices).catch(() => {}).finally(() => setServicesLoading(false))
  }, [env])

  // Pre-load test case from inventory "Run" button
  useEffect(() => {
    const tcId     = searchParams.get('tcId')
    const tcDesc   = searchParams.get('tcDesc')
    const autoRun  = searchParams.get('autoRun') === 'true'
    if (!tcId) return
    setSearchParams({}, { replace: true })
    setMessages(prev => [...prev, { role: 'agent', text: 'Loading test case…' }])
    getTestCase(tcId).then(tc => {
      const reconstructedPlan: Plan = {
        summary: tc.description,
        steps: (tc.steps as Plan['steps']) ?? [],
        mcpCalls: 0,
      }
      savedTcId.current = tcId
      setTcSaved('saved')
      setPlan(reconstructedPlan)
      if (autoRun) {
        setAutoRunReady(true)
        setMessages(prev => [
          ...prev.slice(0, -1),
          { role: 'agent', text: `Ready to run: **${tcDesc ?? tc.description}**\n\nClick ▶ Start Test Execution below to launch the browser.` },
        ])
      } else {
        setMessages(prev => [
          ...prev.slice(0, -1),
          { role: 'agent', text: `Loaded: **${tcDesc ?? tc.description}**\n\nPlan ready with ${reconstructedPlan.steps?.length ?? 0} steps. Reply **yes** to run it, or refine it in chat.` },
        ])
      }
    }).catch(() => {
      setMessages(prev => [...prev.slice(0, -1), { role: 'agent', text: 'Failed to load test case.' }])
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps


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

  async function automateTest() {
    if (!savedTcId.current || automatePhase === 'starting' || automatePhase === 'running') return
    setAutomatePhase('starting')
    setAutomateResult(null)
    setAutomateError(null)
    setStepsSaveState('idle')

    const loadingBlob = new Blob([loadingHtml], { type: 'text/html' })
    const loadingUrl = URL.createObjectURL(loadingBlob)
    const popup = window.open(loadingUrl, 'p2t-browser', 'width=1280,height=820,toolbar=0,menubar=0,location=0')
    popupRef.current = popup

    const label = saveTitleInput || 'Test case'
    const derivedPlan = {
      summary: label,
      steps: planSteps.map(s => ({ stepNumber: s.step, type: 'browser', action: s.action, detail: s.expected })),
      mcpCalls: planSteps.length,
    }

    try {
      const sessionRaw = await callAgent({ inputText: label, mode: 'start_session', sessionId }, sessionId)
      const session = JSON.parse(sessionRaw)
      if (session.error) throw new Error(session.error as string)

      URL.revokeObjectURL(loadingUrl)
      if (popup) popup.location.href = `${session.novnc_url}?autoconnect=true&resize=scale`
      setAutomatePhase('running')

      const raw = await callAgent({
        inputText: label,
        mode: 'automate',
        plan: derivedPlan,
        sessionId,
        task_arn: session.task_arn,
        cluster: session.cluster,
        mcp_endpoint: session.mcp_endpoint,
      }, sessionId)

      const result = JSON.parse(raw)
      if (result.error) throw new Error(result.error as string)

      const passed = result.result?.passed ?? result.passed
      const summary = result.result?.summary ?? result.summary ?? ''

      saveRunRecord({ testCaseId: savedTcId.current!, env, result: passed ? 'PASS' : 'FAIL', summary, runBy: userName }).catch(() => {})
      saveRun({ description: label, passed, timestamp: new Date().toISOString() })

      setAutomateResult({ passed, summary })
      setAutomatePhase('done')
      popupRef.current?.close()
      popupRef.current = null
    } catch (err) {
      URL.revokeObjectURL(loadingUrl)
      popupRef.current?.close()
      popupRef.current = null
      setAutomateError(err instanceof Error ? err.message : String(err))
      setAutomatePhase('error')
    }
  }

  async function send() {
    const text = input.trim()
    if (!text || loading) return
    setMessages(prev => [...prev, { role: 'user', text }])
    setInput('')
    setLoading(true)

    const history = messages
      .filter(m => m.text !== 'Generating test plan…' && m.text !== 'Executing test plan via Playwright MCP…')
      .map(m => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.text}`)
      .join('\n')

    try {
      if (mode === 'plan') {
        // Plan Scenario mode — enrich scenario with real SSM config, conversational refinement
        if (!tcService) {
          setMessages(prev => [...prev, { role: 'agent', text: 'Please pick a service from the panel on the right before sending your scenario.' }])
          setLoading(false)
          return
        }

        setMessages(prev => [...prev, { role: 'agent', text: 'Enriching scenario…' }])

        const raw = await callAgent({
          inputText: text,
          mode: 'plan_scenario',
          service: tcService,
          env,
          sessionId,
          conversationHistory: history,
        }, sessionId)

        const result = JSON.parse(raw)
        if (result.error) {
          setMessages(prev => [...prev.slice(0, -1), { role: 'agent', text: `Error: ${result.error}` }])
          return
        }

        const responseText: string = result.text ?? ''
        const parsed = parseAgentResponse(responseText)

        if (parsed.isFinal) {
          if (parsed.steps.length > 0) setPlanSteps(parsed.steps)
          setPlanScenario(responseText)
          setSaveTitleInput(parsed.summary)
          setSaveTcIdInput('TC-' + Date.now().toString(36).toUpperCase().slice(-6))
          setSaveService(tcService)
          setShowSaveDialog(true)
          setTcSaved('idle')
          setMessages(prev => [...prev.slice(0, -1), { role: 'agent', text: 'Final test case ready — fill in the details on the right to save it.' }])
        } else {
          if (parsed.steps.length > 0) setPlanSteps(parsed.steps)
          setPlanScenario(responseText)
          const displayText = parsed.note || (parsed.steps.length > 0
            ? `I've mapped out ${parsed.steps.length} steps — check the panel on the right. Let me know if you'd like to refine anything.`
            : responseText)
          setMessages(prev => [...prev.slice(0, -1), { role: 'agent', text: displayText }])
        }
      } else {
        // Automate mode — only runs test cases loaded from Test Inventory
        setMessages(prev => [
          ...prev,
          { role: 'user', text },
          { role: 'agent', text: 'Automate mode only runs saved test cases.\n\nGo to Test Inventory → find your test case → click Run.' },
        ])
        setInput('')
      }
    } catch (err: unknown) {
      setMessages(prev => [
        ...prev.slice(0, -1),
        { role: 'agent', text: `Error: ${err instanceof Error ? err.message : String(err)}` },
      ])
    } finally {
      setLoading(false)
    }
  }


  return (
    <div className="flex flex-col h-full bg-[#F5F7FA]">
      {/* Agent topbar */}
      <div className="flex items-center gap-3 px-4 h-[52px] bg-white border-b border-slate-200 flex-shrink-0">
        <span className="text-[14px] font-semibold text-slate-700">Author Agent</span>
        <span className="text-[12px] font-medium text-[#7C3AED] bg-[#EDE9FE] border border-[#DDD6FE] px-2 py-0.5 rounded-full">
          Bedrock · {env.toUpperCase()}
        </span>
      </div>

      {/* Main workspace */}
      <div className="flex flex-1 overflow-hidden">
        {/* Chat panel — narrow during live browser execution */}
        <div className={`flex flex-col border-r border-slate-200 flex-shrink-0 bg-white transition-all duration-300 ${mode === 'auto' && loading ? 'w-[300px]' : 'w-[440px]'}`}>
          <div ref={chatRef} className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.map((msg, i) => (
              <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div className="text-[12px] text-slate-400 mb-1">
                  {msg.role === 'user' ? (userName || 'You') : 'Prompt2Test'}
                </div>
                <div className={`max-w-[85%] px-3.5 py-2.5 rounded-xl text-[14px] leading-relaxed whitespace-pre-line ${
                  msg.role === 'user'
                    ? 'bg-[#7C3AED] text-white rounded-br-sm'
                    : 'bg-slate-50 border border-slate-200 text-slate-700 rounded-bl-sm'
                }`}>
                  {msg.text}
                </div>
              </div>
            ))}
          </div>

          {/* Input */}
          <div className="px-3 pt-3 pb-3 border-t border-slate-200 bg-white">
            <div className="border border-slate-200 rounded-xl bg-white focus-within:border-[#7C3AED] transition-colors">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                placeholder={mode === 'auto' && !autoRunReady ? 'Go to Test Inventory and click Run to execute a test case…' : 'Paste your scenario here…'}
                rows={3}
                disabled={loading || (mode === 'auto' && !autoRunReady)}
                className="w-full bg-white px-4 pt-3 pb-1 text-[14px] text-slate-800 placeholder-slate-400 outline-none resize-none font-sans disabled:opacity-60"
              />

              {/* Bottom toolbar — Copilot style */}
              <div className="flex items-center justify-between px-3 pb-2 pt-1">
                <div className="flex items-center gap-1 flex-wrap">
                  {/* Mode dropdown */}
                  <div className="relative">
                    <button
                      onClick={() => setModeOpen(o => !o)}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[13px] font-medium text-slate-600 hover:bg-slate-100 cursor-pointer transition-colors"
                    >
                      {mode === 'plan'
                        ? <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                        : <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                      }
                      {mode === 'plan' ? 'Plan' : 'Automate'}
                      <svg viewBox="0 0 24 24" className="w-3 h-3 stroke-current fill-none stroke-2 opacity-40"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>

                    {modeOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setModeOpen(false)} />
                        <div className="absolute bottom-full mb-2 left-0 z-50 w-52 bg-white border border-slate-200 rounded-xl shadow-xl py-1 overflow-hidden">
                          {([
                            ['plan', 'Plan', 'Review steps before running'] ,
                            ['auto', 'Automate', 'Run the test directly'],
                          ] as const).map(([m, label, desc]) => (
                            <button key={m} onClick={() => { setMode(m); setModeOpen(false) }}
                              className="w-full text-left px-3 py-2.5 hover:bg-slate-50 flex items-center gap-3 cursor-pointer">
                              <div className={`flex-shrink-0 ${mode === m ? 'text-[#7C3AED]' : 'text-slate-400'}`}>
                                {m === 'plan'
                                  ? <svg viewBox="0 0 24 24" className="w-4 h-4 stroke-current fill-none stroke-2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                                  : <svg viewBox="0 0 24 24" className="w-4 h-4 stroke-current fill-none stroke-2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                                }
                              </div>
                              <div className="flex-1">
                                <div className={`text-[13px] font-semibold ${mode === m ? 'text-[#7C3AED]' : 'text-slate-700'}`}>{label}</div>
                                <div className="text-[11px] text-slate-400 mt-0.5">{desc}</div>
                              </div>
                              {mode === m && (
                                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-[#7C3AED] fill-none stroke-2 flex-shrink-0"><polyline points="20 6 9 17 4 12"/></svg>
                              )}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Service indicator — Plan mode only */}
                  {mode === 'plan' && tcService && (
                    <button
                      onClick={() => { if (!loading) setTcService('') }}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[13px] font-medium text-[#7C3AED] bg-[#EDE9FE] border border-[#DDD6FE] hover:bg-[#DDD6FE] transition-colors cursor-pointer"
                      title="Change service"
                    >
                      <svg viewBox="0 0 24 24" className="w-3 h-3 stroke-current fill-none stroke-2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"/></svg>
                      {tcService}
                      <svg viewBox="0 0 24 24" className="w-2.5 h-2.5 stroke-current fill-none stroke-2 opacity-50"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  )}
                </div>

                {/* Send button */}
                <button onClick={send} disabled={loading || !input.trim()}
                  className="w-7 h-7 flex items-center justify-center bg-[#7C3AED] hover:bg-[#5B21B6] disabled:opacity-40 text-white rounded-lg transition-colors cursor-pointer flex-shrink-0">
                  <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2">
                    <line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Plan / Live Browser panel */}
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* Live browser panel — shown while executing or after completion if novncUrl is set */}
          {(mode === 'auto' && loading) || novncUrl ? (
            <>
              <div className="px-4 py-2.5 border-b border-slate-200 bg-white flex-shrink-0 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${loading ? 'bg-yellow-400 animate-pulse' : novncUrl ? 'bg-green-400 animate-pulse' : 'bg-slate-400'}`} />
                  <span className="text-[13px] font-semibold text-slate-700 uppercase tracking-wider">
                    {loading ? 'Test Running…' : 'Browser Session'}
                  </span>
                </div>
                {novncUrl && (
                  <button
                    onClick={() => {
                      popupRef.current = window.open(
                        `${novncUrl}?autoconnect=true&resize=scale`,
                        'novnc-popup',
                        'width=1280,height=820,toolbar=0,menubar=0,location=0'
                      )
                    }}
                    className="flex items-center gap-1.5 text-[12px] text-slate-500 hover:text-[#7C3AED] border border-slate-200 hover:border-[#7C3AED] rounded-lg px-2.5 py-1 transition-colors cursor-pointer"
                    title="Open browser view in new window"
                  >
                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2">
                      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
                    </svg>
                    Pop out
                  </button>
                )}
              </div>

              <div className="flex-1 overflow-hidden flex flex-col bg-[#0D1117]">
                {loading ? (
                  <div className="flex-1 flex flex-col justify-center px-8 py-6 gap-6">
                    {/* Header */}
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">🎭</span>
                      <div>
                        <div className="text-[15px] font-semibold text-white">
                          {novncUrl ? 'Running test…' : 'Launching test environment'}
                        </div>
                        <div className="text-[12px] text-slate-500 mt-0.5">
                          {novncUrl ? 'Watch it live in the browser popup' : 'Spinning up a dedicated Fargate task'}
                        </div>
                      </div>
                    </div>

                    {/* Progress bar */}
                    <div className="w-full h-1 bg-[#1E2A3A] rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-[#7C3AED] to-[#A855F7]"
                        style={{ width: novncUrl ? '90%' : '55%', transition: 'width 0.8s ease' }}
                      />
                    </div>

                    {/* Activity log */}
                    <div className="font-mono text-[12px] space-y-2.5">
                      {[
                        { label: 'ECS task scheduled', done: true, delay: '0s' },
                        { label: 'Pulling container image', done: !novncUrl, active: !novncUrl, delay: '0.3s' },
                        { label: 'Starting Chromium + Playwright MCP', done: !!novncUrl, active: !novncUrl, delay: '0.6s' },
                        { label: novncUrl ? 'Executing test steps via MCP…' : 'noVNC server initializing', done: false, active: !!novncUrl, delay: '0.9s' },
                      ].map((step, i) => (
                        <div key={i} className="flex items-center gap-3" style={{ animationDelay: step.delay }}>
                          {step.done ? (
                            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-[#22C55E] fill-none stroke-2 flex-shrink-0"><polyline points="20 6 9 17 4 12"/></svg>
                          ) : step.active ? (
                            <span className="w-3.5 h-3.5 flex-shrink-0 flex items-center justify-center">
                              <span className="w-2 h-2 rounded-full bg-[#A855F7] animate-pulse" />
                            </span>
                          ) : (
                            <span className="w-3.5 h-3.5 flex-shrink-0 flex items-center justify-center">
                              <span className="w-2 h-2 rounded-full bg-[#1E2A3A]" />
                            </span>
                          )}
                          <span className={step.done ? 'text-slate-400' : step.active ? 'text-white' : 'text-slate-600'}>
                            {step.label}
                          </span>
                          {step.active && (
                            <span className="text-slate-600 animate-pulse">…</span>
                          )}
                        </div>
                      ))}
                    </div>

                    <div className="text-[11px] text-slate-600">Takes 1–3 min on cold start · container image is cached after first run</div>
                  </div>
                ) : novncUrl ? (
                  <div className="flex-1 flex flex-col items-center justify-center gap-4 text-slate-400">
                    <svg viewBox="0 0 24 24" className="w-10 h-10 stroke-[#22C55E] fill-none stroke-1.5">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    <span className="text-[14px] font-semibold text-white">Browser session ready</span>
                    <button
                      onClick={() => {
                        popupRef.current = window.open(
                          `${novncUrl}?autoconnect=true&resize=scale`,
                          'novnc-popup',
                          'width=1280,height=820,toolbar=0,menubar=0,location=0'
                        )
                      }}
                      className="text-[13px] px-5 py-2 bg-[#7C3AED] hover:bg-[#5B21B6] text-white rounded-lg cursor-pointer transition-colors"
                    >
                      Open browser view
                    </button>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-slate-200 bg-white flex-shrink-0 flex items-center justify-between">
                <div className="text-[13px] font-semibold text-slate-400 uppercase tracking-wider">
                  {mode === 'plan' ? 'Test Steps' : 'Execution Plan'}
                </div>
                {mode === 'plan' && planSteps.length > 0 && !showSaveDialog && (
                  <button
                    onClick={async () => {
                      if (loading) return
                      setLoading(true)
                      try {
                        const h = messages.map(m => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.text}`).join('\n')
                        const raw = await callAgent({ inputText: 'generate_final', mode: 'plan_scenario', service: tcService, env, sessionId, conversationHistory: h }, sessionId)
                        const result = JSON.parse(raw)
                        const responseText: string = result.text ?? ''
                        const parsed = parseAgentResponse(responseText)
                        if (parsed.steps.length > 0) setPlanSteps(parsed.steps)
                        setPlanScenario(responseText)
                        setSaveTitleInput(parsed.summary || responseText.split('\n')[0].replace(/^SUMMARY:\s*/i, '').trim())
                        setSaveTcIdInput('TC-' + Date.now().toString(36).toUpperCase().slice(-6))
                        setShowSaveDialog(true)
                        setTcSaved('idle')
                        setMessages(prev => [...prev, { role: 'agent', text: 'Final test case ready — fill in the details on the right to save it.' }])
                      } finally {
                        setLoading(false)
                      }
                    }}
                    disabled={loading}
                    className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-[12px] font-semibold bg-[#EDE9FE] text-[#7C3AED] border border-[#DDD6FE] hover:bg-[#DDD6FE] transition-colors cursor-pointer disabled:opacity-40"
                  >
                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg>
                    Generate Final
                  </button>
                )}
              </div>

              {/* Plan Scenario panel */}
              {mode === 'plan' ? (
                <>
                  {/* State 1: No service selected — show service picker chips */}
                  {!tcService ? (
                    <div className="flex-1 overflow-y-auto p-4">
                      <div className="text-[12px] font-semibold text-slate-400 uppercase tracking-wider mb-3">Pick a Service</div>
                      {servicesLoading ? (
                        <div className="text-[13px] text-slate-400">Loading services…</div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => setTcService('exploratory')}
                            className="px-3 py-1.5 rounded-full text-[13px] font-semibold border cursor-pointer transition-colors bg-slate-50 text-slate-600 border-slate-200 hover:border-[#7C3AED] hover:text-[#7C3AED]"
                          >
                            Exploratory
                          </button>
                          {availableServices.map(svc => (
                            <button key={svc} onClick={() => setTcService(svc)}
                              className="px-3 py-1.5 rounded-full text-[13px] font-semibold border cursor-pointer transition-colors bg-slate-50 text-slate-600 border-slate-200 hover:border-[#7C3AED] hover:text-[#7C3AED]"
                            >
                              {svc}
                            </button>
                          ))}
                        </div>
                      )}
                      <p className="mt-4 text-[13px] text-slate-400 leading-relaxed">
                        Select a service, then paste your scenario in the chat to start enriching it.
                      </p>
                    </div>
                  ) : planSteps.length > 0 ? (
                    /* State 2: Steps exist — show MTM-style step table */
                    <div className="flex-1 overflow-y-auto p-4">
                      <div className="text-[12px] font-semibold text-slate-400 uppercase tracking-wider mb-3">
                        Test Steps &nbsp;·&nbsp; <span className="text-[#7C3AED] normal-case font-semibold">{tcService}</span>
                      </div>
                      <table className="w-full border-collapse text-[13px]">
                        <thead>
                          <tr className="bg-slate-50 border border-slate-200 rounded-lg">
                            <th className="py-2 px-2.5 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider w-8 border-b border-slate-200">#</th>
                            <th className="py-2 px-3 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-200">Action</th>
                            <th className="py-2 px-3 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-200">Expected Result</th>
                          </tr>
                        </thead>
                        <tbody>
                          {planSteps.map((s, i) => (
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
                    </div>
                  ) : (
                    /* State 2 empty: service selected, no steps yet */
                    <div className="flex-1 flex flex-col items-center justify-center text-center px-6 gap-2">
                      <div className="text-[13px] font-semibold text-slate-600">
                        Service: <span className="text-[#7C3AED]">{tcService}</span>
                      </div>
                      <div className="text-[13px] text-slate-400 leading-relaxed">
                        Paste your scenario in the chat.<br />Steps will appear here as I refine them.
                      </div>
                    </div>
                  )}

                  {/* Save dialog */}
                  {showSaveDialog && (
                    <div className="border-t border-slate-200 bg-white px-4 py-3 flex-shrink-0 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Save Test Case</div>
                        {(saveService || tcService) && (
                          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#EDE9FE] text-[#7C3AED] border border-[#DDD6FE]">
                            {saveService || tcService}
                          </span>
                        )}
                      </div>
                      <input
                        value={saveTitleInput}
                        onChange={e => setSaveTitleInput(e.target.value)}
                        placeholder="Title"
                        disabled={tcSaved === 'saved'}
                        className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-[13px] outline-none focus:border-[#7C3AED] transition-colors disabled:opacity-50 disabled:bg-slate-50"
                      />
                      <div className="flex gap-2">
                        <input
                          value={saveTcIdInput}
                          onChange={e => setSaveTcIdInput(e.target.value)}
                          placeholder="Test Case ID (e.g. TC-001)"
                          disabled={tcSaved === 'saved'}
                          className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-[13px] outline-none focus:border-[#7C3AED] font-mono transition-colors disabled:opacity-50 disabled:bg-slate-50"
                        />
                      </div>
                      <button
                        onClick={async () => {
                          if (tcSaved !== 'idle' || !saveTitleInput.trim()) return
                          setTcSaved('saving')
                          try {
                            const id = await saveTestCase({
                              id: saveTcIdInput.trim() || undefined,
                              title: saveTitleInput.trim(),
                              description: saveTitleInput.trim(),
                              scenario: planScenario,
                              env,
                              service: saveService || tcService || undefined,
                              steps: [],
                              planSteps,
                              createdBy: userName,
                            })
                            savedTcId.current = id
                            setTcSaved('saved')
                            // Keep plan steps in sync if user refines further after saving
                            if (id && planSteps.length) updateTestCasePlanSteps(id, planSteps).catch(() => {})
                          } catch { setTcSaved('idle') }
                        }}
                        disabled={tcSaved !== 'idle' || !saveTitleInput.trim()}
                        className={`w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[13px] font-semibold border transition-colors cursor-pointer ${
                          tcSaved === 'saved'
                            ? 'bg-green-50 text-green-700 border-green-200'
                            : 'bg-[#EDE9FE] text-[#7C3AED] border-[#DDD6FE] hover:bg-[#DDD6FE] disabled:opacity-40 disabled:cursor-not-allowed'
                        }`}
                      >
                        {tcSaved === 'saving' ? (
                          <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>
                        ) : tcSaved === 'saved' ? (
                          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2"><polyline points="20 6 9 17 4 12"/></svg>
                        ) : (
                          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                        )}
                        {tcSaved === 'saving' ? 'Saving…' : tcSaved === 'saved' ? 'Saved to Test Inventory' : 'Save Test Case'}
                      </button>

                      {/* Automate button */}
                      {tcSaved === 'saved' && savedTcId.current && automatePhase === 'idle' && (
                        <button
                          onClick={automateTest}
                          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[13px] font-semibold bg-[#7C3AED] hover:bg-[#5B21B6] text-white transition-colors cursor-pointer"
                        >
                          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                          Automate
                        </button>
                      )}

                      {/* Running indicator */}
                      {(automatePhase === 'starting' || automatePhase === 'running') && (
                        <div className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[13px] font-semibold bg-[#EDE9FE] text-[#7C3AED] border border-[#DDD6FE]">
                          <div className="w-3.5 h-3.5 border-2 border-[#7C3AED] border-t-transparent rounded-full animate-spin" />
                          {automatePhase === 'starting' ? 'Launching browser… (~60s)' : 'Running test…'}
                        </div>
                      )}

                      {/* Result banner — pass */}
                      {automatePhase === 'done' && automateResult?.passed && stepsSaveState !== 'saved' && (
                        <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2.5 space-y-2">
                          <div className="text-[13px] font-semibold text-green-700">✅ Test Passed — save automated steps?</div>
                          {automateResult.summary && <div className="text-[12px] text-green-600 opacity-80">{automateResult.summary}</div>}
                          <div className="flex gap-2">
                            <button
                              onClick={async () => {
                                if (!savedTcId.current || stepsSaveState !== 'idle') return
                                setStepsSaveState('saving')
                                try {
                                  const autoSteps = planSteps.map(s => ({ stepNumber: s.step, type: 'browser', action: s.action, detail: s.expected }))
                                  await updateTestCaseSteps(savedTcId.current, autoSteps)
                                  setStepsSaveState('saved')
                                } catch { setStepsSaveState('idle') }
                              }}
                              disabled={stepsSaveState !== 'idle'}
                              className="flex-1 py-1.5 rounded-lg text-[12px] font-semibold bg-green-600 hover:bg-green-700 text-white transition-colors cursor-pointer disabled:opacity-50"
                            >
                              {stepsSaveState === 'saving' ? 'Saving…' : 'Save Steps'}
                            </button>
                            <button
                              onClick={() => setAutomatePhase('idle')}
                              className="px-3 py-1.5 rounded-lg text-[12px] font-semibold border border-slate-200 text-slate-500 hover:bg-slate-50 transition-colors cursor-pointer"
                            >
                              Discard
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Saved confirmation */}
                      {stepsSaveState === 'saved' && (
                        <div className="text-[12px] text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2 font-semibold">
                          ✅ Automated steps saved — test case is now ⚡ Automated
                        </div>
                      )}

                      {/* Result banner — fail or error */}
                      {(automatePhase === 'done' && !automateResult?.passed) || automatePhase === 'error' ? (
                        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 space-y-1.5">
                          <div className="text-[13px] font-semibold text-red-700">
                            {automatePhase === 'error' ? '⚠️ Execution failed' : '❌ Test Failed'}
                          </div>
                          {(automateResult?.summary || automateError) && (
                            <div className="text-[12px] text-red-600 opacity-80 font-mono">{automateResult?.summary || automateError}</div>
                          )}
                          <button onClick={() => setAutomatePhase('idle')} className="text-[12px] text-red-500 hover:text-red-700 cursor-pointer underline">Dismiss</button>
                        </div>
                      ) : null}
                    </div>
                  )}
                </>
              ) : plan ? (
                <>
                  <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {plan.summary && (
                      <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
                        <div className="text-[12px] text-slate-400 uppercase tracking-wider mb-1">Summary</div>
                        <div className="text-[14px] text-slate-800 font-medium">{plan.summary}</div>
                        {(plan.estimatedTokens || plan.mcpCalls) && (
                          <div className="flex gap-3 mt-2 text-[12px] text-slate-500">
                            {plan.estimatedTokens && <span>~{plan.estimatedTokens} tokens</span>}
                            {plan.mcpCalls && <span>{plan.mcpCalls} MCP calls</span>}
                          </div>
                        )}
                      </div>
                    )}
                    {plan.steps?.map(step => (
                      <div key={step.stepNumber} className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex gap-3">
                        <div className="w-6 h-6 rounded-full bg-[#7C3AED] text-white text-[11px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                          {step.stepNumber}
                        </div>
                        <div>
                          <div className="text-[13px] font-semibold text-slate-800">{step.action}</div>
                          <div className="text-[12px] text-slate-500 mt-0.5">{step.detail}</div>
                          <div className="text-[11px] text-[#7C3AED] mt-1 font-medium uppercase tracking-wide">{step.type} · {step.tool ?? ''}</div>
                        </div>
                      </div>
                    ))}
                    {plan.raw && (
                      <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
                        <pre className="text-[12px] text-slate-600 whitespace-pre-wrap">{plan.raw}</pre>
                      </div>
                    )}
                  </div>

                  {/* Auto-run: Start Execution button */}
                  {autoRunReady && (
                    <div className="border-t border-slate-200 bg-white px-4 py-3 flex-shrink-0">
                      <button
                        onClick={() => {
                          const loadingBlob = new Blob([loadingHtml], { type: 'text/html' })
                          const loadingUrl = URL.createObjectURL(loadingBlob)
                          const popup = window.open(loadingUrl, '_blank')
                          setAutoRunReady(false)
                          setMode('auto')
                          setLoading(true)
                          const activePlan = plan!
                          const label = activePlan.summary ?? 'test'
                          setMessages(prev => [...prev, { role: 'agent', text: 'Launching dedicated browser… (~60s to start Fargate task)' }]);
                          (async () => {
                            try {
                              const sessionRaw = await callAgent({ inputText: label, mode: 'start_session', sessionId }, sessionId)
                              const resolvedSession = JSON.parse(sessionRaw)
                              if (resolvedSession.error) throw new Error(resolvedSession.error as string)
                              URL.revokeObjectURL(loadingUrl)
                              setNovncUrl(resolvedSession.novnc_url as string)
                              if (popup) { popup.location.href = `${resolvedSession.novnc_url}?autoconnect=true&resize=scale`; popupRef.current = popup }
                              setMessages(prev => [...prev.slice(0, -1), { role: 'agent', text: 'Browser is live! Running test now… watch it in the popup' }])
                              const raw = await callAgent({ inputText: label, mode: 'automate', plan: activePlan, sessionId, task_arn: resolvedSession.task_arn, cluster: resolvedSession.cluster, mcp_endpoint: resolvedSession.mcp_endpoint }, sessionId)
                              const result = JSON.parse(raw)
                              if (result.error) throw new Error(result.error as string)
                              const passed = result.result?.passed ?? result.passed
                              const summary = result.result?.summary ?? result.summary ?? ''
                              saveRun({ description: label, passed, timestamp: new Date().toISOString() })
                              if (savedTcId.current) saveRunRecord({ testCaseId: savedTcId.current, env, result: passed ? 'PASS' : 'FAIL', summary, runBy: userName }).catch(() => {})
                              setMessages(prev => [...prev.slice(0, -1), { role: 'agent', text: `Execution ${passed ? '✅ Passed' : '❌ Failed'}\n\n${summary}` }])
                              popupRef.current?.close(); popupRef.current = null
                            } catch (err) {
                              setMessages(prev => [...prev.slice(0, -1), { role: 'agent', text: `Error: ${err instanceof Error ? err.message : String(err)}` }])
                            } finally { setLoading(false) }
                          })()
                        }}
                        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[#7C3AED] hover:bg-[#5B21B6] text-white text-[14px] font-semibold cursor-pointer transition-colors"
                      >
                        <svg viewBox="0 0 24 24" className="w-4 h-4 stroke-current fill-none stroke-2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                        Start Test Execution
                      </button>
                    </div>
                  )}

                  {/* Save test case form */}
                  {!autoRunReady && <div className="border-t border-slate-200 bg-white px-4 py-3 flex-shrink-0">
                    <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Save Test Case</div>

                    {/* Service chips */}
                    <div className="mb-2">
                      <div className="text-[11px] text-slate-400 mb-1.5">Service</div>
                      {servicesLoading ? (
                        <div className="text-[12px] text-slate-400">Loading services…</div>
                      ) : availableServices.length === 0 ? (
                        <div className="text-[12px] text-slate-400">No services configured for {env.toUpperCase()} yet.</div>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {availableServices.map(svc => (
                            <button key={svc} onClick={() => tcSaved === 'idle' && setTcService(svc)}
                              disabled={tcSaved === 'saved'}
                              className={`px-2.5 py-1 rounded-full text-[12px] font-semibold border cursor-pointer transition-colors disabled:opacity-50 ${
                                tcService === svc
                                  ? 'bg-[#7C3AED] text-white border-[#7C3AED]'
                                  : 'bg-slate-50 text-slate-600 border-slate-200 hover:border-[#7C3AED] hover:text-[#7C3AED]'
                              }`}>
                              {svc}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex gap-2 mb-2">
                      <input
                        value={tcName}
                        onChange={e => setTcName(e.target.value)}
                        placeholder="Test case name"
                        disabled={tcSaved === 'saved'}
                        className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-[13px] outline-none focus:border-[#7C3AED] transition-colors disabled:opacity-50 disabled:bg-slate-50"
                      />
                    </div>
                    <button
                      onClick={async () => {
                        if (tcSaved !== 'idle' || !tcService.trim() || !tcName.trim()) return
                        setTcSaved('saving')
                        try {
                          const id = await saveTestCase({
                            description: tcName.trim(),
                            env,
                            service: tcService.trim(),
                            steps: plan.steps ?? [],
                            createdBy: userName,
                          })
                          savedTcId.current = id
                          setTcSaved('saved')
                        } catch {
                          setTcSaved('idle')
                        }
                      }}
                      disabled={tcSaved !== 'idle' || !tcService.trim() || !tcName.trim()}
                      className={`w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[13px] font-semibold border transition-colors cursor-pointer ${
                        tcSaved === 'saved'
                          ? 'bg-green-50 text-green-700 border-green-200'
                          : 'bg-[#EDE9FE] text-[#7C3AED] border-[#DDD6FE] hover:bg-[#DDD6FE] disabled:opacity-40 disabled:cursor-not-allowed'
                      }`}
                    >
                      {tcSaved === 'saving' ? (
                        <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>
                      ) : tcSaved === 'saved' ? (
                        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2"><polyline points="20 6 9 17 4 12"/></svg>
                      ) : (
                        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                      )}
                      {tcSaved === 'saving' ? 'Saving…' : tcSaved === 'saved' ? 'Saved to Test Inventory' : 'Save Test Case'}
                    </button>
                  </div>}
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-[14px] text-slate-400">
                  Plan will appear here once the agent authors a test case.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
