#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Prompt2Test — Full New-Account Deployment Script
#  Run from the root of the Prompt2TestUI repo in Git Bash (Windows) or bash.
#  Automates all CLI steps. Pauses for the 3 steps that require a browser.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Colours ─────────────────────────────────────────────────────────────────
G='\033[0;32m'; Y='\033[1;33m'; B='\033[0;34m'
R='\033[0;31m'; C='\033[0;36m'; W='\033[1m'; N='\033[0m'

phase()  { echo -e "\n${W}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n  $1\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"; }
step()   { echo -e "\n${B}${W}── Step $1: $2${N}"; }
ok()     { echo -e "${G}   ✅  $1${N}"; }
info()   { echo -e "   ${C}ℹ  $1${N}"; }
err()    { echo -e "${R}   ❌  $1${N}"; exit 1; }
manual() { echo -e "\n${Y}${W}   👆  MANUAL STEP REQUIRED${N}\n${Y}$1${N}"; }
pause()  { echo -e "\n${Y}   Press Enter when done ▶${N}"; read -r; }
ask()    { local prompt=$1 var=$2; echo -e "\n${C}   ? $prompt${N}"; read -r "$var"; }

# ── Banner ───────────────────────────────────────────────────────────────────
echo -e "${W}"
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║    Prompt2Test — New AWS Account Deployment Script       ║"
echo "  ║    AWS Region: us-east-1                                 ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo -e "${N}"
echo "  This script automates all CLI steps from the deployment guide."
echo "  It will pause 3 times for steps that require your browser."
echo ""
echo "  Prerequisites: AWS CLI, Node.js v18+, CDK 2.x installed."
echo ""
echo -e "  Press ${W}Enter${N} to start, or Ctrl+C to cancel."
read -r

# Verify script is running from Prompt2TestUI root (infrastructure/ must exist)
[[ -d "infrastructure" ]] || err "Run this script from the root of the Prompt2TestUI repo (infrastructure/ folder not found)."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ════════════════════════════════════════════════════════════════════════════
#  PHASE 1 — PREREQUISITE CHECKS
# ════════════════════════════════════════════════════════════════════════════
phase "PHASE 1 — Prerequisite Checks"

step 1 "AWS CLI"
aws --version | head -1 || err "AWS CLI not found. Install v2 from aws.amazon.com/cli"
ok "AWS CLI found"

step 2 "Node.js"
NODE_VER=$(node --version 2>/dev/null) || err "Node.js not found. Install LTS from nodejs.org"
MAJOR="${NODE_VER#v}"; MAJOR="${MAJOR%%.*}"
[[ "$MAJOR" -ge 18 ]] || err "Node.js v18+ required. Found $NODE_VER"
ok "Node.js $NODE_VER"

step 3 "AWS CDK"
CDK_VER=$(cdk --version 2>/dev/null) || err "CDK not found. Run: npm install -g aws-cdk"
ok "CDK $CDK_VER"

step 4 "AWS credentials"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text) \
  || err "AWS CLI not configured. Run: aws configure"
USER_ARN=$(aws sts get-caller-identity --query Arn --output text)
info "Account : $ACCOUNT_ID"
info "Identity: $USER_ARN"
ok "Connected to AWS account $ACCOUNT_ID"

step "4b" "IAM permissions check"
# Check if the user/role has AdministratorAccess or is root (arn contains :root)
if echo "$USER_ARN" | grep -q ':root'; then
  ok "Running as root user — full access confirmed"
else
  ATTACHED=$(aws iam list-attached-user-policies \
    --user-name "$(basename "$USER_ARN")" \
    --query "AttachedPolicies[?PolicyName=='AdministratorAccess'].PolicyName" \
    --output text 2>/dev/null || echo "")
  if [[ "$ATTACHED" == "AdministratorAccess" ]]; then
    ok "AdministratorAccess policy attached"
  else
    echo -e "${Y}   ⚠  Could not confirm AdministratorAccess on your IAM user.${N}"
    echo "   CDK deploy will fail mid-way if permissions are insufficient."
    echo "   Attach it via: AWS Console → IAM → Users → $(basename "$USER_ARN") → Add permissions → AdministratorAccess"
    echo ""
    echo -e "   Continue anyway? (y/N): \c"
    read -r CONT
    [[ "$CONT" =~ ^[Yy]$ ]] || err "Aborted. Attach AdministratorAccess and re-run."
  fi
