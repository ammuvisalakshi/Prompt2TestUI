const MEMBERS = [
  { initials: 'JD', name: 'Jane D', email: 'jane@company.com', role: 'Admin', access: 'All · L1 config', color: '#0C7B8E' },
  { initials: 'MK', name: 'Mike K', email: 'mike@company.com', role: 'QA Lead', access: 'Promote · L2+L3 config', color: '#6B21A8' },
  { initials: 'SP', name: 'Sara P', email: 'sara@company.com', role: 'QA Lead', access: 'Promote · L2+L3 config', color: '#6B21A8' },
  { initials: 'AL', name: 'Alex L', email: 'alex@company.com', role: 'QA Engineer', access: 'Author · view inventory', color: '#166534' },
  { initials: 'RP', name: 'Raj P', email: 'raj@company.com', role: 'QA Engineer', access: 'Author · view inventory', color: '#166534' },
  { initials: 'KM', name: 'Kim M', email: 'kim@company.com', role: 'QA Engineer', access: 'Author · view inventory', color: '#166534' },
  { initials: 'TW', name: 'Tom W', email: 'tom@company.com', role: 'Developer', access: 'View · run tests', color: '#1E40AF' },
  { initials: 'NJ', name: 'Nina J', email: 'nina@company.com', role: 'Developer', access: 'View · run tests', color: '#1E40AF' },
]

const ROLE_COLORS: Record<string, string> = {
  Admin: 'bg-[#E0F2F7] text-[#0C7B8E] border-[#0C7B8E]/30',
  'QA Lead': 'bg-purple-50 text-purple-800 border-purple-200',
  'QA Engineer': 'bg-green-50 text-green-800 border-green-200',
  Developer: 'bg-blue-50 text-blue-800 border-blue-200',
}

export default function MembersPage() {
  return (
    <div className="h-full overflow-y-auto p-5 bg-[#F5F7FA]">
      <div className="max-w-3xl">
        <div className="flex items-center justify-between mb-5">
          <div>
            <div className="text-[17px] font-bold text-slate-900">Team Members</div>
            <div className="text-[13px] text-slate-400 mt-0.5">{MEMBERS.length} members · Cognito SSO</div>
          </div>
          <button className="px-3.5 py-2 bg-[#0C7B8E] text-white rounded-lg text-[14px] font-medium cursor-pointer hover:bg-[#0A6577] flex items-center gap-1.5">
            + Invite member
          </button>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="text-left px-4 py-3 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Member</th>
                <th className="text-left px-4 py-3 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Role</th>
                <th className="text-left px-4 py-3 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Access</th>
              </tr>
            </thead>
            <tbody>
              {MEMBERS.map((m, i) => (
                <tr key={m.email} className={`border-b border-slate-50 hover:bg-slate-50 ${i % 2 === 1 ? 'bg-slate-50/50' : ''}`}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0"
                        style={{ background: m.color }}
                      >
                        {m.initials}
                      </div>
                      <div>
                        <div className="text-[14px] font-semibold text-slate-900">{m.name}</div>
                        <div className="text-[12px] text-slate-400">{m.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-[12px] px-2 py-0.5 rounded-full border font-medium ${ROLE_COLORS[m.role] || ''}`}>
                      {m.role}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[13px] text-slate-500">{m.access}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
