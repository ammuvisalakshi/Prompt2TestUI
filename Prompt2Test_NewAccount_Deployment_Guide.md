# Prompt2Test — New AWS Account Deployment Guide

This guide walks you through deploying the complete Prompt2Test stack
(Frontend + AI Agent + Browser Automation Server) into a fresh AWS account from scratch.

---

## Prerequisites

### Tools Required (on your local machine)
| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20+ | https://nodejs.org |
| Python | 3.12+ | https://python.org |
| Docker | latest | https://docker.com |
| AWS CLI v2 | latest | https://aws.amazon.com/cli |
| AWS CDK v2 | latest | `npm install -g aws-cdk` |
| Git | latest | https://git-scm.com |

### AWS Account Requirements
- IAM user or role with **AdministratorAccess** (or equivalent) for initial setup
- AWS CLI configured for the new account:
  ```bash
  aws configure --profile new-account
  # Enter: Access Key ID, Secret Access Key, Region (us-east-1), Output (json)
  ```
- Verify access:
  ```bash
  aws sts get-caller-identity --profile new-account
  ```

### Source Code
All three repos must be pushed to GitHub under your GitHub account/org:
- `Prompt2TestUI`
- `Prompt2TestAgent`
- `Prompt2TestPlaywrightMCP`

---

## Step 1 — Enable Amazon Bedrock Model Access

> ⚠️ **Do this first.** Model access approval can take minutes to hours. Starting it early avoids delays later.

1. Go to **AWS Console → Amazon Bedrock → Model access** (us-east-1)
2. Click **Manage model access**
3. Enable the following models:
   - **Anthropic Claude claude-sonnet-4-5** (cross-region inference profile)
   - **Anthropic Claude 3 Sonnet** (fallback)
4. Click **Save changes**
5. Wait until status shows **Access granted** before proceeding to Step 5

---

## Step 2 — Bootstrap CDK

CDK bootstrap creates the S3 bucket and IAM roles CDK needs to deploy stacks.
Run once per account/region:

```bash
cdk bootstrap aws://NEW_ACCOUNT_ID/us-east-1 --profile new-account
```

Replace `NEW_ACCOUNT_ID` with your 12-digit AWS account ID.

Expected output: `✅ Environment aws://NEW_ACCOUNT_ID/us-east-1 bootstrapped`

---

## Step 3 — Create GitHub → AWS Connection (CodeStar)

Both CI/CD pipelines (Agent + PlaywrightMCP) pull source code from GitHub.
This connection must exist in the new account before deploying the CDK stacks.

1. Go to **AWS Console → CodePipeline → Settings → Connections**
2. Click **Create connection**
3. Select **GitHub** as the provider
4. Name it: `prompt2test-github` (or any name — update CDK stacks to match)
5. Click **Connect to GitHub** → authorize the GitHub App
6. Select the repositories: `Prompt2TestAgent` and `Prompt2TestPlaywrightMCP`
7. Click **Connect**
8. Copy the **Connection ARN** — you will need it in the next step

### Update CDK Stacks with the New Connection ARN

Open each CDK stack and replace the existing connection ARN:

**`Prompt2TestAgent/infra/lib/prompt2test-agent-stack.ts`**
Search for `codestarNotificationsArn` or `connectionArn` and replace with the new ARN.

**`Prompt2TestPlaywrightMCP/infra/lib/playwright-mcp-stack.ts`**
Same — replace the connection ARN.

Commit and push both changes to GitHub before deploying.

---

## Step 4 — Deploy Playwright MCP Stack (ECS + ALB)

This stack creates:
- VPC (2 AZs, public + private subnets)
- ECR repository: `prompt2test-playwright-mcp`
- ECS Cluster: `prompt2test-playwright-cluster`
- Fargate task definition (ARM64, 2 vCPU / 4 GB)
- Application Load Balancer with listeners on ports 3000, 6080, 8080
- CodePipeline: GitHub → CodeBuild → ECR → ECS rolling deploy

```bash
cd Prompt2TestPlaywrightMCP/infra
npm install
cdk deploy --profile new-account
```

### Wait for Pipeline to Complete

After `cdk deploy` finishes, the CodePipeline will automatically start:

1. **Source** — pulls code from GitHub
2. **Build** — CodeBuild builds the Docker image and pushes to ECR
3. **Deploy** — ECS rolling update deploys the new task

