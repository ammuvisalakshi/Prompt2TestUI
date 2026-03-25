import { useState, useRef, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { fetchAuthSession, fetchUserAttributes } from '@aws-amplify/auth'
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore'
import type { RunEntry } from '../layouts/PlatformLayout'
import { useEnv } from '../context/EnvContext'
import { saveTestCase, saveRunRecord, getTestCase } from '../lib/lambdaClient'

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

type Plan = {
  confirmationMessage?: string
  summary?: string
  steps?: { stepNumber: number; type: string; tool?: string; action: string; detail: string }[]
  configNeeded?: string[]
  estimatedTokens?: number
  mcpCalls?: number
  raw?: string
}


const AGENT_RUNTIME_ARN = import.meta.env.VITE_AGENT_RUNTIME_ARN as string
const AWS_REGION = import.meta.env.VITE_AWS_REGION as string

async function callAgent(
  payload: object,
  sessionId: string,
  onEvent?: (event: Record<string, unknown>) => void,
): Promise<string> {
  const session = await fetchAuthSession()
  if (!session.credentials) throw new Error('Not authenticated')

  const client = new BedrockAgentCoreClient({
    region: AWS_REGION,
    credentials: session.credentials,
  })

  const cmd = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: AGENT_RUNTIME_ARN,
    runtimeSessionId: sessionId,
    contentType: 'application/json',
    accept: 'application/json',
    payload: new TextEncoder().encode(JSON.stringify(payload)),
  })

  const response = await client.send(cmd)

  if (!response.response) return ''
  const reader = (response.response as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  const chunks: Uint8Array[] = []
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      buffer += decoder.decode(value, { stream: true })
      // Parse and dispatch complete newline-delimited JSON events as they arrive
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          if (onEvent) onEvent(event)
        } catch { /* ignore partial lines */ }
      }
    }
  }

  // Return last complete line (the "complete" event for non-streaming callers)
  const allText = decoder.decode(
    chunks.reduce((a, b) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c }, new Uint8Array())
  )
  const lines = allText.split('\n').filter(l => l.trim())
  return lines[lines.length - 1] ?? allText
}

