import { useState, useRef, useEffect } from 'react'

import { fetchUserAttributes, fetchAuthSession } from '@aws-amplify/auth'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb'

import { useEnv } from '../context/EnvContext'
import { useTeam } from '../context/TeamContext'
import { saveTestCase, updateTestCasePlanSteps } from '../lib/lambdaClient'
import { callAgent } from '../lib/agentClient'

const AWS_REGION = import.meta.env.VITE_AWS_REGION as string
const TABLE = 'prompt2test-config'

async function loadServiceNames(team: string, env: string): Promise<string[]> {
  const session = await fetchAuthSession()
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION, credentials: session.credentials as never }))
  const resp = await db.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': `SERVICE#${team}#${env}` },
    ProjectionExpression: 'svc',
  }))
  const names = new Set<string>((resp.Items ?? []).map(i => i.svc as string).filter(Boolean))
  return [...names].sort()
}

type Message = { role: 'user' | 'agent'; text: string }
type StepItem = { step: number; action: string; expected: string }

function parseAgentResponse(text: string): { steps: StepItem[]; note: string; isFinal: boolean; summary: string } {
  const trimmed = text.trim()
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
  const [planScenario, setPlanScenario] = useState('')
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [saveTitleInput, setSaveTitleInput] = useState('')
  const [saveTcIdInput, setSaveTcIdInput] = useState('')
  const [saveService, setSaveService] = useState('')
  const [planSteps, setPlanSteps] = useState<StepItem[]>([])
  const { env } = useEnv()
  const { team } = useTeam()
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

  useEffect(() => {
    setServicesLoading(true)
    loadServiceNames(team, env).then(setAvailableServices).catch(() => {}).finally(() => setServicesLoading(false))
  }, [env, team])

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
        team,
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#FAFBFF' }}>
      {/* Agent topbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 16px', height: 52, background: 'white', borderBottom: '1px solid #E8EBF0', flexShrink: 0 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#0F172A' }}>Author Agent</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#6D28D9', background: '#EDE9FE', border: '1px solid #DDD6FE', padding: '2px 8px', borderRadius: 20 }}>
          Bedrock · {env.toUpperCase()}
        </span>
      </div>

      {/* Main workspace */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Chat panel */}
        <div style={{ display: 'flex', flexDirection: 'column', borderRight: '1px solid #E8EBF0', flexShrink: 0, background: 'white', width: 440 }}>
          <div ref={chatRef} style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {messages.map((msg, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div style={{ fontSize: 12, color: '#94A3B8', marginBottom: 4 }}>
                  {msg.role === 'user' ? (userName || 'You') : 'Prompt2Test'}
                </div>
                <div style={{
                  maxWidth: '85%', padding: '10px 14px', borderRadius: 14, fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-line',
                  ...(msg.role === 'user'
                    ? { background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', borderBottomRightRadius: 4 }
                    : { background: '#F8FAFC', border: '1px solid #E2E8F0', color: '#334155', borderBottomLeftRadius: 4 }
                  ),
                }}>
                  {msg.text}
                </div>
                {msg.role === 'user' && (
                  <button
                    onClick={() => setInput(msg.text)}
                    title="Edit & resend"
                    style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#94A3B8', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#7C3AED')}
                    onMouseLeave={e => (e.currentTarget.style.color = '#94A3B8')}
                  >
                    <svg viewBox="0 0 24 24" style={{ width: 12, height: 12, stroke: 'currentColor', fill: 'none', strokeWidth: 2 }}>
                      <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.95"/>
                    </svg>
                    resend
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Input */}
          <div style={{ padding: '12px', borderTop: '1px solid #E8EBF0', background: 'white', flexShrink: 0 }}>
            <div style={{ border: '1px solid #E2E8F0', borderRadius: 14, background: '#F8FAFC', overflow: 'hidden' }}>
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                placeholder="Paste your scenario here…"
                rows={3}
                disabled={loading}
                style={{ width: '100%', background: 'transparent', padding: '12px 16px 4px', fontSize: 14, color: '#0F172A', outline: 'none', resize: 'none', fontFamily: 'inherit', boxSizing: 'border-box', opacity: loading ? 0.6 : 1 }}
              />

              {/* Bottom toolbar */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 12px 8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                  {/* Mode dropdown */}
                  <div style={{ position: 'relative' }}>
                    <button
                      onClick={() => setModeOpen(o => !o)}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8, fontSize: 13, fontWeight: 500, color: '#64748B', background: 'none', border: 'none', cursor: 'pointer' }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#F8FAFC')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                    >
                      <svg viewBox="0 0 24 24" style={{ width: 14, height: 14, stroke: 'currentColor', fill: 'none', strokeWidth: 2 }}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                      Plan
                      <svg viewBox="0 0 24 24" style={{ width: 12, height: 12, stroke: 'currentColor', fill: 'none', strokeWidth: 2, opacity: 0.4 }}><polyline points="6 9 12 15 18 9"/></svg>
                    </button>

                    {modeOpen && (
                      <>
                        <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setModeOpen(false)} />
                        <div style={{ position: 'absolute', bottom: '100%', marginBottom: 8, left: 0, zIndex: 50, width: 208, background: 'white', border: '1px solid #E8EBF0', borderRadius: 14, boxShadow: '0 20px 60px rgba(0,0,0,0.15)', padding: '4px 0', overflow: 'hidden' }}>
                          <button onClick={() => setModeOpen(false)}
                            style={{ width: '100%', textAlign: 'left', padding: '10px 12px', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}
                            onMouseEnter={e => (e.currentTarget.style.background = '#F8FAFC')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
                            <div style={{ color: '#7C3AED', flexShrink: 0 }}>
                              <svg viewBox="0 0 24 24" style={{ width: 16, height: 16, stroke: 'currentColor', fill: 'none', strokeWidth: 2 }}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 13, fontWeight: 600, color: '#4F46E5' }}>Plan</div>
                              <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>Review steps before running</div>
                            </div>
                            <svg viewBox="0 0 24 24" style={{ width: 14, height: 14, stroke: '#4F46E5', fill: 'none', strokeWidth: 2, flexShrink: 0 }}><polyline points="20 6 9 17 4 12"/></svg>
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Service indicator */}
                  {tcService && (
                    <button
                      onClick={() => { if (!loading) setTcService('') }}
                      title="Change service"
                      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8, fontSize: 13, fontWeight: 600, color: '#6D28D9', background: '#EDE9FE', border: '1px solid #DDD6FE', cursor: 'pointer' }}
                    >
                      <svg viewBox="0 0 24 24" style={{ width: 12, height: 12, stroke: 'currentColor', fill: 'none', strokeWidth: 2 }}><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"/></svg>
                      {tcService}
                      <svg viewBox="0 0 24 24" style={{ width: 10, height: 10, stroke: 'currentColor', fill: 'none', strokeWidth: 2, opacity: 0.5 }}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  )}
                </div>

                {/* Send button */}
                <button onClick={send} disabled={loading || !input.trim()}
                  style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', borderRadius: 8, cursor: (loading || !input.trim()) ? 'default' : 'pointer', opacity: (loading || !input.trim()) ? 0.4 : 1, flexShrink: 0, boxShadow: '0 2px 8px rgba(124,58,237,0.35)' }}>
                  <svg viewBox="0 0 24 24" style={{ width: 14, height: 14, stroke: 'currentColor', fill: 'none', strokeWidth: 2 }}>
                    <line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Plan panel */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#FAFBFF' }}>
          <>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #E8EBF0', background: 'white', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Test Steps
              </div>
              {planSteps.length > 0 && !showSaveDialog && (
                <button
                  onClick={async () => {
                    if (loading) return
                    setLoading(true)
                    try {
                      const h = messages.map(m => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.text}`).join('\n')
                      const raw = await callAgent({ inputText: 'generate_final', mode: 'plan_scenario', service: tcService, env, team, sessionId, conversationHistory: h }, sessionId)
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
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, background: '#EEF2FF', color: '#4F46E5', border: '1px solid #C7D2FE', cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.4 : 1 }}
                >
                  <svg viewBox="0 0 24 24" style={{ width: 14, height: 14, stroke: 'currentColor', fill: 'none', strokeWidth: 2 }}><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg>
                  Generate Final
                </button>
              )}
            </div>

            {/* Plan Scenario panel */}
            <>
              {/* State 1: No service selected — show service picker chips */}
              {!tcService ? (
                <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Pick a Service</div>
                  {servicesLoading ? (
                    <div style={{ fontSize: 13, color: '#94A3B8' }}>Loading services…</div>
                  ) : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      <button
                        onClick={() => setTcService('exploratory')}
                        style={{ padding: '6px 12px', borderRadius: 20, fontSize: 13, fontWeight: 600, background: '#F8FAFC', color: '#64748B', border: '1px solid #E2E8F0', cursor: 'pointer' }}
                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.border = '1px solid #C7D2FE'; (e.currentTarget as HTMLButtonElement).style.color = '#4F46E5'; (e.currentTarget as HTMLButtonElement).style.background = '#EEF2FF' }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.border = '1px solid #E2E8F0'; (e.currentTarget as HTMLButtonElement).style.color = '#64748B'; (e.currentTarget as HTMLButtonElement).style.background = '#F8FAFC' }}
                      >
                        Exploratory
                      </button>
                      {availableServices.map(svc => (
                        <button key={svc} onClick={() => setTcService(svc)}
                          style={{ padding: '6px 12px', borderRadius: 20, fontSize: 13, fontWeight: 600, background: '#F8FAFC', color: '#64748B', border: '1px solid #E2E8F0', cursor: 'pointer' }}
                          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.border = '1px solid #C7D2FE'; (e.currentTarget as HTMLButtonElement).style.color = '#4F46E5'; (e.currentTarget as HTMLButtonElement).style.background = '#EEF2FF' }}
                          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.border = '1px solid #E2E8F0'; (e.currentTarget as HTMLButtonElement).style.color = '#64748B'; (e.currentTarget as HTMLButtonElement).style.background = '#F8FAFC' }}
                        >
                          {svc}
                        </button>
                      ))}
                    </div>
                  )}
                  <p style={{ marginTop: 16, fontSize: 13, color: '#94A3B8', lineHeight: 1.6 }}>
                    Select a service, then paste your scenario in the chat to start enriching it.
                  </p>
                </div>
              ) : planSteps.length > 0 ? (
                /* State 2: Steps exist — show MTM-style step table */
                <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
                    Test Steps &nbsp;·&nbsp; <span style={{ color: '#4F46E5', textTransform: 'none', fontWeight: 600 }}>{tcService}</span>
                  </div>
                  <div style={{ borderRadius: 10, overflow: 'hidden', background: 'white', border: '1px solid #E8EBF0', boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04)' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: '#F8FAFC', borderBottom: '1px solid #E8EBF0' }}>
                          <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em', width: 32 }}>#</th>
                          <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Action</th>
                          <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Expected Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {planSteps.map((s, i) => (
                          <tr key={s.step} style={{ borderBottom: i < planSteps.length - 1 ? '1px solid #E8EBF0' : 'none', background: i % 2 === 0 ? 'transparent' : '#FAFBFF' }}
                            onMouseEnter={e => (e.currentTarget.style.background = '#F8FAFC')}
                            onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : '#FAFBFF')}
                          >
                            <td style={{ padding: '10px', textAlign: 'center', verticalAlign: 'top' }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: '50%', background: '#EDE9FE', color: '#7C3AED', fontSize: 10, fontWeight: 700 }}>{s.step}</span>
                            </td>
                            <td style={{ padding: '10px 12px', color: '#0F172A', lineHeight: 1.6, verticalAlign: 'top' }}>{s.action}</td>
                            <td style={{ padding: '10px 12px', color: '#64748B', lineHeight: 1.6, verticalAlign: 'top' }}>{s.expected}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                /* State 2 empty: service selected, no steps yet */
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '0 24px', gap: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#64748B' }}>
                    Service: <span style={{ color: '#4F46E5' }}>{tcService}</span>
                  </div>
                  <div style={{ fontSize: 13, color: '#94A3B8', lineHeight: 1.6 }}>
                    Paste your scenario in the chat.<br />Steps will appear here as I refine them.
                  </div>
                </div>
              )}

              {/* Save dialog */}
              {showSaveDialog && (
                <div style={{ borderTop: '1px solid #E8EBF0', background: '#F8FAFC', padding: '12px 16px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Save Test Case</div>
                    {(saveService || tcService) && (
                      <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: '#EDE9FE', color: '#6D28D9', border: '1px solid #DDD6FE' }}>
                        {saveService || tcService}
                      </span>
                    )}
                  </div>
                  <input
                    value={saveTitleInput}
                    onChange={e => setSaveTitleInput(e.target.value)}
                    placeholder="Title"
                    disabled={tcSaved === 'saved'}
                    style={{ width: '100%', padding: '6px 12px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 13, color: '#0F172A', outline: 'none', boxSizing: 'border-box', opacity: tcSaved === 'saved' ? 0.5 : 1 }}
                  />
                  <input
                    value={saveTcIdInput}
                    onChange={e => setSaveTcIdInput(e.target.value)}
                    placeholder="Test Case ID (e.g. TC-001)"
                    disabled={tcSaved === 'saved'}
                    style={{ width: '100%', padding: '6px 12px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 13, color: '#0F172A', outline: 'none', fontFamily: 'monospace', boxSizing: 'border-box', opacity: tcSaved === 'saved' ? 0.5 : 1 }}
                  />
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
                          team,
                        })
                        savedTcId.current = id
                        setTcSaved('saved')
                        if (id && planSteps.length) updateTestCasePlanSteps(id, planSteps).catch(() => {})
                      } catch { setTcSaved('idle') }
                    }}
                    disabled={tcSaved !== 'idle' || !saveTitleInput.trim()}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      padding: '6px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: tcSaved !== 'idle' || !saveTitleInput.trim() ? 'default' : 'pointer',
                      ...(tcSaved === 'saved'
                        ? { background: '#DCFCE7', color: '#166534', border: '1px solid #BBF7D0' }
                        : { background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', boxShadow: '0 2px 8px rgba(124,58,237,0.35)', opacity: (tcSaved !== 'idle' || !saveTitleInput.trim()) ? 0.4 : 1 }
                      ),
                    }}
                  >
                    {tcSaved === 'saving' ? (
                      <svg style={{ width: 14, height: 14, animation: 'spin 0.7s linear infinite' }} viewBox="0 0 24 24" fill="none"><circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>
                    ) : tcSaved === 'saved' ? (
                      <svg viewBox="0 0 24 24" style={{ width: 14, height: 14, stroke: 'currentColor', fill: 'none', strokeWidth: 2 }}><polyline points="20 6 9 17 4 12"/></svg>
                    ) : (
                      <svg viewBox="0 0 24 24" style={{ width: 14, height: 14, stroke: 'currentColor', fill: 'none', strokeWidth: 2 }}><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                    )}
                    {tcSaved === 'saving' ? 'Saving…' : tcSaved === 'saved' ? 'Saved to Test Inventory' : 'Save Test Case'}
                  </button>

                  {/* View Test Case button — shown after save */}
                  {tcSaved === 'saved' && savedTcId.current && (
                    <button
                      onClick={() => window.open(`/test-case/${savedTcId.current}`, '_blank')}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '8px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', cursor: 'pointer', boxShadow: '0 2px 8px rgba(124,58,237,0.35)' }}
                    >
                      <svg viewBox="0 0 24 24" style={{ width: 14, height: 14, stroke: 'currentColor', fill: 'none', strokeWidth: 2 }}><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/></svg>
                      View Test Case →
                    </button>
                  )}
                </div>
              )}
            </>
          </>
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
