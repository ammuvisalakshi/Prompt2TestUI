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

type ServiceConfig = Record<string, { key: string; value: string }[]>

async function loadAllServiceConfigs(team: string, env: string): Promise<ServiceConfig> {
  const session = await fetchAuthSession()
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION, credentials: session.credentials as never }))
  const resp = await db.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': `SERVICE#${team}#${env}` },
  }))
  const configs: ServiceConfig = {}
  for (const item of resp.Items ?? []) {
    const svc = item.svc as string
    if (!svc) continue
    const [, ...rest] = (item.sk as string).split('#')
    const key = rest.join('#')
    if (!configs[svc]) configs[svc] = []
    configs[svc].push({ key, value: item.val as string })
  }
  return configs
}

type Message = { role: 'user' | 'agent'; text: string }
type StepItem = { step: number; action: string; action_resolved?: string; expected: string; expected_resolved?: string }
type TokenCall = { llm_calls: number; input_tokens: number; output_tokens: number }
type TokenUsage = { totalCalls: number; totalInput: number; totalOutput: number; perCall: TokenCall[] }

function fmtNum(n: number): string {
  return n.toLocaleString()
}

function fmtCost(input: number, output: number): string {
  const cost = (input / 1_000_000) * 3 + (output / 1_000_000) * 15
  return cost < 0.005 ? '<$0.01' : `~$${cost.toFixed(2)}`
}

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
  const [serviceConfigs, setServiceConfigs] = useState<ServiceConfig>({})
  const [servicesLoading, setServicesLoading] = useState(false)
  const availableServices = Object.keys(serviceConfigs).sort()
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
  const [tokenUsage, setTokenUsage] = useState<TokenUsage>({ totalCalls: 0, totalInput: 0, totalOutput: 0, perCall: [] })

  // Recording state
  type RecordAction = { type: string; url?: string; selector?: string; text?: string; element_text?: string; key?: string; tag?: string; timestamp?: number }
  const [recordPhase, setRecordPhase] = useState<'idle' | 'starting' | 'recording' | 'converting' | 'done'>('idle')
  const [recordedActions, setRecordedActions] = useState<RecordAction[]>([])
  const recordSessionRef = useRef<{ task_arn?: string; cluster?: string; mcp_endpoint?: string }>({})
  const recordTabRef = useRef<Window | null>(null)
  const recordPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

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
    loadAllServiceConfigs(team, env).then(setServiceConfigs).catch(() => {}).finally(() => setServicesLoading(false))
  }, [env, team])

  async function startRecording() {
    if (recordPhase !== 'idle') return
    setRecordPhase('starting')
    setRecordedActions([])

    try {
      // 1. Start browser session
      const sessionRaw = await callAgent({ inputText: 'record', mode: 'start_session', sessionId }, sessionId)
      const session = JSON.parse(sessionRaw)
      if (session.error) throw new Error(session.error as string)
      recordSessionRef.current = { task_arn: session.task_arn, cluster: session.cluster, mcp_endpoint: session.mcp_endpoint }

      // Open noVNC tab
      const tab = window.open(`${session.novnc_url}?autoconnect=true&resize=scale`, '_blank')
      recordTabRef.current = tab

      // 2. Wait a bit for browser to be ready, then inject recorder
      await new Promise(r => setTimeout(r, 10000))
      await callAgent({ inputText: '', mode: 'inject_recorder', mcp_endpoint: session.mcp_endpoint, sessionId }, sessionId)

      setRecordPhase('recording')
      setMessages(prev => [...prev, { role: 'agent', text: 'Recording started! Browse the site in the browser tab. Your actions will appear here. Click "Stop Recording" when done.' }])

      // 3. Start polling for recorded actions every 3s
      recordPollRef.current = setInterval(async () => {
        try {
          const raw = await callAgent({ inputText: '', mode: 'poll_recording', mcp_endpoint: session.mcp_endpoint, sessionId }, sessionId)
          const result = JSON.parse(raw)
          if (result.actions && result.actions.length > 0) {
            setRecordedActions(result.actions)
          }
        } catch { /* ignore poll errors */ }
      }, 3000)

    } catch (err) {
      setRecordPhase('idle')
      setMessages(prev => [...prev, { role: 'agent', text: `Recording failed: ${err instanceof Error ? err.message : String(err)}` }])
      // Cleanup
      const si = recordSessionRef.current
      if (si.task_arn && si.cluster) {
        callAgent({ inputText: '', mode: 'stop_session', task_arn: si.task_arn, cluster: si.cluster }, sessionId).catch(() => {})
      }
    }
  }

  async function stopRecording() {
    if (recordPhase !== 'recording') return

    // Stop polling
    if (recordPollRef.current) { clearInterval(recordPollRef.current); recordPollRef.current = null }
    recordTabRef.current?.close()
    recordTabRef.current = null

    setRecordPhase('converting')
    setMessages(prev => [...prev, { role: 'agent', text: 'Converting recorded actions to test plan steps...' }])

    try {
      const si = recordSessionRef.current
      const raw = await callAgent({
        inputText: '', mode: 'stop_recording',
        mcp_endpoint: si.mcp_endpoint, task_arn: si.task_arn, cluster: si.cluster,
        sessionId,
      }, sessionId)
      const result = JSON.parse(raw)

      if (result.plan_steps && result.plan_steps.length > 0) {
        setPlanSteps(result.plan_steps)
        setPlanScenario(JSON.stringify(result.plan_steps))
        setSaveTitleInput(result.summary || 'Recorded test')
        setSaveTcIdInput('TC-' + Date.now().toString(36).toUpperCase().slice(-6))
        setSaveService(tcService || 'exploratory')
        setShowSaveDialog(true)
        setTcSaved('idle')
        setMessages(prev => [...prev.slice(0, -1), { role: 'agent', text: `Recorded ${recordedActions.length} actions → ${result.plan_steps.length} test steps. Save the test case on the right.` }])
      } else {
        setMessages(prev => [...prev.slice(0, -1), { role: 'agent', text: 'No actions were recorded. Try again and interact with the browser.' }])
      }
    } catch (err) {
      setMessages(prev => [...prev.slice(0, -1), { role: 'agent', text: `Conversion failed: ${err instanceof Error ? err.message : String(err)}` }])
    } finally {
      setRecordPhase('idle')
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
        serviceConfig: serviceConfigs[tcService] ?? [],
        env,
        team,
        sessionId,
        conversationHistory: history,
      }, sessionId)

      const result = JSON.parse(raw)
      if (result.token_usage) {
        const tu = result.token_usage as TokenCall
        setTokenUsage(prev => ({
          totalCalls: prev.totalCalls + tu.llm_calls,
          totalInput: prev.totalInput + tu.input_tokens,
          totalOutput: prev.totalOutput + tu.output_tokens,
          perCall: [...prev.perCall, tu],
        }))
      }
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
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {recordPhase === 'recording' ? (
            <button onClick={stopRecording}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 8, background: '#DC2626', color: 'white', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
            >
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'white', animation: 'pulse 1.5s ease-in-out infinite' }} />
              Stop Recording ({recordedActions.length} actions)
            </button>
          ) : recordPhase === 'starting' || recordPhase === 'converting' ? (
            <button disabled
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 8, background: '#F1F5F9', color: '#64748B', border: '1px solid #E2E8F0', fontSize: 12, fontWeight: 600, cursor: 'default' }}
            >
              <div style={{ width: 12, height: 12, border: '2px solid #64748B', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              {recordPhase === 'starting' ? 'Launching browser...' : 'Converting...'}
            </button>
          ) : (
            <button onClick={startRecording}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 8, background: '#DC2626', color: 'white', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, boxShadow: '0 2px 8px rgba(220,38,38,0.25)' }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.9')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
            >
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'white' }} />
              Record Test
            </button>
          )}
        </div>
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
                      if (result.token_usage) {
                        const tu = result.token_usage as TokenCall
                        setTokenUsage(prev => ({
                          totalCalls: prev.totalCalls + tu.llm_calls,
                          totalInput: prev.totalInput + tu.input_tokens,
                          totalOutput: prev.totalOutput + tu.output_tokens,
                          perCall: [...prev.perCall, tu],
                        }))
                      }
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
              {/* Recording state: show live recorded actions */}
              {(recordPhase === 'recording' || recordPhase === 'starting' || recordPhase === 'converting') ? (
                <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#DC2626', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#DC2626', animation: recordPhase === 'recording' ? 'pulse 1.5s ease-in-out infinite' : 'none' }} />
                    {recordPhase === 'starting' ? 'Launching browser...' : recordPhase === 'converting' ? 'Converting to test steps...' : `Recording — ${recordedActions.length} actions captured`}
                  </div>
                  {recordedActions.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {recordedActions.map((a, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'white', borderRadius: 8, border: '1px solid #E8EBF0', fontSize: 12 }}>
                          <span style={{
                            fontSize: 10, fontWeight: 700, textTransform: 'uppercase', padding: '1px 6px', borderRadius: 4, flexShrink: 0,
                            color: a.type === 'navigate' ? '#1D4ED8' : a.type === 'click' ? '#7C3AED' : a.type === 'fill' ? '#059669' : '#64748B',
                            background: a.type === 'navigate' ? '#DBEAFE' : a.type === 'click' ? '#EDE9FE' : a.type === 'fill' ? '#D1FAE5' : '#F1F5F9',
                          }}>{a.type}</span>
                          <span style={{ color: '#334155', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {a.type === 'navigate' ? a.url : a.type === 'fill' ? `"${a.text}" → ${a.element_text || a.selector}` : a.element_text || a.selector || a.key || ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, color: '#94A3B8', textAlign: 'center', marginTop: 40 }}>
                      {recordPhase === 'starting' ? 'Starting browser session...' : 'Browse the site in the browser tab. Actions will appear here.'}
                    </div>
                  )}
                </div>
              ) : !tcService ? (
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
                            <td style={{ padding: '10px 12px', color: '#0F172A', lineHeight: 1.6, verticalAlign: 'top' }}>
                              {s.action_resolved || s.action}
                              {s.action_resolved && s.action !== s.action_resolved && (
                                <div style={{ fontSize: 10, color: '#94A3B8', marginTop: 4, fontFamily: 'Cascadia Code, Consolas, monospace' }}>{s.action}</div>
                              )}
                            </td>
                            <td style={{ padding: '10px 12px', color: '#64748B', lineHeight: 1.6, verticalAlign: 'top' }}>
                              {s.expected_resolved || s.expected}
                            </td>
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

        {/* Token usage panel */}
        <div style={{ width: 280, flexShrink: 0, borderLeft: '1px solid #E8EBF0', background: '#FAFBFF', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #E8EBF0', background: 'white', flexShrink: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Token Usage</div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
            {tokenUsage.totalCalls === 0 ? (
              <div style={{ fontSize: 13, color: '#94A3B8', textAlign: 'center', paddingTop: 32 }}>
                Token stats will appear here after each agent call.
              </div>
            ) : (
              <>
                {/* Session totals card */}
                <div style={{ background: 'white', border: '1px solid #E8EBF0', borderRadius: 10, padding: '14px 16px', marginBottom: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Session Totals</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: '#64748B' }}>LLM Calls</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{fmtNum(tokenUsage.totalCalls)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: '#64748B' }}>Input</span>
                      <span style={{ fontSize: 13, color: '#0F172A' }}>{fmtNum(tokenUsage.totalInput)} tokens</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: '#64748B' }}>Output</span>
                      <span style={{ fontSize: 13, color: '#0F172A' }}>{fmtNum(tokenUsage.totalOutput)} tokens</span>
                    </div>
                    <div style={{ borderTop: '1px solid #E8EBF0', marginTop: 4, paddingTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: '#64748B' }}>Est. Cost</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#7C3AED' }}>{fmtCost(tokenUsage.totalInput, tokenUsage.totalOutput)}</span>
                    </div>
                  </div>
                </div>

                {/* Per-call breakdown */}
                <div style={{ background: 'white', border: '1px solid #E8EBF0', borderRadius: 10, padding: '14px 16px' }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Per-Call Breakdown</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {tokenUsage.perCall.map((call, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#0F172A', padding: '4px 0', borderBottom: i < tokenUsage.perCall.length - 1 ? '1px solid #F1F5F9' : 'none' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: '50%', background: '#EDE9FE', color: '#7C3AED', fontSize: 10, fontWeight: 700, flexShrink: 0 }}>#{i + 1}</span>
                        <span style={{ flex: 1, fontSize: 11, color: '#64748B' }}>in: {fmtNum(call.input_tokens)}</span>
                        <span style={{ fontSize: 11, color: '#64748B' }}>out: {fmtNum(call.output_tokens)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
