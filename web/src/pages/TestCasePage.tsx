import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getTestCase } from '../lib/lambdaClient'

type PlanStep = { step: number; action: string; expected: string }
type AutoStep = { stepNumber: number; type: string; tool?: string; action: string; detail: string }

export default function TestCasePage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [tc, setTc] = useState<Awaited<ReturnType<typeof getTestCase>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'plan' | 'automated'>('plan')

  useEffect(() => {
    if (!id) return
    getTestCase(id)
      .then(data => { setTc(data); setLoading(false) })
      .catch(() => { setError('Failed to load test case.'); setLoading(false) })
  }, [id])

  if (loading) return (
    <div className="min-h-screen bg-[#F5F7FA] flex items-center justify-center">
      <div className="text-[14px] text-slate-400">Loading test case…</div>
    </div>
  )

  if (error || !tc) return (
    <div className="min-h-screen bg-[#F5F7FA] flex items-center justify-center">
      <div className="text-[14px] text-red-500">{error ?? 'Test case not found.'}</div>
    </div>
  )

  const planSteps = (tc.planSteps ?? []) as PlanStep[]
  const autoSteps = (tc.steps ?? []) as AutoStep[]
  const isAutomated = autoSteps.length > 0

  return (
    <div className="min-h-screen bg-[#F5F7FA] flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center gap-4">
        <button onClick={() => window.close()} className="text-slate-400 hover:text-slate-600 cursor-pointer transition-colors">
          <svg viewBox="0 0 24 24" className="w-5 h-5 stroke-current fill-none stroke-2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-[16px] font-semibold text-slate-800 truncate">{tc.title || tc.description}</h1>
          <div className="flex items-center gap-2 mt-0.5">
            {tc.service && (
              <span className="text-[11px] px-2 py-0.5 bg-[#EDE9FE] text-[#7C3AED] border border-[#DDD6FE] rounded-full font-semibold">{tc.service}</span>
            )}
            <span className="text-[11px] text-slate-400 font-mono">{tc.id}</span>
            {tc.lastResult && (
              <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${tc.lastResult === 'PASS' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                {tc.lastResult}
              </span>
            )}
          </div>
        </div>
        <span className={`text-[12px] px-3 py-1 rounded-full font-semibold border flex-shrink-0 ${
          isAutomated ? 'bg-purple-50 text-[#7C3AED] border-purple-200' : 'bg-slate-50 text-slate-400 border-slate-200'
        }`}>
          {isAutomated ? '⚡ Automated' : 'Not automated yet'}
        </span>
      </div>

      {/* Tabs */}
      <div className="bg-white border-b border-slate-200 px-6 flex gap-0">
        {(['plan', 'automated'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-5 py-3 text-[13px] font-semibold border-b-2 transition-colors cursor-pointer ${
              tab === t ? 'border-[#7C3AED] text-[#7C3AED]' : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}>
            {t === 'plan' ? '📋 Plan Steps' : '⚡ Automated Steps'}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 max-w-4xl mx-auto w-full px-6 py-6">

        {/* Plan Steps — MTM table */}
        {tab === 'plan' && (
          planSteps.length > 0 ? (
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="py-2.5 px-3 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider w-12">#</th>
                    <th className="py-2.5 px-4 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider w-[45%]">Action</th>
                    <th className="py-2.5 px-4 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Expected Result</th>
                  </tr>
                </thead>
                <tbody>
                  {planSteps.map((s, i) => (
                    <tr key={s.step} className={`border-b border-slate-100 ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'}`}>
                      <td className="py-3 px-3 text-center align-top">
                        <span className="w-6 h-6 inline-flex items-center justify-center rounded-full bg-[#EDE9FE] text-[#7C3AED] text-[11px] font-bold">{s.step}</span>
                      </td>
                      <td className="py-3 px-4 text-slate-700 leading-relaxed align-top">{s.action}</td>
                      <td className="py-3 px-4 text-slate-500 leading-relaxed align-top">{s.expected}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-slate-200 py-16 text-center text-[14px] text-slate-400">
              No plan steps saved yet. Go to Author Agent → Plan mode to create them.
            </div>
          )
        )}

        {/* Automated Steps */}
        {tab === 'automated' && (
          <div className="flex flex-col gap-4">
            {autoSteps.length > 0 ? (
              <>
                <div className="space-y-2">
                  {autoSteps.map((step, i) => (
                    <div key={i} className="flex gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3">
                      <div className="w-6 h-6 rounded-full bg-[#7C3AED] text-white text-[11px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                        {step.stepNumber ?? i + 1}
                      </div>
                      <div>
                        <div className="text-[13px] font-semibold text-slate-800">{step.action}</div>
                        <div className="text-[12px] text-slate-500 mt-0.5">{step.detail}</div>
                        <div className="text-[11px] text-[#7C3AED] mt-0.5 font-medium uppercase tracking-wide">
                          {step.type}{step.tool ? ` · ${step.tool}` : ''}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Run button */}
                <button
                  onClick={() => navigate(`/agent?tcId=${tc.id}&tcDesc=${encodeURIComponent(tc.title || tc.description)}&autoRun=true`)}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-[#7C3AED] hover:bg-[#5B21B6] text-white text-[14px] font-semibold cursor-pointer transition-colors"
                >
                  <svg viewBox="0 0 24 24" className="w-4 h-4 stroke-current fill-none stroke-2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                  Run this test
                </button>
              </>
            ) : (
              <div className="bg-white rounded-2xl border border-slate-200 py-16 text-center text-[14px] text-slate-400">
                Not automated yet — run this test case from the Author Agent to generate automated steps.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
