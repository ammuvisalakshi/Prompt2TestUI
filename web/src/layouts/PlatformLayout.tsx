import { NavLink, Outlet, useNavigate } from 'react-router-dom'

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
    to: '/architecture',
    label: 'Architecture',
    icon: (
      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-current fill-none stroke-2">
        <polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" />
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

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Top nav */}
      <div className="flex items-center h-[52px] px-5 bg-white border-b border-slate-200 flex-shrink-0 gap-3 shadow-sm">
        {/* Logo */}
        <div className="flex items-center gap-1.5 mr-2">
          <div className="w-2 h-2 rounded-full bg-gradient-to-br from-[#028090] to-[#00A896]" />
          <span className="text-[17px] font-bold text-slate-900 tracking-tight">
            TestPilot<span className="text-slate-400 text-[10px] ml-0.5">AI</span>
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
                    ? 'text-[#0B7285] bg-[#E0F7FA] font-semibold'
                    : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
                }`
              }
            >
              {tab.icon}
              {tab.label}
            </NavLink>
          ))}
        </nav>

        {/* Avatar */}
        <div
          className="w-8 h-8 rounded-full bg-gradient-to-br from-[#028090] to-[#06B6D4] flex items-center justify-center text-[11px] font-bold text-white ml-auto cursor-pointer flex-shrink-0"
          onClick={() => navigate('/login')}
          title="Sign out"
        >
          JD
        </div>
      </div>

      {/* Page content */}
      <div className="flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  )
}
