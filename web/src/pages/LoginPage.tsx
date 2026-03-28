import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { signIn, signOut, confirmSignIn } from '@aws-amplify/auth'

export default function LoginPage() {
  const navigate = useNavigate()
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
    setLoading(true)
    try {
      await signOut().catch(() => {})
      const result = await signIn({ username: email.trim().toLowerCase(), password })
      if (result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        setStep('new-password')
      } else {
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
    background: 'rgba(255,255,255,0.07)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 10, fontSize: 14, color: 'white', outline: 'none',
    boxSizing: 'border-box',
  }

  function onFocus(e: React.FocusEvent<HTMLInputElement>) {
    e.currentTarget.style.border = '1px solid rgba(139,92,246,0.6)'
  }
  function onBlur(e: React.FocusEvent<HTMLInputElement>) {
    e.currentTarget.style.border = '1px solid rgba(255,255,255,0.12)'
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'linear-gradient(135deg, #0D0821 0%, #130D35 45%, #0A1628 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'rgba(255,255,255,0.05)', backdropFilter: 'blur(24px)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 20, padding: '44px 40px', width: 400, textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 6 }}>
          <img src="/favicon.svg" width="36" height="36" alt="Prompt2Test" />
          <span style={{ fontSize: 26, fontWeight: 700, color: 'white', textShadow: '0 0 20px rgba(167,139,250,0.5)' }}>Prompt2Test</span>
        </div>
        <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', marginBottom: 24 }}>AI-powered test authoring &amp; automation platform</div>
        <div style={{ display: 'inline-block', fontSize: 12, color: '#C084FC', border: '1px solid rgba(139,92,246,0.4)', background: 'rgba(139,92,246,0.1)', padding: '3px 12px', borderRadius: 20, marginBottom: 28 }}>
          Bedrock Agent Core · AWS · Team workspace
        </div>

        {step === 'login' ? (
          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="your@company.com" required autoFocus
              style={{ ...inputStyle, color: 'white' }}
              onFocus={onFocus} onBlur={onBlur} />
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Password" required
              style={{ ...inputStyle, color: 'white' }}
              onFocus={onFocus} onBlur={onBlur} />
            {error && <div style={{ fontSize: 13, color: '#F87171', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 8, padding: '8px 12px', textAlign: 'left' }}>{error}</div>}
            <button type="submit" disabled={loading}
              style={{ width: '100%', padding: 10, background: 'linear-gradient(135deg, #7C3AED, #A855F7)', color: 'white', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.7 : 1, marginTop: 4, boxShadow: '0 0 20px rgba(139,92,246,0.3)' }}>
              {loading ? 'Signing in…' : 'Sign in →'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleNewPassword} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, color: '#FCD34D', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 8, padding: '8px 12px', textAlign: 'left', marginBottom: 4 }}>
              Your temporary password has expired. Please set a permanent password to continue.
            </div>
            <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
              placeholder="New password" required autoFocus
              style={{ ...inputStyle, color: 'white' }}
              onFocus={onFocus} onBlur={onBlur} />
            <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)}
              placeholder="Confirm new password" required
              style={{ ...inputStyle, color: 'white' }}
              onFocus={onFocus} onBlur={onBlur} />
            {error && <div style={{ fontSize: 13, color: '#F87171', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 8, padding: '8px 12px', textAlign: 'left' }}>{error}</div>}
            <button type="submit" disabled={loading}
              style={{ width: '100%', padding: 10, background: 'linear-gradient(135deg, #7C3AED, #A855F7)', color: 'white', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.7 : 1, marginTop: 4, boxShadow: '0 0 20px rgba(139,92,246,0.3)' }}>
              {loading ? 'Setting password…' : 'Set password & continue →'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
