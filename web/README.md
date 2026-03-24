# Prompt2Test — Frontend

React SPA for the Prompt2Test AI-powered test authoring and automation platform.

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 18 + TypeScript |
| Build | Vite |
| Styling | Tailwind CSS |
| Auth | AWS Amplify Auth (Cognito) |
| Agent API | `@aws-sdk/client-bedrock-agent-runtime` — InvokeAgentRuntime |
| Hosting | AWS Amplify Hosting (CloudFront + S3, managed) |

## Pages

| Route | Page | Description |
|---|---|---|
| `/login` | LoginPage | Cognito sign-in |
| `/agent` | AgentPage | Main chat UI — Plan + Automate |
| `/inventory` | InventoryPage | Saved test cases |
| `/config` | ConfigPage | Config & accounts |
| `/members` | MembersPage | Team members |
| `/architecture` | ArchitecturePage | Live architecture diagram |
| `/concepts` | ConceptsPage | Core concepts guide |

## Agent Flow

The `AgentPage` drives the full test authoring + execution flow:

1. **Plan mode** — user describes a test → agent clarifies → returns JSON plan
2. **start_session** — opens a live browser popup, claims a warm ECS task, returns noVNC URL
3. **automate** — agent connects to playwright-mcp via SSE, executes the plan, stops the task

```
User types → callAgent({ mode: 'plan' })     → plan JSON displayed
User clicks Run → window.open('about:blank') → callAgent({ mode: 'start_session' })
                                             → popup.location.href = novnc_url
                                             → callAgent({ mode: 'automate' })
                                             → result displayed
```

## Local Development

```bash
cd web
npm install
npm run dev       # http://localhost:5173
```

Requires `web/src/amplifyconfiguration.json` with your Cognito + AgentCore config.

## Build & Deploy

Amplify CI/CD auto-deploys on push to `main`:
```bash
npm run build     # outputs to dist/
```

Manually:
```bash
aws amplify start-job --app-id <id> --branch-name main --job-type RELEASE
```

## Environment

The app reads AgentCore ARN and region from `amplifyconfiguration.json`:
```json
{
  "agentRuntimeArn": "arn:aws:bedrock-agentcore:us-east-1:...",
  "region": "us-east-1"
}
```

## Project Structure

```
web/
├── src/
│   ├── pages/
│   │   ├── AgentPage.tsx          # Main UI — plan + automate
│   │   ├── LoginPage.tsx
│   │   ├── InventoryPage.tsx
│   │   ├── ConfigPage.tsx
│   │   ├── MembersPage.tsx
│   │   ├── ArchitecturePage.tsx
│   │   └── ConceptsPage.tsx
│   ├── layouts/
│   │   └── PlatformLayout.tsx     # Top nav with tabs
│   └── main.tsx                   # Amplify.configure + router
├── public/
│   └── favicon.svg                # Robot head with Playwright eyes
└── vite.config.ts
```
