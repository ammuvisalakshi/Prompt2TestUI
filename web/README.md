# Prompt2Test — Frontend

React SPA for the Prompt2Test AI-powered test authoring and automation platform.

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 18 + TypeScript |
| Build | Vite |
| Styling | Inline styles (no CSS framework) |
| Auth | AWS Amplify Auth (Cognito) |
| Agent API | `@aws-sdk/client-bedrock-agent-runtime` — InvokeAgentRuntime |
| Hosting | AWS Amplify Hosting (CloudFront + S3, managed) |

## Pages

| Route | Page | Description |
|---|---|---|
| `/login` | LoginPage | Cognito sign-in |
| `/agent` | AgentPage | Main chat UI — Plan + Automate a test |
| `/testcase/:id` | TestCasePage | View/edit a saved test case; run automation |
| `/inventory` | InventoryPage | Saved test case library |
| `/config` | ConfigPage | Config & service accounts |
| `/members` | MembersPage | Team members |
| `/architecture` | ArchitecturePage | Live architecture diagram |
| `/concepts` | ConceptsPage | Core concepts guide |

## Full Agent Flow

### Step 1 — Plan

User describes a test on AgentPage → agent clarifies → returns a structured JSON plan:

```
User types → callAgent({ mode: 'plan' })
           → plan JSON rendered as step cards in right panel
           → "Save & Automate" button appears
```

### Step 2 — Start Session (live browser)

```
User clicks "Save & Automate"
  → confirmation dialog
  → callAgent({ mode: 'start_session' })
  → ECS task provisioned; noVNC URL returned
  → live browser embedded as iframe in the right panel
  → "Pop out" button available to open in separate window
```

### Step 3 — Automate

```
callAgent({ mode: 'automate', sessionId, taskId, novncUrl })
  → agent executes plan steps via Playwright MCP
  → each playwright tool call (navigate, click, type, snapshot…) streamed back
  → pass/fail result + per-step playwright_calls saved to backend
  → live browser iframe shows real-time execution
```

### Step 4 — Save & Review

```
Test result → updateTestCaseSteps (plan steps) + updateReplayScript (MCP calls)
           → TestCasePage shows two tabs:
               Plan Steps    — action / expected result table
               Automated Steps — full MCP tool detail (tool name, all parameters)
```

## Automated Steps Detail

The **Automated Steps** tab records every Playwright MCP tool the agent called:

| Column | Content |
|---|---|
| # | Step index |
| MCP Tool | Friendly name (e.g. "Navigate") + raw tool ID badge (`playwright_navigate`) |
| Parameters | All key/value pairs sent to the tool (url, selector, text, value…) |

This gives a full audit trail of exactly what the browser automation did.

## Local Development

```bash
cd web
npm install
npm run dev       # http://localhost:5173
```

Requires `web/src/amplifyconfiguration.json` with your Cognito + AgentCore config.

## Build & Deploy

Amplify CI/CD auto-deploys on push to `master`:
```bash
npm run build     # outputs to dist/
```

Manually trigger:
```bash
aws amplify start-job --app-id <id> --branch-name master --job-type RELEASE
```

## Environment

The app reads config from `web/src/amplifyconfiguration.json`:
```json
{
  "Auth": {
    "Cognito": {
      "userPoolId": "us-east-1_XXXXXXX",
      "userPoolClientId": "...",
      "identityPoolId": "us-east-1:...",
      "region": "us-east-1"
    }
  },
  "agentRuntimeArn": "arn:aws:bedrock-agentcore:us-east-1:...:runtime/Prompt2TestAgent-YTVbD4GrTi",
  "region": "us-east-1"
}
```

## Project Structure

```
web/
├── src/
│   ├── pages/
│   │   ├── AgentPage.tsx          # Main UI — plan + automate
│   │   ├── TestCasePage.tsx       # View/edit saved test case; run replay
│   │   ├── InventoryPage.tsx      # Test case library
│   │   ├── LoginPage.tsx
│   │   ├── ConfigPage.tsx
│   │   ├── MembersPage.tsx
│   │   ├── ArchitecturePage.tsx
│   │   └── ConceptsPage.tsx
│   ├── layouts/
│   │   └── PlatformLayout.tsx     # Side nav
│   └── main.tsx                   # Amplify.configure + router
├── public/
│   └── favicon.svg
└── vite.config.ts
```
