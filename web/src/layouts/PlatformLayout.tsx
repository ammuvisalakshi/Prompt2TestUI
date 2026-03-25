import { useState, useEffect } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { fetchUserAttributes, fetchAuthSession, signOut } from '@aws-amplify/auth'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'

const AWS_REGION = import.meta.env.VITE_AWS_REGION as string

const tabs = [
  {
    to: '/agent',
    label: 'Author Agent',
    icon: (
      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    ),
  },
  {
    to: '/inventory',
    label: 'Test Inventory',
    icon: (
      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2">
        <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
      </svg>
    ),
  },
  {
    to: '/config',
    label: 'Config & Accounts',
    icon: (
      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2">
        <circle cx="12" cy="12" r="3" /><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
      </svg>
    ),
  },
  {
    to: '/concepts',
    label: 'Core Concepts',
    icon: (
      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2">
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    ),
  },
  {
    to: '/members',
    label: 'Members',
    icon: (
      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2">
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
      </svg>
    ),
  },
]

export default function PlatformLayout() {
  const navigate = useNavigate()
  const [initials, setInitials]         = useState('?')
  const [displayName, setDisplayName]   = useState('')
  const [role, setRole]                 = useState('')
  const [dropdownOpen, setDropdownOpen] = useState(false)

  useEffect(() => {
    fetchUserAttributes().then(async attrs => {
      const name = attrs.name || attrs.email || ''
      setInitials(name.split(/[\s@]/).filter(Boolean).map((p: string) => p[0]).join('').toUpperCase().slice(0, 2))
      setDisplayName(attrs.name || attrs.email?.split('@')[0] || '')

      // Look up role from SSM by username (email)
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

  async function handleSignOut() {
    await signOut()
    navigate('/login')
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Top nav */}
      <div className="flex items-center h-[52px] px-5 bg-white border-b border-slate-200 flex-shrink-0 gap-3 shadow-sm">
        {/* Logo */}
        <div className="flex items-center gap-2 mr-2">
          <img src="/favicon.svg" width="28" height="28" alt="Prompt2Test" className="flex-shrink-0" />
          <span className="text-[17px] font-bold text-slate-900 tracking-tight">
            Prompt2Test
          </span>
        </div>

        {/* Tabs */}
        <nav className="flex items-center gap-0.5">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                `flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[14px] font-medium cursor-pointer border-none transition-all whitespace-nowrap ${
                  isActive
                    ? 'text-[#5B21B6] bg-[#EDE9FE] font-semibold'
                    : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
                }`
              }
            >
              {tab.icon}
              {tab.label}
            </NavLink>
          ))}
        </nav>

        {/* Avatar with dropdown */}
        <div className="relative ml-auto flex-shrink-0">
          <div
            className="w-8 h-8 rounded-full bg-gradient-to-br from-[#7C3AED] to-[#6D28D9] flex items-center justify-center text-[11px] font-bold text-white cursor-pointer select-none"
            onClick={() => setDropdownOpen(o => !o)}
          >
            {initials}
          </div>

          {dropdownOpen && (
            <>
              {/* Backdrop to close on outside click */}
              <div className="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)} />
              <div className="absolute right-0 top-10 z-50 w-48 bg-white border border-slate-200 rounded-xl shadow-lg py-1 overflow-hidden">
                <div className="px-4 py-2.5 border-b border-slate-100">
                  <div className="text-[13px] font-semibold text-slate-900 truncate">{displayName}</div>
                  {role && <div className="text-[11px] text-[#7C3AED] font-medium mt-0.5">{role}</div>}
                </div>
                <button
                  onClick={handleSignOut}
                  className="w-full text-left px-4 py-2 text-[13px] text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Page content */}
      <div className="flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  )
}
