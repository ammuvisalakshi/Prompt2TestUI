# Speaker Script: LLMs, Agents & MCP

---

## SLIDE 1 — Title: LLMs, Agents & MCP

> Hey everyone, thanks for joining. Today I want to walk you through three concepts that are fundamentally changing how we build software with AI.
>
> We're going to take a journey — starting with **LLMs**, the foundation... then understanding what an **Agent** is and why it matters... and finally diving deep into **MCP** — the Model Context Protocol — which is the glue that connects AI to everything we use.
>
> By the end of this session, you'll understand not just what these things are, but how to actually build with them. Let's get into it.

**[~45 seconds]**

---

## SLIDE 2 — What is a Large Language Model?

> Let's start with the basics. What is an LLM?
>
> Think of it as a flow — you have an **input** on the left, the **model** in the center, and an **output** on the right.
>
> The input is just natural language. You type something like "summarize this document" or "write a Python function to sort a list" — plain English.
>
> In the center is the LLM itself — GPT-4o, Claude, Gemini, Llama — these are all examples. Under the hood, it's been trained on trillions of words from books, the web, and code. It has billions of parameters — think of them as knobs that got tuned during training. And its core task is deceptively simple: **predict the most likely next word**.
>
> That's it. That's all it does — next token prediction. But from that simple mechanism, something remarkable emerges: it understands context, it catches nuance, and it generates remarkably coherent text.
>
> On the right you see the output — a summary, working code, an explanation, an email. Impressive, right?
>
> But here's the critical thing — look at the bottom callout. **LLMs only generate text.** They cannot browse the internet. They cannot read your files. They cannot call an API. They cannot take any action in the real world. They are a brain in a jar. Incredibly smart, but completely disconnected from everything around it.
>
> And that limitation is exactly what sets up our next topic.

**[~2 minutes]**

---

## SLIDE 3 — The Gap: LLMs Can Think, But Can't Act

> So let's be really clear about what this gap looks like.
>
> On the left — what LLMs CAN do. They're phenomenal at generating text, code, summaries. They can reason through complex multi-step problems. They understand context and intent — they read between the lines. And they have a massive knowledge base from their training data.
>
> But on the right — what they CANNOT do. And this is where it gets painful.
>
> They can't access live data. Their training has a cutoff date — so they don't know what happened yesterday. They can't read your files, your databases, your internal systems. They literally cannot see anything outside of what you paste into the prompt. They can't take actions — can't send an email, can't create a Jira ticket, can't deploy your code. And here's the ironic one — they can *write* code beautifully, but they cannot *run* it.
>
> So how do we bridge this gap?
>
> Look at the bottom — this is the key insight of this entire presentation. The solution is to give the LLM **three superpowers**:
>
> **Tools** — let it call APIs, run code, access databases. **Memory** — let it remember context across interactions. And **Autonomy** — let it plan multi-step tasks and self-correct when things go wrong.
>
> When you combine an LLM with Tools, Memory, and Autonomy... you get an **Agent**.

**[~2 minutes]**

---

## SLIDE 4 — What is an AI Agent?

> So here's the architecture of an AI Agent.
>
> At the center you have the **LLM** — it's still there, it's still the brain. But now it's the *reasoning engine* inside a larger system. It understands intent, makes decisions, and — critically — it can self-correct.
>
> Notice the four core capabilities: Perceive, Reason, Plan, Act. That's the cycle an agent goes through.
>
> On the left side, you have **Tools** — this is what the agent can DO. It can call APIs, execute code, read and write files, query databases, search the web, send messages. These are its hands.
>
> On the right side, you have **Memory** — this is what the agent KNOWS beyond the current conversation. Conversation history, prior decisions it made, knowledge retrieved from external sources, user preferences, the current state of whatever task it's working on, and even long-term learned facts.
>
> At the bottom you see the **Environment** — everything the agent interacts with. File systems, databases, APIs, browsers, terminals, cloud services, and us — the users.
>
> And here's the equation that ties it all together: **Agent = LLM + Tools + Memory + Environment**. That's the formula. It's an LLM that can actually do things.

**[~1.5 minutes]**

---

## SLIDE 5 — How Agents Work: The Agent Loop

