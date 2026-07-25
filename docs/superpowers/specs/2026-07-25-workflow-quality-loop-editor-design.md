# Workflow Quality Loop and Capability-Based Editor Design

**Status:** Proposed for user review  
**Date:** 2026-07-25

## Goal

Make generated and manually edited workflows capable of expressing safe, bounded quality-review loops while making node inputs, configuration, and connections directly editable.

The design must support either:

1. The original worker revising its own result.
2. A dedicated revision agent applying grader feedback.

## Confirmed Current Constraints

- Prompt-to-Agent only permits trigger, agent, approval, and output nodes.
- Its prompt explicitly requires an acyclic sequential workflow and forbids loops.
- The trigger has no editable input definition.
- Agent nodes receive the full workflow state implicitly and expose no input mapping.
- Agent output is persisted as `{ text, toolCallCount }`, so a condition cannot reliably read a grader verdict.
- Loop and condition nodes are hidden in Simple mode.
- Edges have no visible inspector or delete action, can only be deleted through keyboard selection, and cannot be reconnected.
- The workflow runtime already supports bounded `while` and `forEach` loops with explicit loop-back edges.
- The active provider endpoint supports `glm-4.7`, but existing agents are individually pinned to `deepseek-chat`.

## Design Principles

- Show controls only when the selected node supports them.
- Keep canvas cards compact; place detailed editing in the inspector.
- Make branching and loop behavior visible rather than implicit.
- Require structured, validated grader output.
- Bound every revision loop by attempts and a defined limit outcome.
- Preserve existing workflow definitions and migrate them without changing behavior.

## Capability-Based Node Structure

Every node type declares its capabilities in the workflow node registry. The frontend derives inspector sections, ports, validation, and summaries from this declaration.

```text
Node
├── Header
├── Inputs
├── Configuration
├── Conditions
├── Execution
├── Input collection
├── Variables
└── Output handles
```

### Section Visibility

| Section | Displayed for |
| --- | --- |
| Header | Every node |
| Inputs | Nodes consuming workflow or upstream data |
| Configuration | Nodes with agent, loop, output, or integration settings |
| Conditions | Condition, grader, and loop nodes |
| Execution | Agent, API, MCP, browser, and action nodes |
| Input collection | Trigger, form, and human-input nodes |
| Variables | Loop, transform, trigger, and advanced nodes |
| Output handles | Derived from the node's declared output ports |

“Execution” replaces separate “Actions” and “Tool calls” sections to avoid duplicated concepts.

### Canvas Card

The canvas card displays only:

- Icon and node name
- Node type or selected resource
- One-line configuration summary
- Validation or runtime status
- Relevant connection handles

Detailed controls live in a progressive inspector with collapsed advanced sections.

## Input Editing

### Trigger

The trigger inspector supports an editable input schema:

- Key
- Label
- Type
- Required state
- Default value
- Example
- Description

The run dialog is generated from this schema and retains a raw JSON option for advanced users.

### Agent and Execution Nodes

Nodes consuming data expose an input mapping editor. It supports:

- Original workflow input
- Upstream node output
- Workflow variables
- Loop variables
- Literal values

Mappings use validated state paths and provide a resolved preview during tests.

An unmapped legacy agent node continues receiving the complete workflow state to preserve existing behavior.

## Connection Editing

Edges become first-class selectable objects.

Users can:

- Select an edge with an enlarged invisible hit target.
- Delete it from an edge toolbar or the keyboard.
- Drag either endpoint to reconnect it.
- Change branch labels where the source node supports branches.
- Insert a node directly onto an edge.
- Use undo and redo for every edge operation.

Connecting a new target from a single-output node offers to replace its existing connection instead of leaving the graph invalid.

## Quality Review Loop

### Required Roles

- Worker agent
- Grader agent
- Optional dedicated revision agent

### Editable Controls

