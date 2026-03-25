#!/usr/bin/env node
import 'source-map-support/register'
import * as cdk from 'aws-cdk-lib'
import { Prompt2TestStack } from '../lib/prompt2test-stack'

const app = new cdk.App()

const githubOwner        = app.node.tryGetContext('githubOwner')        as string
const githubConnectionArn = app.node.tryGetContext('githubConnectionArn') as string

if (!githubOwner || githubOwner === 'YOUR_GITHUB_USERNAME') {
  throw new Error('Set githubOwner in cdk.json context or pass -c githubOwner=<your-github-username>')
}
if (!githubConnectionArn || githubConnectionArn.includes('YOUR_')) {
  throw new Error('Set githubConnectionArn in cdk.json context. Create a CodeStar GitHub connection first: https://console.aws.amazon.com/codesuite/settings/connections')
}

new Prompt2TestStack(app, 'Prompt2TestStack', {
  githubOwner,
  githubConnectionArn,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region:  process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Prompt2Test — Complete infrastructure (Cognito, Aurora, Lambda, ECS, AgentCore, Amplify)',
})