Monitor at: **AWS Console → CodePipeline → prompt2test-playwright-mcp-pipeline**

Wait until pipeline shows ✅ **Succeeded** before continuing.

### Note the ALB DNS Name

From the CDK output or AWS Console → EC2 → Load Balancers:
```
prompt2test-playwright-mcp-XXXXXXXXXX.us-east-1.elb.amazonaws.com
```
Save this — you'll need it in Steps 5 and 7.

### Verify the ECS Task is Running

```bash
aws ecs list-tasks \
  --cluster prompt2test-playwright-cluster \
  --region us-east-1 \
  --profile new-account
```

Should return at least one task ARN. Also verify the ALB target group health:
```bash
aws elbv2 describe-target-health \
  --target-group-arn <TARGET_GROUP_ARN> \
  --region us-east-1 \
  --profile new-account
```
Health check (port 8080) should show `healthy`.

---

## Step 5 — Deploy Agent Stack (ECR + IAM + CodePipeline)

This stack creates:
- ECR repository: `prompt2test-agent`
- IAM role for AgentCore: `prompt2test-agentcore-role`
- CodePipeline: GitHub → CodeBuild → ECR push

```bash
cd Prompt2TestAgent/infra
npm install
cdk deploy --profile new-account
```

### Wait for Pipeline to Complete

Monitor at: **AWS Console → CodePipeline → prompt2test-agent-pipeline**

Wait until pipeline shows ✅ **Succeeded** — the agent image must be in ECR before Step 6.

### Note the IAM Role ARN

From CDK output, note the AgentCore role ARN:
```
arn:aws:iam::NEW_ACCOUNT_ID:role/prompt2test-agentcore-role
```

---

## Step 6 — Create AgentCore Runtime (One-Time CLI Command)

> ⚠️ AWS CDK does not yet support Amazon Bedrock AgentCore. This step must be done manually via CLI.

### Verify Bedrock Model Access (from Step 1)

Before running this, confirm model access is granted:
```bash
aws bedrock list-foundation-models \
  --region us-east-1 \
  --profile new-account \
  --query "modelSummaries[?modelId=='anthropic.claude-sonnet-4-5-20250929-v1:0']"
```

### Create the Runtime

On **Windows (PowerShell)**, use JSON files to avoid quoting issues:

```powershell
# network.json
'{"networkMode":"PUBLIC"}' | Out-File -FilePath network.json -Encoding utf8

# artifact.json — replace NEW_ACCOUNT_ID
'{"containerConfiguration":{"containerUri":"NEW_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/prompt2test-agent:latest"}}' | Out-File -FilePath artifact.json -Encoding utf8

# env-vars.json — replace ALB_DNS with your ALB DNS from Step 4
'{"BEDROCK_MODEL_ID":"us.anthropic.claude-sonnet-4-5-20250929-v1:0","PLAYWRIGHT_MCP_ENDPOINT":"http://ALB_DNS:3000","AWS_REGION":"us-east-1"}' | Out-File -FilePath env-vars.json -Encoding utf8

# Create the runtime
& 'C:\Program Files\Amazon\AWSCLIV2\aws.exe' bedrock-agentcore-control create-agent-runtime `
    --region us-east-1 `
    --agent-runtime-name Prompt2TestAgent `
    --role-arn 'arn:aws:iam::NEW_ACCOUNT_ID:role/prompt2test-agentcore-role' `
    --network-configuration file://network.json `
    --agent-runtime-artifact file://artifact.json `
    --environment-variables file://env-vars.json
```

On **Mac/Linux (bash)**:
```bash
aws bedrock-agentcore-control create-agent-runtime \
  --region us-east-1 \
  --profile new-account \
  --agent-runtime-name Prompt2TestAgent \
  --role-arn arn:aws:iam::NEW_ACCOUNT_ID:role/prompt2test-agentcore-role \
  --network-configuration '{"networkMode":"PUBLIC"}' \
  --agent-runtime-artifact '{"containerConfiguration":{"containerUri":"NEW_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/prompt2test-agent:latest"}}' \
  --environment-variables '{
    "BEDROCK_MODEL_ID": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "PLAYWRIGHT_MCP_ENDPOINT": "http://ALB_DNS:3000",
    "AWS_REGION": "us-east-1"
  }'
