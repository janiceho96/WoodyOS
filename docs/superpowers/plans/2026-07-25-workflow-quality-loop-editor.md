# Workflow Quality Loop and Capability-Based Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workflow inputs and connections directly editable and allow generated or manual workflows to run bounded grader/revision loops using either the original worker or a dedicated revision agent.

**Architecture:** Extend the existing registry as the single source of truth for node capabilities, inspector sections, ports, and validation. Add structured agent-output contracts to the task runtime, then expand the solution compiler to emit the same validated workflow definition consumed by the runtime and editor. Preserve legacy full-state agent inputs and existing agent model assignments.

**Tech Stack:** TypeScript, Fastify, Zod, PostgreSQL, React, `@xyflow/react`, TanStack Query, Vitest, Vite.

## Global Constraints

- Follow strict red-green-refactor: no production behavior change before its failing test is observed.
- Preserve all unrelated dirty-worktree changes.
- Existing workflows without mappings continue receiving the full workflow state.
- Every quality loop has a bounded maximum revision count and explicit limit behavior.
- Structured grader output is validated before it can control a branch.
- External write actions are never repeated silently.
- Canvas cards remain compact; detailed controls belong in the inspector.
- Irrelevant inspector sections are hidden, not disabled.
- The same stored API key is preserved during model-only changes.
- Existing agents remain on their selected model unless explicitly migrated.

---

### Task 1: Capability-Based Node Registry

**Files:**
- Modify: `src/workflows/registry.ts`
- Modify: `src/routes/workflows.ts`
- Modify: `web-stitch/src/api.ts`
- Test: `tests/workflows.test.ts`

**Interfaces:**
- Produces: `WorkflowInspectorSection`, `WorkflowNodeCapability`, and `inspectorSections` on each catalog entry.
- Consumes: Existing `WorkflowNodeType`, `WorkflowPort`, and `WorkflowConfigField`.

- [ ] **Step 1: Write failing registry tests**

Add literal assertions proving that an agent exposes `inputs`, `configuration`, and `execution`; a condition exposes `inputs` and `conditions`; a trigger exposes `input_collection` and `variables`; and irrelevant sections are absent.

```ts
it('declares only the inspector sections supported by each node type', () => {
  expect(workflowNodeDefinition('agent')?.inspectorSections).toEqual([
    'inputs', 'configuration', 'execution',
  ]);
  expect(workflowNodeDefinition('condition')?.inspectorSections).toEqual([
    'inputs', 'conditions',
  ]);
  expect(workflowNodeDefinition('trigger')?.inspectorSections).toEqual([
    'input_collection', 'variables',
  ]);
  expect(workflowNodeDefinition('output')?.inspectorSections).not.toContain('execution');
});
```

- [ ] **Step 2: Run the focused test and observe RED**

Run: `npm test -- tests/workflows.test.ts`

Expected: FAIL because catalog entries do not expose `inspectorSections`.

- [ ] **Step 3: Add the registry contract**

Add:

```ts
export const workflowInspectorSections = [
  'inputs',
  'configuration',
  'conditions',
  'execution',
  'input_collection',
  'variables',
] as const;

export type WorkflowInspectorSection = typeof workflowInspectorSections[number];

export type WorkflowNodeCapability = {
  inspectorSections: WorkflowInspectorSection[];
  supportsInputMapping: boolean;
  supportsStructuredOutput: boolean;
  supportsDynamicHandles: boolean;
};
```

Extend every registry entry with explicit capability values and return them through `/v1/workflows/node-catalog`. Update frontend API types to match.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/workflows.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the isolated registry change**

```bash
git add src/workflows/registry.ts src/routes/workflows.ts web-stitch/src/api.ts tests/workflows.test.ts
git commit -m "feat: declare workflow node capabilities"
```

### Task 2: Editable Trigger Inputs and Node Input Mappings

