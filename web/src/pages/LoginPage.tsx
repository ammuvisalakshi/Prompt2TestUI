import { useNavigate } from 'react-router-dom'

export default function LoginPage() {
  const navigate = useNavigate()

  function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    navigate('/agent')
  }

  return (
    <div className="fixed inset-0 bg-slate-100 flex items-center justify-center">
      <div className="bg-white border border-slate-200 rounded-2xl p-11 w-[400px] text-center shadow-lg">
        <div className="text-[26px] font-bold text-slate-900 mb-1.5">TestPilot AI</div>
        <div className="text-[14px] text-slate-500 mb-7">AI-powered test authoring &amp; automation platform</div>
        <div className="inline-block text-[12px] text-[#028090] border border-[#028090] px-3 py-0.5 rounded-full mb-7">
          Bedrock Agent Core · AWS · Team workspace
        </div>
        <form onSubmit={handleLogin} className="flex flex-col gap-2.5">
          <input
            type="email"
            defaultValue="jane@company.com"
            placeholder="your@company.com"
            className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-[14px] text-slate-800 placeholder-slate-400 outline-none focus:border-[#028090] transition-colors font-sans"
          />
          <input
            type="password"
            defaultValue="password"
            placeholder="Password"
            className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-[14px] text-slate-800 placeholder-slate-400 outline-none focus:border-[#028090] transition-colors font-sans"
          />
          <button
            type="submit"
            className="w-full py-2.5 bg-[#028090] hover:bg-[#01555F] text-white rounded-lg text-[14px] font-semibold mt-1 transition-colors cursor-pointer font-sans"
          >
            Sign in with SSO →
          </button>
        </form>
      </div>
    </div>
  )
}
