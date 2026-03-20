# Prompt2Test — Resume Guide

Use this guide when you want to bring the platform back up after it has been paused (stack destroyed).

---

## What Was Destroyed vs. What Still Exists

| Resource | Status | Notes |
|----------|--------|-------|
| ECS Cluster + Service + Tasks | ❌ Destroyed | Rebuilt by `cdk deploy` |
| ALB (Load Balancer) | ❌ Destroyed | New DNS name after redeploy |
| VPC, Subnets, Security Groups | ❌ Destroyed | Rebuilt by `cdk deploy` |
| CodePipeline + CodeBuild | ❌ Destroyed | Rebuilt by `cdk deploy` |
| ECR Repo (`prompt2test-playwright-mcp`) | ✅ Retained | Images still there, faster rebuild |
| AgentCore Runtime (`Prompt2TestAgent`) | ✅ Retained | Just needs endpoint URL updated |
| S3 + CloudFront (Frontend) | ✅ Retained | Frontend still live |
| ECR Repo (`prompt2test-agent`) | ✅ Retained | Agent image still there |

---

## Step-by-Step Resume Instructions

### Step 1 — Deploy the PlaywrightMCP Stack

```bash
cd C:\MyProjects\AWS\Prompt2TestPlaywrightMCP\infra
npm install
npx cdk deploy --region us-east-1
```

This takes ~5 minutes. CDK will create:
- A new VPC
- A new ECS Cluster, Service, and Task Definition
- A new ALB with a **new DNS name** (this is important — note it down)
- A new CodePipeline

When it finishes, look for the CDK output line like:
```
Prompt2TestPlaywrightMCPStack.ALBDNSName = prompt2test-playwright-mcp-XXXXXXXXXX.us-east-1.elb.amazonaws.com
```
**Copy this DNS name — you need it in the next step.**

---

### Step 2 — Trigger the Pipeline to Deploy the Docker Image

The pipeline will start automatically after `cdk deploy`. Wait for it to finish:

```powershell
# Check pipeline status (run every minute until it shows Succeeded)
& 'C:\Program Files\Amazon\AWSCLIV2\aws.exe' codepipeline get-pipeline-state `
    --name prompt2test-playwright-mcp-pipeline `
    --region us-east-1 `
    --query 'stageStates[].latestExecution.status' `
    --output text
```

Wait until all stages show `Succeeded`. This takes ~5 minutes.

---

### Step 3 — Update AgentCore Runtime with New ALB Endpoint

The AgentCore runtime still exists but its `PLAYWRIGHT_MCP_ENDPOINT` points to the old (deleted) ALB. Update it with the new DNS from Step 1.

Save to files first to avoid JSON quoting issues:

```powershell
# Create the JSON files
'{"networkMode":"PUBLIC"}' | Out-File -FilePath network.json -Encoding utf8
'{"containerConfiguration":{"containerUri":"590183962483.dkr.ecr.us-east-1.amazonaws.com/prompt2test-agent:latest"}}' | Out-File -FilePath artifact.json -Encoding utf8

# Update the runtime (replace ALB_DNS_FROM_STEP_1 with actual value)
& 'C:\Program Files\Amazon\AWSCLIV2\aws.exe' bedrock-agentcore-control update-agent-runtime `
    --agent-runtime-id Prompt2TestAgent-YTVbD4GrTi `
    --region us-east-1 `
    --role-arn arn:aws:iam::590183962483:role/prompt2test-agentcore-role `
    --network-configuration file://network.json `
    --agent-runtime-artifact file://artifact.json `
    --environment-variables '{\"BEDROCK_MODEL_ID\":\"us.anthropic.claude-sonnet-4-5-20250929-v1:0\",\"PLAYWRIGHT_MCP_ENDPOINT\":\"http://ALB_DNS_FROM_STEP_1:3000\",\"AWS_REGION\":\"us-east-1\"}'
```

---

### Step 4 — Update the Frontend noVNC URL

The noVNC live browser view URL also needs to point to the new ALB. Update the frontend `.env`:

```bash
# Edit C:\MyProjects\AWS\Prompt2TestUI\web\.env (or .env.production)
VITE_NOVNC_URL=http://ALB_DNS_FROM_STEP_1:6080
```

Then rebuild and redeploy the frontend:

```bash
cd C:\MyProjects\AWS\Prompt2TestUI\web
npm run build
& 'C:\Program Files\Amazon\AWSCLIV2\aws.exe' s3 sync dist/ s3://YOUR_S3_BUCKET_NAME/ --delete --region us-east-1
```

Then invalidate the CloudFront cache:
```powershell
& 'C:\Program Files\Amazon\AWSCLIV2\aws.exe' cloudfront create-invalidation `
    --distribution-id YOUR_CLOUDFRONT_DISTRIBUTION_ID `
    --paths "/*" `
    --region us-east-1
```

---

### Step 5 — Test the Full Stack

Run the quick test to confirm the agent can connect to playwright-mcp:

```powershell
powershell.exe -ExecutionPolicy Bypass -File 'C:\MyProjects\AWS\test-agent4.ps1'
```

Expected response:
```json
{"sessionId":"test-123","mode":"automate","result":{"passed":true,...}}
```

If it returns `"passed": true` — the stack is fully up. Open the frontend and run a test!

---

## Quick Reference — Key Resource IDs

| Resource | ID / Value |
|----------|-----------|
| AWS Account | `590183962483` |
| Region | `us-east-1` |
| AgentCore Runtime ID | `Prompt2TestAgent-YTVbD4GrTi` |
| AgentCore Role ARN | `arn:aws:iam::590183962483:role/prompt2test-agentcore-role` |
| ECR (playwright-mcp) | `590183962483.dkr.ecr.us-east-1.amazonaws.com/prompt2test-playwright-mcp` |
| ECR (agent) | `590183962483.dkr.ecr.us-east-1.amazonaws.com/prompt2test-agent` |
| CloudFront URL | `https://d1c90tgy4nfi4n.cloudfront.net` |
| GitHub Repo (playwright-mcp) | `https://github.com/ammuvisalakshi/Prompt2TestPlaywrightMCP` |
| GitHub Repo (agent) | `https://github.com/ammuvisalakshi/Prompt2TestAgent` |
| GitHub Repo (UI) | `https://github.com/ammuvisalakshi/Prompt2TestUI` |

---

## What Changes Each Time You Redeploy

| Thing that changes | Where to update |
|-------------------|----------------|
| ALB DNS name | AgentCore env var (`PLAYWRIGHT_MCP_ENDPOINT`) + frontend `VITE_NOVNC_URL` |

Everything else (code, ECR images, AgentCore runtime ID, CloudFront URL) stays the same.

---

## Estimated Resume Time

| Step | Time |
|------|------|
| `cdk deploy` | ~5 min |
| Pipeline builds + deploys ECS | ~5 min |
| Update AgentCore endpoint | ~1 min |
| Frontend redeploy (if needed) | ~2 min |
| **Total** | **~13 minutes** |
