import { useState, useEffect } from 'react'
import { fetchAuthSession } from '@aws-amplify/auth'
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  ListUsersCommand,
  CreateGroupCommand,
  DeleteGroupCommand,
  ListGroupsCommand,
  ListUsersInGroupCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import { useTeam } from '../context/TeamContext'

const USER_POOL_ID  = import.meta.env.VITE_USER_POOL_ID as string
const AWS_REGION    = import.meta.env.VITE_AWS_REGION as string

const AVATAR_COLORS = ['#7C3AED', '#6B21A8', '#166534', '#1E40AF', '#B45309', '#9F1239']

type Team   = { id: string; description: string }
type Member = { username: string; name: string; email: string; team: string; status: string }

// ── AWS client ───────────────────────────────────────────────────────────────

async function getCognito() {
  const s = await fetchAuthSession()
  return new CognitoIdentityProviderClient({ region: AWS_REGION, credentials: s.credentials })
}

// ── Data loaders ─────────────────────────────────────────────────────────────

async function loadGroups(): Promise<Team[]> {
  const c = await getCognito()
  const resp = await c.send(new ListGroupsCommand({ UserPoolId: USER_POOL_ID, Limit: 60 }))
  return (resp.Groups ?? [])
    .filter(g => g.GroupName !== 'admin')
    .map(g => ({ id: g.GroupName ?? '', description: g.Description ?? '' }))
}

async function loadAllMembers(): Promise<Member[]> {
  const c = await getCognito()

  // Get all users
  const usersResp = await c.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID, Limit: 60 }))
  const users = usersResp.Users ?? []

  // Get all groups and their members to build username→team map
  const groupsResp = await c.send(new ListGroupsCommand({ UserPoolId: USER_POOL_ID, Limit: 60 }))
  const teamMap: Record<string, string> = {}
  await Promise.all(
    (groupsResp.Groups ?? []).map(async g => {
      const r = await c.send(new ListUsersInGroupCommand({ UserPoolId: USER_POOL_ID, GroupName: g.GroupName!, Limit: 60 }))
      for (const u of r.Users ?? []) teamMap[u.Username!] = g.GroupName!
    })
  )

  return users.map(u => {
    const attr = (n: string) => u.Attributes?.find(a => a.Name === n)?.Value ?? ''
    const username = u.Username ?? ''
    const email = attr('email') || username
    const name = attr('name') || email.split('@')[0]
    return { username, name, email, team: teamMap[username] ?? '', status: u.UserStatus ?? 'UNCONFIRMED' }
  })
}

async function loadTeamMembers(teamId: string): Promise<Member[]> {
  const c = await getCognito()
  const resp = await c.send(new ListUsersInGroupCommand({ UserPoolId: USER_POOL_ID, GroupName: teamId, Limit: 60 }))
  return (resp.Users ?? []).map(u => {
    const attr = (n: string) => u.Attributes?.find(a => a.Name === n)?.Value ?? ''
    const username = u.Username ?? ''
    const email = attr('email') || username
    const name = attr('name') || email.split('@')[0]
    return { username, name, email, team: teamId, status: u.UserStatus ?? 'UNCONFIRMED' }
  })
}

// ── Root ─────────────────────────────────────────────────────────────────────

export default function MembersPage() {
  const { team: currentUserTeam } = useTeam()
  const isAdmin = currentUserTeam.toLowerCase() === 'admin'
  return isAdmin ? <AdminView /> : <TeamView currentUserTeam={currentUserTeam} />
}

// ── Admin view ────────────────────────────────────────────────────────────────