- Worker agent
- Grader agent
- Grading criteria
- Passing score
- Maximum revision attempts
- Revision strategy
  - Same worker
  - Dedicated revision agent
- Dedicated revision agent selector, shown conditionally
- On-limit behavior
  - Return best result with warning
  - Request human review
  - Fail workflow

### Grader Contract

The grader returns validated structured output:

```json
{
  "passed": false,
  "score": 72,
  "feedback": [
    "Add supporting evidence.",
    "Correct the calculation in the second section."
  ],
  "criteria": [
    {
      "name": "Accuracy",
      "score": 68,
      "reason": "The calculation is not supported."
    }
  ]
}
```

The agent runtime must support a node-level output schema and parse JSON-mode responses into structured state. Invalid grader output is a node failure eligible for the node's technical retry policy; it is not treated as a failed quality grade.

### Execution Semantics

```text
Input
  → Worker
  → Grader
     ├─ passed = true → Output
     └─ passed = false
          → Revision target receives previous result + grader feedback
          → Grader
          → repeat until pass or limit
```

Technical retries and quality revisions remain separate:

- Technical retry repeats a failed API/model call.
- Quality revision creates a new loop iteration because the completed result did not meet the rubric.

Each iteration persists:

- Candidate result
- Grader verdict
- Feedback
- Score
- Selected revision agent
- Attempt number

## Prompt-to-Agent Compiler

The solution schema is expanded to support:

- Condition nodes
- Controlled loop nodes
- Structured-output agent nodes
- Branch labels
- Loop-back edges
- Input and feedback mappings
- Loop limits and limit behavior

The compiler prompt no longer forces every workflow to be sequential. It chooses a bounded quality-loop template when the user requests grading, evaluation, review, revision, retry-until-pass, or a quality threshold.

Generated loops must pass the same backend workflow validator as manually created workflows. Unsupported or unsafe cycles remain rejected.

When a generated proposal contains advanced control flow, its editor opens in Advanced mode automatically and explains why.

## Model Configuration

The active Silra endpoint and existing API key have been verified to support `glm-4.7` and JSON-mode output.

Model migration is separated into:

1. Workspace default model, used by Woody and Prompt-to-Agent.
2. Existing agent models, which require an explicit bulk migration or individual change.

The migration flow previews affected agents, tests the new model first, preserves the API key, and supports reverting model names. The workflow/compiler fixes do not depend on a model upgrade.

Recommended initial configuration:

- Prompt-to-Agent compiler: `glm-4.7`
- Grader temperature: `0.0` to `0.2`
- Worker model: user-selectable
- Revision agent model: user-selectable

## Validation and Safety

- Maximum revision attempts is required and bounded.
- Every failed-grade path must return to the declared loop.
- Every pass path must reach an output.
- A limit outcome must be explicitly selected.
- Structured grader output is schema-validated.
- Data mappings may only reference available input, variables, and upstream or prior-iteration outputs.
- Existing permission and human-confirmation rules continue to apply inside loops.
- External write actions are not repeated silently.

## Compatibility and Rollout

1. Add registry metadata and structured output support without changing existing definitions.
2. Add edge selection and input mapping UI.
3. Extend backend schemas and validators.
4. Add the quality-loop template and runtime state handling.
5. Extend Prompt-to-Agent.
6. Add model migration UI and switch the workspace default only after a provider test.

Existing workflows retain full-state agent input and their current model unless explicitly migrated.

## Verification

- Unit tests for node capabilities and conditional sections.
- Unit tests for structured grader parsing and validation.
- Workflow validation tests for valid and invalid quality loops.
- Runtime tests for pass on first grade, revision then pass, dedicated revision agent, invalid grader output, and attempt limit.
- Compiler tests proving review-loop prompts generate bounded loops.
- Editor interaction tests for editing input mappings and selecting, deleting, reconnecting, and inserting on edges.
- Regression tests for existing linear workflows.
- Provider test before changing the workspace model.
- End-to-end browser verification in light and dark themes.

