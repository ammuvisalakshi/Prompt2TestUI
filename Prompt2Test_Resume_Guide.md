# Prompt2Test — Resume Guide

Use this guide when you want to bring the platform back up after it has been paused (stack destroyed).

---

## What Was Destroyed vs. What Still Exists

| Resource | Status | Notes |
|----------|--------|-------|
| ECS Cluster + Service + Tasks | ❌ Destroyed | Rebuilt by `cdk deploy` |
| ALB (Load Balancer) | ❌ Destroyed | **New DNS name after redeploy** |
| VPC, Subnets, Security Groups | ❌ Destroyed | Rebuilt by `cdk deploy` |
| CodePipeline + CodeBuild | ❌ Destroyed | Rebuilt by `cdk deploy` |
| ECR Repo (`prompt2test-playwright-mcp`) | ✅ Retained | Images still there, faster rebuild |
| AgentCore Runtime (`Prompt2TestAgent`) | ✅ Retained | Just needs endpoint URL updated |
| CloudFront noVNC (`d1c90tgy4nfi4n.cloudfront.net`) | ✅ Retained | Just needs origin updated to new ALB |
| Amplify Frontend (`master.dzjt4ryqd68ry.amplifyapp.com`) | ✅ Retained | No changes needed |
| ECR Repo (`prompt2test-agent`) | ✅ Retained | Agent image still there |

---

## Step-by-Step Resume Instructions

### Step 1 — Deploy the PlaywrightMCP Stack

```bash
cd C:\MyProjects\AWS\Prompt2TestPlaywrightMCP\infra
npm install
npx cdk deploy --require-approval never --region us-east-1
```

This takes ~5 minutes. CDK will create a new VPC, ECS Cluster, Service, ALB, and CodePipeline.

When it finishes, look for the CDK output — note the new ALB DNS name:
```
Prompt2TestPlaywrightMCPStack.PlaywrightMCPEndpoint = http://prompt2test-playwright-mcp-XXXXXXXXXX.us-east-1.elb.amazonaws.com:3000
```
**Copy the ALB DNS (without the port) — you need it in Steps 2, 3, and 4.**

---

### Step 2 — Wait for the Pipeline

The pipeline starts automatically after `cdk deploy`. Check status:

```powershell
& 'C:\Program Files\Amazon\AWSCLIV2\aws.exe' codepipeline get-pipeline-state `
    --name prompt2test-playwright-mcp-pipeline `
    --region us-east-1 `
    --query 'stageStates[].{Stage:stageName,Status:latestExecution.status}' `
    --output table
```

Wait until all stages show `Succeeded` (~5 min). If the pipeline doesn't start automatically, trigger it manually:

```powershell
& 'C:\Program Files\Amazon\AWSCLIV2\aws.exe' codepipeline start-pipeline-execution `
    --name prompt2test-playwright-mcp-pipeline --region us-east-1
```

---

### Step 3 — Update AgentCore Runtime with New ALB Endpoint

```powershell
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText('C:\MyProjects\AWS\network.json',  '{"networkMode":"PUBLIC"}', $utf8NoBom)
[System.IO.File]::WriteAllText('C:\MyProjects\AWS\artifact.json', '{"containerConfiguration":{"containerUri":"590183962483.dkr.ecr.us-east-1.amazonaws.com/prompt2test-agent:latest"}}', $utf8NoBom)
[System.IO.File]::WriteAllText('C:\MyProjects\AWS\envvars.json',  '{"BEDROCK_MODEL_ID":"us.anthropic.claude-sonnet-4-5-20250929-v1:0","PLAYWRIGHT_MCP_ENDPOINT":"http://ALB_DNS_FROM_STEP_1:3000","AWS_REGION":"us-east-1"}', $utf8NoBom)

& 'C:\Program Files\Amazon\AWSCLIV2\aws.exe' bedrock-agentcore-control update-agent-runtime `
    --agent-runtime-id Prompt2TestAgent-YTVbD4GrTi `
    --region us-east-1 `
    --role-arn 'arn:aws:iam::590183962483:role/prompt2test-agentcore-role' `
    --network-configuration  'file://C:\MyProjects\AWS\network.json' `
    --agent-runtime-artifact 'file://C:\MyProjects\AWS\artifact.json' `
    --environment-variables  'file://C:\MyProjects\AWS\envvars.json' `
    --query '{status:status,version:agentRuntimeVersion}'
```

