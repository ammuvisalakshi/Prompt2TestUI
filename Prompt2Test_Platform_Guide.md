# Prompt2Test – Platform Guide

## 1. What Is Prompt2Test

An AI-powered test automation platform. QA engineers describe tests in plain English → AI generates a structured test plan → executes it in a real browser → shows live browser video.

---

## 2. High-Level Architecture

Three independently deployable components:

| Component | Technology | Hosting |
|-----------|-----------|---------|
| **Prompt2TestUI** | React 18 frontend | S3 + CloudFront |
| **Prompt2TestAgent** | Python AI agent | Amazon Bedrock AgentCore |
| **Prompt2TestPlaywrightMCP** | Browser automation server | ECS Fargate + ALB |

---

## 3. Component Details

### 3.1 Prompt2TestUI (Frontend)

- React 18 + TypeScript + Vite + Tailwind CSS
- Hosted on S3, served via CloudFront
- Auth: Amazon Cognito
- Pages: Login, Agent (Plan + Automate tabs), Inventory, Config, Architecture, Concepts, Members
- Calls AgentCore via AWS SDK `BedrockAgentCoreClient.InvokeAgentRuntimeCommand`
- Shows live browser via noVNC iframe (ALB port 6080)

**Key environment variables:**

```
VITE_AGENT_RUNTIME_ARN=arn:aws:bedrock-agentcore:us-east-1:590183962483:runtime/Prompt2TestAgent-YTVbD4GrTi
VITE_NOVNC_URL=http://<alb-dns>:6080
VITE_AWS_REGION=us-east-1
VITE_COGNITO_USER_POOL_ID=...
VITE_COGNITO_CLIENT_ID=...
```

**Infrastructure (CDK):** S3 bucket, CloudFront distribution with OAC

---

### 3.2 Prompt2TestAgent (AI Agent)

- Python 3.12, AWS Strands SDK
- Runs on Amazon Bedrock AgentCore (managed container runtime)
- Two modes:
  - **Plan mode**: Receives plain-English prompt → uses Claude claude-sonnet-4-5 via Bedrock → returns structured JSON test plan
  - **Automate mode**: Receives approved JSON plan → connects to Playwright MCP server via SSE → executes each step in real browser
- Key fix: sends `Host: localhost:3000` header when connecting to playwright-mcp through ALB (playwright-mcp validates Host header for CSRF protection)

**Key files:**

- `agent/agent_runner.py` — `AgentRunner.plan()` and `AgentRunner.automate()`
- `agent/main.py` — AgentCore entrypoint
- `Dockerfile` — Python 3.12 image
- `buildspec.yml` — CodeBuild spec (build + push to ECR)

**AgentCore environment variables:**

```
BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0
PLAYWRIGHT_MCP_ENDPOINT=http://<alb-dns>:3000
AWS_REGION=us-east-1
```

**Infrastructure (CDK):**

- ECR repo: `prompt2test-agent`
- IAM role for AgentCore: Bedrock + ECR + Logs permissions
- CodePipeline: GitHub → CodeBuild → ECR push

