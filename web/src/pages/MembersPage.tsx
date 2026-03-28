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
  Admin:        { background: 'rgba(124,58,237,0.1)',  color: '#6D28D9', border: '1px solid #DDD6FE' },
  'QA Lead':    { background: 'rgba(79,70,229,0.08)', color: '#4338CA', border: '1px solid #C7D2FE' },
  'QA Engineer':{ background: 'rgba(5,150,105,0.08)', color: '#065F46', border: '1px solid #A7F3D0' },
  Developer:    { background: 'rgba(29,78,216,0.08)', color: '#1E40AF', border: '1px solid #BFDBFE' },
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
    <div style={{ height: '100%', overflowY: 'auto', background: '#FAFBFF', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>

      {/* Hero gradient strip */}
      <div style={{ background: 'linear-gradient(135deg, #7C3AED 0%, #4F46E5 50%, #0EA5E9 100%)', padding: '24px 28px 20px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'white', marginBottom: 4, letterSpacing: '-0.3px' }}>Team Members</div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>
              {loading ? 'Loading…' : `${members.length} member${members.length !== 1 ? 's' : ''} · Cognito SSO`}
            </div>
          </div>
          <button onClick={() => setShowModal(true)}
            style={{ padding: '8px 16px', background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.4)', color: 'white', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer', backdropFilter: 'blur(8px)' }}>
            + Invite member
          </button>
        </div>
      </div>

      {/* Content */}
      <div style={{ padding: 24 }}>
        <div style={{ maxWidth: 780 }}>

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
                    <th style={{ textAlign: 'left', padding: '10px 16px', fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Role</th>
                    <th style={{ textAlign: 'left', padding: '10px 16px', fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Access</th>
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
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        <td style={{ padding: '12px 16px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{ width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'white', flexShrink: 0, background: color }}>
                              {initials}
                            </div>
                            <div>
                              <div style={{ fontSize: 14, fontWeight: 600, color: '#0F172A' }}>{m.name}</div>
                              <div style={{ fontSize: 12, color: '#94A3B8' }}>{m.email}</div>
                            </div>
                          </div>
                        </td>
                        <td style={{ padding: '12px 16px' }}>
                          <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 20, fontWeight: 600, ...ROLE_COLORS[m.role] }}>
                            {m.role}
                          </span>
                        </td>
                        <td style={{ padding: '12px 16px', fontSize: 13, color: '#64748B' }}>{ROLE_ACCESS[m.role] ?? '—'}</td>
                        <td style={{ padding: '12px 16px' }}>
                          {isPending ? (
                            <span style={{ fontSize: 11, padding: '2px 8px', background: '#FFFBEB', color: '#92400E', border: '1px solid #FDE68A', borderRadius: 20, fontWeight: 600 }}>Invite pending</span>
                          ) : (
                            <span style={{ fontSize: 11, padding: '2px 8px', background: '#DCFCE7', color: '#166534', border: '1px solid #BBF7D0', borderRadius: 20, fontWeight: 600 }}>Active</span>
                          )}
                        </td>
                        <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                          <button onClick={() => removeMember(m.username)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: 18, lineHeight: 1, padding: 0 }}
                            title="Remove member"
                            onMouseEnter={e => (e.currentTarget.style.color = '#EF4444')}
                            onMouseLeave={e => (e.currentTarget.style.color = '#94A3B8')}>
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
    background: '#F8FAFC',
    border: '1px solid #E2E8F0',
    borderRadius: 8, fontSize: 14, color: '#0F172A', outline: 'none',
    boxSizing: 'border-box',
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={onClose}>
      <div style={{ background: 'white', border: '1px solid #E8EBF0', borderRadius: 16, padding: 28, width: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.15)' }} onClick={e => e.stopPropagation()}>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#64748B', marginBottom: 4 }}>Full Name</label>
              <input style={inputStyle} placeholder="Jane Doe" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#64748B', marginBottom: 4 }}>Work Email</label>
              <input style={inputStyle} placeholder="jane@company.com" type="email" value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#64748B', marginBottom: 4 }}>Role</label>
              <select style={{ ...inputStyle, background: '#F8FAFC' }} value={role} onChange={e => setRole(e.target.value as Role)}>
                {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <div style={{ marginTop: 4, fontSize: 11, color: '#94A3B8' }}>{ROLE_ACCESS[role]}</div>
            </div>

            {error && <div style={{ fontSize: 12, color: '#991B1B' }}>✗ {error}</div>}

            <div style={{ fontSize: 11, color: '#64748B', background: '#F8FAFC', borderRadius: 8, padding: 12, border: '1px solid #E2E8F0' }}>
              An email with a temporary password will be sent via Cognito. They must change it on first login.
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 4 }}>
              <button onClick={onClose}
                style={{ padding: '8px 16px', background: 'white', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 14, color: '#64748B', cursor: 'pointer' }}>
                Cancel
              </button>
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
