# Woody User Manual

Welcome to Woody: your workspace for creating AI agents, giving them trusted
knowledge, running tasks, connecting approved tools, and turning repeatable
work into controlled workflows.

Open Woody at `http://localhost:3002` after starting the app.

## What Woody does

Woody helps you organise AI work instead of relying on one long chat. A normal
working flow is:

1. Add knowledge your agents can use.
2. Create one or more specialised agents.
3. Give an agent a well-defined task.
4. Review the result, event trace, token use, and downloadable files.
5. Turn a successful repeated process into a workflow.

Woody does not replace your judgment. Keep a human approval step before any
important external action, such as sending a message, changing data, publishing
content, or calling a write-capable tool.

## Your first 15 minutes

### 1. Complete onboarding

When you first sign in, Woody shows onboarding. It introduces the workspace and
helps you create a first agent and task. You can skip it and resume it later
from **Settings**.

### 2. Create one focused agent

Open **Agents** and select **Create Agent** or open **Builder**.

Give the agent:

- A clear name, such as `Market Researcher`.
- A role, such as `Research analyst`.
- A goal, such as `Find reliable evidence and turn it into concise business recommendations.`
- Instructions that define quality, boundaries, output format, and what to do
  when information is missing.

Keep early agents narrow. A research agent, a writer, and a reviewer are easier
to improve than one agent asked to do everything.

Make sure the agent status is **active** before assigning a task.

### 3. Run a first task

Open **Logs** and select **Run task**. Choose an active agent, enter a short
title, and describe the desired outcome.

Good task request:

> Research the Malaysian specialty coffee market. Give me a short summary,
> five competitors, risks, opportunities, and links or named sources to verify.

The execution page shows the task status, activity timeline, output, token use,
estimated cost, and any errors.

## Writing useful task briefs

For important work, include these five parts:

```text
Goal: What final result do I want?
Context: What background, market, audience, or constraints matter?
Deliverable: What exact structure or file should be returned?
Quality bar: What makes this acceptable?
Boundaries: What must not be assumed, changed, sent, or published?
```

Example:

```text
Goal: Create a client-ready launch plan.
Context: We sell premium home coffee equipment in Malaysia.
Deliverable: A Markdown plan with timeline, owner, budget assumptions and risks.
Quality bar: Be concise, distinguish facts from assumptions, and name missing information.
Boundaries: Do not invent market statistics or contact customers.
```

## Knowledge Hub: give agents trusted context

Open **Knowledge Base** to add documents that agents can retrieve while working.

You can upload PDF, DOCX, Excel, CSV, TXT, Markdown, and image files up to
25 MB, or choose **Add text document** to paste a policy, handbook, notes, or
brief.

After upload, wait for the document status to become **ready**. Use the search
box to confirm that Woody extracted the text you expect.

Knowledge is workspace-wide today. Any agent with its **Knowledge Base**
capability enabled can retrieve relevant passages. It is not yet a separate
private knowledge collection per agent.

For best results:

- Use clean, trustworthy documents.
- Split very large handbooks into logical documents.
- Give documents clear names.
- Ask the agent to use the knowledge base and identify uncertainty.
- Do not upload secrets you would not want available to other agents in the
  same workspace.

Knowledge reduces unnecessary prompt repetition because Woody retrieves only
relevant passages rather than sending every document to the model on every task.

## Downloadable PDF, Word, PowerPoint, and Excel outputs

When creating a task, use **Downloadable output** to request any combination of:

- PDF
- DOCX (Microsoft Word)
- PPTX (PowerPoint)
- XLSX (Excel)

Woody first stores the normal agent result as Markdown or JSON. After the task
finishes, it creates the selected files in the background. This keeps the real
agent output visible and avoids trusting a model-generated binary file.

In the task detail under **Downloadable files**:

- **queued** or **generating** means the file is still being created.
- **ready** means you can download it.
- PDF has a preview button.
- Word, PowerPoint, and Excel files download and open in their usual apps.
- **failed** shows a readable error. Select that format again and use
  **Generate selected** to retry.

You can also ask for a file in your task request, for example: “Deliver this as
a PDF and PowerPoint.” Woody can recognise many direct file requests, but use
the format checkboxes when the file type matters.

## Workflows: automate a repeatable process

Open **Workflows** when you have a process that has worked well several times.
A workflow is a saved chain of controlled steps, not a free-form autonomous
loop.

### Main workflow nodes

| Node | Use it for |
|---|---|
| Trigger | Starting the workflow manually. |
| Agent | Giving a defined part of the job to an agent. |
| Tool action | Calling an approved API tool. |
| Condition | Sending the workflow down a true or false path. |
| Loop | Repeating over a list or while a condition is true, within a limit. |
| Approval | Pausing for a person to approve or reject the next step. |
| Output | Returning the final result and optionally generating files. |

### Build a simple workflow

