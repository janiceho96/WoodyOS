# Departments, Integration Boundaries, and Runtime Roadmap Design

**Status:** Proposed for implementation planning  
**Date:** 2026-07-26  
**Product:** Woody Agent OS  
**Scope:** Product and architecture design only

## 1. Goal

Improve Woody in three coordinated areas:

1. Introduce an editable **Department** experience that presents agents in a clear organizational hierarchy.
2. Separate **MCP** and **API Tools** into distinct first-class product areas.
3. Reconcile the external improvement plan with the current codebase and define the runtime safeguards required before Department-level autonomous delegation.

The work must preserve existing workflows, agents, starter solutions, credentials, policy enforcement, and published execution behavior.

## 2. Product Decisions

- Use a paired foundation-and-product roadmap rather than a UI-only or runtime-only program.
- Add **Department** as a main navigation item after Agents.
- Use a hybrid organizational view:
  - The default is a clean org chart.
  - Cross-department collaboration appears on demand.
- Each agent has at most one primary Department and may have multiple shared Department assignments.
- The hierarchy begins with the workspace/company, followed by an optional executive agent, Department managers, and Department members.
- The first Department release supports viewing and editing the organization. It does not enable autonomous delegation.
- Add **MCP** and **API Tools** as separate main-navigation items.
- Retain separate MCP and API backend domains while continuing to use the shared action-policy gateway.

## 3. Improvement-Plan Assessment

The improvement plan is a useful risk register, but it is not an accurate literal backlog because several proposed foundations already exist.

### 3.1 Prioritize

- Immutable agent versions.
- Complete execution manifests.
- Structured runtime errors.
- End-to-end tracing and correlation identifiers.
- Cancellation propagation.
- Worker leases and execution heartbeats.
- Retry classification.
- Immutable quality history tied to exact output versions.
- Memory provenance, verification, scope, expiry, and supersession.
- Dry-run, simulation, and regression evaluation.
- Typed workflow contracts and deterministic collection behavior.

### 3.2 Extend Existing Capabilities

- Published workflow versions and definition snapshots already exist. Extend them into complete execution manifests.
- The shared policy gateway already provides action identity, guarded execution, and an external-action ledger. Audit and harden it instead of building a second ledger.
- Atomic action claiming and approval expiry have foundations. Add expiry processing, escalation behavior, and concurrency verification.
- Workflow graphs already support structural branching. Future work is specifically parallel scheduling, deterministic joins, branch quotas, and state merging.
- MCP and API already use separate backend adapters. The immediate need is clear information architecture and separate management experiences.
- Agent teams already exist. Migrate their data into explicit Department concepts rather than creating an unrelated grouping system.

### 3.3 Defer

- Parallel fork/join execution.
- Broad saga compensation.
- Large-scale durable timers.
- Distributed resource locking.
- Knowledge-graph memory.
- Real-time CRDT workflow collaboration.
- Cross-workspace publishing.
- Predictive monitoring.
- Automatic memory consolidation.
- A dedicated analytics warehouse.

### 3.4 Exclude From the Foreseeable Roadmap

- Multi-region active-active execution.
- A full event-sourced runtime.
- A proprietary marketplace registry that duplicates curated and public MCP discovery.
- Four separate analytics products; begin with one role-aware operations experience.
- Autonomous Department delegation before versioning, budgets, tracing, cancellation, and evaluation are verified.

## 4. Department Product Design

### 4.1 Navigation and Purpose

Add **Department** immediately after Agents in the primary sidebar.

Department represents organization, responsibility, ownership, and visibility. It is not a second workflow editor and does not introduce a new execution engine.

### 4.2 Hierarchy

```text
Workspace / Company
└── Optional Executive Agent
    ├── Department Manager
    │   └── Primary Department Agents
    └── Department Manager
        └── Primary Department Agents

Shared Specialists
└── Agents with additional Department assignments
```

The workspace root is always present. The executive agent is optional.