**Files:**
- Modify: `src/workflows/registry.ts`
- Modify: `src/workflows/definition.ts`
- Modify: `src/workflows/adapters/agent.ts`
- Modify: `src/workflows/adapters/templates.ts`
- Test: `tests/workflows.test.ts`
- Test: `tests/database.integration.test.ts`

**Interfaces:**
- Produces: `WorkflowInputField`, trigger `inputSchema`, and node `inputMapping`.
- Produces: `resolveNodeInput(mapping, state)` returning a JSON object.
- Consumes: Existing safe workflow-state path validation.

- [ ] **Step 1: Write failing schema and runtime tests**

Cover:

```ts
it('accepts a typed trigger input schema and safe agent input mapping', () => {
  expect(workflowDefinitionErrors({
    nodes: [
      { id: 'start', type: 'trigger', config: { inputSchema: [
        { key: 'topic', label: 'Topic', type: 'text', required: true },
      ] } },
      { id: 'writer', type: 'agent', config: {
        agentId: agentId,
        inputMapping: {
          topic: '{{ input.topic }}',
          prior: '{{ input.prior }}',
        },
      } },
      { id: 'finish', type: 'output', config: { fromNodeId: 'writer' } },
    ],
    edges: [
      { source: 'start', target: 'writer' },
      { source: 'writer', target: 'finish' },
    ],
  })).toEqual([]);
});
```

Add a database integration assertion that a mapped agent task receives only the resolved mapping plus workflow metadata, while an unmapped legacy node still receives the full state.

- [ ] **Step 2: Run focused tests and observe RED**

Run: `npm test -- tests/workflows.test.ts tests/database.integration.test.ts`

Expected: FAIL because input schema and agent mapping are not implemented.

- [ ] **Step 3: Implement validation and resolution**

Define input field types as `text | number | boolean | object | collection | file`. Validate safe keys, unique keys, defaults matching types, and mapping references.

Add:

```ts
export function resolveNodeInput(
  mapping: Record<string, unknown> | undefined,
  state: Record<string, unknown>,
) {
  return mapping ? resolveWorkflowTemplates(mapping, state) : state;
}
```

In `executeAgentNode`, build:

```ts
const mappedInput = resolveNodeInput(
  isRecord(node.config.inputMapping) ? node.config.inputMapping : undefined,
  run.state,
);
const agentInput = {
  ...mappedInput,
  workflow: {
    name: run.name,
    runId: run.id,
    nodeId: node.id,
    iterationKey,
    attempt: cursor.attempt,
    responsibility: node.config.responsibility ?? null,
    expectedOutput: node.config.expectedOutput ?? null,
    outputContract: node.config.outputContract ?? null,
  },
};
```

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/workflows.test.ts tests/database.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflows/registry.ts src/workflows/definition.ts src/workflows/adapters/agent.ts src/workflows/adapters/templates.ts tests/workflows.test.ts tests/database.integration.test.ts
git commit -m "feat: add editable workflow input mappings"
```

### Task 3: Structured Grader Output

**Files:**
- Create: `src/workflows/output-contracts.ts`
- Modify: `src/worker.ts`
- Modify: `src/workflows/registry.ts`
- Modify: `src/workflows/definition.ts`
- Test: `tests/workflows.test.ts`
- Test: `tests/database.integration.test.ts`

**Interfaces:**
- Produces: `graderOutputSchema`.
- Produces: `parseAgentOutput(text, contract)` returning `{ text, data?, toolCallCount }`.
- Consumes: Agent node `config.outputContract`.

- [ ] **Step 1: Write failing parser tests**

```ts
it('parses and validates a grader verdict', () => {
  expect(parseAgentOutput(
    '{"passed":false,"score":72,"feedback":["Add evidence"],"criteria":[]}',
    'grader',
    0,
  )).toEqual({
    text: '{"passed":false,"score":72,"feedback":["Add evidence"],"criteria":[]}',
    data: { passed: false, score: 72, feedback: ['Add evidence'], criteria: [] },
    toolCallCount: 0,
  });
});

