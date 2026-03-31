"""Regenerate audio at faster rate with tighter scripts."""
import asyncio, os
import edge_tts

AUDIO_DIR = r"c:\MyProjects\AWS\Prompt2TestUI\slides_audio"
VOICE = "en-US-GuyNeural"
RATE = "+15%"

SCRIPTS = [
# Slide 1
"""Hey everyone, thanks for joining. Today we're covering three concepts changing how we build with AI.
We'll go from LLMs, to Agents, to MCP, the Model Context Protocol, which connects AI to all your tools.
By the end, you'll know not just what these are, but how to build with them. Let's go.""",

# Slide 2
"""What is an LLM? Think of it as a flow. Input on the left, model in center, output on right.
You type natural language, like summarize this document or write a Python function.
The LLM, whether GPT-4o, Claude, or Gemini, has been trained on trillions of words with billions of parameters. Its core task? Predict the next word.
From that simple mechanism, it understands context, catches nuance, and generates coherent text.
But here's the key limitation. LLMs only generate text. They cannot browse the web, read your files, call APIs, or take any action. They're a brain in a jar. Smart, but disconnected.""",

# Slide 3
"""Let's be clear about the gap. LLMs CAN generate text, reason through problems, understand context, and draw on training knowledge.
But they CANNOT access live data, read your files or databases, take real-world actions, or execute code.
The solution? Give the LLM three superpowers. Tools to call APIs. Memory to remember context. Autonomy to plan and self-correct.
LLM plus Tools plus Memory plus Autonomy equals Agent.""",

# Slide 4
"""Here's an Agent's architecture. At center, the LLM as reasoning engine. It perceives, reasons, plans, and acts.
On the left, Tools. What the agent can DO. Call APIs, execute code, query databases, send messages.
On the right, Memory. What the agent KNOWS. Conversation history, prior decisions, retrieved knowledge.
At bottom, the Environment it interacts with. File systems, databases, APIs, cloud services.
The equation: Agent equals LLM plus Tools plus Memory plus Environment.""",

# Slide 5
"""How does an agent work? The Agent Loop.
Perceive, receive input. Reason, analyze the situation. Plan, break into steps. Act, execute with a tool. Observe, check the result. Reflect, am I done or should I loop?
Then back to step 1. Each iteration gets closer to the goal.
Three key properties: self-correcting, multi-step, and autonomous.""",

# Slide 6
"""Four design patterns for agents.
Reflection: review your own output, critique it, revise, deliver polished work. Great for code review.
Tool Use: decide which tool to call, process results, continue or stop. Think automation.
Planning: decompose complex tasks, order by dependency, execute step by step.
Multi-Agent: specialized agents collaborate. Planner, Coder, Reviewer, each doing their part.
In practice, you combine these patterns together.""",

# Slide 7
"""A real example. Someone says: 500 error in prod, fix it.
Agent plans: check logs, find error, read code, fix, test, notify.
Calls log search, finds NullPointerError at line 42. Reads the code. Identifies missing null check.
Edits the file. Runs tests, all pass. Sends Slack notification.
Reports: Fixed, tests pass, team notified. Five tools used.
But each was custom-built. What if there was a standard way? That's MCP.""",

# Slide 8
"""MCP, Model Context Protocol.
Think USB-C. Before it, every device had its own charger. After? One universal port.
MCP is USB-C for AI. One protocol. Any AI app. Any tool.
Open standard by Anthropic, adopted industry-wide. JSON-RPC protocol. Auto-discovers tools.
Without MCP: N times M custom integrations. With MCP: N plus M. Build once, works everywhere.""",

# Slide 9
"""MCP architecture has four layers.
Host, your AI app like VS Code Copilot. Clients, one per server connection. Servers, each wrapping a tool or data source. External services, the actual APIs.
Three primitives: Tools for actions, Resources for read-only data, Prompts for reusable templates.
The LLM just sees tool names and parameters. MCP servers handle the rest.""",

# Slide 10
"""What can become an MCP server? Almost everything.
If it has an API, CLI, or data, it qualifies.
Dev tools like GitHub and Jira. Databases like PostgreSQL and MongoDB. Communication like Slack and email. Cloud services like AWS and Datadog. Internal tools and custom APIs. Knowledge bases, wikis, and docs.
Think about what your team uses daily. Most of it can be an MCP server.""",

# Slide 11
"""Building one takes five steps.
Identify a tool with an API. Map its top operations. Code a FastMCP server, about 50 lines of Python. Add config to VS Code settings. Then just ask Copilot in plain English.
Show my tickets. Create a bug. What's in the sprint? Copilot auto-discovers your tools through MCP.""",

# Slide 12
"""Full example. Tell Copilot: triage new bugs, assign to the right dev, notify on Slack.
Agent calls Jira MCP, gets 8 bugs. Analyzes each, assigns owners. Calls Jira again to transition. Calls Slack to notify.
Done. 8 bugs triaged, 2 critical to Alice, 6 normal distributed. Each MCP server is independent and reusable.""",

# Slide 13
"""What's next? This week: pip install mcp, build a hello-world server, connect to VS Code.
Next week: pick one tool your team uses, build the MCP server, share it.
Month one: add more servers, combine them for multi-tool workflows.
Key takeaway: over a thousand pre-built MCP servers exist. Start there. Build custom only for internal tools.
Thanks everyone! Let's do questions and hands-on building.""",
]

async def main():
    # Clean old audio
    for f in os.listdir(AUDIO_DIR):
        if f.endswith(".mp3"):
            os.remove(os.path.join(AUDIO_DIR, f))

    for i, script in enumerate(SCRIPTS):
        path = os.path.join(AUDIO_DIR, f"slide_{i+1:02d}.mp3")
        for attempt in range(5):
            try:
                c = edge_tts.Communicate(text=script.strip(), voice=VOICE, rate=RATE)
                await c.save(path)
                print(f"Slide {i+1} done")
                break
            except Exception as e:
                print(f"Slide {i+1} retry {attempt+1}...")
                await asyncio.sleep(3 * (attempt + 1))
        await asyncio.sleep(0.5)

asyncio.run(main())