### 4.3 Views

**Org view**

- Default view.
- Solid lines show primary Department and reporting relationships.
- Each agent appears once in the hierarchy.
- Shared specialists appear in a separate rail.

**Collaboration view**

- Optional view.
- Shows shared Department relationships and wider collaboration.
- Uses focus and filtering to prevent an unreadable graph.

**Focus mode**

- Selecting an agent or Department hides unrelated relationships.
- Selecting a shared agent reveals its additional assignments.

**Filters**

- Department.
- Agent role.
- Agent status.
- Active work.
- MCP access.
- API Tool access.

The page provides automatic layout and a **Reset layout** action. Agent cards open the existing Agent Workspace.

### 4.4 Phase-One Capabilities

Authorized users can:

- Create, rename, describe, archive, and reorder Departments.
- Select or remove an optional executive agent.
- Select one manager for each Department.
- Give each agent one primary Department.
- Add or remove shared Department assignments.
- Move an agent between primary Departments with explicit confirmation.
- Inspect unassigned agents.
- View agent status and current work.
- View Department activity summaries without initiating Department-level execution.

Phase one does not support:

- Department goals that initiate execution.
- Manager-led delegation.
- Recursive agent delegation.
- Department-specific tools or credentials.
- A separate Department runtime.

### 4.5 Data Model

Introduce:

```text
departments
department_memberships
workspace_org_settings
```

`departments` owns workspace identity, name, description, status, display order, and manager-agent reference.

`department_memberships` owns the Department-agent relationship and membership type:

```text
primary
shared
```

A database constraint ensures each agent has at most one active primary Department. An agent may have multiple shared assignments. All referenced Departments, agents, executive agents, and managers must belong to the same workspace.

`workspace_org_settings` stores the optional executive-agent reference and future organization-level display preferences.

Managers must be active agents. Selecting a Department manager makes that Department the agent's primary Department; moving an existing primary assignment requires confirmation. Selecting an executive agent does not alter that agent's Department memberships. The executive card is its canonical org-chart position, and any Department membership is shown as a compact reference rather than a duplicate card.

### 4.6 Existing Team Compatibility

Migration is additive and staged:

1. Add the new Department schema.
2. Backfill each `agent_teams` row into a Department.
3. When an agent belongs to exactly one legacy team, backfill that membership as primary.
4. When an agent belongs to multiple legacy teams, backfill every membership as shared and leave the agent without a primary Department until an authorized user chooses one.
5. Update starter-solution installation to create Departments and Department memberships.
6. Keep `/v1/teams` as a temporary compatibility adapter.
7. Remove the compatibility adapter only after no supported client or installer depends on it.

Migration never deletes agents, workflows, tasks, or memberships.

### 4.7 Permissions and Privacy

- Owners and admins may edit Department structure.
- Members may view Department structure.
- Every structural mutation creates an audit event.
- Archiving a Department preserves its agents and makes its primary members unassigned.
- Removing a manager does not remove or archive the agent.
- Department graph responses never contain credentials, agent instructions, hidden memory, raw tool configuration, or secrets.

## 5. MCP and API Tools Separation

### 5.1 Navigation

The primary navigation becomes:

```text
Home
Agents
Department
Workflows
Outputs
Knowledge
MCP
API Tools
```

Analytics and Settings remain in the footer.

### 5.2 MCP

MCP is application- and server-oriented.

Its page supports:

- Curated application and community MCP discovery.
- Custom Streamable HTTP servers.
- OAuth and server authentication.
- Exact MCP action discovery and review.
- Server and action allowlists per agent.
- Connection health.
- Confirmation handling.
- MCP call activity.

Sections:

```text
Discover
Connected
Agent Access
Activity
```

### 5.3 API Tools

API Tools is endpoint- and provider-oriented.

Its page supports:

- Installed API tools.
- Custom HTTPS APIs.
- Server-owned public starter APIs.
- Web-research providers.
- Read-only job-search providers.
- Credentials, health checks, methods, schemas, and permissions.
- API-call activity and failures.

