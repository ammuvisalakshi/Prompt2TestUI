# Prompt2Test — CDK Infrastructure

Single CDK stack that deploys the entire TestPilot AI platform to any AWS account.

## What this deploys

| # | Resource | Service |
|---|---|---|
| 1 | VPC (2 AZs, public + isolated subnets) | EC2 |
| 2 | User Pool + Identity Pool | Cognito |
| 3 | Aurora Serverless v2 PostgreSQL + pgvector (auto-pause) | RDS |
| 4 | Secrets Manager secret (Aurora credentials) | Secrets Manager |
| 5 | DB schema init (pgvector, test_cases, run_records tables) | Lambda custom resource |
| 6 | `p2t-testcase-writer` Lambda | Lambda |
| 7 | `p2t-testcase-reader` Lambda | Lambda |
| 8 | ECR repos: `prompt2test-agent` + `prompt2test-playwright-mcp` | ECR |
| 9 | ECS Fargate cluster + task definition (ARM64, 2vCPU/4GB) | ECS |
| 10 | SSM parameters (ECS config for AgentCore) | SSM |
| 11 | CodePipeline: GitHub → ECR (Agent) | CodePipeline |
| 12 | CodePipeline: GitHub → ECR (Playwright MCP) | CodePipeline |
| 13 | AgentCore IAM role | IAM |
| 14 | Cognito auth role (browser SDK permissions) | IAM |
| 15 | Amplify app (React UI, auto-deploy) | Amplify |

**One manual step remaining after deploy:** Create the Bedrock AgentCore runtime (no CloudFormation support yet).

---

## Prerequisites

```bash
# Install CDK globally
npm install -g aws-cdk

# Configure AWS credentials for the target account
aws configure

# Bootstrap CDK in the account/region (one-time per account)
cdk bootstrap aws://ACCOUNT_ID/us-east-1
```

---

## Step 1 — Create a GitHub CodeStar Connection

This is required for CodePipeline to pull from your GitHub repos.

1. Go to **AWS Console → Developer Tools → Settings → Connections**
2. Click **Create connection** → select **GitHub**
3. Authorize and complete the OAuth flow
4. Copy the **Connection ARN** — you'll need it in the next step

---

## Step 2 — Configure cdk.json

Edit `cdk.json` and replace the placeholder values:

```json
{
  "context": {
    "githubOwner": "your-github-username",
    "githubConnectionArn": "arn:aws:codestar-connections:us-east-1:ACCOUNT:connection/XXXXXXXX"
  }
}
```

Or pass them at deploy time:
```bash
cdk deploy -c githubOwner=myuser -c githubConnectionArn=arn:aws:...
```

---

## Step 3 — Deploy the Stack

```bash
cd infrastructure
npm install
cdk deploy
```

Takes about **5–10 minutes**. When done, copy the **Outputs** — you'll need them in the next steps.

Example outputs:
```
Prompt2TestStack.OutUserPoolId        = us-east-1_XXXXXXXXX   → VITE_USER_POOL_ID
Prompt2TestStack.OutUserPoolClientId  = 1bvraf...              → VITE_USER_POOL_CLIENT_ID
Prompt2TestStack.OutIdentityPoolId    = us-east-1:xxxx-...     → VITE_IDENTITY_POOL_ID
Prompt2TestStack.OutRegion            = us-east-1              → VITE_AWS_REGION
Prompt2TestStack.OutAgentCoreRoleArn  = arn:aws:iam::...       → use in Step 5
Prompt2TestStack.OutAgentEcrUri       = ACCOUNT.dkr.ecr...     → use in Step 5
```

---

## Step 4 — Build & Push Docker Images

The CodePipelines are set up but need a first run.
Trigger them by pushing to GitHub, or run manually:

```bash
aws codepipeline start-pipeline-execution --name prompt2test-playwright-mcp
aws codepipeline start-pipeline-execution --name prompt2test-agent
```

Wait for both to show **Succeeded** (~5–10 min each).

---

## Step 5 — Create Bedrock AgentCore Runtime (Manual)

CloudFormation doesn't support AgentCore yet, so this is done via CLI:

```bash
# Enable Bedrock model access first (console):
# Bedrock → Model access → Enable:
#   - Claude Sonnet 4.5 (cross-region inference)
#   - Titan Embed Text v2

# Create the AgentCore runtime
aws bedrock-agentcore-control create-agent-runtime \
  --agent-runtime-name Prompt2TestAgent \
  --agent-runtime-artifact '{"containerConfiguration":{"image":"AGENT_ECR_URI:latest"}}' \
  --role-arn AGENT_CORE_ROLE_ARN \
  --network-configuration '{"networkMode":"PUBLIC"}'

# Copy the agentRuntimeArn from the response
```

Replace `AGENT_ECR_URI` and `AGENT_CORE_ROLE_ARN` with the values from Step 3 outputs.

---

## Step 6 — Connect Amplify to GitHub

The CDK creates the Amplify app but GitHub OAuth requires a manual step:

1. Go to **AWS Console → Amplify → Prompt2TestUI**
2. Click **Connect branch** → GitHub → authorize → select `master`
3. Set environment variable: `VITE_AGENT_RUNTIME_ARN = <arn from Step 5>`
4. Click **Save and deploy**

---

## Step 7 — Add SSM Service Config

Add your environment-specific service parameters so the service chip selector works:

```bash
aws ssm put-parameter \
  --name "/prompt2test/config/dev/services/MyService/URL" \
  --value "https://myservice.dev.example.com" \
  --type String

# Repeat for each service / environment
```

---

## Step 8 — Create First Admin User

```bash
aws cognito-idp admin-create-user \
  --user-pool-id USER_POOL_ID \
  --username admin@example.com \
  --temporary-password TempPass123 \
  --user-attributes Name=email,Value=admin@example.com Name=email_verified,Value=true
```

---

## Teardown

```bash
cdk destroy
```

Note: Aurora cluster is set to `SNAPSHOT` (data preserved) and Cognito User Pool to `RETAIN` (users preserved) on destroy. ECR repos also retained. Delete these manually if you want a full cleanup.

---

## Cost at Idle (~zero usage)

| Service | Monthly |
|---|---|
| Aurora (auto-paused) | $0 |
| Secrets Manager | $0.40 |
| ECR (2 repos) | ~$0.20 |
| Everything else | $0 |
| **Total** | **~$0.60/month** |