```

### Save the Runtime ARN

The response includes:
```json
{
  "agentRuntimeArn": "arn:aws:bedrock-agentcore:us-east-1:NEW_ACCOUNT_ID:runtime/Prompt2TestAgent-XXXXXXXXXX",
  "status": "CREATING"
}
```

Save the `agentRuntimeArn` — you'll need it in Step 7.

### Verify the Runtime is Ready

```bash
aws bedrock-agentcore-control get-agent-runtime \
  --agent-runtime-id Prompt2TestAgent-XXXXXXXXXX \
  --region us-east-1 \
  --profile new-account \
  --query 'status'
```

Wait until status is `READY` before testing.

---

## Step 7 — Deploy the Frontend (S3 + CloudFront)

### Option A — Using CDK (if UI infra stack exists)

```bash
cd Prompt2TestUI/infra
npm install
cdk deploy --profile new-account
```

Note the S3 bucket name and CloudFront distribution ID from output.

### Option B — Manual S3 + CloudFront setup

1. Create S3 bucket (block all public access — CloudFront will serve it)
2. Create CloudFront distribution pointing to the S3 bucket with OAC
3. Note the distribution domain name and ID

### Build and Upload the Frontend

Create the environment file:

```bash
cd Prompt2TestUI/web
```

Create `.env` (or `.env.production`):
```
VITE_AGENT_RUNTIME_ARN=arn:aws:bedrock-agentcore:us-east-1:NEW_ACCOUNT_ID:runtime/Prompt2TestAgent-XXXXXXXXXX
VITE_NOVNC_URL=http://ALB_DNS:6080
VITE_AWS_REGION=us-east-1
VITE_COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
VITE_COGNITO_CLIENT_ID=XXXXXXXXXXXXXXXXXXXXXXXXXX
```

> Note: If you are not using Cognito in the new account yet, you can leave the Cognito vars blank and set up auth later.

Build and deploy:
```bash
npm install
npm run build

# Upload to S3
aws s3 sync dist/ s3://YOUR_BUCKET_NAME/ --delete --profile new-account

# Invalidate CloudFront cache
aws cloudfront create-invalidation \
  --distribution-id YOUR_DISTRIBUTION_ID \
  --paths "/*" \
  --profile new-account
```

---

## Step 8 — Verify End-to-End

### 8.1 Test playwright-mcp directly
```bash
curl -H "Host: localhost:3000" http://ALB_DNS:3000/sse --max-time 5
# Expected: HTTP 200 with SSE stream headers
```

### 8.2 Test the agent (Plan mode)
```powershell
# Windows PowerShell
$body = '{"inputText":"Test that the Google homepage loads and has a search box","mode":"plan","sessionId":"test-001"}'
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
$b64 = [Convert]::ToBase64String($bytes)
$sessionId = [guid]::NewGuid().ToString()

& 'C:\Program Files\Amazon\AWSCLIV2\aws.exe' bedrock-agentcore invoke-agent-runtime `
    --agent-runtime-arn 'arn:aws:bedrock-agentcore:us-east-1:NEW_ACCOUNT_ID:runtime/Prompt2TestAgent-XXXXXXXXXX' `
    --runtime-session-id $sessionId `
    --qualifier 'DEFAULT' `
    --payload $b64 `
    --region us-east-1 `
    --content-type 'application/json' `
    --accept 'application/json' `
    'C:\Temp\agent-out.json'

