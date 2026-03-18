# Prompt2Test — UI Implementation & AWS Deployment Guide

---

## Table of Contents
1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [Project Structure](#3-project-structure)
4. [UI Pages & Components](#4-ui-pages--components)
5. [Design System](#5-design-system)
6. [Local Development Setup](#6-local-development-setup)
7. [AWS Deployment — AWS Amplify](#7-aws-deployment--aws-amplify)
8. [CI/CD — Auto Deploy on Git Push](#8-cicd--auto-deploy-on-git-push)
9. [Next Steps — Backend](#9-next-steps--backend)

---

## 1. Project Overview

**Prompt2Test** is an AI-powered test authoring and automation platform for API and workflow testing.

- QA engineers describe what they want to test in plain English
- An AI agent (AWS Bedrock / Strands SDK) interprets the request and authors a structured, deterministic execution plan
- The orchestrator replays that plan forever — with zero LLM involvement after authoring
- Tests can be promoted across environments: DEV → QA → UAT → PROD

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 18 + TypeScript |
| Build tool | Vite |
| Styling | Tailwind CSS v4 |
| Routing | React Router v6 |
| Fonts | Plus Jakarta Sans (UI), JetBrains Mono (code) |
| Package manager | npm |
| Hosting | AWS Amplify (CloudFront + S3 under the hood) |

---

## 3. Project Structure

```
Prompt2TestUI/
├── web/                          # React app root
│   ├── src/
│   │   ├── layouts/
│   │   │   └── PlatformLayout.tsx    # Top nav + tab routing wrapper
│   │   ├── pages/
│   │   │   ├── LoginPage.tsx         # Login screen
│   │   │   ├── AgentPage.tsx         # AI chat + execution plan panel
│   │   │   ├── InventoryPage.tsx     # Test case browser by environment
│   │   │   ├── ConfigPage.tsx        # Base config, services, test accounts
│   │   │   ├── ArchitecturePage.tsx  # Platform architecture docs
│   │   │   ├── ConceptsPage.tsx      # Core concepts accordion
│   │   │   └── MembersPage.tsx       # Team RBAC management
│   │   ├── App.tsx                   # Router setup
│   │   ├── main.tsx                  # Entry point
│   │   └── index.css                 # Global styles + CSS variables
│   ├── index.html                    # HTML shell (title: Prompt2Test)
│   ├── package.json
│   ├── tailwind.config.js
│   ├── vite.config.ts
│   └── tsconfig.json
├── BluePrint_TestAgent3.html         # Original UI blueprint (reference)
└── Prompt2Test_UI_Implementation_and_Deployment.md
```

---

## 4. UI Pages & Components

### 4.1 Login Page (`/login`)
- Light theme: white card on slate-100 background
- Email + password fields with teal focus ring
- SSO sign-in button
- Redirects to `/agent` on submit

### 4.2 Author Agent (`/agent`)
- **Left panel (440px)**: AI chat interface
  - Agent messages (slate bubble) + user messages (teal bubble)
  - Hint chips for quick test prompts
  - Textarea input with Enter-to-send
- **Right panel**: Execution Plan
  - Empty state: placeholder text
  - Will render structured JSON plan once agent authors a test
- **Top bar**: Mode toggle (Plan / Automate), user badge, environment badge

### 4.3 Test Inventory (`/inventory`)
- Environment tabs: DEV / QA / UAT / PROD
- Stats row: Total TCs, Services, Smoke tagged, Failures
- Test case table: Name, Service, Tags (Smoke), Status (pass/fail)
- "Author TC" button available in DEV only

### 4.4 Config & Accounts (`/config`)
- Environment tabs: DEV / QA / UAT / PROD
- Sub-tabs: Base Config | Services | Test Accounts
- **Base Config**: API URL, OAuth URL, Timeout, Retry settings → Save to SSM
- **Services**: Per-service URL + Swagger URL configuration
- **Test Accounts**: Account list with plan tier badges

### 4.5 Architecture (`/architecture`)
- Sub-tabs: Platform | Infrastructure | Data Flow | Cost Model
- **Platform**: 3-layer architecture cards (LLM Authoring / Orchestrator / LLM Assertion)
- **Infrastructure**: AWS services grid with icons
- **Data Flow**: Step-by-step flow table
- **Cost Model**: Token cost breakdown table

### 4.6 Core Concepts (`/concepts`)
- Accordion-style collapsible sections
- Covers: Vision, Token Management, Adoption Strategy
- Side-by-side comparison cards (Before vs After)

### 4.7 Members (`/members`)
- Team table: avatar, name, email, role badge, access level
- RBAC roles: Admin, QA Lead, QA Engineer, Developer
- Invite member button

---

## 5. Design System

### Colors
| Token | Value | Usage |
|---|---|---|
| Teal (primary) | `#0C7B8E` | Buttons, active tabs, links |
| Teal dark | `#0A6577` | Button hover |
| Teal light | `#E0F2F7` | Active tab background |
| Background | `#F5F7FA` | Page background |
| Surface | `#FFFFFF` | Cards, panels |
| Border | `slate-200` | Dividers, card borders |
| Text primary | `slate-900` | Headings |
| Text secondary | `slate-500` | Subtitles, labels |
| Text muted | `slate-400` | Hints, placeholders |

### Typography
| Element | Size | Weight |
|---|---|---|
| Page heading | 17px | Bold |
| Section heading | 15px | Bold |
| Body / table rows | 14px | Regular |
| Labels / badges | 12-13px | Medium |
| Table headers | 12px | Semibold |

### Font Families
- **UI**: `Plus Jakarta Sans` — all body/UI text
- **Code/Mono**: `JetBrains Mono` — code blocks

---

## 6. Local Development Setup

### Prerequisites
- Node.js 18+
- npm 9+

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/ammuvisalakshi/Prompt2TestUI.git
cd Prompt2TestUI

# 2. Install dependencies
cd web
npm install

# 3. Start dev server
npm run dev
```

App runs at: `http://localhost:5173`

### Build for production
```bash
npm run build
# Output in web/dist/
```

---

## 7. AWS Deployment — AWS Amplify

### Why Amplify?
- Connects directly to GitHub — no manual uploads
- Auto-builds and deploys on every push to `master`
- Provides a live HTTPS URL instantly (CloudFront + S3 under the hood)
- Free tier available for small projects

### One-time Setup Steps

#### Step 1 — Open AWS Amplify
- Go to **AWS Console → AWS Amplify → Create new app**

#### Step 2 — Connect GitHub
- Source provider: **GitHub**
- Authorize AWS Amplify to access your GitHub account
- Select repository: `ammuvisalakshi/Prompt2TestUI`
- Branch: `master`
- Check **"My app is a monorepo"**

#### Step 3 — App Settings
Amplify auto-detects the build config. Verify:
- **App name**: `Prompt2TestUI`
- **Frontend build command**: `npm run build`
- **Build output directory**: `dist`

The auto-generated `amplify.yml` will be:
```yaml
version: 1
applications:
  - frontend:
      phases:
        preBuild:
          commands:
            - npm ci --cache .npm --prefer-offline
        build:
          commands:
            - npm run build
      artifacts:
        baseDirectory: dist
        files:
          - '**/*'
      cache:
        paths:
          - .npm/**/*
    appRoot: web
```

#### Step 4 — Advanced Settings
Amplify auto-sets these environment variables:
- `AMPLIFY_DIFF_DEPLOY` = `false`
- `AMPLIFY_MONOREPO_APP_ROOT` = `web`

Leave SSR disabled (this is a pure SPA).

#### Step 5 — Deploy
- Click **Next → Review → Save and Deploy**
- Amplify pulls the code from GitHub, builds, and deploys
- Live URL format: `https://master.xxxxxxxx.amplifyapp.com`

### Amplify Build Stages
| Stage | What happens |
|---|---|
| Provision | Spins up build container (Amazon Linux 2023) |
| Build | Runs `npm ci` then `npm run build` |
| Deploy | Uploads `dist/` to S3 + invalidates CloudFront |
| Verify | Health check on the live URL |

---

## 8. CI/CD — Auto Deploy on Git Push

Once Amplify is set up, every push to `master` automatically:
1. Triggers a new build
2. Pulls latest code from GitHub
3. Runs `npm run build`
4. Deploys to the live URL

### Workflow for future changes
```bash
# Make code changes locally
git add .
git commit -m "your change description"
git push origin master
# → Amplify auto-deploys within ~2 minutes
```

---

## 9. Next Steps — Backend

The UI is now live. The next phase is building the backend:

### Phase 1 — Auth (AWS Cognito)
- Replace mock login with real Cognito SSO
- JWT token management
- RBAC roles: Admin, QA Lead, QA Engineer, Developer

### Phase 2 — REST API (API Gateway + Lambda)
- `/services` — list microservices
- `/test-cases` — CRUD for test cases per environment
- `/config` — read/write SSM parameters
- `/members` — team management
- **Runtime**: Python FastAPI on AWS Lambda
- **Database**: DynamoDB

### Phase 3 — AI Agent (AWS Bedrock + Strands SDK)
- WebSocket API for real-time agent streaming
- Agent runs on ECS Fargate (long-running)
- Uses Claude Sonnet via AWS Bedrock
- MCP tools to call real APIs during authoring
- Execution plans saved to S3

### Phase 4 — Test Execution
- SQS queue for multi-account parallel runs
- Lambda workers execute frozen plans
- Results stored in DynamoDB + OpenSearch
- Zero LLM involvement during execution

### AWS Services Needed
| Service | Purpose |
|---|---|
| Cognito | Auth + SSO + RBAC |
| API Gateway (REST) | REST API endpoints |
| API Gateway (WebSocket) | Real-time agent streaming |
| Lambda | API handlers + test orchestrator |
| DynamoDB | Services, TCs, accounts, config |
| S3 | Execution plans + response archives |
| OpenSearch | Semantic TC search |
| SQS | Multi-account test run queue |
| Secrets Manager | Test account credentials |
| SSM Parameter Store | Config per environment |
| Bedrock | Claude Sonnet for AI agent |
| ECS Fargate | Long-running agent container |

---

*Document generated: March 2026*
*Repository: https://github.com/ammuvisalakshi/Prompt2TestUI*