> Now let's look at HOW an agent actually works. This is the core pattern — the Agent Loop. Every agent framework implements some version of this.
>
> **Step 1: Perceive.** The agent receives input. That could be your initial request, or it could be the result of a tool it just called, or a change in the environment. The question it's asking is: "What just happened?"
>
> **Step 2: Reason.** The LLM analyzes the situation. What's my goal? What do I know so far? What information am I missing? This is pure LLM reasoning at work.
>
> **Step 3: Plan.** Based on that reasoning, break the task into steps. What tools do I need? What order should I do things in? What's my approach?
>
> **Step 4: Act.** Execute the next step. Call a tool, write some code, query a database, send a message. This is where the agent actually does something in the real world.
>
> **Step 5: Observe.** Read the result. Did the tool call succeed? Did I get an error? Is there new data I didn't have before?
>
> **Step 6: Reflect.** Am I done? Do I need to retry? Should I change my plan? This is the self-correction step.
>
> And then — look at the bottom — it **loops back** to step 1. Each iteration gets closer to the goal. The agent decides when to stop.
>
> This is why agents are so powerful. Three key properties: they're **self-correcting** — if something fails, they try a different approach. They're **multi-step** — complex tasks get broken down and executed piece by piece. And they're **autonomous** — no human is needed between steps.

**[~2 minutes]**

---

## SLIDE 6 — 4 Agentic Design Patterns

> Now, there are four established patterns for building agents. Think of these as building blocks you can mix and match.
>
> **First: Reflection.** The agent reviews its own output before delivering it. Generate something, then critique it — "Is this correct? Did I miss anything?" — find gaps, revise, and deliver a polished result. This is huge for code review, writing, and QA tasks. Example: "Write unit tests, then review them yourself for edge cases."
>
> **Second: Tool Use.** This is the one we've been talking about. The agent decides which tools to call, calls them with the right parameters, processes the results, and decides whether to continue or it's done. Think data analysis, automation. Example: "Look up the customer record, then check their recent orders."
>
> **Third: Planning.** For complex tasks, the agent first decomposes the work into sub-tasks, orders them by dependency, then executes step by step. If something fails, it re-plans. Great for research, project scoping. Example: "Migrate this API endpoint — plan the steps first before writing any code."
>
> **Fourth: Multi-Agent.** This is where it gets really interesting. Instead of one agent doing everything, you have specialized agents collaborating. A planner agent designs the approach. A coder agent implements. A reviewer agent checks the work. They hand off to each other, and an orchestrator manages the flow. This is used in software development, content pipelines, complex workflows.
>
> In practice, you combine these. A real agent might use Planning to break down a task, Tool Use to execute each step, and Reflection to verify its work.

**[~2.5 minutes]**

---

## SLIDE 7 — Agent in Action: A Real Example

> Let me make this concrete. Let's watch an agent handle a real scenario: someone says "There's a 500 error in prod, fix it."
>
> **Step 1 — Perceive:** The agent gets the user's request.
>
> **Step 2 — Plan:** It immediately breaks this down. I need to: check the logs, find the error, read the code, fix it, test it, and notify the team. Six sub-tasks, planned in advance.
>
> **Step 3 — Act: Search logs.** It calls a log search tool — "find me 500 errors from the last hour." Gets back a result: NullPointerError in /api/users, line 42.
>
> **Step 4 — Observe:** Now it has concrete information. It knows the file and line number.
>
> **Step 5 — Act: Read code.** It calls a file read tool, reads api/users.py around line 42.
>
> **Step 6 — Reason:** It reads the code and identifies the issue — user.email is being accessed before a null check.
>
> **Step 7 — Act: Fix code.** Calls an edit tool, adds the null check.
>
> **Step 8 — Act: Run tests.** Calls the test runner — all tests pass.
>
> **Step 9 — Act: Notify.** Sends a Slack message to the dev channel: "Fixed NullPointer in /api/users."
>
> **Step 10 — Done.** Reports back: "Fixed! Added null check, tests pass, team notified."
>
> Look at the right side — five different tools were used. Log search, file read, file edit, test runner, Slack. Each one was a custom integration.
>
> And that's the problem at the bottom right. Each of those tools had to be custom-built for this specific agent. What if there was a **standard way** to connect any tool to any AI? That's exactly what MCP solves.

