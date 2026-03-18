import { useState } from 'react'

const SECTIONS = [
  {
    title: 'Vision & problem statement',
    content: 'TestPilot AI is an AI-powered test automation platform built for API and workflow testing. A QA describes a workflow in plain English. An AI agent executes it against real APIs, observes real responses, and freezes the run as a deterministic plan. From that point the plan runs forever without LLM involvement.',
    bullets: [
      { label: 'Today with Postman', items: ['Collections break on schema change', 'Multi-account runs are manual', 'Only engineers can author tests', 'Cross-service chaining needs custom scripts'], color: 'text-slate-600 bg-slate-50 border-slate-200' },
      { label: 'With TestPilot', items: ['One template update fixes all TCs', 'All accounts run in parallel automatically', 'Any QA can author in plain English', 'Agent chains steps and captures values'], color: 'text-[#0C7B8E] bg-[#F0F9FC] border-[#0C7B8E]' },
    ],
  },
  {
    title: 'Token management',
    content: 'The LLM only sees what it needs for the next decision. Large payloads never enter context. Captured variables live in agent.state outside the conversation window entirely.',
    bullets: [
      { label: 'Token killers', items: ['Full Swagger spec (~100k tokens)', 'Large API responses in context (2000+ fields)', 'Captured variables in chat history', 'Retry attempts stored verbatim'], color: 'text-red-700 bg-red-50 border-red-200' },
      { label: 'Solutions', items: ['Semantic search — only relevant endpoints (~800 tok)', 'capture_and_compress — 20-token summary + S3 archive', 'agent.state — values outside context window entirely', 'Retries compressed to one-line summary'], color: 'text-green-700 bg-green-50 border-green-200' },
    ],
  },
  {
    title: 'Adoption strategy',
    content: 'TestPilot is not a Postman replacement. Postman handles exploration. TestPilot handles regression, multi-account execution, and CI/CD.',
    bullets: [
      { label: 'Postman / Bruno', items: ['Exploration and debugging', 'One-off API calls', 'Engineer-authored collections', 'Manual maintenance on schema change'], color: 'text-slate-600 bg-slate-50 border-slate-200' },
      { label: 'TestPilot', items: ['Regression and CI/CD', 'Multi-account parallel execution', 'Plain English — any QA can author', 'One template update covers all TCs'], color: 'text-[#0C7B8E] bg-[#F0F9FC] border-[#0C7B8E]' },
    ],
  },
]

export default function ConceptsPage() {
  const [open, setOpen] = useState<number | null>(0)

  return (
    <div className="h-full overflow-y-auto p-5 bg-[#F5F7FA]">
      <div className="max-w-3xl">
        <div className="mb-5">
          <div className="text-[15px] font-bold text-slate-900">Core Concepts</div>
          <div className="text-[13px] text-slate-400 mt-0.5">Architecture, design decisions, and engineering rationale for TestPilot AI.</div>
        </div>
        <div className="space-y-3">
          {SECTIONS.map((s, i) => (
            <div key={s.title} className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
              <button
                className="w-full flex items-center gap-3 px-4 py-3.5 cursor-pointer text-left"
                onClick={() => setOpen(open === i ? null : i)}
              >
                <div className="flex-1 text-[13px] font-semibold text-slate-900">{s.title}</div>
                <span className="text-slate-400 text-[11px]">{open === i ? '▲' : '▼'}</span>
              </button>
              {open === i && (
                <div className="border-t border-slate-100 p-4">
                  <p className="text-[13px] text-slate-600 leading-relaxed mb-4">{s.content}</p>
                  <div className="grid grid-cols-2 gap-3">
                    {s.bullets.map(b => (
                      <div key={b.label} className={`border rounded-lg p-3 ${b.color}`}>
                        <div className="text-[11px] font-bold uppercase tracking-wider mb-2 opacity-80">{b.label}</div>
                        {b.items.map(item => (
                          <div key={item} className="text-[12px] py-1.5 border-b border-current/10 last:border-b-0">{item}</div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