it('rejects malformed grader output instead of routing it as a failed grade', () => {
  expect(() => parseAgentOutput('Needs work', 'grader', 0))
    .toThrow('Agent grader output did not match its contract');
});
```

- [ ] **Step 2: Run parser tests and observe RED**

Run: `npm test -- tests/workflows.test.ts`

Expected: FAIL because `parseAgentOutput` does not exist.

- [ ] **Step 3: Implement the output contract**

Use Zod:

```ts
export const graderOutputSchema = z.object({
  passed: z.boolean(),
  score: z.number().min(0).max(100),
  feedback: z.array(z.string().min(1).max(2_000)).max(50),
  criteria: z.array(z.object({
    name: z.string().min(1).max(200),
    score: z.number().min(0).max(100),
    reason: z.string().min(1).max(2_000),
  })).max(50).default([]),
});
```

For OpenAI-compatible providers, request `response_format: { type: 'json_object' }` when `outputContract === 'grader'`. For Anthropic, append the exact JSON contract to the system prompt and validate the returned text.

- [ ] **Step 4: Add an integration test for persisted structured output**

Assert that a grader task persists `output.data.passed`, `output.data.score`, and `output.data.feedback`, and that invalid JSON marks the node as failed rather than selecting a branch.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- tests/workflows.test.ts tests/database.integration.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workflows/output-contracts.ts src/worker.ts src/workflows/registry.ts src/workflows/definition.ts tests/workflows.test.ts tests/database.integration.test.ts
git commit -m "feat: validate structured grader output"
```

### Task 4: Bounded Quality-Review Loop Template

**Files:**
- Create: `src/workflows/quality-loop.ts`
- Modify: `src/workflows/definition.ts`
- Modify: `src/workflows/runtime.ts`
- Modify: `src/workflows/registry.ts`
- Test: `tests/workflows.test.ts`
- Test: `tests/database.integration.test.ts`

**Interfaces:**
- Produces: `QualityLoopConfig`.
- Produces: `buildQualityLoopDefinition(config)`.
- Consumes: `nodes.<grader>.data.passed`, `score`, and `feedback`.

- [ ] **Step 1: Write failing definition tests**

Test both strategies with literal graphs:

```ts
it('builds a bounded same-worker quality loop', () => {
  const definition = buildQualityLoopDefinition({
    workerAgentId: workerId,
    graderAgentId: graderId,
    revisionStrategy: 'same_worker',
    maximumRevisions: 3,
    passingScore: 80,
    onLimit: 'human_review',
  });
  expect(workflowDefinitionErrors(definition)).toEqual([]);
  expect(definition.edges).toContainEqual({
    source: 'grader',
    target: 'quality_loop',
    condition: 'continue',
  });
});
```

The same-worker graph is:

```text
trigger → quality_loop
quality_loop.body → worker → grader
grader.continue → quality_loop
quality_loop.done → limit_reason → output or limit handling
```

The quality loop uses `nodes.grader.data.passed not_equals true`, so the missing first verdict starts iteration one and a passing verdict exits.

Add a dedicated-revision assertion for this graph:

```text
quality_loop.body → has_feedback
has_feedback.false → worker → grader
has_feedback.true → revision_agent → grader
grader.continue → quality_loop
```

`has_feedback` checks whether `nodes.grader.data.feedback` exists, making the original worker create the first candidate and the selected revision agent handle later iterations.

- [ ] **Step 2: Run tests and observe RED**

Run: `npm test -- tests/workflows.test.ts`

Expected: FAIL because the quality-loop builder does not exist and the runtime has no quality-loop state.

- [ ] **Step 3: Implement explicit quality-loop state**

Persist per iteration:

```ts
type QualityIteration = {
  iteration: number;
  candidate: unknown;
  verdict: z.infer<typeof graderOutputSchema>;
  revisionAgentId: string;
};
```

Keep technical retry attempts separate from `maximumRevisions`. Extend while-loop limit handling so `exit` records `reason: 'limit_exit'`; route that reason through a normal condition node to `return_best` or `human_review`, while `fail` retains the runtime's safe failure behavior.