fi

# ════════════════════════════════════════════════════════════════════════════
#  PHASE 2 — MANUAL CONSOLE STEPS
# ════════════════════════════════════════════════════════════════════════════
phase "PHASE 2 — Manual Console Steps (browser required)"

# ── Step 7: Bedrock ──────────────────────────────────────────────────────────
step 7 "Enable Bedrock Model Access (browser)"
manual "$(cat <<'MSG'
   Open: AWS Console → Amazon Bedrock → Model access → Manage model access
   Enable both:
     • Claude Sonnet 4.5  (Anthropic — use cross-region inference profile)
     • Titan Embed Text v2  (Amazon)
   Click Save changes and wait until both show "Access granted".
MSG
)"
pause

# ── Step 8: CDK Bootstrap ────────────────────────────────────────────────────
step 8 "CDK Bootstrap"
info "Running cdk bootstrap for account $ACCOUNT_ID in us-east-1..."
cd "$SCRIPT_DIR/infrastructure"
cdk bootstrap "aws://$ACCOUNT_ID/us-east-1"
ok "CDK bootstrapped"

# ── Step 9: GitHub CodeStar Connection ──────────────────────────────────────
step 9 "Create GitHub CodeStar Connection (browser)"
manual "$(cat <<'MSG'
   Open: AWS Console → Developer Tools → Settings → Connections
   1. Click "Create connection" → select GitHub
   2. Name it:  Prompt2TestGitHub
   3. Click "Connect to GitHub" → authorize the popup
   4. Click "Connect"
   5. Click on your new connection → copy the Connection ARN
      It looks like: arn:aws:codeconnections:us-east-1:ACCOUNT:connection/UUID
MSG
)"
pause

ask "Paste your GitHub Connection ARN:" GITHUB_CONN_ARN
ask "Your GitHub username (just the username, e.g. jsmith):" GITHUB_OWNER

# Sanity-check the ARN looks right
[[ "$GITHUB_CONN_ARN" == arn:aws:*connections:* ]] \
  || echo -e "   ${Y}⚠  ARN doesn't look right — make sure to paste the full ARN${N}"

# ════════════════════════════════════════════════════════════════════════════
#  PHASE 3 — CDK DEPLOY
# ════════════════════════════════════════════════════════════════════════════
phase "PHASE 3 — CDK Deploy (automated, ~5–10 min)"

step 10 "Update cdk.json"
cd "$SCRIPT_DIR/infrastructure"
node - <<JS
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('cdk.json', 'utf8'));
cfg.context.githubOwner          = '${GITHUB_OWNER}';
cfg.context.githubConnectionArn  = '${GITHUB_CONN_ARN}';
fs.writeFileSync('cdk.json', JSON.stringify(cfg, null, 2) + '\n');
JS
ok "cdk.json updated with githubOwner=$GITHUB_OWNER"

step 11 "npm install"
npm install --silent
ok "Dependencies installed"

step 11b "cdk deploy"
info "Deploying — this takes 5–10 minutes..."
cdk deploy --require-approval never
ok "CDK deploy complete"

# ── Capture CDK outputs ──────────────────────────────────────────────────────
info "Reading CDK stack outputs..."
cfn_out() {
  aws cloudformation describe-stacks \
    --stack-name Prompt2TestStack \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text
}
USER_POOL_ID=$(cfn_out OutUserPoolId)
USER_POOL_CLIENT_ID=$(cfn_out OutUserPoolClientId)
IDENTITY_POOL_ID=$(cfn_out OutIdentityPoolId)
AGENT_ECR_URI=$(cfn_out OutAgentEcrUri)
AGENTCORE_ROLE_ARN=$(cfn_out OutAgentCoreRoleArn)
AMPLIFY_APP_ID=$(cfn_out OutAmplifyAppId)

