# Woody Workflow Copilot Proposal

## Product definition

Woody should be both:

1. A friendly visual desktop companion that explains what the system is doing.
2. A workspace-aware LLM copilot that helps a user design, test, operate, and improve agents and workflows.

Woody should not be another unrestricted agent. The recommended interaction model is:

```text
Discuss → Diagnose → Draft a structured plan → Validate → Estimate cost and permissions → User confirms → Apply → Test → Observe → Improve
```

Casual conversation is read-only. Creating or changing agents, workflows, knowledge, schedules, budgets, or tool permissions requires a visible draft and explicit confirmation.

## Architecture recommendation

### Recommended: copilot plus validated plan compiler

Woody chats naturally, but converts proposed changes into a typed `WorkflowPlan` before touching the system. The existing validators then check agent definitions, workflow structure, tools, permissions, approval gates, and output contracts. Applying a plan creates a versioned, auditable change set that can be tested and rolled back.

Advantages:

- Natural for a beginner.
- Safer than allowing chat messages to mutate the system directly.
- Every proposed agent, tool permission, workflow edge, budget, and schedule is visible before creation.
- Plans can be validated, cost-estimated, tested, versioned, and undone.
- The same plan format can later support templates and automation.

Trade-offs:

- Adds one confirmation step before changes.
- Requires structured plan schemas, plan storage, and an apply service.
- Slightly more development than a simple chat box.

### Alternative: direct-action chat

The chat calls create/update APIs immediately. This is faster to build, but it is easier to create duplicate agents, grant broad tool access, make expensive loops, or change a working workflow without a clear preview. This is not recommended.

### Alternative: fully autonomous orchestrator

Woody continuously changes and runs workflows on its own. This is powerful, but requires mature policy enforcement, evaluation, rollback, spend control, and supervision. It should be a later opt-in mode, not the first release.

## Proposed chat modes

- **Ask:** Explain the workspace, agents, runs, tools, errors, costs, and concepts. Read-only.
- **Design:** Interview the user and produce an agent/workflow plan. Read-only until confirmed.
- **Apply:** Create or update the approved plan through existing APIs. Always confirmed and audited.
- **Test:** Run a limited sandbox test with a budget and no unapproved external writes.
- **Operate:** Explain live runs, retry safe failures, and request approval for consequential actions.
- **Improve:** Compare results against success criteria and propose a new version rather than silently changing the current one.

## Minimum UI

- Persistent Woody button with idle, thinking, working, waiting-for-approval, success, and error states.
- Resizable chat panel available from every page.
- Context chip showing which page, agent, workflow, execution, or MCP connection Woody is discussing.
- Plan preview with agents, workflow nodes, tools, knowledge, permissions, output format, schedule, estimated tokens, and estimated cost.
- Separate **Apply plan**, **Run safe test**, and **Discard** buttons.
- Confirmation dialog showing the exact writes and external actions.
- Links from Woody's answers to the affected agent, workflow, execution, document, or setting.
- Conversation history scoped to the workspace, with rename, archive, export, and delete controls.

## Required quick-start interview

Woody should start with these questions and skip any already answered by the user's prompt:

1. What result do you want at the end?
2. Who will use or approve the result?
3. What information will the workflow receive, and where does it come from?
4. What exact deliverable should it produce: answer, Markdown, PDF, Word, PowerPoint, Excel, CSV, or another format?
5. When should it run: manually, on a schedule, after an event, or continuously?
6. How will we decide whether the result is correct and useful?
7. Which actions may it take, and which actions must always require your approval?
8. Which tools, MCP connections, and knowledge sources may it use?
9. What time, token, or cost limit should one run have?
10. Should we start with one agent or a small specialist team?

Woody then summarizes its understanding and asks: **“Is this correct before I design the workflow?”**

## Full adaptive workflow-design question bank

Woody should ask only relevant unanswered questions, normally three or fewer at a time.

### 1. Objective and context

1. What problem are you trying to solve?
2. What specific outcome should this workflow deliver?
3. Why is this outcome important now?
4. Who is the customer, reader, operator, or decision-maker?
5. What does the current manual process look like?
6. Which part currently takes the most time or causes the most errors?
7. What is explicitly outside the scope?
8. Is this a one-time job, recurring process, or reusable capability?
9. What would make this workflow not worth using?

### 2. Inputs and triggers

1. What starts the workflow?
2. Will the user type a request, upload files, select records, or trigger it from another system?
3. Which input fields are required?
4. Which inputs are optional?
5. What file types may be supplied?
6. What is the expected and maximum input size?
7. Can inputs contain confidential or personal information?
8. Can inputs be incomplete, inconsistent, duplicated, or outdated?
9. What should happen when required information is missing?
10. Should Woody ask follow-up questions before starting a run?

