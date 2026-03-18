import { useNavigate } from 'react-router-dom'

export default function LoginPage() {
  const navigate = useNavigate()

  function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    navigate('/agent')
  }

  return (
    <div className="fixed inset-0 bg-[#0A1520] flex items-center justify-center">
      <div className="bg-[#0D1B2A] border border-[#1E3A4A] rounded-2xl p-11 w-[380px] text-center">
        <div className="text-[22px] font-bold text-white mb-1.5">TestPilot AI</div>
        <div className="text-xs text-[#5A7A8A] mb-7">AI-powered test authoring &amp; automation platform</div>
        <div className="inline-block text-[10px] text-[#028090] border border-[#028090] px-3 py-0.5 rounded-full mb-7">
          Bedrock Agent Core · AWS · Team workspace
        </div>
        <form onSubmit={handleLogin} className="flex flex-col gap-2.5">
          <input
            type="email"
            defaultValue="jane@company.com"
            placeholder="your@company.com"
            className="w-full px-3.5 py-2.5 bg-[#071624] border border-[#1E3A4A] rounded-lg text-sm text-white placeholder-[#3A5A6A] outline-none focus:border-[#028090] transition-colors font-sans"
          />
          <input
            type="password"
            defaultValue="password"
            placeholder="Password"
            className="w-full px-3.5 py-2.5 bg-[#071624] border border-[#1E3A4A] rounded-lg text-sm text-white placeholder-[#3A5A6A] outline-none focus:border-[#028090] transition-colors font-sans"
          />
          <button
            type="submit"
            className="w-full py-2.5 bg-[#028090] hover:bg-[#01555F] text-white rounded-lg text-sm font-semibold mt-1 transition-colors cursor-pointer font-sans"
          >
            Sign in with SSO →
          </button>
        </form>
      </div>
    </div>
  )
}
