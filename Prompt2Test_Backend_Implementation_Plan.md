# Prompt2Test — Backend Implementation Plan
## Phase 1: Agent (Plan Mode) on Bedrock AgentCore

---

## Table of Contents
1. [What We Are Building](#1-what-we-are-building)
2. [Architecture Overview](#2-architecture-overview)
3. [Plan Mode — End to End Flow](#3-plan-mode--end-to-end-flow)
4. [Project Structure](#4-project-structure)
5. [Component Breakdown](#5-component-breakdown)
6. [MCP Tools](#6-mcp-tools)
7. [AWS Services Needed](#7-aws-services-needed)
8. [Build Order](#8-build-order)
9. [How UI Connects to Agent](#9-how-ui-connects-to-agent)

---

## 1. What We Are Building

**Goal**: Wire up the "Author Agent" chat panel in the UI so that when a QA types a test description and clicks Send, a real AI agent:

1. Asks for the service and account
2. Calls real APIs via MCP tools
3. Observes real responses
4. Generates a structured execution plan (Gherkin + variables + steps)
5. Returns it to the UI to display in the Execution Plan panel

**What is Bedrock AgentCore?**
AWS Bedrock AgentCore is a managed runtime that hosts and runs your AI agent code. You write the agent in Python using the AWS Strands Agents SDK, deploy it to AgentCore, and AWS manages the container, scaling, and session memory for you.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser (React UI)                    │
│              Author Agent chat panel — Plan mode             │
└───────────────────────┬─────────────────────────────────────┘
                        │  POST /agent/invoke (REST)
                        ▼
┌─────────────────────────────────────────────────────────────┐
│               API Gateway (REST API)                         │
│               Validates request, routes to Lambda            │
└───────────────────────┬─────────────────────────────────────┘
                        │  invoke
                        ▼
┌─────────────────────────────────────────────────────────────┐
│               Lambda (Router Function)                       │
│               Calls Bedrock AgentCore with session ID        │
└───────────────────────┬─────────────────────────────────────┘
                        │  invoke agent
                        ▼
┌─────────────────────────────────────────────────────────────┐
│          Bedrock AgentCore Runtime                           │
│          Hosts the Strands Agent (Python)                    │
│                                                              │
│   Agent (Claude Sonnet)                                      │
│     ├── search_endpoints tool  ──► OpenSearch (TC index)     │
│     ├── capture_and_compress   ──► S3 (response archive)     │
│     ├── read_state             ──► agent.state               │
│     └── save_execution_plan    ──► S3 + DynamoDB             │
│                                                              │
│   Config resolution:                                         │
│     ├── SSM Parameter Store (BASE_URL, timeouts, etc.)       │
│     └── Secrets Manager (account passwords)                  │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Plan Mode — End to End Flow

### Step 1 — User types test description
```
UI: "Test that billing plan shows Enterprise for Acme Corp"
→ POST /agent/invoke { session_id, message, mode: "plan" }
```

### Step 2 — Agent asks for service + account (if not provided)
```
Agent: "Which service and account should I test against?"
UI: shows service picker (Billing, Payment, Auth, User)
UI: shows account picker (Acme Corp, Beta Corp, Corp 3)
```

### Step 3 — Agent calls search_endpoints MCP tool
```
search_endpoints("billing plan check")
→ OpenSearch returns: POST /api/billing/check schema (~800 tokens)
→ NOT full Swagger (would be ~100k tokens)
```

### Step 4 — Agent calls real API via rest_mcp
```
Agent resolves BASE_URL from SSM Parameter Store
Agent resolves ACCOUNT_PASSWORD from Secrets Manager
Agent calls: POST https://dev.myapp.com/api/billing/check
Agent observes real response
capture_and_compress → saves response to S3, writes to agent.state
```

### Step 5 — Agent generates execution plan
```
Agent produces:
{
  feature: "Billing — plan validation per account",
  gherkin: [ "Given I am logged in as {{ACCOUNT_USER}}", ... ],
  variables: [ {key: "BASE_URL", source: "team", value: "..."}, ... ],
  steps: [ "Navigate to {{BASE_URL}}/billing", ... ]
}
```

### Step 6 — Plan returned to UI
```
Lambda returns plan JSON to UI
UI renders:
  - Gherkin card
  - Variables card (with source: team/service/account)
  - Steps card
  - "Approve & Automate" button
```

---

## 4. Project Structure

```
Prompt2TestUI/
├── web/                          # ✅ Done — React UI
└── backend/
    ├── agent/                    # Strands Agent (Python)
    │   ├── agent.py              # Main agent definition
    │   ├── tools/
    │   │   ├── search_endpoints.py      # Semantic search on OpenSearch
    │   │   ├── capture_and_compress.py  # Compress + save to S3
    │   │   ├── read_state.py            # Read from agent.state
    │   │   └── save_execution_plan.py   # Save plan to S3 + DynamoDB
    │   ├── config/
    │   │   └── resolver.py       # 4-level config resolution (SSM + Secrets)
    │   ├── Dockerfile            # Container for AgentCore deployment
    │   └── requirements.txt
    ├── lambda/
    │   └── router/
    │       ├── handler.py        # Lambda that routes UI → AgentCore
    │       └── requirements.txt
    ├── infra/                    # AWS CDK v2 (TypeScript)
    │   ├── lib/
    │   │   ├── agent-stack.ts    # AgentCore deployment
    │   │   ├── api-stack.ts      # API Gateway + Lambda
    │   │   └── data-stack.ts     # S3, DynamoDB, SSM setup
    │   ├── bin/
    │   │   └── app.ts
    │   └── package.json
    └── scripts/
        └── seed_ssm.py           # Seed SSM with dev config values
```

---

## 5. Component Breakdown

### 5.1 Agent (`backend/agent/agent.py`)
The core of the system. Written in Python using AWS Strands Agents SDK.

```python
from strands import Agent
from strands.models import BedrockModel
from strands_tools import http_request
from tools.search_endpoints import search_endpoints
from tools.capture_and_compress import capture_and_compress
from tools.read_state import read_state
from tools.save_execution_plan import save_execution_plan

SYSTEM_PROMPT = """
You are a QA test authoring agent for Prompt2Test.
Your job is to understand what the QA wants to test,
call the real API, observe real responses, and produce
a frozen deterministic execution plan.

Rules:
- Only call APIs that are relevant to the test
- Always use capture_and_compress after every API call
- Never store large responses in conversation — use agent.state
- Always ask for service and account if not provided
- Produce a plan in the exact JSON schema provided
"""

agent = Agent(
  model=BedrockModel(model_id="claude-sonnet-4-6"),
  system_prompt=SYSTEM_PROMPT,
  tools=[
    search_endpoints,
    capture_and_compress,
    read_state,
    save_execution_plan,
    http_request,      # for calling real APIs
  ]
)
```

### 5.2 Lambda Router (`backend/lambda/router/handler.py`)
Receives requests from API Gateway and invokes the AgentCore agent.

```python
import boto3
import json

def handler(event, context):
    body = json.loads(event['body'])
    session_id = body['session_id']
    message = body['message']

    # Call Bedrock AgentCore
    agentcore = boto3.client('bedrock-agentcore-runtime')
    response = agentcore.invoke_agent(
        agentId=AGENT_ID,
        sessionId=session_id,
        inputText=message
    )

    return {
        'statusCode': 200,
        'body': json.dumps(response['output'])
    }
```

### 5.3 Config Resolver (`backend/agent/config/resolver.py`)
Resolves the 4-level config hierarchy for any given context.

```
Resolution order (later wins):
L1: /prompt2test/{team}/base/*         → SSM
L2: /prompt2test/{team}/{service}/*    → SSM
L3: /prompt2test/{team}/{env}/*        → SSM
L4: /prompt2test/{team}/accounts/{id} → Secrets Manager
```

---

## 6. MCP Tools

### 6.1 `search_endpoints`
- **Input**: natural language query (e.g. "billing plan check")
- **What it does**: Semantic search on OpenSearch endpoint index
- **Returns**: Only relevant endpoint schemas (~800 tokens) — NOT full Swagger
- **Why**: Prevents sending 100k token Swagger doc to LLM

### 6.2 `capture_and_compress`
- **Input**: API response (full JSON)
- **What it does**:
  1. Archives full response to S3
  2. Writes key fields to agent.state
  3. Returns a 20-token summary to LLM
- **Why**: Keeps LLM context small — large payloads never enter the conversation window

### 6.3 `read_state`
- **Input**: key name (e.g. "AUTH_TOKEN", "USER_ID")
- **What it does**: Reads from agent.state (stored outside conversation window)
- **Returns**: The value
- **Why**: Variables captured in earlier steps are available in later steps without bloating context

### 6.4 `save_execution_plan`
- **Input**: completed plan JSON (feature, gherkin, variables, steps)
- **What it does**:
  1. Saves frozen plan JSON to S3
  2. Indexes TC in DynamoDB
  3. Upserts vector embedding into OpenSearch (via Titan)
- **Returns**: plan_id, s3_path
- **Why**: Once QA approves, plan is frozen forever — orchestrator just replays it

---

## 7. AWS Services Needed (Phase 1)

| Service | Purpose | When needed |
|---|---|---|
| **Bedrock AgentCore** | Hosts and runs the agent | Core — Day 1 |
| **Bedrock (Claude Sonnet)** | LLM for the agent | Core — Day 1 |
| **API Gateway (REST)** | Entry point from UI | Day 1 |
| **Lambda** | Routes UI requests to AgentCore | Day 1 |
| **SSM Parameter Store** | Stores BASE_URL, timeouts per env | Day 1 |
| **Secrets Manager** | Stores account passwords | Day 1 |
| **S3** | Stores compressed API responses + execution plans | Day 1 |
| **DynamoDB** | Indexes saved test cases | Day 1 |
| **OpenSearch** | Endpoint index for semantic search | Day 2 |
| **Titan Embeddings** | Vectorises TC specs for OpenSearch | Day 2 |

---

## 8. Build Order

### Week 1 — Core Agent Working Locally
- [ ] Set up Python project + Strands SDK
- [ ] Write agent.py with system prompt
- [ ] Implement `capture_and_compress` tool
- [ ] Implement `read_state` tool
- [ ] Implement `save_execution_plan` tool (S3 only first)
- [ ] Implement config resolver (SSM + Secrets Manager)
- [ ] Test agent locally: input prompt → output plan JSON

### Week 2 — Deploy to AgentCore + Wire Up API
- [ ] Write Dockerfile for agent
- [ ] Deploy agent to Bedrock AgentCore
- [ ] Write Lambda router function
- [ ] Create API Gateway endpoint: POST /agent/invoke
- [ ] Test end-to-end: UI → API Gateway → Lambda → AgentCore → response

### Week 3 — Connect UI to Real Agent
- [ ] Update AgentPage.tsx to call real API instead of simulated responses
- [ ] Render real execution plan JSON in the Plan panel
- [ ] Add session management (session_id per conversation)
- [ ] Implement `search_endpoints` with OpenSearch

### Week 4 — Polish + Save Plans
- [ ] DynamoDB indexing of saved TCs
- [ ] OpenSearch vector index via Titan Embeddings
- [ ] "Approve Plan" button saves to DynamoDB
- [ ] Saved TCs appear in Test Inventory page

---

## 9. How UI Connects to Agent

### Current UI (AgentPage.tsx)
Right now the UI simulates the agent response with a `setTimeout`:
```ts
setTimeout(() => {
  setMessages(prev => [...prev, { role: 'agent', text: `Got it...` }])
}, 800)
```

### After wiring up
Replace the `send()` function in `AgentPage.tsx` to call the real API:

```ts
async function send() {
  const text = input.trim()
  if (!text) return
  setMessages(prev => [...prev, { role: 'user', text }])
  setInput('')

  const response = await fetch('https://your-api-gateway-url/agent/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,   // unique per conversation
      message: text,
      mode: 'plan'
    })
  })

  const data = await response.json()

  // If agent returned a plan, render it in the Plan panel
  if (data.plan) {
    setPlan(data.plan)
  } else {
    // Regular chat message
    setMessages(prev => [...prev, { role: 'agent', text: data.message }])
  }
}
```

### API Contract

**Request:**
```json
POST /agent/invoke
{
  "session_id": "sess_abc123",
  "message": "Test billing plan shows Enterprise for Acme Corp",
  "mode": "plan",
  "service": "Billing",         // optional — agent will ask if missing
  "account_id": "acme"          // optional — agent will ask if missing
}
```

**Response (chat message):**
```json
{
  "type": "message",
  "message": "Which service should I test against?"
}
```

**Response (execution plan ready):**
```json
{
  "type": "plan",
  "plan": {
    "feature": "Billing — plan validation per account",
    "gherkin": ["Given I am logged in as {{ACCOUNT_USER}}", "..."],
    "variables": [
      { "key": "BASE_URL", "source": "team", "value": "https://dev.myapp.com" },
      { "key": "ACCOUNT_USER", "source": "account", "value": "admin@acme.com" }
    ],
    "steps": [
      "Navigate to {{BASE_URL}}/billing",
      "Assert plan badge = {{EXPECTED_PLAN}}"
    ]
  },
  "plan_id": "tc_20260317_001",
  "tokens_used": 1850
}
```

---

## Next Action

Start with **Week 1** — get the agent working locally first before deploying anywhere:

1. Set up `backend/agent/` Python project
2. Install Strands SDK
3. Write `agent.py` with the 4 MCP tools
4. Test it locally: type a test description, get back a plan JSON

*Repository: https://github.com/ammuvisalakshi/Prompt2TestUI*
*Document created: March 2026*
