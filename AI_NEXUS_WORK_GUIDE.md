# Maximizing Woody for Your Own Work

Woody is most useful when you treat it as a small digital workforce rather than another general-purpose chatbot.

The core operating pattern is:

```text
Knowledge → Specialized agent → Clear task → Tools → Review → Repeatable workflow
```

## 1. Start with one real work outcome

Do not begin by creating many agents. Choose one recurring task that currently costs you time, such as:

- Producing a weekly report
- Researching competitors
- Turning notes into polished documents
- Reviewing proposals
- Summarizing operational information
- Creating social content
- Checking information against company policies
- Extracting actions from meeting notes

Define success clearly:

```text
Current process: 90 minutes every Friday
Desired result: A reliable Markdown report in under 10 minutes
Human responsibility: Verify facts and approve the final version
```

Build and improve that workflow before expanding.

## 2. Create specialized agents

Avoid one agent that tries to do everything. Narrow agents are easier to control, test, and improve.

### Research Agent

```text
Role: Research analyst
Goal: Find and organize evidence relevant to a business question
Temperature: 0.2
Capabilities: Knowledge and approved web/API tools
Output: Findings, sources, uncertainties, and unanswered questions
```

### Analysis Agent

```text
Role: Strategic analyst
Goal: Turn research into conclusions, risks, and recommendations
Temperature: 0.2
Output: Executive summary, evidence, risks, and recommended actions
```

### Writing Agent

```text
Role: Business writer
Goal: Convert approved analysis into a polished document
Temperature: 0.5
Output: Clear Markdown suitable for delivery
```

### Review Agent

```text
Role: Quality reviewer
Goal: Detect unsupported claims, contradictions, and missing requirements
Temperature: 0.1
Output: Pass/fail decision and required corrections
```

You can connect these agents sequentially in a workflow. They do not automatically collaborate unless the workflow explicitly passes work between them.

## 3. Write better agent instructions

A strong agent configuration has six parts:

```text
Identity
Responsibility
Available context
Rules
Required output
Quality standard
```

Example:

```text
You are a senior operations analyst.

Your responsibility is to analyze operational reports and identify:
- recurring problems,
- measurable trends,
- risks,
- recommended actions.

Use workspace knowledge as the primary source of truth.

Rules:
- Never invent missing figures.
- Clearly label assumptions.
- Separate evidence from recommendations.
- If information conflicts, explain the conflict.
- Do not claim an action was completed unless tool output confirms it.

Return Markdown containing:
1. Executive summary
2. Key findings
3. Supporting evidence
4. Risks
5. Recommended actions
6. Missing information

A successful result is concise, evidence-based, and actionable.
```

This is considerably more reliable than:

```text
Analyze my business.
```

## 4. Give every task a proper brief

Use this structure when running a task:

```text
Objective:
What must be achieved?

Context:
What situation should the agent understand?

Inputs:
Which documents, facts, or records are relevant?

Constraints:
What must the agent avoid?

Output:
What exact format should be returned?

Quality check:
How will you decide whether it is correct?
```

Example:

```text
Objective:
Prepare this week's operational performance report.

Context:
The report is for management and should focus on problems requiring decisions.

Inputs:
Use the uploaded weekly operations notes and KPI definitions.

Constraints:
Do not invent missing metrics. Mark incomplete information clearly.

Output:
Markdown with an executive summary, KPI table, risks, and five prioritized actions.

Quality check:
Every conclusion must reference a figure or statement from the supplied material.
```

## 5. Build a high-quality Knowledge Hub

Knowledge quality often matters more than the model.

Good knowledge documents include:

- Company policies
- Product information
- Standard operating procedures
- Writing and branding guidelines
- Customer profiles
- Frequently asked questions
- Approved examples
- Definitions of important metrics
- Project requirements
- Decision history

Avoid uploading large collections of outdated or contradictory files without organization.

Use clear document names:

```text
Customer Support Policy — 2026-07
Brand Voice Guidelines — Version 3
Weekly KPI Definitions
Product Catalogue — July 2026
```

When a document changes, replace or clearly version it. Agents cannot reliably know which conflicting document is authoritative unless you tell them.

## 6. Connect tools carefully

Tools let agents retrieve information or perform real work.

Useful tool categories include:

- Internal search APIs
- CRM APIs
- Reporting services
- Inventory systems
- Project-management systems
- Public research APIs
- Document-generation services

Give each tool narrow permissions. For example:

```text
customers.read
```

is safer than:

```text
customers.*
```

Test the connection before assigning it to an agent.

Remember that an agent with a tool may send task information to the external service. Do not give confidential documents to agents connected to untrusted endpoints.

OAuth connections such as Gmail, Slack, and Google Drive are not currently enabled. Their cards remain disabled until proper OAuth backends are implemented.

## 7. Turn successful tasks into workflows

Do not automate a process before you know it works manually.