echo ""
echo "  ┌─────────────────────────────────────────────────────────────┐"
echo "  │  CDK Outputs — save these                                   │"
echo "  ├─────────────────────────────────────────────────────────────┤"
printf "  │  %-22s  %s\n" "UserPoolId"          "$USER_POOL_ID"
printf "  │  %-22s  %s\n" "UserPoolClientId"    "$USER_POOL_CLIENT_ID"
printf "  │  %-22s  %s\n" "IdentityPoolId"      "$IDENTITY_POOL_ID"
printf "  │  %-22s  %s\n" "AgentEcrUri"         "$AGENT_ECR_URI"
printf "  │  %-22s  %s\n" "AgentCoreRoleArn"    "$AGENTCORE_ROLE_ARN"
printf "  │  %-22s  %s\n" "AmplifyAppId"        "$AMPLIFY_APP_ID"
echo "  └─────────────────────────────────────────────────────────────┘"

# ════════════════════════════════════════════════════════════════════════════
#  PHASE 4 — TRIGGER CODEPIPELINES
# ════════════════════════════════════════════════════════════════════════════
phase "PHASE 4 — Deploy Lambda Code & Build Docker Images (~5–10 min each)"

step 12 "Trigger all 3 CodePipelines"
for P in prompt2test-lambda prompt2test-playwright-mcp prompt2test-agent; do
  aws codepipeline start-pipeline-execution --name "$P" > /dev/null
  info "Started $P"
done
ok "All 3 pipelines triggered"

echo ""
info "Polling pipelines — waiting for Succeeded (dots = still running)..."
for P in prompt2test-lambda prompt2test-playwright-mcp prompt2test-agent; do
  printf "   %-38s" "$P"
  while true; do
    STATUS=$(aws codepipeline list-pipeline-executions \
      --pipeline-name "$P" --max-results 1 \
      --query 'pipelineExecutionSummaries[0].status' --output text)
    case "$STATUS" in
      Succeeded) echo -e " ${G}✅ Succeeded${N}"; break ;;
      Failed)    echo -e " ${R}❌ Failed${N}"
                 err "Pipeline $P failed. Go to AWS Console → CodePipeline → $P → click the failed stage → View in CodeBuild." ;;
      *)         printf "."; sleep 15 ;;
    esac
  done
done

# ════════════════════════════════════════════════════════════════════════════
#  PHASE 5 — AGENTCORE RUNTIME
# ════════════════════════════════════════════════════════════════════════════
phase "PHASE 5 — Create Bedrock AgentCore Runtime"

step 13 "Create AgentCore Runtime"
AGENTCORE_JSON=$(aws bedrock-agentcore-control create-agent-runtime \
  --agent-runtime-name Prompt2TestAgent \
  --agent-runtime-artifact "{\"containerConfiguration\":{\"image\":\"${AGENT_ECR_URI}:latest\"}}" \
  --role-arn "$AGENTCORE_ROLE_ARN" \
  --network-configuration '{"networkMode":"PUBLIC"}')

AGENT_RUNTIME_ARN=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).agentRuntimeArn)" <<< "$AGENTCORE_JSON")
AGENT_RUNTIME_ID=$(node  -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).agentRuntimeId)"  <<< "$AGENTCORE_JSON")

info "AgentCore ARN: $AGENT_RUNTIME_ARN"

printf "   Waiting for ACTIVE"
while true; do
  STATUS=$(aws bedrock-agentcore-control get-agent-runtime \
    --agent-runtime-id "$AGENT_RUNTIME_ID" \
    --query 'status' --output text)
  if [[ "$STATUS" == "ACTIVE" ]]; then
    echo -e " ${G}✅ ACTIVE${N}"; break
  else
    printf "."; sleep 20
  fi
done

# ════════════════════════════════════════════════════════════════════════════
#  PHASE 6 — AMPLIFY CONNECT (MANUAL)
# ════════════════════════════════════════════════════════════════════════════
phase "PHASE 6 — Connect Amplify to GitHub (browser required)"

# Set VITE_AGENT_RUNTIME_ARN on the Amplify app via CLI so the user only
# needs to do the branch connection (OAuth) manually.
step "6a" "Set VITE_AGENT_RUNTIME_ARN on Amplify app"
EXISTING_ENV=$(aws amplify get-app --app-id "$AMPLIFY_APP_ID" \
  --query 'app.environmentVariables' --output json)
UPDATED_ENV=$(node - <<JS
const env = JSON.parse('${EXISTING_ENV}');
env['VITE_AGENT_RUNTIME_ARN'] = '${AGENT_RUNTIME_ARN}';
process.stdout.write(JSON.stringify(env));
JS
)
aws amplify update-app \
  --app-id "$AMPLIFY_APP_ID" \
  --environment-variables "$UPDATED_ENV" > /dev/null
