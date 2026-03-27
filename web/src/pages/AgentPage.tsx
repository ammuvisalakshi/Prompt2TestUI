import { useState, useRef, useEffect } from 'react'

import { fetchUserAttributes, fetchAuthSession } from '@aws-amplify/auth'
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm'

import { useEnv } from '../context/EnvContext'
import { saveTestCase, updateTestCasePlanSteps } from '../lib/lambdaClient'
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

export default function AgentPage() {

  const [messages, setMessages] = useState<Message[]>([
    { role: 'agent', text: "Hi! Ready to author tests.\n\nPaste a scenario below, pick a service, and I'll enrich it with your real config values." },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sessionId] = useState(() => crypto.randomUUID())
  const [userName, setUserName] = useState('')
  const savedTcId = useRef<string | null>(null)
  const [tcSaved, setTcSaved] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [tcService, setTcService] = useState('')
  const [availableServices, setAvailableServices] = useState<string[]>([])
  const [servicesLoading, setServicesLoading] = useState(false)
  // Plan Scenario mode state
  const [planScenario, setPlanScenario] = useState('')
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [saveTitleInput, setSaveTitleInput] = useState('')
  const [saveTcIdInput, setSaveTcIdInput] = useState('')
  const [saveService, setSaveService] = useState('')  // locked-in service at dialog-open time
  const [planSteps, setPlanSteps] = useState<StepItem[]>([])
  const { env } = useEnv()
  const [modeOpen, setModeOpen] = useState(false)
  const chatRef = useRef<HTMLDivElement>(null)


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
        {/* Chat panel */}
        <div className="flex flex-col border-r border-slate-200 flex-shrink-0 bg-white w-[440px]">
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
                {msg.role === 'user' && (
                  <button
                    onClick={() => setInput(msg.text)}
                    title="Edit & resend"
                    className="mt-1 flex items-center gap-1 text-[11px] text-slate-400 hover:text-[#7C3AED] cursor-pointer transition-colors"
                  >
                    <svg viewBox="0 0 24 24" className="w-3 h-3 stroke-current fill-none stroke-2">
                      <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.95"/>
                    </svg>
                    resend
                  </button>
                )}
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
                placeholder="Paste your scenario here…"
                rows={3}
                disabled={loading}
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
                      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                      Plan
                      <svg viewBox="0 0 24 24" className="w-3 h-3 stroke-current fill-none stroke-2 opacity-40"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>

                    {modeOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setModeOpen(false)} />
                        <div className="absolute bottom-full mb-2 left-0 z-50 w-52 bg-white border border-slate-200 rounded-xl shadow-xl py-1 overflow-hidden">
                          <button onClick={() => setModeOpen(false)}
                            className="w-full text-left px-3 py-2.5 hover:bg-slate-50 flex items-center gap-3 cursor-pointer">
                            <div className="flex-shrink-0 text-[#7C3AED]">
                              <svg viewBox="0 0 24 24" className="w-4 h-4 stroke-current fill-none stroke-2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                            </div>
                            <div className="flex-1">
                              <div className="text-[13px] font-semibold text-[#7C3AED]">Plan</div>
                              <div className="text-[11px] text-slate-400 mt-0.5">Review steps before running</div>
                            </div>
                            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-[#7C3AED] fill-none stroke-2 flex-shrink-0"><polyline points="20 6 9 17 4 12"/></svg>
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Service indicator */}
                  {tcService && (
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

        {/* Plan panel */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <>
            <div className="px-4 py-3 border-b border-slate-200 bg-white flex-shrink-0 flex items-center justify-between">
              <div className="text-[13px] font-semibold text-slate-400 uppercase tracking-wider">
                Test Steps
              </div>
              {planSteps.length > 0 && !showSaveDialog && (
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

                  {/* View Test Case button — shown after save */}
                  {tcSaved === 'saved' && savedTcId.current && (
                    <button
                      onClick={() => window.open(`/test-case/${savedTcId.current}`, '_blank')}
                      className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[13px] font-semibold bg-[#7C3AED] hover:bg-[#5B21B6] text-white transition-colors cursor-pointer"
                    >
                      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/></svg>
                      View Test Case →
                    </button>
                  )}
                </div>
              )}
            </>
          </>
        </div>
      </div>
    </div>
  )
}
