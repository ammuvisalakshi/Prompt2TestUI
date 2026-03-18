import { useState, useRef, useEffect } from 'react'

type Message = { role: 'user' | 'agent'; text: string }

const HINTS = [
  'Test billing plan is correct',
  'Verify export button visibility',
  'Check max user limit shown',
]

export default function AgentPage() {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'agent', text: "Hi Jane! Ready to author tests.\n\nDescribe what you want to test in plain English — I'll ask you to choose the service and test account as part of planning." },
  ])
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<'plan' | 'auto'>('plan')
  const chatRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight
  }, [messages])

  function send() {
    const text = input.trim()
    if (!text) return
    setMessages(prev => [...prev, { role: 'user', text }])
    setInput('')
    setTimeout(() => {
      setMessages(prev => [...prev, {
        role: 'agent',
        text: `Got it. I'll plan a test for: "${text}"\n\nWhich service should I test against?\n• Billing\n• Payment\n• Auth\n• User`,
      }])
    }, 800)
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
          {/* Mode toggle */}
          <div className="flex bg-slate-100 border border-slate-200 rounded-lg overflow-hidden">
            {(['plan', 'auto'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-1 text-[13px] font-medium transition-colors cursor-pointer ${
                  mode === m
                    ? 'bg-[#028090] text-white'
                    : 'text-slate-500 hover:text-slate-800'
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
                  {msg.role === 'user' ? 'Jane D' : 'TestPilot AI'}
                </div>
                <div
                  className={`max-w-[85%] px-3.5 py-2.5 rounded-xl text-[14px] leading-relaxed whitespace-pre-line ${
                    msg.role === 'user'
                      ? 'bg-[#028090] text-white rounded-br-sm'
                      : 'bg-slate-50 border border-slate-200 text-slate-700 rounded-bl-sm'
                  }`}
                >
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
                placeholder="Describe what you want to test…"
                rows={2}
                className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-[14px] text-slate-800 placeholder-slate-400 outline-none resize-none focus:border-[#028090] transition-colors font-sans"
              />
              <button
                onClick={send}
                className="px-3 py-2 bg-[#028090] hover:bg-[#01555F] text-white rounded-lg transition-colors cursor-pointer flex-shrink-0"
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

        {/* Plan panel */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-white flex-shrink-0">
            <div className="text-[13px] font-semibold text-slate-400 uppercase tracking-wider">Execution Plan</div>
          </div>
          <div className="flex-1 flex items-center justify-center text-[14px] text-slate-400">
            Plan will appear here once the agent authors a test case.
          </div>
        </div>
      </div>
    </div>
  )
}