When the quality loop is revisited, append the latest candidate, validated verdict, selected revision agent, and iteration number to `run.state.qualityHistory[loopNodeId]`. Existing per-iteration node states remain the immutable execution trace.

- [ ] **Step 4: Add runtime integration scenarios**

Cover:

- First grade passes.
- Same worker revises once and then passes.
- Dedicated revision agent revises and then passes.
- Invalid grader output fails technically.
- Maximum revisions returns best result.
- Maximum revisions waits for human review.
- Maximum revisions fails safely.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- tests/workflows.test.ts tests/database.integration.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workflows/quality-loop.ts src/workflows/definition.ts src/workflows/runtime.ts src/workflows/registry.ts tests/workflows.test.ts tests/database.integration.test.ts
git commit -m "feat: add bounded workflow quality loops"
```

### Task 5: Prompt-to-Agent Generates Advanced Workflows

**Files:**
- Modify: `src/solutions/schema.ts`
- Modify: `src/solutions/compiler.ts`
- Modify: `src/solutions/installer.ts`
- Modify: `src/solutions/catalog.ts`
- Test: `tests/agent-solutions.test.ts`

**Interfaces:**
- Produces: Solution workflow edges with optional `condition`.
- Produces: Solution workflow node types matching supported workflow registry types.
- Consumes: Quality-loop node configuration and structured grader output contract.

- [ ] **Step 1: Write failing solution-schema tests**

Add a generated solution containing trigger, worker, grader, quality loop, optional revision agent, and output. Assert it parses and materializes without losing edge conditions.

Add a negative test proving an arbitrary unbounded cycle is rejected.

- [ ] **Step 2: Run tests and observe RED**

Run: `npm test -- tests/agent-solutions.test.ts`

Expected: FAIL because solution nodes only support four types and solution cycles are always rejected.

- [ ] **Step 3: Expand the compiler contract**

Make solution edges:

```ts
z.object({
  source: key,
  target: key,
  condition: z.enum(['true', 'false', 'body', 'done', 'continue', 'passed', 'failed', 'limit']).optional(),
})
```

Allow supported condition/loop nodes and delegate final safety validation to `workflowDefinitionErrors(materializeWorkflowDefinition(...))`.

Replace the compiler rule requiring an acyclic sequential workflow with explicit bounded-loop rules and a quality-loop JSON example. Require a quality loop when the user asks for a grader, evaluator, retry-until-pass behavior, or a quality threshold.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/agent-solutions.test.ts tests/workflows.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/solutions/schema.ts src/solutions/compiler.ts src/solutions/installer.ts src/solutions/catalog.ts tests/agent-solutions.test.ts
git commit -m "feat: generate advanced quality workflows"
```

### Task 6: Progressive Node Inspector

**Files:**
- Create: `web-stitch/src/features/workflows/NodeInspector.tsx`
- Create: `web-stitch/src/features/workflows/InputSchemaEditor.tsx`
- Create: `web-stitch/src/features/workflows/InputMappingEditor.tsx`
- Modify: `web-stitch/src/features/workflows/WorkflowsPage.tsx`
- Modify: `web-stitch/src/features/workflows/WorkflowCanvas.tsx`
- Modify: `web-stitch/src/index.css`
- Test: `web-stitch/src/features/workflows/NodeInspector.test.tsx`

**Interfaces:**
- Produces: `NodeInspector` driven by catalog `inspectorSections`.
- Consumes: Node config update callback, resources, upstream nodes, and validation messages.

- [ ] **Step 1: Add frontend test dependencies only if absent**

Use the existing Vitest stack. If React Testing Library is absent, install `@testing-library/react`, `@testing-library/user-event`, and `jsdom` as development dependencies and configure the frontend test environment.

- [ ] **Step 2: Write failing inspector behavior tests**

Render real inspector components and assert:

- Agent displays Inputs, Configuration, and Execution.
- Trigger displays Input collection and Variables.
- Output does not display Execution.
- Choosing dedicated revision reveals the revision-agent selector.
- Editing a mapping calls `update` with the expected literal config.

- [ ] **Step 3: Run frontend tests and observe RED**

Run: `cd web-stitch && npx vitest run src/features/workflows/NodeInspector.test.tsx`

Expected: FAIL because the progressive inspector components do not exist.

- [ ] **Step 4: Implement progressive sections**

Move the current schema field rendering out of `WorkflowsPage.tsx`. Use semantic fieldsets with section-level validation. Keep advanced mappings and variables collapsed by default. Render no markup for unsupported sections.

Generate trigger input forms in the workflow test/run dialog while preserving a “Raw JSON” switch.

- [ ] **Step 5: Verify GREEN and build**

Run:

```bash
cd web-stitch
npx vitest run src/features/workflows/NodeInspector.test.tsx
npm run build
```

Expected: PASS and build exit 0.

- [ ] **Step 6: Commit**

```bash
git add web-stitch/package.json web-stitch/package-lock.json web-stitch/src/features/workflows/NodeInspector.tsx web-stitch/src/features/workflows/InputSchemaEditor.tsx web-stitch/src/features/workflows/InputMappingEditor.tsx web-stitch/src/features/workflows/NodeInspector.test.tsx web-stitch/src/features/workflows/WorkflowsPage.tsx web-stitch/src/features/workflows/WorkflowCanvas.tsx web-stitch/src/index.css
git commit -m "feat: add capability-based workflow inspector"
```

### Task 7: First-Class Edge Editing

**Files:**
- Create: `web-stitch/src/features/workflows/WorkflowEdge.tsx`
- Modify: `web-stitch/src/features/workflows/WorkflowCanvas.tsx`
- Modify: `web-stitch/src/features/workflows/WorkflowsPage.tsx`
- Modify: `web-stitch/src/index.css`
- Test: `web-stitch/src/features/workflows/WorkflowEdge.test.tsx`

**Interfaces:**
- Produces: Selectable edge component with delete, reconnect, label, and insert actions.
- Consumes: Existing undo/redo snapshot state and workflow edge definitions.

- [ ] **Step 1: Write failing edge interaction tests**

Assert observable callbacks for:

- Clicking the enlarged edge hit target selects it.
- Toolbar delete removes exactly that edge.
- Reconnecting replaces source or target while retaining a valid branch label.
- Insert-on-edge replaces one edge with two edges.
- Connecting a single-output node with an existing target requests replacement.

- [ ] **Step 2: Run tests and observe RED**

Run: `cd web-stitch && npx vitest run src/features/workflows/WorkflowEdge.test.tsx`

Expected: FAIL because there is no custom selectable edge.

- [ ] **Step 3: Implement edge editing**

Use a custom React Flow edge with a wide transparent interaction path and visible selected state. Enable `edgesReconnectable`, implement `onReconnect`, and expose an accessible edge toolbar. Route every mutation through the existing snapshot history.

- [ ] **Step 4: Verify GREEN and build**

Run:

```bash
cd web-stitch
npx vitest run src/features/workflows/WorkflowEdge.test.tsx
npm run build
```

Expected: PASS and build exit 0.

- [ ] **Step 5: Commit**

```bash
git add web-stitch/src/features/workflows/WorkflowEdge.tsx web-stitch/src/features/workflows/WorkflowEdge.test.tsx web-stitch/src/features/workflows/WorkflowCanvas.tsx web-stitch/src/features/workflows/WorkflowsPage.tsx web-stitch/src/index.css
git commit -m "feat: make workflow connections directly editable"
```

### Task 8: GLM-4.7 Model Migration

**Files:**
- Modify: `src/routes/runtime.ts`
- Modify: `src/routes/agents.ts`
- Modify: `web-stitch/src/api.ts`
- Modify: `web-stitch/src/features/settings/ProviderSettingsPanel.tsx`
- Test: `tests/api-validation.test.ts`
- Test: `tests/database.integration.test.ts`

