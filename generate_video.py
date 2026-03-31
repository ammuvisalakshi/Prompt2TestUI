"""Generate video: PPT slides + edge-tts voice narration -> MP4."""

import asyncio, os, glob, time
import edge_tts
from moviepy import ImageClip, AudioFileClip, concatenate_videoclips

# ── Paths ──
BASE = r"c:\MyProjects\AWS\Prompt2TestUI"
PPTX = os.path.join(BASE, "AI_Agents_MCP_Agentic_Workflows.pptx")
SLIDES_DIR = os.path.join(BASE, "slides_img")
AUDIO_DIR = os.path.join(BASE, "slides_audio")
OUTPUT = os.path.join(BASE, "AI_Agents_MCP_Agentic_Workflows.mp4")

os.makedirs(SLIDES_DIR, exist_ok=True)
os.makedirs(AUDIO_DIR, exist_ok=True)

# ── Voice config ──
VOICE = "en-US-GuyNeural"  # Professional male voice
RATE = "+15%"               # Faster, more energetic delivery

# ── Narration scripts (one per slide) ──
SCRIPTS = [
    # Slide 1 - Title
    """Hey everyone, thanks for joining. Today I want to walk you through three concepts
that are fundamentally changing how we build software with AI.

We're going to take a journey, starting with LLMs - the foundation,
then understanding what an Agent is and why it matters,
and finally diving deep into MCP, the Model Context Protocol,
which is the glue that connects AI to everything we use.

By the end of this session, you'll understand not just what these things are,
but how to actually build with them. Let's get into it.""",

    # Slide 2 - What is an LLM
    """Let's start with the basics. What is an LLM, a Large Language Model?

Think of it as a flow. You have an input on the left, the model in the center, and an output on the right.

The input is just natural language. You type something like "summarize this document" or
"write a Python function to sort a list." Plain English.

In the center is the LLM itself. GPT-4o, Claude, Gemini, Llama - these are all examples.
Under the hood, it's been trained on trillions of words from books, the web, and code.
It has billions of parameters, think of them as knobs that got tuned during training.
And its core task is deceptively simple: predict the most likely next word.

That's it. That's all it does. Next token prediction.
But from that simple mechanism, something remarkable emerges.
It understands context, catches nuance, and generates remarkably coherent text.

On the right you see the output. A summary, working code, an explanation, an email. Impressive, right?

But here's the critical thing. Look at the bottom callout.
LLMs only generate text. They cannot browse the internet.
They cannot read your files. They cannot call an API.
They cannot take any action in the real world.
They are a brain in a jar. Incredibly smart, but completely disconnected from everything around it.

And that limitation is exactly what sets up our next topic.""",

    # Slide 3 - The Gap
    """So let's be really clear about what this gap looks like.

On the left, what LLMs CAN do. They're phenomenal at generating text, code, and summaries.
They can reason through complex multi-step problems.
They understand context and intent, reading between the lines.
And they have a massive knowledge base from their training data.

But on the right, what they CANNOT do. And this is where it gets painful.

They can't access live data. Their training has a cutoff date, so they don't know what happened yesterday.
They can't read your files, your databases, your internal systems.
They literally cannot see anything outside of what you paste into the prompt.
They can't take actions. Can't send an email, can't create a Jira ticket, can't deploy your code.
And here's the ironic one. They can WRITE code beautifully, but they cannot RUN it.

So how do we bridge this gap?

Look at the bottom. This is the key insight of this entire presentation.
The solution is to give the LLM three superpowers:

Tools. Let it call APIs, run code, access databases.
Memory. Let it remember context across interactions.
And Autonomy. Let it plan multi-step tasks and self-correct when things go wrong.

When you combine an LLM with Tools, Memory, and Autonomy, you get an Agent.""",

    # Slide 4 - What is an Agent
    """So here's the architecture of an AI Agent.

At the center you have the LLM. It's still there, it's still the brain.
But now it's the reasoning engine inside a larger system.
It understands intent, makes decisions, and critically, it can self-correct.

Notice the four core capabilities: Perceive, Reason, Plan, Act.
That's the cycle an agent goes through.

On the left side, you have Tools, this is what the agent can DO.
It can call APIs, execute code, read and write files, query databases,
search the web, send messages. These are its hands.

On the right side, you have Memory, this is what the agent KNOWS beyond the current conversation.
Conversation history, prior decisions, retrieved knowledge, user preferences,
and the current state of whatever task it's working on.

At the bottom you see the Environment, everything the agent interacts with.
File systems, databases, APIs, browsers, terminals, cloud services, and us, the users.

And here's the equation that ties it all together:
Agent equals LLM plus Tools plus Memory plus Environment.
That's the formula. It's an LLM that can actually do things.""",

    # Slide 5 - The Agent Loop
    """Now let's look at HOW an agent actually works. This is the core pattern. The Agent Loop.
Every agent framework implements some version of this.

Step 1: Perceive. The agent receives input.
That could be your initial request, or the result of a tool it just called.
The question it's asking is: "What just happened?"

Step 2: Reason. The LLM analyzes the situation.
What's my goal? What do I know so far? What information am I missing?

Step 3: Plan. Based on that reasoning, break the task into steps.
What tools do I need? What order should I do things in?

Step 4: Act. Execute the next step.
Call a tool, write some code, query a database, send a message.
This is where the agent actually does something in the real world.

Step 5: Observe. Read the result.
Did the tool call succeed? Did I get an error? Is there new data?

Step 6: Reflect. Am I done? Do I need to retry? Should I change my plan?

And then, it loops back to step 1. Each iteration gets closer to the goal.
The agent decides when to stop.

This is why agents are so powerful.
They're self-correcting. If something fails, they try a different approach.
They're multi-step. Complex tasks get broken down and executed piece by piece.
And they're autonomous. No human is needed between steps.""",

    # Slide 6 - 4 Design Patterns
    """Now, there are four established patterns for building agents.
Think of these as building blocks you can mix and match.

First: Reflection. The agent reviews its own output before delivering it.
Generate something, then critique it. Is this correct? Did I miss anything?
Find gaps, revise, and deliver a polished result.
This is huge for code review, writing, and QA tasks.

Second: Tool Use. The agent decides which tools to call, calls them with the right parameters,
processes the results, and decides whether to continue or stop.
Think data analysis and automation.

Third: Planning. For complex tasks, the agent first decomposes the work into sub-tasks,
orders them by dependency, then executes step by step.
If something fails, it re-plans. Great for research and project scoping.

Fourth: Multi-Agent. Instead of one agent doing everything,
you have specialized agents collaborating.
A planner agent designs the approach. A coder agent implements.
A reviewer agent checks the work. They hand off to each other.

In practice, you combine these patterns. A real agent might use Planning to break down a task,
Tool Use to execute each step, and Reflection to verify its work.""",

    # Slide 7 - Agent in Action
    """Let me make this concrete. Let's watch an agent handle a real scenario.
Someone says: "There's a 500 error in production, fix it."

Step 1: The agent gets the user's request.

Step 2: It plans. Check the logs, find the error, read the code, fix it, test it, notify the team.

Step 3: It calls a log search tool. "Find me 500 errors from the last hour."
Gets back: NullPointerError in api/users, line 42.

Step 4: Now it has concrete information. It knows the file and line number.

Step 5: It reads the source code at that location.

Step 6: It identifies the issue. User dot email is being accessed before a null check.

Step 7: It edits the file, adds the null check.

Step 8: Runs the tests. All pass.

Step 9: Sends a Slack message to the dev channel: "Fixed NullPointer in api/users."

Step 10: Reports back: "Fixed! Added null check, tests pass, team notified."

Five different tools were used. Log search, file read, file edit, test runner, and Slack.
Each one was a custom integration.

And that's the problem. What if there was a standard way to connect any tool to any AI?
That's exactly what MCP solves.""",

    # Slide 8 - What is MCP
    """Alright, MCP. Model Context Protocol. Let me start with an analogy.

Before USB-C, every device had its own charger.
Micro-USB, Lightning, barrel jacks. Drawer full of cables, none interchangeable.

After USB-C? One universal port. Any device, any charger. Just works.

MCP is USB-C for AI. One protocol. Any AI app. Any tool.

Technically, it's an open standard created by Anthropic, but adopted industry-wide.
GitHub, Google, Microsoft, everyone supports it.
It uses JSON-RPC 2.0, a lightweight protocol.
It supports stdio for local processes and HTTP for remote servers.
The AI automatically discovers what tools are available. And it maintains a stateful session.

Now look at the bottom. This is the key visual.
Without MCP, you have N AI apps and M tools, and you need N times M custom integrations.
Every app builds its own connector to every tool. That's the mess of red lines.

With MCP, every AI app speaks one protocol, and every tool speaks one protocol on the other side.
N plus M integrations instead of N times M.
Build your tool connector once, and it works with Copilot, Cursor, any MCP-compatible app.""",

    # Slide 9 - MCP Architecture
    """Let's look at how MCP is structured. There are four layers.

Layer 1: The Host. This is your AI application. VS Code with Copilot, Cursor, or a custom app.
The host contains the LLM and manages everything.

Layer 2: MCP Clients. Inside the host, there's one client per server connection.
Each client maintains a one-to-one session, communicating over JSON-RPC 2.0.

Layer 3: MCP Servers. This is where the magic happens.
Each server wraps a specific tool or data source and exposes it in a standard way.
A GitHub server exposes search code, create PR, list issues.
A Database server exposes query, get schema, insert row.

Layer 4: External Services. The actual APIs and databases that the MCP servers talk to.

At the bottom, you see the three MCP Primitives:

Tools, functions the AI can call to perform actions.
Resources, data the AI can read for context, these are read-only.
And Prompts, reusable instruction templates.

The beauty is that everything is decoupled. The LLM doesn't need to know how GitHub's API works.
It just sees a tool called "create issue" with parameters, and the MCP server handles the rest.""",

    # Slide 10 - What Can Become MCP
    """This is my favorite slide. The answer to "what can become an MCP server?" is: almost everything.

The rule is simple: if it has an API, a CLI, or data, it can be an MCP server.

Dev Tools: GitHub, GitLab, Jira, Linear, CI/CD pipelines, Docker, Kubernetes, Terraform.

Databases: PostgreSQL, MySQL, MongoDB, DynamoDB, Redis, Elasticsearch, S3, data warehouses.

Communication: Slack, Teams, email, Confluence, Notion, calendars, PagerDuty.

Cloud and Infrastructure: AWS services, Azure, GCP, Datadog, Splunk, DNS, CDNs.

Internal Tools: admin dashboards, CRM like Salesforce, HR systems, billing,
and any custom REST API you've already built.

Knowledge: documentation sites, wikis, runbooks, code repositories, PDFs, and vector databases.

Think about what your team uses every day.
How many of those could be MCP servers? The answer is probably: most of them.""",

    # Slide 11 - Build an MCP Server
    """So how do you actually build one? There's a five-step pattern.

Step 1: Identify. Pick a tool your team uses that has an API. For this example, Jira.

Step 2: Map. What are the top operations? Get my tickets, create a ticket, read the sprint.

Step 3: Code. Look at the code on the right. It's a thin wrapper using FastMCP.
You use the @mcp.tool decorator to expose each function.
Get my tickets searches Jira. Create ticket creates an issue.
Current sprint is a resource that returns sprint data. About 50 lines of Python.

Step 4: Config. Add it to your VS Code settings.json.
Just tell it where the server is and how to run it.

Step 5: Use. Open Copilot Chat and ask in plain English.
"Show my in-progress tickets." "Create a bug for the login crash."
"What's in our current sprint?"

Copilot auto-discovers your tools through MCP and calls them when needed.
50 lines of Python, and your AI assistant can manage your Jira board.""",

    # Slide 12 - End-to-End
    """Let's put it all together. You open Copilot and say:
"Triage all new bugs, check severity, assign to the right developer, and notify on Slack."

Step 1: You type that into Copilot Chat.

Step 2: The agent plans, breaking it into sub-tasks: fetch bugs, analyze, assign, notify.

Step 3: It calls the Jira MCP server. Get tickets with status "New." Returns 8 unassigned bugs.

Step 4: The LLM reads each bug, infers severity and the right owner.

Step 5: It calls Jira MCP again, transitioning each ticket and assigning it.

Step 6: It calls the Slack MCP server, posting a summary to the dev channel.

Step 7: Reports back: "Done! 8 bugs triaged. 2 critical assigned to Alice, 6 normal distributed. Team notified."

Look at the architecture on the right. You talked to Copilot.
Copilot's agent reasoned and planned. The MCP client routed to the right servers.
Each server is independent and reusable.
That's the power of Agent plus MCP.""",

    # Slide 13 - Start Building
    """So what should you do next? Here's a practical plan.

This week: Install the MCP Python SDK. Just "pip install mcp."
Build a hello-world server, it takes about 15 minutes. Connect it to VS Code Copilot.

Next week: Pick ONE tool your team uses daily. Jira, your database, an internal API.
Map its top 3 to 5 operations. Build the MCP server and share it with the team.

Month one: Add 2 to 3 more servers. Your database, Slack, your CI/CD pipeline.
Start combining them for multi-tool agent workflows.

On the right you have all the resources. The MCP docs at modelcontextprotocol.io.
Python and TypeScript SDKs. Over a thousand pre-built servers.
Check those before building from scratch.

The key takeaway: you don't need to build everything yourself.
There's probably already an MCP server for GitHub, Slack, PostgreSQL, and most popular tools.
Start by plugging those in. Build custom servers only for your internal tools.

Thanks everyone! Let's open it up for questions, and then we can do some hands-on building together.""",
]