ok "VITE_AGENT_RUNTIME_ARN set on Amplify app"

step 14 "Connect Amplify branch to GitHub (browser)"
manual "$(cat <<MSG
   Open: AWS Console → AWS Amplify → Prompt2TestUI  (App ID: $AMPLIFY_APP_ID)
   1. Click "Connect branch"
   2. Select GitHub → Prompt2TestUI repo → branch: master
   3. Environment variables are already set (VITE_AGENT_RUNTIME_ARN was just set for you)
   4. Click "Save and deploy"
   5. Wait for all build stages to show ✅
MSG
)"
pause

# ════════════════════════════════════════════════════════════════════════════
#  PHASE 7 — SERVICES & ADMIN USER
# ════════════════════════════════════════════════════════════════════════════
phase "PHASE 7 — Add Services & Create Admin User"

step 15 "Add services to SSM Parameter Store"
echo "  You can add as many services as you like. Press Enter to skip."
while true; do
  ask "Service name to add (or Enter to skip):" SVC_NAME
  [[ -z "$SVC_NAME" ]] && break
  ask "URL for $SVC_NAME in dev environment:" SVC_URL
  aws ssm put-parameter \
    --name "/prompt2test/config/dev/services/${SVC_NAME}/URL" \
    --value "$SVC_URL" \
    --type String > /dev/null
  ok "Added: /prompt2test/config/dev/services/$SVC_NAME/URL"
done

step 16 "Create admin user in Cognito"
ask "Admin email address (used to log in):" ADMIN_EMAIL
aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$ADMIN_EMAIL" \
  --temporary-password "TempPass123!" \
  --user-attributes \
    Name=email,Value="$ADMIN_EMAIL" \
    Name=email_verified,Value=true > /dev/null
ok "Admin user created — temporary password: TempPass123!"

# ════════════════════════════════════════════════════════════════════════════
#  SAVE OUTPUTS TO FILE
# ════════════════════════════════════════════════════════════════════════════
OUTPUTS_FILE="$SCRIPT_DIR/deployment-outputs.txt"
cat > "$OUTPUTS_FILE" <<EOF
Prompt2Test Deployment Outputs
Generated: $(date)
Account ID:             $ACCOUNT_ID
Region:                 us-east-1
GitHub Owner:           $GITHUB_OWNER
GitHub Connection ARN:  $GITHUB_CONN_ARN

CDK Stack Outputs:
  UserPoolId:           $USER_POOL_ID
  UserPoolClientId:     $USER_POOL_CLIENT_ID
  IdentityPoolId:       $IDENTITY_POOL_ID
  AgentEcrUri:          $AGENT_ECR_URI
  AgentCoreRoleArn:     $AGENTCORE_ROLE_ARN
  AmplifyAppId:         $AMPLIFY_APP_ID

AgentCore:
  ARN:                  $AGENT_RUNTIME_ARN
  ID:                   $AGENT_RUNTIME_ID

Admin User:
  Email:                $ADMIN_EMAIL
  Temp Password:        TempPass123!
EOF
info "All values saved to: deployment-outputs.txt"

# ════════════════════════════════════════════════════════════════════════════
#  DONE
# ════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${G}${W}"
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║   🎉  Deployment Complete!                               ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo -e "${N}"
echo "  Next step:"
echo "    1. Open your Amplify URL from the AWS Console → Amplify → Prompt2TestUI"
echo "    2. Log in with: $ADMIN_EMAIL  /  TempPass123!"
echo "    3. You will be prompted to set a permanent password"
echo ""
echo "  Verify the platform:"
echo "    • Config tab    → your services appear as chips"
echo "    • Agent tab     → type a test prompt → agent responds"
echo "    • Inventory tab → save a test and verify it is stored"
echo "    • Run a test    → live browser window opens → PASS/FAIL recorded"
echo ""
echo "  All saved values: deployment-outputs.txt"
echo ""
echo -e "${Y}  Security reminder:${N}"
echo "  You ran this script with AdministratorAccess. Now that deployment is"
echo "  complete, consider removing that policy from your IAM user and keeping"
echo "  only the day-to-day permissions (SSM, Cognito, CodePipeline)."
echo ""