**AgentCore runtime created via CLI** (CDK doesn't support it yet):

```bash
aws bedrock-agentcore-control create-agent-runtime \
  --agent-runtime-name Prompt2TestAgent \
  --role-arn <agentcore-role-arn> \
  --network-configuration '{"networkMode":"PUBLIC"}' \
  --agent-runtime-artifact '{"containerConfiguration":{"containerUri":"<account>.dkr.ecr.us-east-1.amazonaws.com/prompt2test-agent:latest"}}' \
  --environment-variables '{
    "BEDROCK_MODEL_ID": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "PLAYWRIGHT_MCP_ENDPOINT": "http://<alb-dns>:3000",
    "AWS_REGION": "us-east-1"
  }'
```

---

### 3.3 Prompt2TestPlaywrightMCP (Browser Server)

- Docker container on ECS Fargate (ARM64/Graviton, 2 vCPU / 4 GB)
- Three processes inside the container:
  1. **Playwright MCP server** (port 3000) — MCP protocol over SSE, provides browser control tools to the agent
  2. **Xvfb + x11vnc + noVNC** (port 6080) — virtual display with VNC, web-accessible live browser view
  3. **Health check server** (port 8080) — simple HTTP server for ALB health checks

**Port summary:**

| Port | Purpose | Consumer |
|------|---------|---------|
| 3000 | Playwright MCP SSE endpoint | AgentCore agent |
| 6080 | noVNC web UI (live browser view) | React UI iframe |
| 8080 | ALB health checks | ALB target group |

Key fix: playwright-mcp runs with `--host 0.0.0.0 --allowed-origins "*"` bound directly (no reverse proxy). Previously a Node.js proxy was causing "socket hang up" errors.

**Infrastructure (CDK):**

- VPC (2 AZs)
- ECR repo: `prompt2test-playwright-mcp`
- ECS Cluster + Fargate task definition
- ALB with listener rules for ports 3000, 6080
- ALB target group health check on port 8080
- ECS Service (1 task, `BROWSER_MODE=headed`)
- CodePipeline: GitHub → CodeBuild → ECR push → ECS deploy

---

## 4. End-to-End Data Flow

```
1. USER AUTHENTICATION
   Browser → Cognito → JWT token

2. PLAN MODE
   Browser → CloudFront → S3 (React app)
   React UI → BedrockAgentCoreClient.InvokeAgentRuntime()
   AgentCore pulls prompt2test-agent:latest from ECR
   Agent → Bedrock (Claude claude-sonnet-4-5) → generates JSON test plan
   JSON plan streamed back → displayed in Plan tab

3. AUTOMATE MODE
   User clicks "Run" → React sends plan back to AgentCore
   Agent → ALB:3000/sse (Host: localhost:3000 header) → playwright-mcp
   playwright-mcp → controls Chromium in headed mode
   Chromium → Xvfb virtual display
   x11vnc captures display → noVNC websockify on port 6080
   React UI embeds noVNC iframe via ALB:6080 (live browser view)
   Agent streams step results back → displayed in Automate tab

4. CI/CD (on every git push)
   GitHub push → CodePipeline trigger
   CodeBuild builds Docker image → pushes to ECR
   For playwright-mcp: ECS rolling deployment (new task replaces old)
   For agent: AgentCore pulls new image on next session start
```

---

## 5. Repository Structure

```
Prompt2TestUI/
├── web/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── AgentPage.tsx       ← main working page (plan + automate)
│   │   │   ├── LoginPage.tsx
│   │   │   ├── InventoryPage.tsx
│   │   │   ├── ConfigPage.tsx
│   │   │   └── ...
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── package.json
│   └── vite.config.ts
└── (infra CDK stack for S3 + CloudFront)

Prompt2TestAgent/
├── agent/
│   ├── agent_runner.py             ← Plan + Automate logic
│   ├── main.py                     ← AgentCore entrypoint
│   └── config/agent_config.yaml
├── infra/
│   └── lib/prompt2test-agent-stack.ts  ← CDK: ECR + IAM + CodePipeline
├── Dockerfile
├── buildspec.yml
└── requirements.txt

Prompt2TestPlaywrightMCP/
├── entrypoint.sh                   ← starts playwright-mcp + noVNC + health server
├── Dockerfile
├── package.json
└── infra/
    └── lib/playwright-mcp-stack.ts ← CDK: VPC + ECS + ALB + CodePipeline
```

---

## 6. Deployment Steps (from scratch)

### Prerequisites

- AWS account with CLI configured
- GitHub repos for each project, CodeStar connection created in AWS
- Node.js 20+, Python 3.12+, Docker
- AWS CDK v2: `npm install -g aws-cdk`
- CDK bootstrap: `cdk bootstrap aws://ACCOUNT/us-east-1`

### Step 1 — Deploy Playwright MCP (ECS + ALB)

```bash
cd Prompt2TestPlaywrightMCP/infra
npm install
cdk deploy
```

- Creates: VPC, ECR, ECS Cluster, ALB, CodePipeline
- Pipeline auto-builds and deploys the Docker image
- Note the ALB DNS name from output (needed for Step 2 + 4)

### Step 2 — Deploy Agent (ECR + IAM + Pipeline)

```bash
cd Prompt2TestAgent/infra
npm install
cdk deploy
```

- Creates: ECR repo, IAM role for AgentCore, CodePipeline
- Pipeline builds and pushes agent image to ECR
- Note the IAM role ARN and ECR URI from output

### Step 3 — Create AgentCore Runtime (one-time CLI)

```bash
# Save JSON files to avoid PowerShell quoting issues
echo '{"networkMode":"PUBLIC"}' > /tmp/network.json
echo '{"containerConfiguration":{"containerUri":"ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/prompt2test-agent:latest"}}' > /tmp/artifact.json

aws bedrock-agentcore-control create-agent-runtime \
  --region us-east-1 \
  --agent-runtime-name Prompt2TestAgent \
  --role-arn arn:aws:iam::ACCOUNT:role/prompt2test-agentcore-role \
  --network-configuration file:///tmp/network.json \
  --agent-runtime-artifact file:///tmp/artifact.json \
  --environment-variables '{
    "BEDROCK_MODEL_ID":"us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "PLAYWRIGHT_MCP_ENDPOINT":"http://ALB_DNS:3000",
    "AWS_REGION":"us-east-1"
  }'
```

Note the returned `agentRuntimeArn`.

### Step 4 — Deploy Frontend (S3 + CloudFront)

```bash
cd Prompt2TestUI/web
cp .env.example .env
# Edit .env:
#   VITE_AGENT_RUNTIME_ARN=<arn from step 3>
#   VITE_NOVNC_URL=http://<alb-dns>:6080
#   VITE_COGNITO_USER_POOL_ID=...
#   VITE_COGNITO_CLIENT_ID=...

npm install
npm run build

# Upload to S3 (get bucket name from CDK output)
aws s3 sync dist/ s3://BUCKET_NAME/ --delete
aws cloudfront create-invalidation --distribution-id DIST_ID --paths "/*"
```

---

## 7. Current Live Resources (us-east-1, account 590183962483)

| Resource | Value |
|---------|-------|
| CloudFront | d1c90tgy4nfi4n.cloudfront.net |
| AgentCore ARN | arn:aws:bedrock-agentcore:us-east-1:590183962483:runtime/Prompt2TestAgent-YTVbD4GrTi |
| Playwright MCP ALB | prompt2test-playwright-mcp-1435391408.us-east-1.elb.amazonaws.com |
| Agent ECR | 590183962483.dkr.ecr.us-east-1.amazonaws.com/prompt2test-agent |
| MCP ECR | 590183962483.dkr.ecr.us-east-1.amazonaws.com/prompt2test-playwright-mcp |
| ECS Cluster | prompt2test-playwright-cluster |
| Agent Pipeline | prompt2test-agent-pipeline |
| MCP Pipeline | prompt2test-playwright-mcp-pipeline |

---

## 8. Key Technical Decisions & Gotchas

### playwright-mcp Host Header Validation

playwright-mcp (via `@modelcontextprotocol/sdk`) validates that the HTTP `Host` header is `localhost` for CSRF protection. When the agent connects through the ALB, the ALB sends its own hostname. **Fix:** the agent explicitly sets `Host: localhost:3000` in the SSE client call in `agent_runner.py`.

### ALB Health Check on Port 8080

The ALB target group uses port 8080 (health server) for health checks, NOT port 3000 (MCP). This is intentional — it keeps health checks lightweight. But it means the target can show "healthy" even if the MCP server on 3000 is broken.

### No Reverse Proxy

An earlier design used a Node.js reverse proxy on port 3000 → playwright-mcp on 3001. This caused "socket hang up" errors because playwright-mcp rejected connections from the proxy. The proxy was removed — playwright-mcp now binds directly to `0.0.0.0:3000`.

### AgentCore Image Updates

AgentCore pulls the `:latest` image when a new session starts. After a pipeline deployment, new sessions automatically get the new code. No manual runtime update needed.

### Windows PowerShell + AWS CLI JSON

AWS CLI on Windows/PowerShell strips double quotes from inline JSON strings. Use `file://` references to JSON files instead of inline JSON for complex parameters.
