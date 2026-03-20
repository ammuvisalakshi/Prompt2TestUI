import { useState, useRef, useEffect } from 'react'
import { fetchAuthSession, signOut } from '@aws-amplify/auth'
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore'
import { useNavigate } from 'react-router-dom'

type Message = { role: 'user' | 'agent'; text: string }

type Plan = {
  summary?: string
  steps?: { stepNumber: number; type: string; tool?: string; action: string; detail: string }[]
  configNeeded?: string[]
  estimatedTokens?: number
  mcpCalls?: number
  raw?: string
}

const HINTS = [
  'Test billing plan is correct',
  'Verify export button visibility',
  'Check max user limit shown',
]

const AGENT_RUNTIME_ARN = import.meta.env.VITE_AGENT_RUNTIME_ARN as string
const AWS_REGION = import.meta.env.VITE_AWS_REGION as string
const NOVNC_URL = import.meta.env.VITE_NOVNC_URL as string | undefined

async function callAgent(payload: object, sessionId: string): Promise<string> {
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

  // Response is a streaming blob
  if (!response.response) return ''
  const reader = (response.response as ReadableStream<Uint8Array>).getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  const text = new TextDecoder().decode(
    chunks.reduce((a, b) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c }, new Uint8Array())
  )
  return text
}