Wait for status to return `READY`.

---

### Step 4 — Update CloudFront noVNC Distribution to New ALB

The CloudFront distribution `d1c90tgy4nfi4n.cloudfront.net` (ID: `E89UU6XNKAJJA`) routes noVNC traffic to the ALB on port 6080. Update its origin to the new ALB:

```powershell
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

# Get current config and ETag
$etag = & 'C:\Program Files\Amazon\AWSCLIV2\aws.exe' cloudfront get-distribution-config `
    --id E89UU6XNKAJJA --region us-east-1 --query 'ETag' --output text
$cfg = & 'C:\Program Files\Amazon\AWSCLIV2\aws.exe' cloudfront get-distribution-config `
    --id E89UU6XNKAJJA --region us-east-1 --query 'DistributionConfig' | ConvertFrom-Json

# Update origin to new ALB DNS
$cfg.Origins.Items[0].DomainName = 'ALB_DNS_FROM_STEP_1'
$cfgJson = $cfg | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText('C:\MyProjects\AWS\cf_novnc_updated.json', $cfgJson, $utf8NoBom)

& 'C:\Program Files\Amazon\AWSCLIV2\aws.exe' cloudfront update-distribution `
    --id E89UU6XNKAJJA `
    --distribution-config 'file://C:\MyProjects\AWS\cf_novnc_updated.json' `
    --if-match $etag --region us-east-1 `
    --query 'Distribution.{Status:Status}'
```

Wait for CloudFront to show `Deployed` (~5 min):
```powershell
& 'C:\Program Files\Amazon\AWSCLIV2\aws.exe' cloudfront get-distribution `
    --id E89UU6XNKAJJA --region us-east-1 --query 'Distribution.Status' --output text
```

> **Note:** The Amplify frontend and its `VITE_NOVNC_URL` do NOT need updating — they always point to `https://d1c90tgy4nfi4n.cloudfront.net` which stays the same.

---

### Step 5 — Test the Full Stack

```powershell
powershell.exe -ExecutionPolicy Bypass -File 'C:\MyProjects\AWS\test-agent4.ps1'
```

Expected response includes `"mode":"plan"` and a plan object — confirms agent + playwright-mcp are connected.

Then open `https://master.dzjt4ryqd68ry.amplifyapp.com/agent`, type a prompt, generate a plan, and say **run** — the noVNC panel should connect and show the live browser.

---

## Quick Reference — Key Resource IDs

| Resource | ID / Value |
|----------|-----------|
| AWS Account | `590183962483` |
| Region | `us-east-1` |
| AgentCore Runtime ID | `Prompt2TestAgent-YTVbD4GrTi` |
| AgentCore Role ARN | `arn:aws:iam::590183962483:role/prompt2test-agentcore-role` |
| CloudFront noVNC Distribution ID | `E89UU6XNKAJJA` |
| CloudFront noVNC URL | `https://d1c90tgy4nfi4n.cloudfront.net` |
| Amplify Frontend URL | `https://master.dzjt4ryqd68ry.amplifyapp.com` |
| ECR (playwright-mcp) | `590183962483.dkr.ecr.us-east-1.amazonaws.com/prompt2test-playwright-mcp` |
| ECR (agent) | `590183962483.dkr.ecr.us-east-1.amazonaws.com/prompt2test-agent` |
| GitHub Repo (playwright-mcp) | `https://github.com/ammuvisalakshi/Prompt2TestPlaywrightMCP` |
| GitHub Repo (agent) | `https://github.com/ammuvisalakshi/Prompt2TestAgent` |
| GitHub Repo (UI) | `https://github.com/ammuvisalakshi/Prompt2TestUI` |

---

## What Changes Each Time You Redeploy

| Thing that changes | Where to update |
|-------------------|----------------|
| ALB DNS name | AgentCore `PLAYWRIGHT_MCP_ENDPOINT` (Step 3) + CloudFront noVNC origin (Step 4) |

Everything else stays the same — Amplify URL, CloudFront URL, AgentCore runtime ID, ECR images.

---

## Estimated Resume Time

| Step | Time |
|------|------|
| `cdk deploy` | ~5 min |
| Pipeline builds + deploys ECS | ~5 min |
| Update AgentCore endpoint | ~1 min |
| Update CloudFront noVNC origin | ~5 min (propagation) |
| **Total** | **~16 minutes** |