# ── Step 1: Export PPT slides to images ──
def export_slides():
    """Use PowerPoint COM to export slides as PNG images."""
    print("Exporting slides to images...")
    import comtypes.client

    # Clean old images
    for f in glob.glob(os.path.join(SLIDES_DIR, "*.png")):
        os.remove(f)

    powerpoint = comtypes.client.CreateObject("PowerPoint.Application")
    powerpoint.Visible = 1

    pptx_path = os.path.abspath(PPTX)
    presentation = powerpoint.Presentations.Open(pptx_path, WithWindow=False)

    for i, slide in enumerate(presentation.Slides):
        img_path = os.path.join(SLIDES_DIR, f"slide_{i+1:02d}.png")
        slide.Export(os.path.abspath(img_path), "PNG", 1920, 1080)
        print(f"  Exported slide {i+1}")

    presentation.Close()
    powerpoint.Quit()
    print(f"  Done: {len(SCRIPTS)} slides exported\n")


# ── Step 2: Generate voice for each slide ──
async def generate_one_audio(i, script):
    """Generate audio for a single slide with retries."""
    audio_path = os.path.join(AUDIO_DIR, f"slide_{i+1:02d}.mp3")
    if os.path.exists(audio_path) and os.path.getsize(audio_path) > 1000:
        print(f"  Slide {i+1}: already exists, skipping")
        return

    for attempt in range(5):
        try:
            communicate = edge_tts.Communicate(
                text=script.strip(),
                voice=VOICE,
                rate=RATE
            )
            await communicate.save(audio_path)
            print(f"  Generated audio for slide {i+1}")
            return
        except Exception as e:
            wait = 3 * (attempt + 1)
            print(f"  Slide {i+1} attempt {attempt+1} failed: {e.__class__.__name__}. Retrying in {wait}s...")
            await asyncio.sleep(wait)
    print(f"  ERROR: Failed to generate audio for slide {i+1} after 5 attempts")


