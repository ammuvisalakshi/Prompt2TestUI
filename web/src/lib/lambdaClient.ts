import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { fetchAuthSession } from '@aws-amplify/auth'

const AWS_REGION = import.meta.env.VITE_AWS_REGION as string

async function getLambdaClient() {
  const session = await fetchAuthSession()
  if (!session.credentials) throw new Error('Not authenticated')
  return new LambdaClient({ region: AWS_REGION, credentials: session.credentials })
}

async function invokeLambda(functionName: string, payload: object): Promise<unknown> {
  const client = await getLambdaClient()
  const cmd = new InvokeCommand({
    FunctionName: functionName,
    Payload: new TextEncoder().encode(JSON.stringify(payload)),
  })
  const res = await client.send(cmd)
  if (!res.Payload) return null
  const text = new TextDecoder().decode(res.Payload)
  const parsed = JSON.parse(text)

  // Lambda function-level error (unhandled exception)
  if (res.FunctionError) {
    throw new Error(parsed.errorMessage ?? 'Lambda function error')
  }

  // Lambda wraps response in statusCode/body envelope
  const body = parsed.body ? JSON.parse(parsed.body) : parsed
  if (parsed.statusCode && parsed.statusCode >= 400) {
    throw new Error(body.error ?? `Lambda returned ${parsed.statusCode}`)
  }
  return body
}

export type TestCase = {
  id: string
  env: string
  service: string
  title: string
  description: string
  scenario?: string
  tags: string[]
  createdBy: string
  createdAt: string
  lastResult: string | null
  lastRunAt: string | null
  runs: { id: string; result: string; runAt: string; runBy: string; summary: string }[]
}

export type RunRecord = {
  id: string
  testCaseId: string
  description: string
  env: string
  result: string
  summary: string
  runBy: string
  runAt: string
}

export async function saveTestCase(params: {
  id?: string
  title?: string
  description: string
  scenario?: string
  env: string
  service?: string
  steps?: object[]
  planSteps?: object[]
  tags?: string[]
  createdBy?: string
}): Promise<string> {
  const res = await invokeLambda('p2t-testcase-writer', { action: 'save_test_case', ...params }) as { id: string }
  return res.id
}

export async function saveRunRecord(params: {
  testCaseId: string
  env: string
  result: 'PASS' | 'FAIL'
  summary?: string
  runBy?: string
}): Promise<string> {
  const res = await invokeLambda('p2t-testcase-writer', { action: 'save_run_record', ...params }) as { id: string }
  return res.id
}

export async function listTestCases(env: string): Promise<TestCase[]> {
  return invokeLambda('p2t-testcase-reader', { action: 'list_test_cases', env }) as Promise<TestCase[]>
}

export async function listRunRecords(env: string): Promise<RunRecord[]> {
  return invokeLambda('p2t-testcase-reader', { action: 'list_run_records', env }) as Promise<RunRecord[]>
}

export async function getTestCase(id: string): Promise<TestCase & { steps: object[]; planSteps: object[] }> {
  return invokeLambda('p2t-testcase-reader', { action: 'get_test_case', id }) as Promise<TestCase & { steps: object[]; planSteps: object[] }>
}

export async function updateTestCasePlanSteps(id: string, planSteps: object[]): Promise<void> {
  await invokeLambda('p2t-testcase-writer', { action: 'update_test_case', id, planSteps })
}

export async function updateTestCaseService(id: string, service: string): Promise<void> {
  await invokeLambda('p2t-testcase-writer', { action: 'update_test_case', id, service })
}

export async function updateTestCaseSteps(id: string, steps: object[]): Promise<void> {
  await invokeLambda('p2t-testcase-writer', { action: 'update_test_case', id, steps })
}

export async function deleteTestCase(id: string): Promise<void> {
  await invokeLambda('p2t-testcase-writer', { action: 'delete_test_case', id })
}

export async function searchTestCases(query: string, env: string, threshold = 0.75): Promise<(TestCase & { similarity: number })[]> {
  return invokeLambda('p2t-testcase-reader', { action: 'search', query, env, threshold }) as Promise<(TestCase & { similarity: number })[]>
}
