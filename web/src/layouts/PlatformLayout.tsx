import { useState, useEffect, useRef, useCallback } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { fetchUserAttributes, fetchAuthSession, signOut } from '@aws-amplify/auth'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { EnvContext, ENVS, ENV_COLORS, ENV_DOT, type Env } from '../context/EnvContext'

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
      <svg viewBox="0 0 24 24" className="w-4 h-4 stroke-current fill-none stroke-2 flex-shrink-0">
        <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
      </svg>
    ),
  },
  {
    to: '/config',
    label: 'Config & Accounts',
    icon: (
      <svg viewBox="0 0 24 24" className="w-4 h-4 stroke-current fill-none stroke-2 flex-shrink-0">
        <circle cx="12" cy="12" r="3" /><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
      </svg>
    ),
  },
  {
    to: '/members',
    label: 'Members',
    icon: (
      <svg viewBox="0 0 24 24" className="w-4 h-4 stroke-current fill-none stroke-2 flex-shrink-0">
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
      </svg>
    ),
  },
]

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
  const [role,         setRole]         = useState('')
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [runs,         setRuns]         = useState<RunEntry[]>([])
  const [env,          setEnv]          = useState<Env>('dev')
  const [sidebarWidth, setSidebarWidth] = useState(220)
  const dragging = useRef(false)

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const startX = e.clientX
    const startW = sidebarWidth

    function onMove(ev: MouseEvent) {
      if (!dragging.current) return
      const next = Math.min(400, Math.max(160, startW + ev.clientX - startX))
      setSidebarWidth(next)
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

      const username = attrs.email ?? ''
      if (username) {
        try {
          const session = await fetchAuthSession()
          const ssm = new SSMClient({ region: AWS_REGION, credentials: session.credentials })
          const resp = await ssm.send(new GetParameterCommand({ Name: `/prompt2test/config/members/${username}/ROLE` }))
          setRole(resp.Parameter?.Value ?? '')
        } catch { /* no role stored yet */ }
      }
    }).catch(() => {})
  }, [])

  // Load + keep run history in sync with localStorage
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
    <div className="flex h-screen overflow-hidden" style={{ background: 'linear-gradient(135deg, #0D0821 0%, #130D35 45%, #0A1628 100%)' }}>

      {/* ── Left Sidebar ──────────────────────────────────────────────── */}
      <div style={{ width: sidebarWidth, background: 'rgba(255,255,255,0.04)', backdropFilter: 'blur(24px)', borderRight: '1px solid rgba(255,255,255,0.07)', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>

        {/* Logo */}
        <div style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }} className="flex items-center gap-2 px-4 h-[52px] flex-shrink-0">
          <img src="/favicon.svg" width="24" height="24" alt="Prompt2Test" />
          <span className="text-[15px] font-bold text-white tracking-tight" style={{ textShadow: '0 0 20px rgba(167,139,250,0.5)' }}>Prompt2Test</span>
        </div>

        {/* Author Agent — primary action */}
        <div className="px-3 pt-3 pb-1">
          <NavLink
            to="/agent"
            className={({ isActive }) =>
              `flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-semibold cursor-pointer transition-all ${
                isActive
                  ? 'text-purple-300'
                  : 'text-slate-400 hover:text-white'
              }`
            }
            style={({ isActive }) => isActive ? {
              background: 'rgba(139,92,246,0.2)',
              border: '1px solid rgba(139,92,246,0.35)',
              boxShadow: '0 0 12px rgba(139,92,246,0.15)'
            } : {}}
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4 stroke-current fill-none stroke-2 flex-shrink-0">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            Author Agent
          </NavLink>
        </div>

        {/* Environment selector */}
        <div className="px-3 pt-3 pb-1">
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest px-1 mb-1.5">Environment</div>
          <div className="grid grid-cols-2 gap-1">
            {ENVS.map(e => (
              <button key={e} onClick={() => setEnv(e)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold cursor-pointer transition-all ${
                  env === e ? ENV_COLORS[e] : 'text-slate-500 hover:text-slate-300'
                }`}
                style={env === e ? { background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)' } : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
              >
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${env === e ? ENV_DOT[e] : 'bg-slate-600'}`} />
                {e.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Workspace nav */}
        <div className="px-4 pt-4 pb-1">
          <div className="text-[10px] font-semibold text-slate-600 uppercase tracking-widest">Workspace</div>
        </div>
        <nav className="flex flex-col gap-0.5 px-3">
          {NAV.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium cursor-pointer transition-all ${
                  isActive ? 'text-purple-300' : 'text-slate-400 hover:text-white'
                }`
              }
              style={({ isActive }) => isActive ? {
                background: 'rgba(139,92,246,0.15)',
                border: '1px solid rgba(139,92,246,0.25)',
              } : {}}
            >
              {item.icon}
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* Run History */}
        <div className="px-4 pt-5 pb-1 flex-shrink-0">
          <div className="text-[10px] font-semibold text-slate-600 uppercase tracking-widest">Run History</div>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-3">
          {runs.length === 0 ? (
            <div className="text-[12px] text-slate-600 px-3 py-2 italic">No runs yet</div>
          ) : (
            <div className="flex flex-col gap-1">
              {runs.slice().reverse().map(run => (
                <div key={run.id} className="flex items-start gap-2 px-3 py-2 rounded-lg cursor-default transition-colors" style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <span className={`mt-0.5 flex-shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded ${run.passed ? 'bg-emerald-900/60 text-emerald-400' : 'bg-red-900/50 text-red-400'}`}>
                    {run.passed ? 'PASS' : 'FAIL'}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[12px] text-slate-300 truncate leading-tight">{run.description}</div>
                    <div className="text-[11px] text-slate-600 mt-0.5">{timeAgo(run.timestamp)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Avatar / profile at bottom */}
        <div className="p-3 flex-shrink-0" style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          <div className="relative">
            <button
              onClick={() => setDropdownOpen(o => !o)}
              className="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-lg transition-colors cursor-pointer hover:bg-white/5"
            >
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#A855F7] to-[#7C3AED] flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0" style={{ boxShadow: '0 0 10px rgba(168,85,247,0.4)' }}>
                {initials}
              </div>
              <div className="flex-1 min-w-0 text-left">
                <div className="text-[13px] font-semibold text-slate-200 truncate">{displayName}</div>
                {role && <div className="text-[11px] text-purple-400 font-medium truncate">{role}</div>}
              </div>
            </button>

            {dropdownOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)} />
                <div className="absolute bottom-full left-0 mb-1 z-50 w-48 rounded-xl shadow-2xl py-1 overflow-hidden" style={{ background: 'rgba(20,10,50,0.95)', border: '1px solid rgba(255,255,255,0.12)', backdropFilter: 'blur(16px)' }}>
                  <button
                    onClick={handleSignOut}
                    className="w-full text-left px-4 py-2 text-[13px] text-slate-300 hover:text-white hover:bg-white/8 cursor-pointer transition-colors"
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
        className="w-px flex-shrink-0 cursor-col-resize transition-colors"
        style={{ background: 'rgba(255,255,255,0.06)' }}
        onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = 'rgba(139,92,246,0.5)'}
        onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.06)'}
      />

      {/* ── Main content ──────────────────────────────────────────────── */}
      <EnvContext.Provider value={{ env, setEnv }}>
        <div className="flex-1 overflow-hidden">
          <Outlet />
        </div>
      </EnvContext.Provider>
    </div>
  )
}