Use this progression:

```text
Run task manually
→ Improve instructions
→ Repeat successfully 3–5 times
→ Convert into workflow
→ Add approval
→ Monitor results
```

### Research workflow

```text
Trigger
→ Research Agent
→ Analysis Agent
→ Human Approval
→ Writing Agent
→ Output
```

### Content workflow

```text
Topic input
→ Research
→ Draft
→ Brand review
→ Human approval
→ Final Markdown
```

### Operational workflow

```text
Receive API data
→ Analyze anomalies
→ Generate recommended actions
→ Human approval
→ Call reporting tool
→ Save result
```

Until loop nodes are implemented, create explicit review stages or manually rerun a task when revisions are needed.

## 8. Use human approval at the right point

Approval should be placed before actions that are:

- Irreversible
- Expensive
- Public
- Financial
- Customer-facing
- Destructive
- Legally sensitive

For example:

```text
Generate email → Human approval → Send email
```

Not:

```text
Send email → Human review
```

Low-risk research and summarization usually do not require approval.

## 9. Learn from the Execution Monitor

After every important run, inspect Logs or the Execution Monitor.

Check:

- Did the correct agent run?
- Which model was used?
- Was relevant knowledge retrieved?
- Were tools called?
- Did any tool fail?
- How many tokens were used?
- How long did it take?
- Was the output genuinely useful?
- Did the agent follow the requested format?

When a result is poor, diagnose the source:

| Problem | Likely correction |
|---|---|
| Output is vague | Make the objective and output format more specific |
| Facts are invented | Add authoritative knowledge and stricter rules |
| Wrong tool is used | Reduce assigned tools or clarify permissions |
| Output is too long | Lower maximum tokens and specify a length |
| Output is repetitive | Add a non-repetition rule and reduce temperature |
| Creative output is dull | Increase temperature slightly |
| Agent misses context | Improve knowledge documents or task inputs |
| Process is inconsistent | Convert it into a deterministic workflow |

## 10. Choose model settings deliberately

Suggested temperature settings:

| Task | Temperature |
|---|---:|
| Compliance or fact extraction | 0.0–0.2 |
| Research and analysis | 0.1–0.3 |
| Business writing | 0.3–0.6 |
| Brainstorming and creative work | 0.6–0.9 |

Maximum tokens control output length, not total input cost.

Suggested output limits:

```text
Short extraction: 500–1,000
Normal report: 2,000–4,000
Detailed analysis: 4,000–8,000
```

Higher limits do not automatically produce better answers.

## 11. Control token usage

Use the smallest workflow that achieves the desired quality.

To reduce usage:

- Retrieve only relevant knowledge
- Keep agent instructions focused
- Avoid passing complete raw histories between every agent
- Use deterministic code or API tools for calculations
- Do not use an AI model for simple formatting or routing
- Limit revision cycles
- Use one review agent instead of several
- Stop workflows when sufficient quality is reached

A five-agent workflow can easily consume five to ten times more tokens than a focused single agent.

## 12. Create a quality scorecard

Evaluate important outputs consistently.

| Criterion | Weight |
|---|---:|
| Factual accuracy | 30% |
| Completeness | 20% |
| Evidence and traceability | 20% |
| Actionability | 15% |
| Format compliance | 10% |
| Writing quality | 5% |

Keep examples of excellent outputs in the Knowledge Hub. Tell agents to follow those examples without copying their specific facts.

## 13. A practical daily routine

### Beginning of the day

- Review running or failed tasks
- Add new source material to the Knowledge Hub
- Queue research and analysis tasks

### During the day

- Review completed output in the Execution Monitor
- Approve protected workflow steps
- Correct weak instructions
- Convert validated results into final documents

### End of the week

- Review Analytics
- Identify failed or expensive workflows
- Deactivate unused agents
- Update outdated knowledge
- Improve the highest-value recurring workflow

## 14. Recommended first-week plan

### Day 1

Choose one recurring process and create one specialized agent.

### Day 2

Upload the authoritative knowledge needed for that process.

### Day 3

Run five realistic tasks and record what fails.

### Day 4

Improve the agent's instructions and required output structure.

### Day 5

Create a reviewer agent and compare quality.

### Day 6

Turn the successful process into a workflow with human approval.

### Day 7

Review execution time, token usage, failures, and time saved.

## 15. Current limitations

- The provider key is currently server-wide through `.env.local`
- Per-workspace key configuration has been designed but not implemented
- Workflow loop nodes are not yet supported
- LangGraph has not yet been integrated
- OAuth marketplace connections remain disabled
- Compatible-provider pricing is unavailable unless billing rates are configured
- Accounts and data are local to the Docker/PostgreSQL installation
- The application does not currently provide cloud backup

## Final principle

The biggest improvement will not come from creating more agents. It will come from creating one well-defined, evidence-based process, measuring its results, and only then turning it into an automated workflow.