### 3. Knowledge and evidence

1. Which documents or knowledge collections should agents use?
2. Which sources are authoritative?
3. May agents use the public internet?
4. Must claims include citations or links?
5. How recent must information be?
6. How should conflicting sources be handled?
7. Should the agent state uncertainty and evidence gaps?
8. Are there sources it must never use?
9. Who maintains the knowledge, and how often is it reviewed?
10. Should a run fail if no reliable evidence is found?

### 4. Deliverable and artifact format

1. What exact output format is required?
2. Is the output for reading, presenting, editing, importing, or automation?
3. Is there a template, brand guide, workbook, slide deck, or example to follow?
4. What sections, sheets, slides, columns, or fields are mandatory?
5. What length or size should the result be?
6. What tone, reading level, and language should it use?
7. Should it include tables, charts, images, speaker notes, formulas, or appendices?
8. Should source citations appear inline, as footnotes, or in a references section?
9. What filename convention should be used?
10. Should Woody create one artifact or several related files?
11. Should the artifact be previewed before download?
12. Where should the final artifact be stored or sent?

### 5. Agent roles and team design

1. Can one agent reliably complete the job?
2. Which parts require different expertise?
3. Which agent should own the final answer?
4. Does the workflow need a researcher, analyst, writer, reviewer, data specialist, or tool operator?
5. What should each agent receive from the previous step?
6. Which agents may work in parallel?
7. Which agents must work sequentially?
8. Should one agent critique another agent's result?
9. Should the final agent reconcile disagreements?
10. What should each agent do when uncertain?
11. Which model and settings should each role use?
12. What is the maximum number of agents justified by the expected value?

### 6. Workflow logic

1. What are the major steps from input to final output?
2. Which conditions create different branches?
3. Are any steps optional?
4. Can any steps run simultaneously?
5. Where should human review occur?
6. Does any step need a loop?
7. What exact condition ends each loop?
8. What is the maximum loop count?
9. What data should be preserved between steps?
10. What should the output node return?
11. Should partial results be available if later steps fail?
12. Can a paused workflow resume safely without repeating external actions?

### 7. Tools and MCP connections

1. Which applications or services must the workflow access?
2. Which installed MCP connections already provide those capabilities?
3. Which exact tools does each agent need?
4. Can the access be read-only?
5. Which tools require read-write access?
6. Which actions create, edit, send, publish, purchase, delete, or share something externally?
7. Which destructive or external-write actions require confirmation every time?
8. Which accounts, folders, databases, channels, or repositories are in scope?
9. What should happen when a connection is unhealthy or authentication expires?
10. May the workflow fall back to another tool or provider?
11. What information is safe to send to each external service?
12. How should tool results be validated before they are trusted?

### 8. Quality and verification

1. What does a high-quality result look like?
2. Which facts, calculations, formulas, or links must be verified?
3. What errors are unacceptable?
4. What error rate is tolerable?
5. Should a separate reviewer agent check the result?
6. Should numerical results be recalculated deterministically?
7. Should the result be checked against a schema or template?
8. Should unsupported claims be removed or clearly marked?
9. What test examples represent normal, difficult, and invalid inputs?
10. Who gives final approval?
11. What evaluation score is required before release?
12. Should Woody compare the result with a previous approved example?

### 9. Safety, privacy, and permissions

1. What sensitive information may be processed?
2. Are there legal, contractual, regulatory, or company-policy requirements?
3. Which people may view the inputs, chat, logs, and outputs?
4. Which information must be redacted?
5. May information leave the local system?
6. How long should conversations, logs, inputs, and artifacts be retained?
7. Which actions must never be automated?
8. Which changes require owner or administrator approval?
9. Should agents be prevented from following instructions found inside documents or tool responses?
10. Are there geographic or provider restrictions?
11. Should generated outputs include disclaimers?
12. What is the rollback or recovery procedure after an incorrect external action?

### 10. Cost, speed, and limits

1. What is the maximum cost per run?
2. What is the monthly budget?
3. Is speed, quality, or cost the highest priority?
4. What is the acceptable completion time?
5. What maximum input and output token limits should apply?
6. Can cheaper models handle preparation steps?
7. Which steps require the strongest model?
8. Should repeated context be summarized or cached?
9. When should the workflow stop rather than spend more tokens?
10. Should Woody warn before a run likely exceeds the budget?

### 11. Failure and recovery