1. Give the workflow a name and description.
2. Add an **Agent** node and choose an active agent.
3. Connect `trigger → agent → output`.
4. In the Output node, choose whether to return all workflow state or a result
   from one specific node.
5. Select PDF, DOCX, PPTX, or XLSX if the workflow should generate files.
6. Save the workflow.
7. Select **Prepare run**, enter the input JSON, and run it.

For a loop that processes a list, add a Loop node configured with a path such as
`input.items`. It requires three explicit connections:

```text
loop --body--> work step
loop --done--> output
work step --continue--> loop
```

Loops are deliberately limited to 100 iterations or fewer. This prevents a
mistake from running indefinitely or consuming unexpected model usage.

### Workflow safety rules

- Conditions require exactly one **true** and one **false** connection.
- Loops require **body**, **done**, and a return **continue** connection.
- Retries are limited to five attempts with bounded delays.
- Write-capable tools must come directly after a human Approval node.
- Write-capable tools cannot retry automatically.
- Arbitrary cycles and self-loops are blocked.

Every run records its node attempts, branches, approvals, loop iterations,
errors, and generated files. Use this trace to understand what happened before
changing the workflow.

## Tools and MCP Marketplace

**Tools** are API connections created for this workspace. **MCP** connections
are external tool servers using the Model Context Protocol. They are related,
but they run differently.

Open **MCP Marketplace** to:

1. Browse a registry server or add a custom HTTPS Streamable HTTP endpoint.
2. Configure authentication without exposing the secret in the browser.
3. Test the connection and discover its tools.
4. Enable only tools you actually need.
5. Assign the connection to specific agents.
6. Choose read-only or read/write access.
7. Select an explicit per-agent tool allowlist.

Use the smallest possible access level. Start with read-only tools, test one
agent, and review the activity log. Unknown, destructive, and external write
actions require explicit confirmation.

If an allowlist is empty, first test and discover the MCP server, then enable
the individual read-only tools. Disabled or undiscovered tools cannot be
assigned to an agent.

## Starter Solutions and Woody chat

Open **Starter Solutions** when you want a working starting team for a common
job. You can review the suggested agents, edit their instructions, and install
the solution into your workspace.

Woody chat is your advisory assistant. Use it to think through an agent design,
improve a prompt, choose a workflow, or explain an error. It does not silently
create agents, run workflows, or send external actions on your behalf.

## Settings, limits, and costs

Open **Settings** to choose light or dark mode, restart onboarding, and set
workspace AI usage limits.

Owners and administrators can set:

- Monthly model-call limit.
- Monthly token limit.
- Monthly estimated-cost limit.
- A warning threshold.
- A hard limit that blocks new work after the configured maximum is reached.

Woody can show provider rate-limit or credit information only if your AI
provider supplies safe values in its API responses. Otherwise it shows Woody’s
own tracked usage and estimated cost.

## Common problems

### My task will not start

- Confirm the chosen agent is active.
- Check the AI budget in Settings.
- Open Logs and read the task event timeline for the specific error.
- Confirm Docker services are running if you use the local app.

### My knowledge document stays queued

- Refresh the Knowledge Base.
- Check that the file type is supported and under 25 MB.
- Use a text-based PDF; scanned PDFs or complex layouts can extract poorly.

### My file output failed

- Open the task’s Downloadable files section and read the failure message.
- Retry only the failed format with **Generate selected**.
- Check that the source task has a normal text or Markdown result.

### My MCP tool cannot be used

- Test the connection first.
- Discover tools and enable the required one.
- Assign the connection to the intended agent.
- Save a non-empty allowlist.
- Check the agent permission level and whether confirmation is waiting.

### My workflow cannot be saved

- Check every node is reachable from the trigger.
- Check condition and loop connection labels.
- Add an Approval node immediately before write-capable tools.
- Reduce invalid retry or loop limits.

## Recommended way to grow Woody

Start with one agent and one real task. Improve the task brief and agent
instructions after reviewing the result. Add knowledge when the work needs
stable internal context. Create a workflow only after the process succeeds a
few times manually. Connect external tools last, with least privilege and
approval.

That sequence makes Woody more reliable, easier to understand, and less costly
to run.

## Current product boundaries

- Knowledge is workspace-wide; private per-agent collections are not available
  yet.
- PDF can preview inside Woody; DOCX, PPTX, and XLSX download to native apps.
- Direct file attachment to a single task/chat is not available yet. Upload
  material through Knowledge Base instead.
- Workflows do not yet support sub-workflows or parallel joins.
- Remote Streamable HTTP is the current MCP transport; local stdio MCP servers
  are not yet supported.

For technical setup and Docker commands, see [README.md](README.md). For a
deeper guide to improving your own agent work, see
[AI_NEXUS_WORK_GUIDE.md](AI_NEXUS_WORK_GUIDE.md).