export default function AgentPage() {

  const [messages, setMessages] = useState<Message[]>([
    { role: 'agent', text: "Hi! Ready to author tests.\n\nDescribe what you want to test in plain English." },
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
  const [autoRunReady, setAutoRunReady] = useState(false)
  const { env } = useEnv()
  const [modeOpen, setModeOpen] = useState(false)
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
        // If a plan exists and user is confirming execution — run it
        if (plan && /^(yes|run|execute|go|ok|sure|start|do it)/i.test(text)) {
          setMode('auto')

          // Save test case to Aurora (fire-and-forget, don't block execution)
          saveTestCase({
            description: plan.summary ?? messages.find(m => m.role === 'user')?.text ?? text,
            env,
            steps: plan.steps ?? [],
            createdBy: userName,
          }).then(id => { savedTcId.current = id }).catch(() => {})

          // Open popup immediately within user gesture — shows progress bar while task boots
          const loadingBlob = new Blob([loadingHtml], { type: 'text/html' })
          const loadingUrl = URL.createObjectURL(loadingBlob)
          const popup = window.open(loadingUrl, 'novnc-popup', 'width=1280,height=820,toolbar=0,menubar=0,location=0')

          setMessages(prev => [...prev, { role: 'agent', text: 'Launching dedicated browser… (~60s to start Fargate task)' }])

          // ── Step 1: RunTask + wait for RUNNING (~60s) ─────────────────────
          const sessionRaw = await callAgent({ inputText: text, mode: 'start_session', sessionId }, sessionId)
          const resolvedSession = JSON.parse(sessionRaw)
          if (resolvedSession.error) throw new Error(resolvedSession.error as string)

          URL.revokeObjectURL(loadingUrl)
          setNovncUrl(resolvedSession.novnc_url as string)
          if (popup) {
            popup.location.href = `${resolvedSession.novnc_url}?autoconnect=true&resize=scale`
            popupRef.current = popup
          }
          setMessages(prev => [
            ...prev.slice(0, -1),
            { role: 'agent', text: 'Browser is live! Running test now… watch it in the popup' },
          ])

          // ── Step 2: run the test against the live session ─────────────────
          const raw = await callAgent({
            inputText: text,
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
          saveRun({ description: text, passed, timestamp: new Date().toISOString() })
          if (savedTcId.current) saveRunRecord({ testCaseId: savedTcId.current, env, result: passed ? 'PASS' : 'FAIL', summary, runBy: userName }).catch(() => {})
          setMessages(prev => [
            ...prev.slice(0, -1),
            { role: 'agent', text: `Execution ${passed ? '✅ Passed' : '❌ Failed'}\n\n${summary}` },
          ])
          window.open('', 'novnc-popup')?.close()
          popupRef.current = null
        } else {
          // Generate / refine the plan
          setMessages(prev => [...prev, { role: 'agent', text: 'Generating test plan…' }])
          const raw = await callAgent({ inputText: text, mode: 'plan', sessionId, conversationHistory: history }, sessionId)
          const result = JSON.parse(raw)

          // Surface agent-side errors immediately
          if (result.error) {
            setMessages(prev => [
              ...prev.slice(0, -1),
              { role: 'agent', text: `Agent error: ${result.error}` },
            ])
            return
          }

          const agentPlan: Plan = result.plan ?? result

          if (!agentPlan.steps || agentPlan.steps.length === 0) {
            // Conversational response (clarifying question) — show as chat
            const conversationalText = agentPlan.raw?.trim()
              || (agentPlan.summary !== 'Plan generated' ? agentPlan.summary : '')
              || 'What would you like to test? Describe the feature, the URL, and what the expected result should be.'
            setMessages(prev => [
              ...prev.slice(0, -1),
              { role: 'agent', text: conversationalText },
            ])
            return
          }

          setPlan(agentPlan)
          setTcSaved('idle')

          // Show confirmationMessage (what was agreed) + plan-ready prompt as separate messages
          const confirmMsg = agentPlan.confirmationMessage
          const planReadyMsg = `Plan ready! ${agentPlan.summary ?? ''}\n\n${agentPlan.steps?.length ?? 0} steps · ${agentPlan.mcpCalls ?? 0} MCP calls\n\nWould you like me to execute this test? Reply **yes** to run it, or keep chatting to refine the plan.`
          setMessages(prev => [
            ...prev.slice(0, -1),
            ...(confirmMsg ? [{ role: 'agent' as const, text: confirmMsg }] : []),
            { role: 'agent', text: planReadyMsg },
          ])
        }
      } else {
        if (!plan) {
          setMessages(prev => [...prev, { role: 'agent', text: 'Please generate a plan first in Plan mode.' }])
          return
        }
        const loadingBlob2 = new Blob([loadingHtml], { type: 'text/html' })
        const loadingUrl2 = URL.createObjectURL(loadingBlob2)
        const popup2 = window.open(loadingUrl2, 'novnc-popup', 'width=1280,height=820,toolbar=0,menubar=0,location=0')
        setMessages(prev => [...prev, { role: 'agent', text: 'Starting browser session… opening live view shortly' }])
        const sessionRaw2 = await callAgent({ inputText: text, mode: 'start_session', sessionId }, sessionId)
        const sessionResult2 = JSON.parse(sessionRaw2)
        if (sessionResult2.error) throw new Error(sessionResult2.error as string)
        const novncUrl2 = sessionResult2.novnc_url as string
        setNovncUrl(novncUrl2)
        URL.revokeObjectURL(loadingUrl2)
        if (popup2) {
          popup2.location.href = `${novncUrl2}?autoconnect=true&resize=scale`
          popupRef.current = popup2
        }
        setMessages(prev => [...prev.slice(0, -1), { role: 'agent', text: 'Browser is live! Running test now… watch it in the popup' }])
        const raw = await callAgent({
          inputText: text, mode: 'automate', plan, sessionId,
          task_arn: sessionResult2.task_arn, cluster: sessionResult2.cluster, mcp_endpoint: sessionResult2.mcp_endpoint,
        }, sessionId)
        const result = JSON.parse(raw)
        const passed = result.result?.passed ?? result.passed
        const summary2 = result.result?.summary ?? result.summary ?? ''
        saveRun({ description: text, passed, timestamp: new Date().toISOString() })
        if (savedTcId.current) saveRunRecord({ testCaseId: savedTcId.current, env, result: passed ? 'PASS' : 'FAIL', summary: summary2, runBy: userName }).catch(() => {})
        setMessages(prev => [
          ...prev.slice(0, -1),
          { role: 'agent', text: `Execution ${passed ? '✅ Passed' : '❌ Failed'}\n\n${summary2}` },
        ])
        window.open('', 'novnc-popup')?.close()
        popupRef.current = null
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
            <div className="border border-slate-200 rounded-xl bg-white focus-within:border-[#7C3AED] transition-colors overflow-hidden">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                placeholder="Describe what you want to test…"
                rows={3}
                disabled={loading}
                className="w-full bg-white px-4 pt-3 pb-1 text-[14px] text-slate-800 placeholder-slate-400 outline-none resize-none font-sans disabled:opacity-60"
              />

              {/* Bottom toolbar — Copilot style */}
              <div className="flex items-center justify-between px-3 pb-2 pt-1">
                <div className="flex items-center gap-1">
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
              <div className="flex-1 overflow-hidden flex flex-col items-center justify-center gap-4 bg-slate-900 text-slate-400">
                {loading ? (
                  <>
                    <svg className="w-8 h-8 animate-spin text-[#7C3AED]" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                    </svg>
                    <span className="text-[13px]">{novncUrl ? 'Test running… watch it live in the browser popup' : 'Starting browser session…'}</span>
                    <span className="text-[11px] text-slate-500">Takes 1–3 min depending on test complexity</span>
                  </>
                ) : novncUrl ? (
                  <>
                    <svg viewBox="0 0 24 24" className="w-8 h-8 stroke-current fill-none stroke-1.5 opacity-40">
                      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
                    </svg>
                    <span className="text-[13px]">Browser session ready</span>
                    <button
                      onClick={() => {
                        popupRef.current = window.open(
                          `${novncUrl}?autoconnect=true&resize=scale`,
                          'novnc-popup',
                          'width=1280,height=820,toolbar=0,menubar=0,location=0'
                        )
                      }}
                      className="text-[13px] px-4 py-2 bg-[#7C3AED] hover:bg-[#5B21B6] text-white rounded-lg cursor-pointer transition-colors"
                    >
                      Open browser view
                    </button>
                  </>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-slate-200 bg-white flex-shrink-0">
                <div className="text-[13px] font-semibold text-slate-400 uppercase tracking-wider">Execution Plan</div>
              </div>
              {plan ? (
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
                          const popup = window.open(loadingUrl, 'novnc-popup', 'width=1280,height=820,toolbar=0,menubar=0,location=0')
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
                              window.open('', 'novnc-popup')?.close(); popupRef.current = null
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
                    <div className="flex gap-2 mb-2">
                      <input
                        value={tcService}
                        onChange={e => setTcService(e.target.value)}
                        placeholder="Service (e.g. Amazon)"
                        disabled={tcSaved === 'saved'}
                        className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-[13px] outline-none focus:border-[#7C3AED] transition-colors disabled:opacity-50 disabled:bg-slate-50"
                      />
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