function AdminView() {
  const [tab, setTab] = useState<'teams' | 'members'>('teams')
  return (
    <div style={{ height: '100%', overflowY: 'auto', background: '#FAFBFF', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div style={{ background: 'linear-gradient(135deg, #7C3AED 0%, #4F46E5 50%, #0EA5E9 100%)', padding: '24px 28px 0' }}>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'white', marginBottom: 4, letterSpacing: '-0.3px' }}>Team Management</div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>Create teams and manage member access</div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['teams', 'members'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: '8px 20px', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
              borderRadius: '8px 8px 0 0',
              ...(tab === t ? { background: '#FAFBFF', color: '#4F46E5' } : { background: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.8)' }),
            }}>{t === 'teams' ? 'Teams' : 'Members'}</button>
          ))}
        </div>
      </div>
      <div style={{ padding: 24 }}>
        {tab === 'teams' ? <TeamsTab /> : <AdminMembersTab />}
      </div>
    </div>
  )
}

// ── Teams tab ─────────────────────────────────────────────────────────────────

function TeamsTab() {
  const [teams,    setTeams]    = useState<Team[]>([])
  const [loading,  setLoading]  = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [teamId,   setTeamId]   = useState('')
  const [teamDesc, setTeamDesc] = useState('')
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState('')

  async function load() {
    setLoading(true)
    try { setTeams(await loadGroups()) }
    catch (e) { console.error(e) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  async function createTeam() {
    const id = teamId.trim().toLowerCase().replace(/\s+/g, '')
    if (!id) { setError('Team ID is required'); return }
    if (id === 'admin') { setError('"admin" is reserved'); return }
    setSaving(true); setError('')
    try {
      const c = await getCognito()
      await c.send(new CreateGroupCommand({ UserPoolId: USER_POOL_ID, GroupName: id, Description: teamDesc.trim() || id }))
      setTeamId(''); setTeamDesc(''); setShowForm(false)
      await load()
    } catch (e: unknown) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }

  async function deleteTeam(id: string) {
    if (!confirm(`Delete team "${id}"? Members will lose access.`)) return
    try {
      const c = await getCognito()
      await c.send(new DeleteGroupCommand({ UserPoolId: USER_POOL_ID, GroupName: id }))
      setTeams(prev => prev.filter(t => t.id !== id))
    } catch (e) { console.error(e); alert('Failed to delete team') }
  }

  const inp: React.CSSProperties = { width: '100%', padding: '8px 12px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 13, color: '#0F172A', outline: 'none', boxSizing: 'border-box' }

  return (
    <div style={{ maxWidth: 680 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#0F172A' }}>
          {loading ? 'Loading…' : `${teams.length} team${teams.length !== 1 ? 's' : ''}`}
        </div>
        <button onClick={() => { setShowForm(f => !f); setError('') }}
          style={{ padding: '7px 16px', background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', boxShadow: '0 2px 8px rgba(124,58,237,0.3)' }}>
          + New Team
        </button>
      </div>

      {showForm && (
        <div style={{ background: 'white', border: '1px solid #E8EBF0', borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#0F172A', marginBottom: 14 }}>Create New Team</div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: '#64748B', marginBottom: 4 }}>Team ID</label>
              <input value={teamId} onChange={e => setTeamId(e.target.value)} placeholder="e.g. teama" style={inp} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: '#64748B', marginBottom: 4 }}>Display Name</label>
              <input value={teamDesc} onChange={e => setTeamDesc(e.target.value)} placeholder="e.g. Team Alpha" style={inp} />
            </div>
          </div>
          {error && <div style={{ fontSize: 12, color: '#991B1B', marginBottom: 10 }}>✗ {error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => { setShowForm(false); setError('') }}
              style={{ padding: '7px 14px', background: 'white', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 13, color: '#64748B', cursor: 'pointer' }}>Cancel</button>
            <button onClick={createTeam} disabled={saving}
              style={{ padding: '7px 14px', background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Creating…' : 'Create Team'}
            </button>
          </div>
        </div>
      )}

      <div style={{ background: 'white', border: '1px solid #E8EBF0', borderRadius: 14, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
        {loading ? (
          <div style={{ padding: '48px 24px', textAlign: 'center', fontSize: 13, color: '#94A3B8' }}>Loading teams…</div>
        ) : teams.length === 0 ? (
          <div style={{ padding: '48px 24px', textAlign: 'center', fontSize: 13, color: '#94A3B8' }}>
            No teams yet. Click <strong style={{ color: '#64748B' }}>+ New Team</strong> to create one.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#F8FAFC', borderBottom: '1px solid #E8EBF0' }}>
                <th style={{ textAlign: 'left', padding: '10px 16px', fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Team</th>
                <th style={{ textAlign: 'left', padding: '10px 16px', fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Team ID</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {teams.map(t => (
                <tr key={t.id} style={{ borderBottom: '1px solid #E8EBF0' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#F8FAFC')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 32, height: 32, borderRadius: 8, background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'white' }}>
                        {t.id.slice(0, 2).toUpperCase()}
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#0F172A' }}>{t.description || t.id}</div>
                    </div>
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <span style={{ fontSize: 12, fontFamily: 'monospace', background: '#F1F5F9', color: '#475569', padding: '2px 8px', borderRadius: 5 }}>{t.id}</span>
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                    <button onClick={() => deleteTeam(t.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: 18, lineHeight: 1, padding: 0 }}
                      onMouseEnter={e => (e.currentTarget.style.color = '#EF4444')}
                      onMouseLeave={e => (e.currentTarget.style.color = '#94A3B8')}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── Admin members tab ─────────────────────────────────────────────────────────

function AdminMembersTab() {
  const [members,   setMembers]   = useState<Member[]>([])
  const [teams,     setTeams]     = useState<Team[]>([])
  const [loading,   setLoading]   = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [filter,    setFilter]    = useState('')

  async function load() {
    setLoading(true)
    try {
      const [m, t] = await Promise.all([loadAllMembers(), loadGroups()])
      setMembers(m); setTeams(t)
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  async function removeMember(username: string, team: string) {
    if (!confirm('Remove this member? They will lose access immediately.')) return
    try {
      const c = await getCognito()
      await Promise.all([
        c.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: username })),
        team ? c.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: USER_POOL_ID, Username: username, GroupName: team })).catch(() => {}) : Promise.resolve(),
      ])
      setMembers(prev => prev.filter(m => m.username !== username))
    } catch (e) { console.error(e); alert('Failed to remove member') }
  }

  const filtered = filter ? members.filter(m => m.team === filter) : members

  return (
    <div style={{ maxWidth: 780 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#0F172A' }}>
            {loading ? 'Loading…' : `${filtered.length} member${filtered.length !== 1 ? 's' : ''}`}
          </div>
          <select value={filter} onChange={e => setFilter(e.target.value)}
            style={{ padding: '5px 10px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 12, color: '#475569', cursor: 'pointer', outline: 'none' }}>
            <option value="">All teams</option>
            {teams.map(t => <option key={t.id} value={t.id}>{t.description || t.id} ({t.id})</option>)}
          </select>
        </div>
        <button onClick={() => setShowModal(true)}
          style={{ padding: '7px 16px', background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', boxShadow: '0 2px 8px rgba(124,58,237,0.3)' }}>
          + Invite Member
        </button>
      </div>
      <MembersTable members={filtered} loading={loading} onRemove={removeMember} />
      {showModal && <InviteModal teams={teams} onClose={() => setShowModal(false)} onInvited={() => { setShowModal(false); load() }} />}
    </div>
  )
}

// ── Regular team view ─────────────────────────────────────────────────────────

function TeamView({ currentUserTeam }: { currentUserTeam: string }) {
  const [members,   setMembers]   = useState<Member[]>([])
  const [loading,   setLoading]   = useState(true)
  const [showModal, setShowModal] = useState(false)

  async function load() {
    if (!currentUserTeam) return
    setLoading(true)
    try { setMembers(await loadTeamMembers(currentUserTeam)) }
    catch (e) { console.error(e) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [currentUserTeam])

  async function removeMember(username: string, team: string) {
    if (!confirm('Remove this member? They will lose access immediately.')) return
    try {
      const c = await getCognito()
      await Promise.all([
        c.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: username })),
        c.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: USER_POOL_ID, Username: username, GroupName: team })).catch(() => {}),
      ])
      setMembers(prev => prev.filter(m => m.username !== username))
    } catch (e) { console.error(e); alert('Failed to remove member') }
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: '#FAFBFF', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div style={{ background: 'linear-gradient(135deg, #7C3AED 0%, #4F46E5 50%, #0EA5E9 100%)', padding: '24px 28px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'white', marginBottom: 4, letterSpacing: '-0.3px' }}>Team Members</div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>
              {loading ? 'Loading…' : `${members.length} member${members.length !== 1 ? 's' : ''} · ${currentUserTeam}`}
            </div>
          </div>
          <button onClick={() => setShowModal(true)}
            style={{ padding: '8px 16px', background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.4)', color: 'white', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer', backdropFilter: 'blur(8px)' }}>
            + Invite member
          </button>
        </div>
      </div>
      <div style={{ padding: 24 }}>
        <div style={{ maxWidth: 780 }}>
          <MembersTable members={members} loading={loading} onRemove={removeMember} />
        </div>
      </div>
      {showModal && (
        <InviteModal
          teams={[{ id: currentUserTeam, description: currentUserTeam }]}
          defaultTeam={currentUserTeam}
          onClose={() => setShowModal(false)}
          onInvited={() => { setShowModal(false); load() }}
        />
      )}
    </div>
  )
}

// ── Shared members table ──────────────────────────────────────────────────────

function MembersTable({ members, loading, onRemove }: { members: Member[]; loading: boolean; onRemove: (username: string, team: string) => void }) {
  return (
    <div style={{ background: 'white', border: '1px solid #E8EBF0', borderRadius: 14, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04)' }}>
      {loading ? (
        <div style={{ padding: '48px 24px', textAlign: 'center', fontSize: 13, color: '#94A3B8' }}>Loading members…</div>
      ) : members.length === 0 ? (
        <div style={{ padding: '48px 24px', textAlign: 'center', fontSize: 13, color: '#94A3B8' }}>
          No members yet. Click <strong style={{ color: '#64748B' }}>+ Invite member</strong> to add someone.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#F8FAFC', borderBottom: '1px solid #E8EBF0' }}>
              <th style={{ textAlign: 'left', padding: '10px 16px', fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Member</th>
              <th style={{ textAlign: 'left', padding: '10px 16px', fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Team</th>
              <th style={{ textAlign: 'left', padding: '10px 16px', fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {members.map((m, i) => {
              const initials = m.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
              const color = AVATAR_COLORS[i % AVATAR_COLORS.length]
              const isPending = m.status === 'FORCE_CHANGE_PASSWORD'
              return (
                <tr key={m.username} style={{ borderBottom: '1px solid #E8EBF0' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#F8FAFC')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 32, height: 32, borderRadius: '50%', background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'white', flexShrink: 0 }}>{initials}</div>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: '#0F172A' }}>{m.name}</div>
                        <div style={{ fontSize: 12, color: '#94A3B8' }}>{m.email}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    {m.team ? (
                      <span style={{ fontSize: 12, fontFamily: 'monospace', background: '#EEF2FF', color: '#4F46E5', padding: '2px 8px', borderRadius: 5, fontWeight: 600 }}>{m.team}</span>
                    ) : <span style={{ fontSize: 13, color: '#94A3B8' }}>—</span>}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    {isPending
                      ? <span style={{ fontSize: 11, padding: '2px 8px', background: '#FFFBEB', color: '#92400E', border: '1px solid #FDE68A', borderRadius: 20, fontWeight: 600 }}>Invite pending</span>
                      : <span style={{ fontSize: 11, padding: '2px 8px', background: '#DCFCE7', color: '#166534', border: '1px solid #BBF7D0', borderRadius: 20, fontWeight: 600 }}>Active</span>}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                    <button onClick={() => onRemove(m.username, m.team)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: 18, lineHeight: 1, padding: 0 }}
                      onMouseEnter={e => (e.currentTarget.style.color = '#EF4444')}
                      onMouseLeave={e => (e.currentTarget.style.color = '#94A3B8')}>×</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Invite modal ──────────────────────────────────────────────────────────────

function InviteModal({ teams, defaultTeam, onClose, onInvited }: {
  teams: Team[]; defaultTeam?: string; onClose: () => void; onInvited: () => void
}) {
  const [name,    setName]    = useState('')
  const [email,   setEmail]   = useState('')
  const [teamId,  setTeamId]  = useState(defaultTeam ?? teams[0]?.id ?? '')
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')
  const [success, setSuccess] = useState(false)

  const isAdmin = !defaultTeam

  async function handleInvite() {
    if (!name.trim() || !email.trim()) { setError('Name and email are required'); return }
    if (!teamId) { setError('Please select a team'); return }
    setSaving(true); setError('')
    try {
      const c = await getCognito()
      const resp = await c.send(new AdminCreateUserCommand({
        UserPoolId:     USER_POOL_ID,
        Username:       email.trim().toLowerCase(),
        UserAttributes: [
          { Name: 'email',          Value: email.trim().toLowerCase() },
          { Name: 'name',           Value: name.trim() },
          { Name: 'email_verified', Value: 'true' },
        ],
        DesiredDeliveryMediums: ['EMAIL'],
      }))
      const username = resp.User?.Username ?? email.trim().toLowerCase()
      await c.send(new AdminAddUserToGroupCommand({ UserPoolId: USER_POOL_ID, Username: username, GroupName: teamId }))
      setSuccess(true)
      setTimeout(onInvited, 1500)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setSaving(false) }
  }

  const inp: React.CSSProperties = { width: '100%', padding: '8px 12px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 14, color: '#0F172A', outline: 'none', boxSizing: 'border-box' }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={onClose}>
      <div style={{ background: 'white', border: '1px solid #E8EBF0', borderRadius: 16, padding: 28, width: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A' }}>Invite Team Member</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: 20, lineHeight: 1, padding: 0 }}>×</button>
        </div>
        {success ? (
          <div style={{ padding: '24px 0', textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>✉️</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#0F172A', marginBottom: 4 }}>Invite sent!</div>
            <div style={{ fontSize: 13, color: '#64748B' }}>{email} will receive an email with login instructions.</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: '#64748B', marginBottom: 4 }}>Full Name</label>
              <input style={inp} placeholder="Jane Doe" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: '#64748B', marginBottom: 4 }}>Work Email</label>
              <input style={inp} type="email" placeholder="jane@company.com" value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            {isAdmin ? (
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: '#64748B', marginBottom: 4 }}>Assign to Team</label>
                <select value={teamId} onChange={e => setTeamId(e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
                  <option value="">— Select a team —</option>
                  {teams.map(t => <option key={t.id} value={t.id}>{t.description || t.id} ({t.id})</option>)}
                </select>
              </div>
            ) : (
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: '#64748B', marginBottom: 4 }}>Team</label>
                <div style={{ ...inp, color: '#64748B', background: '#F1F5F9' }}>{teamId}</div>
              </div>
            )}
            {error && <div style={{ fontSize: 12, color: '#991B1B' }}>✗ {error}</div>}
            <div style={{ fontSize: 11, color: '#64748B', background: '#F8FAFC', borderRadius: 8, padding: 12, border: '1px solid #E2E8F0' }}>
              A temporary password will be sent via Cognito. The user must change it on first login.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 4 }}>
              <button onClick={onClose} style={{ padding: '8px 16px', background: 'white', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 14, color: '#64748B', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleInvite} disabled={saving}
                style={{ padding: '8px 16px', background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1, boxShadow: '0 2px 8px rgba(124,58,237,0.35)' }}>
                {saving ? 'Sending invite…' : 'Send Invite'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
