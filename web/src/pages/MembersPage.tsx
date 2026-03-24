import { useState, useEffect } from 'react'
import { fetchAuthSession } from '@aws-amplify/auth'
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import { SSMClient, GetParametersByPathCommand, PutParameterCommand, DeleteParameterCommand } from '@aws-sdk/client-ssm'

const AWS_REGION    = import.meta.env.VITE_AWS_REGION as string
const USER_POOL_ID  = import.meta.env.VITE_USER_POOL_ID as string
const SSM_MEMBERS   = '/prompt2test/config/members'

const ROLES = ['Admin', 'QA Lead', 'QA Engineer', 'Developer'] as const
type Role = typeof ROLES[number]

const ROLE_COLORS: Record<string, string> = {
  Admin:        'bg-[#EDE9FE] text-[#7C3AED] border-[#7C3AED]/30',
  'QA Lead':    'bg-purple-50 text-purple-800 border-purple-200',
  'QA Engineer':'bg-green-50 text-green-800 border-green-200',
  Developer:    'bg-blue-50 text-blue-800 border-blue-200',
}

const ROLE_ACCESS: Record<string, string> = {
  Admin:        'All · L1 config',
  'QA Lead':    'Promote · L2+L3 config',
  'QA Engineer':'Author · view inventory',
  Developer:    'View · run tests',
}

const AVATAR_COLORS = ['#7C3AED', '#6B21A8', '#166534', '#1E40AF', '#B45309', '#9F1239']

type Member = {
  username: string
  name: string
  email: string
  role: string
  status: string   // CONFIRMED | FORCE_CHANGE_PASSWORD | UNCONFIRMED
}

// ── AWS clients ────────────────────────────────────────────────────────────

async function getCognitoClient() {
  const session = await fetchAuthSession()
  return new CognitoIdentityProviderClient({ region: AWS_REGION, credentials: session.credentials })
}

async function getSSMClient() {
  const session = await fetchAuthSession()
  return new SSMClient({ region: AWS_REGION, credentials: session.credentials })
}

async function loadRolesFromSSM(): Promise<Record<string, string>> {
  const client = await getSSMClient()
  const roles: Record<string, string> = {}
  let nextToken: string | undefined
  do {
    const resp = await client.send(new GetParametersByPathCommand({
      Path: SSM_MEMBERS, Recursive: true, NextToken: nextToken,
    }))
    for (const p of resp.Parameters ?? []) {
      // Name looks like /prompt2test/config/members/{username}/ROLE
      const parts = p.Name!.split('/')
      if (parts[parts.length - 1] === 'ROLE') {
        roles[parts[parts.length - 2]] = p.Value ?? ''
      }
    }
    nextToken = resp.NextToken
  } while (nextToken)
  return roles
}

// ── Component ──────────────────────────────────────────────────────────────