export default function AgentPage() {
  const navigate = useNavigate()
  const [messages, setMessages] = useState<Message[]>([
    { role: 'agent', text: "Hi! Ready to author tests.\n\nDescribe what you want to test in plain English." },
  ])
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<'plan' | 'auto'>('plan')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [loading, setLoading] = useState(false)
  const [sessionId] = useState(() => crypto.randomUUID())
  const chatRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight
  }, [messages])

  async function handleSignOut() {
    await signOut()
    navigate('/login')
  }

  async function send() {
    const text = input.trim()
    if (!text || loading) return
    setMessages(prev => [...prev, { role: 'user', text }])
    setInput('')
    setLoading(true)

    // Build conversation history to give agent memory across turns
    const history = messages
      .filter(m => m.text !== 'Generating test plan…' && m.text !== 'Executing test plan via Playwright MCP…')
      .map(m => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.text}`)
      .join('\n')

    try {
      if (mode === 'plan') {
        setMessages(prev => [...prev, { role: 'agent', text: 'Generating test plan…' }])
        const raw = await callAgent({ inputText: text, mode: 'plan', sessionId, conversationHistory: history }, sessionId)
        const result = JSON.parse(raw)
        const agentPlan: Plan = result.plan ?? result

        // If no steps returned, the agent is asking a clarifying question — show as conversation
        if (!agentPlan.steps || agentPlan.steps.length === 0) {
          const conversationalText = agentPlan.raw ?? agentPlan.summary ?? 'Could you provide more details?'
          // Auto-switch to Automate mode if agent is telling user to switch
          const switchKeywords = ['automate tab', 'automate mode', 'switch to automate', 'click automate', 'use automate']
          if (switchKeywords.some(k => conversationalText.toLowerCase().includes(k))) {
            setMode('auto')
          }
          setMessages(prev => [
            ...prev.slice(0, -1),
            { role: 'agent', text: conversationalText },
          ])
          return
        }

        setPlan(agentPlan)
        setMessages(prev => [
          ...prev.slice(0, -1),
          { role: 'agent', text: `Plan ready! ${agentPlan.summary ?? ''}\n\n${agentPlan.steps?.length ?? 0} steps · ${agentPlan.mcpCalls ?? 0} MCP calls\n\nSwitching to Automate mode — type anything to execute.` },
        ])
        setMode('auto')
      } else {
        if (!plan) {
          setMessages(prev => [...prev, { role: 'agent', text: 'Please generate a plan first in Plan mode.' }])
          return
        }
        setMessages(prev => [...prev, { role: 'agent', text: 'Executing test plan via Playwright MCP…' }])
        const raw = await callAgent({ inputText: text, mode: 'automate', plan, sessionId }, sessionId)
        const result = JSON.parse(raw)
        const passed = result.result?.passed ?? result.passed
        setMessages(prev => [
          ...prev.slice(0, -1),
          { role: 'agent', text: `Execution ${passed ? '✅ Passed' : '❌ Failed'}\n\n${result.result?.summary ?? result.summary ?? ''}` },
        ])
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
      <div className="flex items-center justify-between px-4 py-2.5 bg-white border-b border-slate-200 flex-shrink-0 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="text-[15px] font-semibold text-slate-900">
            Author Agent{' '}
            <span className="text-[12px] font-medium text-[#028090] bg-[#E0F7FA] border border-[#B2EBF2] px-2 py-0.5 rounded-full ml-1">
              Bedrock · DEV
            </span>
          </span>
          <div className="flex bg-slate-100 border border-slate-200 rounded-lg overflow-hidden">
            {(['plan', 'auto'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-1 text-[13px] font-medium transition-colors cursor-pointer ${
                  mode === m ? 'bg-[#028090] text-white' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {m === 'plan' ? 'Plan' : 'Automate'}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 text-[13px] text-slate-500">
          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#028090] to-[#06B6D4] flex items-center justify-center text-[11px] font-bold text-white">JD</div>
          <span>Jane D</span>
          <span className="px-2 py-0.5 bg-green-50 border border-green-200 rounded-full text-green-700 text-[12px]">DEV</span>
          <button onClick={handleSignOut} className="text-[12px] text-slate-400 hover:text-slate-700 cursor-pointer ml-1">Sign out</button>
        </div>
      </div>

      {/* Main workspace */}
      <div className="flex flex-1 overflow-hidden">
        {/* Chat panel */}
        <div className="flex flex-col w-[440px] border-r border-slate-200 flex-shrink-0 bg-white">
          <div ref={chatRef} className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.map((msg, i) => (
              <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div className="text-[12px] text-slate-400 mb-1">
                  {msg.role === 'user' ? 'Jane D' : 'Prompt2Test'}
                </div>
                <div className={`max-w-[85%] px-3.5 py-2.5 rounded-xl text-[14px] leading-relaxed whitespace-pre-line ${
                  msg.role === 'user'
                    ? 'bg-[#028090] text-white rounded-br-sm'
                    : 'bg-slate-50 border border-slate-200 text-slate-700 rounded-bl-sm'
                }`}>
                  {msg.text}
                </div>
              </div>
            ))}
          </div>

          {/* Input */}
          <div className="p-3 border-t border-slate-200">
            <div className="flex gap-2 items-end">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                placeholder={mode === 'plan' ? 'Describe what you want to test…' : 'Type "run" to execute the plan…'}
                rows={2}
                disabled={loading}
                className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-[14px] text-slate-800 placeholder-slate-400 outline-none resize-none focus:border-[#028090] transition-colors font-sans disabled:opacity-60"
              />
              <button
                onClick={send}
                disabled={loading}
                className="px-3 py-2 bg-[#028090] hover:bg-[#01555F] disabled:opacity-60 text-white rounded-lg transition-colors cursor-pointer flex-shrink-0"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4 stroke-current fill-none stroke-2">
                  <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" />
                </svg>
              </button>
            </div>
            <div className="flex gap-2 mt-2 flex-wrap">
              {HINTS.map(h => (
                <button
                  key={h}
                  onClick={() => setInput(h)}
                  className="text-[12px] px-2.5 py-1 bg-white border border-slate-200 rounded-full text-slate-500 hover:border-[#028090] hover:text-[#028090] transition-colors cursor-pointer"
                >
                  {h}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Plan / Live Browser panel */}
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* Live browser — full panel when executing */}
          {mode === 'auto' && loading && NOVNC_URL ? (
            <>
              <div className="px-4 py-2.5 border-b border-slate-200 bg-white flex-shrink-0 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                  <span className="text-[13px] font-semibold text-slate-700 uppercase tracking-wider">Live Browser</span>
                </div>
                <button
                  onClick={() => window.open(`${NOVNC_URL}/vnc.html?autoconnect=true&reconnect=true&resize=scale`, '_blank', 'width=1280,height=800,toolbar=0,menubar=0')}
                  className="flex items-center gap-1.5 text-[12px] text-slate-500 hover:text-[#028090] border border-slate-200 hover:border-[#028090] rounded-lg px-2.5 py-1 transition-colors cursor-pointer"
                  title="Pop out to new window"
                >
                  <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2">
                    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
                  </svg>
                  Pop out
                </button>
              </div>
              <div className="flex-1 overflow-hidden">
                <iframe
                  src={`${NOVNC_URL}/vnc.html?autoconnect=true&reconnect=true&reconnect_delay=2000&resize=scale`}
                  className="w-full h-full border-0"
                  allow="fullscreen"
                  title="Live browser view"
                />
              </div>
            </>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-slate-200 bg-white flex-shrink-0">
                <div className="text-[13px] font-semibold text-slate-400 uppercase tracking-wider">Execution Plan</div>
              </div>
              {plan ? (
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
                      <div className="w-6 h-6 rounded-full bg-[#028090] text-white text-[11px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                        {step.stepNumber}
                      </div>
                      <div>
                        <div className="text-[13px] font-semibold text-slate-800">{step.action}</div>
                        <div className="text-[12px] text-slate-500 mt-0.5">{step.detail}</div>
                        <div className="text-[11px] text-[#028090] mt-1 font-medium uppercase tracking-wide">{step.type} · {step.tool ?? ''}</div>
                      </div>
                    </div>
                  ))}
                  {plan.raw && (
                    <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
                      <pre className="text-[12px] text-slate-600 whitespace-pre-wrap">{plan.raw}</pre>
                    </div>
                  )}
                </div>
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