Get-Content 'C:\Temp\agent-out.json' | ConvertFrom-Json | ConvertTo-Json -Depth 10
```

Expected: a JSON plan with `summary` and `steps` array.

### 8.3 Test the agent (Automate mode)
```powershell
$body = '{"inputText":"run","mode":"automate","plan":{"summary":"Test Google","steps":[{"stepNumber":1,"type":"navigate","action":"Go to Google","detail":"Navigate to https://www.google.com"}]},"sessionId":"test-001"}'
```

Expected: `{"passed": true, "steps": [...]}` with each step showing `"status": "passed"`.

### 8.4 Open the UI
Navigate to your CloudFront URL in a browser. You should see the Prompt2Test login page.

---

## What Changes Per Account — Quick Reference

| Item | Where to Change | Notes |
|------|----------------|-------|
| CodeStar connection ARN | Both CDK stacks | Create new connection in new account first |
| ECR URI (account ID prefix) | Auto — CDK uses `this.account` | No manual change needed |
| AgentCore role ARN | Step 6 CLI command | Output from CDK agent stack |
| `PLAYWRIGHT_MCP_ENDPOINT` | AgentCore runtime env var (Step 6) | New ALB DNS |
| `VITE_AGENT_RUNTIME_ARN` | Frontend `.env` (Step 7) | New runtime ARN |
| `VITE_NOVNC_URL` | Frontend `.env` (Step 7) | New ALB DNS + port 6080 |
| Cognito User Pool / Client ID | Frontend `.env` (Step 7) | If using auth |

## What Stays the Same (No Changes Needed)

- All application source code
- Docker image build process
- Bedrock model ID (as long as access is enabled)
- The `Host: localhost:3000` SSE fix in `agent_runner.py`
- CDK stack logic (only the connection ARN needs updating)
- ECS task definition structure

---

## Common Issues & Fixes

### "Model not found" or "Access denied" calling Bedrock
**Cause:** Bedrock model access not enabled in the new account.
**Fix:** Go to Bedrock console → Model access → enable Claude claude-sonnet-4-5.

### CodePipeline fails at Source stage
**Cause:** CodeStar connection ARN in CDK stack is from the old account.
**Fix:** Create a new GitHub connection in the new account, update the ARN in both CDK stacks, redeploy.

### AgentCore runtime stuck in `CREATING`
**Cause:** ECR image not yet present (agent pipeline hasn't finished), or IAM role missing permissions.
**Fix:** Wait for the agent pipeline to complete first. Check the role has `ecr:GetDownloadUrlForLayer`, `ecr:BatchGetImage`, and `bedrock:InvokeModel` permissions.

### "Execution failed" — client initialization failed (403)
**Cause:** The `Host` header fix in `agent_runner.py` is not deployed, or playwright-mcp is not running.
**Fix:** Check ECS task is running and healthy. Verify `curl -H "Host: localhost:3000" http://ALB_DNS:3000/sse` returns 200.

### ECS task keeps restarting
**Cause:** Chromium or playwright-mcp failing to start (often a memory issue or stale lock files).
**Fix:** Check CloudWatch logs at `/prompt2test/playwright-mcp`. The entrypoint.sh cleans stale lock files on startup — make sure the latest image is deployed.

### noVNC shows blank / can't connect
**Cause:** ALB security group not allowing port 6080, or ECS task not exposing port 6080.
**Fix:** Check ALB listener on port 6080 exists and target group maps to ECS port 6080. Check security group inbound rules.

### Frontend shows no data / agent calls fail
**Cause:** `VITE_AGENT_RUNTIME_ARN` or `VITE_NOVNC_URL` in `.env` still points to old account.
**Fix:** Update `.env`, rebuild (`npm run build`), re-sync to S3, invalidate CloudFront.

---

## Estimated Time

| Step | Estimated Time |
|------|---------------|
| Step 1 — Bedrock model access | 5–30 min (approval varies) |
| Step 2 — CDK bootstrap | 2 min |
| Step 3 — GitHub connection + CDK update | 10 min |
| Step 4 — PlaywrightMCP CDK deploy + pipeline | 15–20 min |
| Step 5 — Agent CDK deploy + pipeline | 10–15 min |
| Step 6 — Create AgentCore runtime | 5 min |
| Step 7 — Build + deploy frontend | 5–10 min |
| Step 8 — Verification | 10 min |
| **Total** | **~60–90 min** |

---

## Current Account Reference (us-east-1, account 590183962483)

Use this as a reference when setting up the new account:

| Resource | Current Value |
|---------|--------------|
| CloudFront URL | https://d1c90tgy4nfi4n.cloudfront.net |
| AgentCore ARN | arn:aws:bedrock-agentcore:us-east-1:590183962483:runtime/Prompt2TestAgent-YTVbD4GrTi |
| Playwright MCP ALB | prompt2test-playwright-mcp-1435391408.us-east-1.elb.amazonaws.com |
| Agent ECR | 590183962483.dkr.ecr.us-east-1.amazonaws.com/prompt2test-agent |
| MCP ECR | 590183962483.dkr.ecr.us-east-1.amazonaws.com/prompt2test-playwright-mcp |
| ECS Cluster | prompt2test-playwright-cluster |
| ECS Service | prompt2test-playwright-mcp-service |
| Agent Pipeline | prompt2test-agent-pipeline |
| MCP Pipeline | prompt2test-playwright-mcp-pipeline |
| Bedrock Model | us.anthropic.claude-sonnet-4-5-20250929-v1:0 |
