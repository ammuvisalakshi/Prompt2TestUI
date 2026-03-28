import { useState, useEffect, useRef, useCallback } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { fetchUserAttributes, fetchAuthSession, signOut } from '@aws-amplify/auth'
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm'
import { EnvContext, ENVS, type Env } from '../context/EnvContext'
import { TeamContext } from '../context/TeamContext'

const AWS_REGION = import.meta.env.VITE_AWS_REGION as string

export type RunEntry = {
  id: string
  description: string
  passed: boolean
  timestamp: string
}

const NAV = [
  {
    to: '/inventory',
    label: 'Test Inventory',
    icon: (
      <svg viewBox="0 0 24 24" style={{ width: 15, height: 15, stroke: 'currentColor', fill: 'none', strokeWidth: 2, flexShrink: 0 }}>
        <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
      </svg>
    ),
  },
  {
    to: '/config',
    label: 'Config & Accounts',
    icon: (
      <svg viewBox="0 0 24 24" style={{ width: 15, height: 15, stroke: 'currentColor', fill: 'none', strokeWidth: 2, flexShrink: 0 }}>
        <circle cx="12" cy="12" r="3" /><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
      </svg>
    ),
  },
  {
    to: '/members',
    label: 'Members',
    icon: (
      <svg viewBox="0 0 24 24" style={{ width: 15, height: 15, stroke: 'currentColor', fill: 'none', strokeWidth: 2, flexShrink: 0 }}>
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
      </svg>
    ),
  },
]

const ENV_STYLE: Record<Env, { active: React.CSSProperties; dot: string }> = {
  dev:  { active: { background: '#ECFDF5', border: '1.5px solid #A7F3D0', color: '#059669' }, dot: '#10B981' },
  qa:   { active: { background: '#EFF6FF', border: '1.5px solid #BFDBFE', color: '#1D4ED8' }, dot: '#3B82F6' },
  uat:  { active: { background: '#FFFBEB', border: '1.5px solid #FDE68A', color: '#D97706' }, dot: '#F59E0B' },
  prod: { active: { background: '#FEF2F2', border: '1.5px solid #FECACA', color: '#DC2626' }, dot: '#EF4444' },
}

function timeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime()
  const m = Math.floor(diff / 60000)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d ago`
  if (h > 0) return `${h}h ago`
  if (m > 0) return `${m}m ago`
  return 'just now'
}

export default function PlatformLayout() {
  const navigate = useNavigate()
  const [initials,     setInitials]     = useState('?')
  const [displayName,  setDisplayName]  = useState('')
  const [team,         setTeam]         = useState('')
  const [teamLoaded,   setTeamLoaded]   = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [runs,         setRuns]         = useState<RunEntry[]>([])
  const [env,          setEnv]          = useState<Env>('dev')
  const [sidebarWidth, setSidebarWidth] = useState(224)
  const dragging = useRef(false)

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const startX = e.clientX
    const startW = sidebarWidth
    function onMove(ev: MouseEvent) {
      if (!dragging.current) return
      setSidebarWidth(Math.min(400, Math.max(160, startW + ev.clientX - startX)))
    }
    function onUp() {
      dragging.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [sidebarWidth])

  useEffect(() => {
    fetchUserAttributes().then(async attrs => {
      const name = attrs.name || attrs.email || ''
      setInitials(name.split(/[\s@]/).filter(Boolean).map((p: string) => p[0]).join('').toUpperCase().slice(0, 2))
      setDisplayName(attrs.name || attrs.email?.split('@')[0] || '')
      const username = attrs.name ?? ''  // e.g. VA1234
      if (username) {
        try {
          const session = await fetchAuthSession()
          const ssm = new SSMClient({ region: AWS_REGION, credentials: session.credentials })
          const resp = await ssm.send(new GetParametersByPathCommand({ Path: `/prompt2test/config/members/${username}`, Recursive: true }))
          for (const p of resp.Parameters ?? []) {
            const parts = p.Name!.split('/')
            const key = parts[parts.length - 1]
            if (key === 'TEAM') setTeam(p.Value ?? '')
          }
        } catch { /* no params stored yet */ }
      }
      setTeamLoaded(true)
    }).catch(() => { setTeamLoaded(true) })
  }, [])

  useEffect(() => {
    function load() {
      try {
        const raw = localStorage.getItem('p2t_run_history')
        setRuns(raw ? JSON.parse(raw) : [])
      } catch { setRuns([]) }
    }
    load()
    window.addEventListener('p2t_run_saved', load)
    return () => window.removeEventListener('p2t_run_saved', load)
  }, [])

  async function handleSignOut() {
    await signOut()
    navigate('/login')
  }

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: '#F0F4FF' }}>

      {/* ── Left Sidebar ──────────────────────────────────────────────── */}
      <div style={{ width: sidebarWidth, background: 'white', borderRight: '1px solid #E8EBF0', flexShrink: 0, display: 'flex', flexDirection: 'column', boxShadow: '2px 0 8px rgba(0,0,0,0.04)' }}>

        {/* Logo */}
        <div style={{ borderBottom: '1px solid #F1F5F9', display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', height: 56, flexShrink: 0 }}>
          <img src="/favicon.svg" width="26" height="26" alt="Prompt2Test" />
          <span style={{ fontSize: 15, fontWeight: 800, color: '#0F172A', letterSpacing: '-0.4px' }}>Prompt2Test</span>
        </div>

        {team.toLowerCase() !== 'admin' && (
          <>
            {/* Author Agent — primary action */}
            <div style={{ padding: '12px 12px 4px' }}>
              <NavLink
                to="/agent"
                style={({ isActive }) => ({
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8,
                  fontSize: 13, fontWeight: 700, cursor: 'pointer', textDecoration: 'none',
                  ...(isActive
                    ? { background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', boxShadow: '0 2px 10px rgba(124,58,237,0.35)' }
                    : { color: '#64748B' }
                  ),
                })}
              >
                <svg viewBox="0 0 24 24" style={{ width: 15, height: 15, stroke: 'currentColor', fill: 'none', strokeWidth: 2, flexShrink: 0 }}>
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
                Author Agent
              </NavLink>
            </div>

            {/* Environment selector */}
            <div style={{ padding: '12px 12px 4px' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#CBD5E1', textTransform: 'uppercase', letterSpacing: '0.1em', padding: '0 2px', marginBottom: 6 }}>Environment</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                {ENVS.map(e => {
                  const s = ENV_STYLE[e]
                  const isActive = env === e
                  return (
                    <button key={e} onClick={() => setEnv(e)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 5, padding: '5px 8px', borderRadius: 7,
                        fontSize: 11, fontWeight: 700, cursor: 'pointer', transition: 'all 0.15s',
                        ...(isActive ? s.active : { background: '#F8FAFC', border: '1.5px solid #E8EBF0', color: '#94A3B8' }),
                      }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: isActive ? s.dot : '#CBD5E1' }} />
                      {e.toUpperCase()}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Workspace nav */}
            <div style={{ padding: '16px 14px 4px' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#CBD5E1', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Workspace</div>
            </div>
            <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 12px' }}>
              {NAV.map(item => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  style={({ isActive }) => ({
                    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 8,
                    fontSize: 13, fontWeight: isActive ? 600 : 500, cursor: 'pointer', textDecoration: 'none',
                    ...(isActive
                      ? { background: '#EEF2FF', color: '#4F46E5', border: '1px solid #C7D2FE' }
                      : { color: '#64748B' }
                    ),
                  })}
                >
                  {item.icon}
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </>
        )}

        {team.toLowerCase() !== 'admin' && (
          <>
            {/* Run History */}
            <div style={{ padding: '20px 14px 4px', flexShrink: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#CBD5E1', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Run History</div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 12px' }}>
              {runs.length === 0 ? (
                <div style={{ fontSize: 12, color: '#CBD5E1', padding: '8px 10px', fontStyle: 'italic' }}>No runs yet</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {runs.slice().reverse().map(run => (
                    <div key={run.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 8, background: '#F8FAFC', border: '1px solid #F1F5F9' }}>
                      <span style={{ marginTop: 1, flexShrink: 0, fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4, ...(run.passed ? { background: '#DCFCE7', color: '#166534' } : { background: '#FEE2E2', color: '#991B1B' }) }}>
                        {run.passed ? 'PASS' : 'FAIL'}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: '#334155', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.4 }}>{run.description}</div>
                        <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>{timeAgo(run.timestamp)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
        {team.toLowerCase() === 'admin' && <div style={{ flex: 1 }} />}

        {/* Avatar / profile at bottom */}
        <div style={{ padding: 12, flexShrink: 0, borderTop: '1px solid #F1F5F9' }}>
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setDropdownOpen(o => !o)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 8px', borderRadius: 8, background: 'none', border: 'none', cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#F8FAFC')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            >
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'white', flexShrink: 0, boxShadow: '0 2px 8px rgba(124,58,237,0.3)' }}>
                {initials}
              </div>
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</div>
                {team && <div style={{ fontSize: 11, color: '#0EA5E9', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{team}</div>}
              </div>
            </button>

            {dropdownOpen && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setDropdownOpen(false)} />
                <div style={{ position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, zIndex: 50, width: 192, borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', padding: '4px 0', overflow: 'hidden', background: 'white', border: '1px solid #E8EBF0' }}>
                  <button
                    onClick={handleSignOut}
                    style={{ width: '100%', textAlign: 'left', padding: '8px 16px', fontSize: 13, color: '#64748B', background: 'none', border: 'none', cursor: 'pointer' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#F8FAFC'; (e.currentTarget as HTMLButtonElement).style.color = '#0F172A' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'none'; (e.currentTarget as HTMLButtonElement).style.color = '#64748B' }}
                  >
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Drag handle ───────────────────────────────────────────────── */}
      <div
        onMouseDown={onDragStart}
        style={{ width: 4, flexShrink: 0, cursor: 'col-resize', background: 'transparent' }}
        onMouseEnter={e => (e.currentTarget.style.background = '#C7D2FE')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      />

      {/* ── Main content ──────────────────────────────────────────────── */}
      <EnvContext.Provider value={{ env, setEnv }}>
        <TeamContext.Provider value={{ team, teamLoaded }}>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            {teamLoaded ? <Outlet /> : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#94A3B8', fontSize: 13 }}>
                Loading…
              </div>
            )}
          </div>
        </TeamContext.Provider>
      </EnvContext.Provider>
    </div>
  )
}