export default function MembersPage() {
  const [members, setMembers]       = useState<Member[]>([])
  const [loading, setLoading]       = useState(true)
  const [showModal, setShowModal]   = useState(false)

  async function loadMembers() {
    setLoading(true)
    try {
      const [cognitoClient, roles] = await Promise.all([getCognitoClient(), loadRolesFromSSM()])

      const resp = await cognitoClient.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID, Limit: 60 }))

      const list: Member[] = (resp.Users ?? []).map(u => {
        const attr = (name: string) => u.Attributes?.find(a => a.Name === name)?.Value ?? ''
        const username = u.Username ?? ''
        const email = attr('email') || username
        const name  = attr('name') || attr('given_name')
          ? `${attr('given_name')} ${attr('family_name')}`.trim()
          : email.split('@')[0]
        return {
          username,
          name,
          email,
          role:   roles[username] ?? 'QA Engineer',
          status: u.UserStatus ?? 'UNCONFIRMED',
        }
      })

      setMembers(list)
    } catch (e) {
      console.error('Load members failed:', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadMembers() }, [])

  async function removeMember(username: string) {
    if (!confirm('Remove this member? They will lose access immediately.')) return
    try {
      const [cognitoClient, ssmClient] = await Promise.all([getCognitoClient(), getSSMClient()])
      await Promise.all([
        cognitoClient.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: username })),
        ssmClient.send(new DeleteParameterCommand({ Name: `${SSM_MEMBERS}/${username}/ROLE` })).catch(() => {}),
      ])
      setMembers(prev => prev.filter(m => m.username !== username))
    } catch (e) {
      console.error('Remove member failed:', e)
      alert('Failed to remove member. See console for details.')
    }
  }

  return (
    <div className="h-full overflow-y-auto p-5 bg-[#F5F7FA]">
      <div className="max-w-3xl">
        <div className="flex items-center justify-between mb-5">
          <div>
            <div className="text-[17px] font-bold text-slate-900">Team Members</div>
            <div className="text-[13px] text-slate-400 mt-0.5">
              {loading ? 'Loading…' : `${members.length} member${members.length !== 1 ? 's' : ''} · Cognito SSO`}
            </div>
          </div>
          <button onClick={() => setShowModal(true)}
            className="px-3.5 py-2 bg-[#7C3AED] text-white rounded-lg text-[14px] font-medium cursor-pointer hover:bg-[#5B21B6]">
            + Invite member
          </button>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          {loading ? (
            <div className="py-12 text-center text-[13px] text-slate-400">Loading members…</div>
          ) : members.length === 0 ? (
            <div className="py-12 text-center text-[13px] text-slate-400">
              No members yet. Click <strong>+ Invite member</strong> to add someone.
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="text-left px-4 py-3 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Member</th>
                  <th className="text-left px-4 py-3 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Role</th>
                  <th className="text-left px-4 py-3 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Access</th>
                  <th className="text-left px-4 py-3 text-[12px] font-semibold text-slate-400 uppercase tracking-wider">Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {members.map((m, i) => {
                  const initials = m.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
                  const color = AVATAR_COLORS[i % AVATAR_COLORS.length]
                  const isPending = m.status === 'FORCE_CHANGE_PASSWORD'
                  return (
                    <tr key={m.username} className={`border-b border-slate-50 hover:bg-slate-50 ${i % 2 === 1 ? 'bg-slate-50/50' : ''}`}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0"
                            style={{ background: color }}>
                            {initials}
                          </div>
                          <div>
                            <div className="text-[14px] font-semibold text-slate-900">{m.name}</div>
                            <div className="text-[12px] text-slate-400">{m.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-[12px] px-2 py-0.5 rounded-full border font-medium ${ROLE_COLORS[m.role] ?? ''}`}>
                          {m.role}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-[13px] text-slate-500">{ROLE_ACCESS[m.role] ?? '—'}</td>
                      <td className="px-4 py-3">
                        {isPending ? (
                          <span className="text-[11px] px-2 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-full font-medium">Invite pending</span>
                        ) : (
                          <span className="text-[11px] px-2 py-0.5 bg-green-50 text-green-700 border border-green-200 rounded-full font-medium">Active</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button onClick={() => removeMember(m.username)}
                          className="text-slate-300 hover:text-red-400 transition-colors cursor-pointer text-[18px] leading-none" title="Remove member">
                          ×
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showModal && (
        <InviteModal
          onClose={() => setShowModal(false)}
          onInvited={() => { setShowModal(false); loadMembers() }}
        />
      )}
    </div>
  )
}

// ── Invite Modal ───────────────────────────────────────────────────────────

function InviteModal({ onClose, onInvited }: { onClose: () => void; onInvited: () => void }) {
  const [name,    setName]    = useState('')
  const [email,   setEmail]   = useState('')
  const [role,    setRole]    = useState<Role>('QA Engineer')
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')
  const [success, setSuccess] = useState(false)

  async function handleInvite() {
    if (!name.trim() || !email.trim()) { setError('Name and email are required'); return }
    setSaving(true)
    setError('')
    try {
      const [cognitoClient, ssmClient] = await Promise.all([getCognitoClient(), getSSMClient()])

      // Create Cognito user — sends temp password email automatically
      const resp = await cognitoClient.send(new AdminCreateUserCommand({
        UserPoolId:        USER_POOL_ID,
        Username:          email.trim().toLowerCase(),
        UserAttributes:    [
          { Name: 'email',          Value: email.trim().toLowerCase() },
          { Name: 'name',           Value: name.trim() },
          { Name: 'email_verified', Value: 'true' },
        ],
        DesiredDeliveryMediums: ['EMAIL'],
      }))

      const username = resp.User?.Username ?? email.trim().toLowerCase()

      // Save role to SSM
      await ssmClient.send(new PutParameterCommand({
        Name: `${SSM_MEMBERS}/${username}/ROLE`, Value: role, Type: 'String', Overwrite: true,
      }))

      setSuccess(true)
      setTimeout(onInvited, 1500)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-[420px] p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <div className="text-[16px] font-bold text-slate-900">Invite Team Member</div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-[20px] cursor-pointer leading-none">×</button>
        </div>

        {success ? (
          <div className="py-6 text-center">
            <div className="text-[32px] mb-3">✉️</div>
            <div className="text-[15px] font-semibold text-slate-900 mb-1">Invite sent!</div>
            <div className="text-[13px] text-slate-400">{email} will receive an email with login instructions.</div>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="block text-[13px] font-medium text-slate-600 mb-1">Full Name</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[14px] outline-none focus:border-[#7C3AED]"
                placeholder="Jane Doe" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-slate-600 mb-1">Work Email</label>
              <input className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[14px] outline-none focus:border-[#7C3AED]"
                placeholder="jane@company.com" type="email" value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-slate-600 mb-1">Role</label>
              <select className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[14px] outline-none focus:border-[#7C3AED] bg-white"
                value={role} onChange={e => setRole(e.target.value as Role)}>
                {ROLES.map(r => <option key={r}>{r}</option>)}
              </select>
              <div className="mt-1 text-[11px] text-slate-400">{ROLE_ACCESS[role]}</div>
            </div>

            {error && <div className="text-[12px] text-red-500">✗ {error}</div>}

            <div className="pt-1 text-[11px] text-slate-400 bg-slate-50 rounded-lg p-3">
              An email with a temporary password will be sent via Cognito. They must change it on first login.
            </div>

            <div className="flex justify-end gap-3 pt-1">
              <button onClick={onClose} className="px-4 py-2 border border-slate-200 rounded-lg text-[14px] text-slate-600 cursor-pointer hover:bg-slate-50">
                Cancel
              </button>
              <button onClick={handleInvite} disabled={saving}
                className="px-4 py-2 bg-[#7C3AED] text-white rounded-lg text-[14px] font-medium cursor-pointer hover:bg-[#5B21B6] disabled:opacity-50 disabled:cursor-not-allowed">
                {saving ? 'Sending invite…' : 'Send Invite'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