**[~2.5 minutes]**

---

## SLIDE 8 — What is MCP?

> Alright, MCP — Model Context Protocol. Let me start with an analogy.
>
> **Before USB-C**, every device had its own charger. Your phone used Micro-USB, your Apple device used Lightning, your laptop had some barrel jack. Drawer full of cables, and none of them were interchangeable.
>
> **After USB-C** — one universal port. Any device, any charger. Just works.
>
> **MCP is USB-C for AI.** One protocol. Any AI app. Any tool.
>
> Technically, it's an open standard created by Anthropic, but adopted industry-wide — GitHub, Google, Microsoft, everyone is supporting it. It uses JSON-RPC 2.0 — a lightweight request-response protocol. It supports two transports: stdio for local processes and HTTP+SSE for remote servers. It has built-in discovery — the AI automatically finds out what tools are available. And it's stateful — it maintains a session between the AI and the tools.
>
> Now look at the bottom — this is the key visual. **Without MCP**, you have N AI apps and M tools, and you need N times M custom integrations. Every app has to build its own connector to every tool. That's the mess of red lines you see.
>
> **With MCP**, every AI app speaks one protocol to the MCP hub, and every tool speaks one protocol on the other side. N plus M integrations instead of N times M. Build your tool connector once, and it works with Copilot, Cursor, Claude, any MCP-compatible app. That's a massive reduction in complexity.

**[~2 minutes]**

---

## SLIDE 9 — MCP Architecture

> Let's look at how MCP is structured. There are four layers.
>
> **Layer 1: The Host.** This is your AI application — VS Code with Copilot, Cursor, or a custom app you build. The host contains the LLM and manages everything.
>
> **Layer 2: MCP Clients.** Inside the host, there's one client per server connection. Each client maintains a one-to-one session with a server, communicating over JSON-RPC 2.0. The transport can be stdio for local processes or HTTP for remote ones.
>
> **Layer 3: MCP Servers.** This is where the magic happens. Each server wraps a specific tool or data source and exposes it in a standard way. A GitHub server exposes functions like search_code, create_pr, list_issues. A Database server exposes query, get_schema, insert_row. A custom server can expose whatever you need — deploy, check_status, rollback.
>
> **Layer 4: External Services.** The actual APIs, databases, and cloud services that the MCP servers talk to under the hood.
>
> At the bottom, you see the three **MCP Primitives** — the three types of things a server can expose:
>
> **Tools** — functions the AI can call to perform actions. Like create_issue or send_message.
> **Resources** — data the AI can read for context. Like file contents, database schemas, config values. These are read-only.
> **Prompts** — reusable instruction templates. Like "summarize this PR" or "triage this bug."
>
> The beauty of this architecture is that everything is decoupled. The LLM doesn't need to know how GitHub's API works. It just sees a tool called "create_issue" with parameters, and the MCP server handles the rest.

**[~2 minutes]**

---

## SLIDE 10 — What Can Become an MCP Server?

> This is my favorite slide. The answer to "what can become an MCP server?" is: **almost everything**.
>
> The rule of thumb is simple: if it has an API, a CLI, or data — it can be an MCP server.
>
> **Dev Tools** — GitHub, GitLab, Jira, Linear, your CI/CD pipelines, Docker, Kubernetes, Terraform. Anything your developers touch daily.
>
> **Databases** — PostgreSQL, MySQL, MongoDB, DynamoDB, Redis, Elasticsearch, S3, your data warehouse. Any data source you query.
>
> **Communication** — Slack, Teams, email via SMTP or Microsoft Graph, Confluence, Notion, calendar systems, PagerDuty. Any channel your team communicates on.
>
> **Cloud & Infrastructure** — AWS services, Azure, GCP, monitoring tools like Datadog, log systems like Splunk, DNS, CDNs, load balancers. Anything you manage in your infrastructure.
>
> **Internal Tools** — your admin dashboards, CRM like Salesforce, HR systems, billing and payments, and — this is a big one — any custom REST API you've already built. If you have an internal API, you can wrap it in MCP.
>
> **Knowledge** — documentation sites, wikis, runbooks, code repositories, PDFs and Office documents, and vector databases for RAG. Any knowledge your team needs access to.
>
> Think about what your team uses every day. How many of those could be MCP servers that an agent can call? The answer is probably: most of them.