async def generate_audio():
    """Use edge-tts to generate natural voice narration."""
    print("Generating voice narration...")

    for i, script in enumerate(SCRIPTS):
        await generate_one_audio(i, script)
        await asyncio.sleep(1)  # small delay between requests

    print(f"  Done: audio generation complete\n")


# ── Step 3: Combine into video ──
def create_video():
    """Combine slide images + audio into final MP4."""
    print("Creating video...")

    clips = []
    for i in range(len(SCRIPTS)):
        img_path = os.path.join(SLIDES_DIR, f"slide_{i+1:02d}.png")
        audio_path = os.path.join(AUDIO_DIR, f"slide_{i+1:02d}.mp3")

        if not os.path.exists(img_path) or not os.path.exists(audio_path):
            print(f"  WARNING: Missing files for slide {i+1}, skipping")
            continue

        audio = AudioFileClip(audio_path)
        duration = audio.duration + 1.5  # 1.5s padding after narration

        clip = (
            ImageClip(img_path)
            .with_duration(duration)
            .resized((1920, 1080))
            .with_audio(audio)
        )
        clips.append(clip)
        print(f"  Slide {i+1}: {duration:.1f}s")

    print("\n  Concatenating clips...")
    final = concatenate_videoclips(clips, method="compose")

    print(f"  Writing video ({final.duration:.0f}s total)...")
    final.write_videofile(
        OUTPUT,
        fps=1,
        codec="libx264",
        audio_codec="aac",
        audio_bitrate="192k",
        preset="ultrafast",
        threads=4,
        logger="bar"
    )

    # Cleanup
    for clip in clips:
        clip.close()
    final.close()

    print(f"\nVideo saved: {OUTPUT}")
    print(f"Total duration: {final.duration:.0f} seconds ({final.duration/60:.1f} minutes)")


# ── Main ──
if __name__ == "__main__":
    print("=" * 60)
    print("  PPT + Voice -> Video Generator")
    print("=" * 60 + "\n")

    export_slides()
    asyncio.run(generate_audio())
    create_video()

    print("\nDone!")