**Interfaces:**
- Produces: `POST /v1/runtime/config/model-migration-preview`.
- Produces: `POST /v1/runtime/config/model-migration`.
- Consumes: Existing workspace provider configuration and encrypted API key.

- [ ] **Step 1: Write failing migration tests**

Assert that:

- Preview returns affected agent count and model distribution without mutation.
- Applying a model-only migration preserves the encrypted key and base URL.
- Existing agents change only when `migrateExistingAgents` is true.
- A provider test must succeed before migration.
- Unauthorized members cannot migrate models.

- [ ] **Step 2: Run tests and observe RED**

Run: `npm test -- tests/api-validation.test.ts tests/database.integration.test.ts`

Expected: FAIL because migration routes do not exist.

- [ ] **Step 3: Implement transactional migration**

Within one transaction:

1. Lock the workspace provider config.
2. Verify the tested provider/model combination is healthy.
3. Update only `default_model`, preserving `encrypted_api_key` and `base_url`.
4. Optionally update agents matching an explicit source-model filter.
5. Write an audit event containing counts and model names, never credentials.

- [ ] **Step 4: Add settings preview and confirmation**

Show:

- Current and target models.
- Number of affected agents.
- “Workspace default only” and “Also migrate existing agents” control.
- Provider-test result.
- A reversible model-name preview.

- [ ] **Step 5: Test GLM-4.7 through the existing provider test route**

Set the workspace override to the existing OpenAI-compatible base URL and `glm-4.7` without supplying a new API key. Call `/v1/runtime/config/test`; proceed only on `healthy`.

- [ ] **Step 6: Verify GREEN and build**

Run:

```bash
npm test -- tests/api-validation.test.ts tests/database.integration.test.ts
npm run build
cd web-stitch && npm run build
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/routes/runtime.ts src/routes/agents.ts web-stitch/src/api.ts web-stitch/src/features/settings/ProviderSettingsPanel.tsx tests/api-validation.test.ts tests/database.integration.test.ts
git commit -m "feat: add safe workspace model migration"
```

### Task 9: Full Verification and UX Acceptance

**Files:**
- Modify if required by observed failures: only files already listed above.
- Test: all affected backend and frontend tests.

**Interfaces:**
- Consumes: Completed workflow editor, runtime, compiler, and model migration.
- Produces: Verification evidence and an acceptance checklist.

- [ ] **Step 1: Run the complete backend suite**

Run:

```bash
npm test
npm run build
```

Expected: zero failures and exit 0.

- [ ] **Step 2: Run frontend checks**

Run:

```bash
cd web-stitch
npx vitest run
npm run lint
npm run build
```

Expected: zero failures/errors and exit 0.

- [ ] **Step 3: Rebuild the local stack**

Run: `docker compose up -d --build api worker web-stitch`

Expected: containers start successfully and health checks remain healthy.

- [ ] **Step 4: Verify the complete browser story**

In the running app:

1. Generate “Create a writer and grader; revise until score is at least 80.”
2. Confirm the proposal contains worker, grader, pass output, bounded failed-grade loop, and editable revision strategy.
3. Change from same-worker to dedicated revision agent.
4. Edit trigger fields and agent input mappings.
5. Delete, reconnect, relabel, and insert a node on an edge.
6. Run a failing-then-passing test and inspect persisted iteration feedback.
7. Confirm the editor and handles remain readable in light and dark themes.
8. Confirm existing linear workflows still open and run without mappings.

- [ ] **Step 5: Review the final diff against the design**

Run:

```bash
git diff --check
git status --short
```

Confirm every design requirement maps to implementation and that unrelated dirty files were not overwritten.

- [ ] **Step 6: Commit verification-only corrections**

If browser verification required corrections, stage only those feature files and commit:

```bash
git commit -m "fix: complete workflow quality-loop acceptance"
```
