import { fetchAuthSession } from '@aws-amplify/auth'
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore'

const AGENT_RUNTIME_ARN = import.meta.env.VITE_AGENT_RUNTIME_ARN as string
const AWS_REGION        = import.meta.env.VITE_AWS_REGION as string

export async function callAgent(
  payload: object,
  sessionId: string,
  onEvent?: (event: Record<string, unknown>) => void,
): Promise<string> {
  const session = await fetchAuthSession()
  if (!session.credentials) throw new Error('Not authenticated')

  const client = new BedrockAgentCoreClient({ region: AWS_REGION, credentials: session.credentials })
  const cmd = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: AGENT_RUNTIME_ARN,
    runtimeSessionId: sessionId,
    contentType: 'application/json',
    accept: 'application/json',
    payload: new TextEncoder().encode(JSON.stringify(payload)),
  })

  const response = await client.send(cmd)
  if (!response.response) return ''

  const reader = (response.response as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  const chunks: Uint8Array[] = []
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try { const event = JSON.parse(line); if (onEvent) onEvent(event) } catch { /* ignore */ }
      }
    }
  }

  const allText = decoder.decode(
    chunks.reduce((a, b) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c }, new Uint8Array())
  )
  const lines = allText.split('\n').filter(l => l.trim())
  return lines[lines.length - 1] ?? allText
}
