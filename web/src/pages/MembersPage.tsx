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

const ROLE_COLORS: Record<string, React.CSSProperties> = {
  Admin:        { background: 'rgba(139,92,246,0.2)',  color: '#C084FC', border: '1px solid rgba(139,92,246,0.35)' },
  'QA Lead':    { background: 'rgba(168,85,247,0.15)', color: '#D8B4FE', border: '1px solid rgba(168,85,247,0.3)' },
  'QA Engineer':{ background: 'rgba(16,185,129,0.15)', color: '#6EE7B7', border: '1px solid rgba(16,185,129,0.25)' },
  Developer:    { background: 'rgba(59,130,246,0.15)', color: '#93C5FD', border: '1px solid rgba(59,130,246,0.25)' },
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
          username, name, email,
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
    <div style={{ height: '100%', overflowY: 'auto', padding: 20, background: 'transparent' }}>
      <div style={{ maxWidth: 780 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'white', textShadow: '0 0 20px rgba(139,92,246,0.3)' }}>Team Members</div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>
              {loading ? 'Loading…' : `${members.length} member${members.length !== 1 ? 's' : ''} · Cognito SSO`}
            </div>
          </div>
          <button onClick={() => setShowModal(true)}
            style={{ padding: '8px 14px', background: 'linear-gradient(135deg, #7C3AED, #A855F7)', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer', boxShadow: '0 0 16px rgba(139,92,246,0.3)' }}>
            + Invite member
          </button>
        </div>

        <div style={{ background: 'rgba(255,255,255,0.04)', backdropFilter: 'blur(20px)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, overflow: 'hidden', boxShadow: '0 8px 32px rgba(0,0,0,0.3)' }}>
          {loading ? (
            <div style={{ padding: '48px 24px', textAlign: 'center', fontSize: 13, color: 'rgba(255,255,255,0.3)' }}>Loading members…</div>
          ) : members.length === 0 ? (
            <div style={{ padding: '48px 24px', textAlign: 'center', fontSize: 13, color: 'rgba(255,255,255,0.3)' }}>
              No members yet. Click <strong style={{ color: 'rgba(255,255,255,0.5)' }}>+ Invite member</strong> to add someone.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'rgba(0,0,0,0.3)', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                  <th style={{ textAlign: 'left', padding: '10px 16px', fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Member</th>
                  <th style={{ textAlign: 'left', padding: '10px 16px', fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Role</th>
                  <th style={{ textAlign: 'left', padding: '10px 16px', fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Access</th>
                  <th style={{ textAlign: 'left', padding: '10px 16px', fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {members.map((m, i) => {
                  const initials = m.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
                  const color = AVATAR_COLORS[i % AVATAR_COLORS.length]
                  const isPending = m.status === 'FORCE_CHANGE_PASSWORD'
                  return (
                    <tr key={m.username} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: i % 2 === 1 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                      <td style={{ padding: '12px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <div style={{ width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'white', flexShrink: 0, background: color }}>
                            {initials}
                          </div>
                          <div>
                            <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>{m.name}</div>
                            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)' }}>{m.email}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 20, fontWeight: 600, ...ROLE_COLORS[m.role] }}>
                          {m.role}
                        </span>
                      </td>
                      <td style={{ padding: '12px 16px', fontSize: 13, color: 'rgba(255,255,255,0.4)' }}>{ROLE_ACCESS[m.role] ?? '—'}</td>
                      <td style={{ padding: '12px 16px' }}>
                        {isPending ? (
                          <span style={{ fontSize: 11, padding: '2px 8px', background: 'rgba(245,158,11,0.15)', color: '#FCD34D', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 20, fontWeight: 600 }}>Invite pending</span>
                        ) : (
                          <span style={{ fontSize: 11, padding: '2px 8px', background: 'rgba(16,185,129,0.15)', color: '#6EE7B7', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 20, fontWeight: 600 }}>Active</span>
                        )}
                      </td>
                      <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                        <button onClick={() => removeMember(m.username)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.2)', fontSize: 18, lineHeight: 1, padding: 0 }}
                          title="Remove member"
                          onMouseEnter={e => (e.currentTarget.style.color = '#F87171')}
                          onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.2)')}>
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

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px',
    background: 'rgba(255,255,255,0.07)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 8, fontSize: 14, color: 'white', outline: 'none',
    boxSizing: 'border-box',
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={onClose}>
      <div style={{ background: 'rgba(20,10,50,0.95)', backdropFilter: 'blur(24px)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 16, padding: 28, width: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'white' }}>Invite Team Member</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', fontSize: 20, lineHeight: 1, padding: 0 }}>×</button>
        </div>

        {success ? (
          <div style={{ padding: '24px 0', textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>✉️</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'white', marginBottom: 4 }}>Invite sent!</div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)' }}>{email} will receive an email with login instructions.</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>Full Name</label>
              <input style={inputStyle} placeholder="Jane Doe" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>Work Email</label>
              <input style={inputStyle} placeholder="jane@company.com" type="email" value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>Role</label>
              <select style={{ ...inputStyle, background: 'rgba(255,255,255,0.07)' }} value={role} onChange={e => setRole(e.target.value as Role)}>
                {ROLES.map(r => <option key={r} value={r} style={{ background: '#1a0d40' }}>{r}</option>)}
              </select>
              <div style={{ marginTop: 4, fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>{ROLE_ACCESS[role]}</div>
            </div>

            {error && <div style={{ fontSize: 12, color: '#F87171' }}>✗ {error}</div>}

            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: 12 }}>
              An email with a temporary password will be sent via Cognito. They must change it on first login.
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 4 }}>
              <button onClick={onClose}
                style={{ padding: '8px 16px', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 14, color: 'rgba(255,255,255,0.6)', cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={handleInvite} disabled={saving}
                style={{ padding: '8px 16px', background: '#7C3AED', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Sending invite…' : 'Send Invite'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