Sections:

```text
Installed
Add API
Providers
Activity
```

AI model providers remain in Settings because they power agent execution and are not agent-callable tools.

### 5.4 Technical Boundary

```text
MCP page ──────> /v1/mcp/* ───> MCP runtime and transport
API Tools page -> /v1/tools/* ─> API Tool runtime
                                      │
                                      v
                          Shared action-policy gateway
```

Both domains share:

- Workspace isolation.
- Encrypted server-side credentials.
- Agent permissions.
- Approval rules.
- Idempotency safeguards.
- Cost and usage controls.
- Redacted audit history.

They do not share connection forms, transport-specific states, authentication terminology, or error vocabulary.

### 5.5 Cross-Product Consistency

- Agent Builder shows separate MCP access and API Tool access groups.
- Agent Workspace presents assigned MCP and API resources separately.
- Workflow Designer retains distinct MCP and API nodes.
- Department filters expose MCP access and API Tool access independently.
- Global search distinguishes MCP Connection, MCP Action, and API Tool.
- Frontend `/tools` redirects to `/api-tools`.
- Existing backend `/v1/tools` routes remain stable.
- MCP connections are not moved into the `tools` database table.

## 6. Runtime Trust Roadmap

The runtime target is:

> Every run uses frozen dependencies, every consequential action has one logical identity, and every execution can be traced, cancelled, and safely diagnosed.

### 6.1 Preserve and Verify Existing Foundations

- Verify published workflow-version immutability.
- Verify action-policy enforcement for both API and MCP calls.
- Document existing snapshot, approval, idempotency, and uncertain-outcome behavior.
- Remove duplicate proposed mechanisms from the backlog.

### 6.2 Agent Versions and Execution Manifests

Add immutable `agent_versions`.

Publishing an agent freezes:

- Instructions.
- Goal and role.
- Model identifier and configuration.
- Capabilities.
- MCP permissions.
- API Tool permissions.
- Memory configuration.
- Runtime-relevant avatar or identity metadata only where required for output.

Production runs must reference published agent versions. Draft tests may use draft agent configuration and must be identified as test runs.

Each production run manifest records:

- Workflow version.
- Agent versions.
- Prompt versions.
- Model identifiers and parameters.
- MCP action schemas.
- API Tool schemas.
- Policy version.
- Adapter versions.
- Runtime version.
- State-schema version.
- Output-contract versions.
- Artifact-template versions.

A paused run resumes against its manifest. It must not silently substitute current live configuration.

### 6.3 Observability and Recovery

Add:

- `trace_id`
- `span_id`
- `parent_span_id`
- `correlation_id`

Trace context propagates across API handling, BullMQ, workflow execution, model calls, knowledge retrieval, MCP calls, API calls, approvals, file processing, and artifact generation.

Structured runtime errors include:

- Stable code.
- Category.
- Retryability.
- User-facing message.
- Recommended recovery action.
- Run, node, attempt, provider, and resource identity.
- External request identifier when available.
- Redacted diagnostic details.

Retry behavior is category-aware. Queue redelivery cannot multiply node retries into repeated logical executions.

Cancellation propagates through a run-scoped abort context to cancellable model, MCP, API, file, and artifact operations. The runtime distinguishes a cancelled operation from a completed side effect with an uncertain local result.

Long-running work uses worker leases and execution heartbeats. A worker may not take over an unexpired lease.

### 6.4 Quality, Memory, and Evaluation

Quality history is an immutable ordered collection linked to:

- Exact output-document version.
- Agent version.
- Grader version.
- Model version.
- Automated and manual revision numbers.
- Score, feedback, criteria, and exit reason.

Memory records add:

- Type.
- Scope.
- Source and provenance.
- Confidence.
- Verification state.
- Importance.
- Expiry.
- Supersession state.
- Last-accessed time.

