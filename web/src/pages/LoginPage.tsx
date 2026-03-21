import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { signIn } from '@aws-amplify/auth'

export default function LoginPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('jane@company.com')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await signIn({ username: email, password })
      navigate('/agent')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign in failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-slate-100 flex items-center justify-center">
      <div className="bg-white border border-slate-200 rounded-2xl p-11 w-[400px] text-center shadow-lg">
        <div className="flex items-center justify-center gap-2.5 mb-1.5">
          <img src="/favicon.svg" width="36" height="36" alt="Prompt2Test"/>
          <span className="text-[26px] font-bold text-slate-900">Prompt2Test</span>
        </div>
        <div className="text-[14px] text-slate-500 mb-7">AI-powered test authoring &amp; automation platform</div>
        <div className="inline-block text-[12px] text-[#7C3AED] border border-[#7C3AED] px-3 py-0.5 rounded-full mb-7">
          Bedrock Agent Core · AWS · Team workspace
        </div>
        <form onSubmit={handleLogin} className="flex flex-col gap-2.5">
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="your@company.com"
            required
            className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-[14px] text-slate-800 placeholder-slate-400 outline-none focus:border-[#7C3AED] transition-colors font-sans"
          />
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Password"
            required
            className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-[14px] text-slate-800 placeholder-slate-400 outline-none focus:border-[#7C3AED] transition-colors font-sans"
          />
          {error && (
            <div className="text-[13px] text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-left">
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-[#7C3AED] hover:bg-[#5B21B6] disabled:opacity-60 text-white rounded-lg text-[14px] font-semibold mt-1 transition-colors cursor-pointer font-sans"
          >
            {loading ? 'Signing in…' : 'Sign in →'}
          </button>
        </form>
      </div>
    </div>
  )
}