**[~2 minutes]**

---

## SLIDE 11 — Build an MCP Server: From Idea to Working Code

> So how do you actually build one? There's a five-step pattern.
>
> **Step 1: Identify.** Pick a tool your team uses that has an API. For this example, let's use Jira.
>
> **Step 2: Map.** What are the top operations? For Jira: get my tickets, create a ticket, read the current sprint. Those become your tools and resources.
>
> **Step 3: Code.** Write a FastMCP server. Look at the code on the right — it's a thin wrapper. You import FastMCP, connect to Jira's API, and use the `@mcp.tool()` decorator to expose each function. `get_my_tickets` searches Jira. `create_ticket` creates an issue. `current_sprint` is a resource that returns what's in the sprint. That's about 50 lines of Python.
>
> **Step 4: Config.** Add it to your VS Code settings.json — just tell it where the server is and how to run it. That's the small code block at the bottom right.
>
> **Step 5: Use.** Now open Copilot Chat and just ask in plain English. "Show my in-progress tickets." "Create a bug for the login crash." "What's in our current sprint?" "Create tickets for each TODO in this file."
>
> Copilot auto-discovers your tools through MCP and calls them when needed. 50 lines of Python, and suddenly your AI assistant can manage your Jira board.

**[~2 minutes]**

---

## SLIDE 12 — End-to-End: Agent + MCP in Action

> Let's put it all together with a real scenario. You open Copilot and say: "Triage all new bugs — check severity, assign to the right developer, and notify on Slack."
>
> Watch what happens:
>
> **Step 1:** You type that into Copilot Chat.
>
> **Step 2:** The agent plans — it breaks this into sub-tasks: fetch new bugs, analyze each one, assign them, notify the team.
>
> **Step 3:** It calls the **Jira MCP server** — get_my_tickets with status "New." Gets back 8 unassigned bugs.
>
> **Step 4:** The LLM reads each bug's title and description, infers severity and which component it belongs to, and figures out who should own it.
>
> **Step 5:** It calls the **Jira MCP server** again — transition_ticket for each bug, assigning them and moving them to "In Progress."
>
> **Step 6:** It calls the **Slack MCP server** — sends a summary message to the #dev channel.
>
> **Step 7:** Reports back to you: "Done! 8 bugs triaged — 2 critical assigned to Alice, 6 normal distributed across the team. Team notified on Slack."
>
> Look at the architecture on the right. You talked to Copilot. Copilot's agent reasoned and planned. The MCP client routed to the right servers. The Jira server talked to the Jira API. The Slack server talked to the Slack API. Each server is independent and reusable.
>
> That's the power of Agent plus MCP. You describe what you want in English, and the system figures out the rest.

**[~2 minutes]**

---

## SLIDE 13 — Start Building Today

> So what should you do next? Here's a practical plan.
>
> **This week:** Install the MCP Python SDK — it's just `pip install mcp`. Build a hello-world server — it takes about 15 minutes. Connect it to VS Code Copilot and see it work.
>
> **Next week:** Pick ONE tool your team uses daily — Jira, your database, an internal API. Map its top 3-5 operations. Build the MCP server and share it with the team.
>
> **Month one:** Add 2-3 more servers. Maybe your database, Slack, and your CI/CD pipeline. Start combining them — that's when you get multi-tool agent workflows where one request triggers actions across multiple systems.
>
> On the right you have all the resources you need. The MCP official docs at modelcontextprotocol.io. The Python and TypeScript SDKs on GitHub. Over a thousand pre-built servers you can use right away — check those before building from scratch. VS Code MCP setup docs. And the Copilot Agent Mode documentation.
>
> The quickstart at the bottom is literally two commands. Install MCP and verify it works.
>
> The key takeaway: **you don't need to build everything from scratch.** There's probably already an MCP server for GitHub, Slack, PostgreSQL, and most popular tools. Start by plugging those in. Then build custom servers only for your internal tools.
>
> Questions? Let's discuss, and then we can do some hands-on building together.

**[~2 minutes]**

---

## Total estimated time: ~25 minutes (without Q&A)