Retrieval ranking combines semantic relevance with scope, source authority, validity, importance, and recency.

Workflow evaluation adds:

- Dry-run validation without external writes.
- Deterministic fixture-based node tests.
- Full workflow regression cases.
- Quality, cost, latency, and schema-conformance measurements.

## 7. Future Controlled Department Delegation

Department delegation is a separate future project and may begin only after the runtime trust roadmap is verified.

```text
User submits Department goal
→ Manager agent proposes a delegation plan
→ Policy validates members, permissions, budgets, and versions
→ User approves consequential or costly execution
→ Existing workflow/task runtime performs work
→ Department page summarizes progress
```

The first delegation release requires:

- A published manager-agent version.
- Explicit member allowlists.
- Per-goal token, cost, wall-clock, retry, and tool-call budgets.
- Maximum delegation depth of one.
- No unrestricted recursive delegation.
- Full traceability and cancellation.
- Human approval before external writes.

Department managers orchestrate through existing workflows and tasks. No Department-specific execution engine is introduced.

## 8. Error Handling

Department APIs return stable, recoverable errors for:

- Duplicate primary Department assignment.
- Inactive or cross-workspace manager.
- Invalid executive agent.
- Concurrent structural edit.
- Archived Department mutation.
- Insufficient permission.

Mutations use optimistic concurrency. A stale edit returns a conflict response and the latest organization revision.

MCP and API Tools maintain domain-specific error vocabularies. Both map execution failures into the shared structured runtime taxonomy without exposing credentials or raw provider responses.

## 9. Validation

### 9.1 Backend

- Department constraints and lifecycle.
- Primary and shared membership rules.
- Workspace isolation and role permissions.
- Legacy-team migration and compatibility.
- Immutable agent publishing.
- Production version pinning.
- Execution-manifest completeness.
- API and MCP policy-gateway parity.
- Retry classification.
- Duplicate-action prevention.
- Cancellation propagation.
- Worker leases and takeover.
- Approval expiry.
- Trace propagation.
- Redaction.

### 9.2 Frontend

- Main navigation and legacy redirects.
- Department creation, editing, archiving, assignment, focus mode, filters, and empty states.
- Keyboard-accessible graph traversal.
- Responsive behavior at desktop, laptop, tablet, and mobile widths.
- Separate MCP and API Tool experiences.
- Separate resource assignment in Agent Builder and Agent Workspace.
- No secrets or hidden server configuration in browser responses.

### 9.3 Integration Scenarios

- Existing published workflows run unchanged.
- A paused workflow resumes using its frozen manifest.
- A cancelled run stops cancellable work and reports uncertain side effects accurately.
- A shared agent retains one unambiguous primary Department.
- External writes cannot bypass confirmation through MCP or API Tools.
- Legacy starter solutions continue installing during the compatibility period.

## 10. Delivery Sequence

1. Baseline verification and compatibility coverage.
2. MCP and API Tools navigation separation.
3. Department schema, migration, and APIs.
4. Department hybrid org-chart UI.
5. Agent versions and expanded execution manifests.
6. Tracing, structured errors, retry classification, cancellation, and leases.
7. Quality history, governed memory, and workflow evaluation.
8. Controlled Department delegation as a separately approved future project.

Each stage must be independently deployable and reversible. Department delegation must not be bundled into the organizational release.

## 11. Success Criteria

- Users can understand the organization and locate an agent without reading workflows.
- Every agent has zero or one primary Department and any number of explicit shared assignments.
- Cross-department collaboration is visible without making the default graph unreadable.
- MCP and API Tools have distinct navigation, terminology, setup, assignment, and activity experiences.
- Existing credentials and backend API contracts remain secure.
- Existing published workflows continue to run.
- Production runs are reproducible from frozen execution manifests.
- Operators can trace, classify, cancel, and safely recover supported executions.
- Department delegation remains disabled until its prerequisites are verified and separately approved.