1. What should happen if the model provider is unavailable?
2. Which steps are safe to retry automatically?
3. How many retries are allowed?
4. Which external actions must never be automatically repeated?
5. What should happen after malformed model output?
6. What should happen when an uploaded document cannot be read?
7. What should happen when a tool returns incomplete or contradictory data?
8. Who should be notified about a failure?
9. Should the workflow return a partial result?
10. From which checkpoint should a failed run resume?
11. When should Woody ask a human to intervene?
12. What information should the error message contain?

### 12. Scheduling and operations

1. Should the workflow run manually, on a schedule, or after an event?
2. What timezone should schedules use?
3. Can runs overlap?
4. What should happen if the previous run is still active?
5. Are there business-hour or blackout restrictions?
6. Who can start, pause, cancel, or rerun it?
7. Who should receive completion or failure notifications?
8. How often should the workflow configuration be reviewed?
9. What metrics should appear on the dashboard?
10. When should old run data and artifacts be archived or deleted?

### 13. Testing and rollout

1. What is the smallest safe pilot?
2. Which sample inputs should be used?
3. What expected outputs should those samples produce?
4. Can the pilot use read-only tools and synthetic data?
5. Which external writes should be disabled during testing?
6. What budget should the test have?
7. Who reviews the test result?
8. What conditions must pass before activation?
9. Should the workflow start in draft, paused, or active state?
10. How should the previous version be restored if the new one performs worse?

## Questions the user should be able to ask Woody

### Understand the workspace

- What agents do I have, and what does each one do?
- Which agents are active, idle, failing, or unused?
- What workflows are running now?
- What changed recently?
- Which tools and MCP connections are installed?
- Which agents can use each tool?
- What knowledge is available to my agents?
- Explain this screen in simple language.

### Design agents and workflows

- Turn this goal into the smallest reliable agent workflow.
- Should this use one agent or several agents?
- What specialist roles are missing?
- Convert this ChatGPT prompt into an agent and workflow.
- Show me the workflow before creating anything.
- Add a human approval before external writes.
- Add a reviewer that checks facts and calculations.
- Make this workflow cheaper, faster, or more accurate.
- Create a reusable version of this manual process.
- What inputs and success criteria are still missing?

### Operate and troubleshoot

- Why did this execution fail?
- Explain this error without technical jargon.
- Is it safe to retry this run?
- Which step used the most tokens?
- Which tool call is waiting for approval?
- Why is this MCP connection unhealthy?
- Why is the tool allowlist empty?
- What permission does this agent actually need?
- Show me the last successful run and compare it with this one.
- What can be recovered from this partial run?

### Improve quality

- Review this output against my success criteria.
- Which claims lack evidence?
- Find contradictions or missing information.
- Compare these two workflow versions.
- Suggest a safer or simpler architecture.
- Propose evaluation tests before I activate this workflow.
- Which agent instructions are ambiguous?
- How can I make the result more consistent?
- Should this use deterministic code instead of an LLM?
- What should remain a human decision?

### Cost and governance

- Estimate the token and cost range before I run this.
- Why did this run cost more than expected?
- Which model should each step use?
- Can I stay within this monthly budget?
- What data will leave my computer?
- Which actions can write to external systems?
- Show all approvals and audit events for this workflow.
- Which permissions are broader than necessary?
- What should I delete, archive, or disable?
- Is this workflow safe to schedule unattended?

### Artifacts and deliverables

- Turn this result into a PDF, Word document, PowerPoint, Excel workbook, CSV, or Markdown file.
- Preview the artifact before creating it.
- Follow this uploaded template or brand guide.
- Add charts, tables, formulas, citations, or speaker notes.
- Explain which parts of the file are model-generated and which are deterministic.
- Save the result to an approved connected destination.

## First-release boundaries

- Woody may read workspace metadata, plans, run traces, and redacted tool health.
- Woody must never receive stored secret values.
- Chat does not bypass agent or MCP permission controls.
- Casual chat cannot create, update, enable, delete, schedule, send, publish, or purchase anything.
- Every system change is represented as a validated plan and explicit diff.
- External writes and destructive actions require a separate confirmation even after a plan is approved.
- Test mode uses a fixed budget, limited loop count, and read-only tools unless the user explicitly authorizes otherwise.
- Conversation memory is workspace-scoped and user-deletable.
- Woody must state when it is uncertain or when a capability is not implemented.

## Recommended implementation order

1. Add the persistent mascot and read-only Ask mode.
2. Add workspace-aware context retrieval with secret redaction.
3. Add the structured `WorkflowPlan` schema and validation.
4. Add plan preview, diff, cost estimate, and permission summary.
5. Add confirmed apply and audit logging.
6. Add safe sandbox testing and result evaluation.
7. Add artifact generation and download support.
8. Add opt-in scheduling and proactive operational suggestions.

