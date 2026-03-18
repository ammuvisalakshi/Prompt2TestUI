import { useState } from 'react'

const TABS = ['Platform', 'Infrastructure', 'Data flow', 'Cost model'] as const
type Tab = typeof TABS[number]

const PLATFORM_LAYERS = [
  {
    n: '1', label: 'LLM Understanding', sub: 'Authoring only · ~1,850 tokens',
    color: '#6B21A8', bg: '#FAF5FF',
    points: ['Called once during TC authoring in DEV only', 'Receives only relevant endpoint schemas — not full Swagger', 'Operates in agentic loop with MCP tools against real APIs', 'Outputs frozen execution plan JSON saved to S3'],
  },
  {
    n: '2', label: 'Orchestrator', sub: 'Zero LLM · zero tokens · runs forever',
    color: '#0C7B8E', bg: '#F0F9FC',
    points: ['Reads frozen plan and replays exactly — no decisions', 'Resolves {{variables}} from runtime state dictionary', 'Fetches large payloads from S3 by reference', 'Refreshes OAuth tokens in code · dispatches all accounts via SQS'],
  },
  {
    n: '3', label: 'LLM Assertion', sub: 'Optional · ambiguous checks only · ~300 tokens',
    color: '#92400E', bg: '#FFFBEB',
    points: ['Only for ambiguous assertions — deterministic checks in code', 'Receives only the expected vs actual diff', 'Never sees full conversation history'],
  },
]

const AWS_SERVICES = [
  { name: 'Bedrock', desc: 'Claude Sonnet for authoring agent', icon: '🧠' },
  { name: 'ECS Fargate', desc: 'Strands Agent container (long-running)', icon: '🐳' },
  { name: 'API Gateway', desc: 'REST + WebSocket APIs', icon: '🔌' },
  { name: 'Lambda', desc: 'API handlers + test orchestrator', icon: 'λ' },
  { name: 'DynamoDB', desc: 'Services, TCs, accounts, config', icon: '🗄️' },
  { name: 'S3', desc: 'Execution plans + response archives', icon: '🪣' },
  { name: 'OpenSearch', desc: 'Semantic TC index search', icon: '🔍' },
  { name: 'SQS', desc: 'Multi-account test run queue', icon: '📬' },
  { name: 'Cognito', desc: 'Auth + SSO + RBAC', icon: '🔐' },
  { name: 'Secrets Manager', desc: 'Test account credentials', icon: '🔑' },
  { name: 'SSM', desc: 'Config parameter store', icon: '⚙️' },
  { name: 'CloudFront + S3', desc: 'React SPA hosting', icon: '🌐' },
]

export default function ArchitecturePage() {
  const [tab, setTab] = useState<Tab>('Platform')

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#F5F7FA]">
      {/* Tabs */}
      <div className="flex items-center gap-1 px-5 border-b border-slate-200 bg-white flex-shrink-0">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-3 text-[13px] font-medium cursor-pointer border-b-2 -mb-px transition-colors ${
              tab === t ? 'text-[#0C7B8E] border-[#0C7B8E]' : 'text-slate-400 border-transparent hover:text-slate-600'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {tab === 'Platform' && (
          <div className="space-y-3 max-w-3xl">
            <p className="text-[13px] text-slate-500 mb-4">Three-layer architecture — only Layer 1 involves an LLM during authoring. Execution (Layer 2) is fully deterministic with zero tokens.</p>
            {PLATFORM_LAYERS.map(l => (
              <div key={l.n} className="bg-white border rounded-xl p-4 shadow-sm" style={{ borderColor: l.color + '40' }}>
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center text-[13px] font-black text-white flex-shrink-0" style={{ background: l.color }}>{l.n}</div>
                  <div>
                    <div className="text-[13px] font-bold text-slate-900">{l.label}</div>
                    <div className="text-[11px] text-slate-400">{l.sub}</div>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {l.points.map(p => (
                    <div key={p} className="text-[12px] text-slate-600 pl-3 border-l-2" style={{ borderColor: l.color }}>
                      {p}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'Infrastructure' && (
          <div>
            <p className="text-[13px] text-slate-500 mb-4">All AWS services used in the platform.</p>
            <div className="grid grid-cols-3 gap-3">
              {AWS_SERVICES.map(s => (
                <div key={s.name} className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
                  <div className="text-xl mb-2">{s.icon}</div>
                  <div className="text-[13px] font-bold text-slate-900">{s.name}</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">{s.desc}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'Data flow' && (
          <div className="max-w-2xl">
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
              {[
                ['QA describes test in plain English', 'Author Agent (Bedrock/Strands)'],
                ['Agent searches endpoint index', 'OpenSearch Serverless'],
                ['Agent calls real API via MCP', 'Target microservice'],
                ['capture_and_compress called', 'S3 archive + agent.state'],
                ['QA reviews and approves plan', 'TestPilot UI'],
                ['save_execution_plan called', 'S3 + DynamoDB index'],
                ['Test run triggered', 'SQS → Lambda workers'],
                ['Results stored', 'DynamoDB + OpenSearch'],
              ].map(([step, system], i) => (
                <div key={i} className="flex items-center gap-4 px-4 py-3 border-b border-slate-100 last:border-b-0">
                  <div className="w-6 h-6 rounded-full bg-[#E0F2F7] text-[#0C7B8E] flex items-center justify-center text-[11px] font-bold flex-shrink-0">{i + 1}</div>
                  <div className="flex-1 text-[12px] font-medium text-slate-700">{step}</div>
                  <div className="text-[11px] px-2 py-0.5 bg-slate-100 text-slate-500 rounded-full">{system}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'Cost model' && (
          <div className="max-w-xl">
            <div className="bg-[#F0F9FC] border border-[#0C7B8E] rounded-xl p-4 mb-4">
              <div className="text-[13px] font-bold text-[#0C7B8E] mb-1">Key metric: ~1,850 tokens per TC authoring</div>
              <div className="text-[12px] text-slate-600">6-step workflow uses ~1,770 tokens — under 1% of 200k context window. Execution is zero-token forever.</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
              {[
                ['TC authoring (LLM)', '~1,850 tokens (one time)'],
                ['TC execution', '0 tokens (forever)'],
                ['Ambiguous assertion', '~300 tokens (optional)'],
                ['Lambda invocations', 'Pay per run'],
                ['ECS Fargate (agent)', 'Only during authoring sessions'],
                ['OpenSearch Serverless', 'Pay per query'],
              ].map(([item, cost]) => (
                <div key={item} className="flex justify-between px-4 py-3 border-b border-slate-100 last:border-b-0 text-[13px]">
                  <span className="text-slate-600">{item}</span>
                  <span className="font-medium text-slate-900">{cost}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
