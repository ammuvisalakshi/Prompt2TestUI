import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { signIn, signOut, confirmSignIn, getCurrentUser, fetchAuthSession } from '@aws-amplify/auth'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'

const AWS_REGION = import.meta.env.VITE_AWS_REGION as string

export default function LoginPage() {
  const navigate = useNavigate()
  const [team,        setTeam]        = useState('')
  const [email,       setEmail]       = useState('')
  const [password,    setPassword]    = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPw,   setConfirmPw]   = useState('')
  const [step,        setStep]        = useState<'login' | 'new-password'>('login')
  const [error,       setError]       = useState('')
  const [loading,     setLoading]     = useState(false)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!team.trim()) { setError('Please enter your team ID'); return }
    setLoading(true)
    try {
      await signOut().catch(() => {})
      const result = await signIn({ username: email.trim().toLowerCase(), password })
      if (result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        setStep('new-password')
      } else {
        // Validate team membership — use Cognito username (e.g. VA1234), not email
        const { username } = await getCurrentUser()
        try {
          const session = await fetchAuthSession()
          const ssm = new SSMClient({ region: AWS_REGION, credentials: session.credentials })
          const resp = await ssm.send(new GetParameterCommand({ Name: `/prompt2test/config/members/${username}/TEAM` }))
          const assignedTeam = (resp.Parameter?.Value ?? '').toLowerCase().replace(/\s+/g, '')
          const enteredTeam = team.trim().toLowerCase().replace(/\s+/g, '')
          if (assignedTeam && assignedTeam !== enteredTeam) {
            await signOut()
            setError('You are not a member of this team')
            return
          }
        } catch {
          // No team assigned yet — allow through (super admin accounts)
        }
        navigate('/agent')
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign in failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleNewPassword(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (newPassword !== confirmPw) { setError('Passwords do not match'); return }
    if (newPassword.length < 8)   { setError('Password must be at least 8 characters'); return }
    setLoading(true)
    try {
      await confirmSignIn({ challengeResponse: newPassword })
      navigate('/agent')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to set password')
    } finally {
      setLoading(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 14px',
    background: '#F8FAFC',
    border: '1.5px solid #E2E8F0',
    borderRadius: 10, fontSize: 14, color: '#0F172A', outline: 'none',
    boxSizing: 'border-box', transition: 'border-color 0.15s',
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'linear-gradient(135deg, #7C3AED 0%, #4F46E5 50%, #0EA5E9 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {/* decorative blobs */}
      <div style={{ position: 'absolute', top: '10%', left: '15%', width: 300, height: 300, background: 'rgba(255,255,255,0.06)', borderRadius: '50%', filter: 'blur(60px)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', bottom: '15%', right: '10%', width: 250, height: 250, background: 'rgba(255,255,255,0.05)', borderRadius: '50%', filter: 'blur(60px)', pointerEvents: 'none' }} />

      <div style={{ background: 'white', borderRadius: 20, padding: '44px 40px', width: 420, textAlign: 'center', boxShadow: '0 24px 64px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 6 }}>
          <img src="/favicon.svg" width="34" height="34" alt="Prompt2Test" />
          <span style={{ fontSize: 24, fontWeight: 800, color: '#0F172A', letterSpacing: '-0.5px' }}>Prompt2Test</span>
        </div>
        <div style={{ fontSize: 14, color: '#64748B', marginBottom: 20 }}>AI-powered test authoring &amp; automation</div>
        <div style={{ display: 'inline-block', fontSize: 12, color: '#7C3AED', border: '1px solid #DDD6FE', background: '#EDE9FE', padding: '3px 12px', borderRadius: 20, marginBottom: 28, fontWeight: 600 }}>
          Bedrock Agent Core · AWS · Team workspace
        </div>

        {step === 'login' ? (
          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input type="text" value={team} onChange={e => setTeam(e.target.value)}
              placeholder="Team ID (e.g. teama)" required style={inputStyle}
              onFocus={e => (e.currentTarget.style.borderColor = '#7C3AED')}
              onBlur={e => (e.currentTarget.style.borderColor = '#E2E8F0')} />
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="your@company.com" required autoFocus style={inputStyle}
              onFocus={e => (e.currentTarget.style.borderColor = '#7C3AED')}
              onBlur={e => (e.currentTarget.style.borderColor = '#E2E8F0')} />
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Password" required style={inputStyle}
              onFocus={e => (e.currentTarget.style.borderColor = '#7C3AED')}
              onBlur={e => (e.currentTarget.style.borderColor = '#E2E8F0')} />
            {error && <div style={{ fontSize: 13, color: '#DC2626', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '8px 12px', textAlign: 'left' }}>{error}</div>}
            <button type="submit" disabled={loading}
              style={{ width: '100%', padding: 11, background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.7 : 1, marginTop: 4, boxShadow: '0 4px 14px rgba(124,58,237,0.4)' }}>
              {loading ? 'Signing in…' : 'Sign in →'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleNewPassword} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, color: '#92400E', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: '8px 12px', textAlign: 'left', marginBottom: 4 }}>
              Your temporary password has expired. Please set a permanent password to continue.
            </div>
            <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
              placeholder="New password" required autoFocus style={inputStyle}
              onFocus={e => (e.currentTarget.style.borderColor = '#7C3AED')}
              onBlur={e => (e.currentTarget.style.borderColor = '#E2E8F0')} />
            <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)}
              placeholder="Confirm new password" required style={inputStyle}
              onFocus={e => (e.currentTarget.style.borderColor = '#7C3AED')}
              onBlur={e => (e.currentTarget.style.borderColor = '#E2E8F0')} />
            {error && <div style={{ fontSize: 13, color: '#DC2626', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '8px 12px', textAlign: 'left' }}>{error}</div>}
            <button type="submit" disabled={loading}
              style={{ width: '100%', padding: 11, background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.7 : 1, marginTop: 4, boxShadow: '0 4px 14px rgba(124,58,237,0.4)' }}>
              {loading ? 'Setting password…' : 'Set password & continue →'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
