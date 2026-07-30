# LangGraph Copilot Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace proposal-only Copilot routing with an embedded LangGraph.js orchestrator that answers contextual questions, generates valid refinement and Draft-agent proposals, repairs malformed candidates once, and reports actionable safe failures.

**Architecture:** Add a typed `StateGraph` behind the existing `orchestrateCopilotTurn` interface. Deterministic nodes route common intents; provider-backed nodes answer, classify ambiguous turns, compile candidates, and perform at most one bounded repair. Existing PostgreSQL chat/context/proposal/approval/receipt services remain authoritative, and the graph never approves or applies mutations.

**Tech Stack:** TypeScript, Node.js 22, `@langchain/langgraph@1.4.8`, `@langchain/core@1.2.3`, Zod 3.25+, Fastify, PostgreSQL, Vitest, React

## Global Constraints

- Keep the graph embedded in the existing TypeScript API; do not add Python, Agent Server, LangSmith, or a LangGraph checkpointer.
- Preserve the current `orchestrateCopilotTurn` public interface so chat routes and integration tests do not require a second orchestration API.
- Keep existing chat threads, context snapshots, proposals, approvals, output versions, Draft agents, audits, and receipts as the system of record.
- Support only contextual answers, clarification, output refinement, and Draft-agent proposals.
- Permit no more than one repair call and no more than three provider calls in the ambiguous-intent-plus-repair edge case.
- Never log raw provider responses, output content, attachment extracts, credentials, or document passages.
- Invalid output must create no proposal and cause no mutation.
- Deferred features remain deferred: workflow graph changes, Departments, MCP/API permissions, publishing, and activation.
- Preserve unrelated worktree changes, including the existing MCP connection modification and untracked workspace-import work.

---

## File structure

### New files

- `src/copilot/graph/state.ts` — graph state schema, intent enum, validation issue and final result types.
- `src/copilot/graph/intent.ts` — deterministic intent detection and bounded ambiguous-intent classification contract.
- `src/copilot/graph/model.ts` — provider completion adapter for answers, candidates, classification, and repair.
- `src/copilot/graph/nodes.ts` — focused graph nodes with injected dependencies.
- `src/copilot/graph/graph.ts` — `StateGraph` construction, conditional edges, and invocation adapter.
- `tests/copilot-langgraph-intent.test.ts` — deterministic and ambiguous routing tests.
- `tests/copilot-langgraph-graph.test.ts` — graph path, validation, repair, and persistence tests.
- `tests/copilot-citation-deduplication.test.ts` — citation identity and score-selection tests.

### Modified files

- `package.json`, `package-lock.json` — LangGraph/Core dependencies and compatible Zod floor.
- `src/copilot/types.ts` — typed proposal-error event.
- `src/copilot/contracts.ts` — exported generated-candidate parsing helpers used by graph validation.
- `src/copilot/orchestrator.ts` — retain context loading and public interface while delegating turn execution to the graph.
- `src/files/context.ts` — deduplicate display citations by `fileId + locator`.
- `src/routes/chat-threads.ts` — safe trace logging and proposal-error metadata; no raw model output.
- `tests/copilot-orchestrator.test.ts` — legacy-interface parity and error-code assertions.
- `tests/copilot-api.integration.test.ts` — contextual question and safe schema failure coverage.
- `tests/copilot-vertical-slice.integration.test.ts` — proposal/approval parity through the LangGraph path.
- `web-stitch/src/contracts/copilot.ts` — frontend proposal-error event contract.
- `web-stitch/src/features/copilot/CopilotEventCard.tsx` — actionable retry card.
- `web-stitch/src/features/copilot/CopilotCards.test.tsx` — proposal-error and retry rendering.
- `web-stitch/src/features/copilot/WoodyChat.tsx` — retry the failed user intent without losing context.
- `web-stitch/src/features/copilot/WoodyChat.test.tsx` — retry and retained-context behavior.

---

### Task 1: Install LangGraph and define graph state

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/copilot/graph/state.ts`
- Test: `tests/copilot-langgraph-intent.test.ts`

**Interfaces:**
- Produces: `CopilotIntent`, `CopilotGraphInput`, `CopilotGraphState`, `CopilotGraphResult`, `SafeValidationIssue`.
- Consumes: existing `CopilotContextSnapshotRecord`, `CopilotEvent`, `WoodyChatMessage`, and proposal-kind types.

- [ ] **Step 1: Install compatible runtime dependencies**

Run:

```bash
npm install @langchain/langgraph@1.4.8 @langchain/core@1.2.3 zod@^3.25.32
```

Expected:

- `package.json` contains the two LangChain packages.
- Zod remains on major version 3 and satisfies LangGraph's peer range.
- `npm ls @langchain/langgraph @langchain/core zod` exits successfully.

- [ ] **Step 2: Write the failing graph-state schema test**

Create `tests/copilot-langgraph-intent.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { copilotIntentSchema, safeValidationIssueSchema } from '../src/copilot/graph/state.js';

describe('Copilot LangGraph state contracts', () => {
  it('accepts only supported intents', () => {
    expect(copilotIntentSchema.parse('answer_question')).toBe('answer_question');
    expect(copilotIntentSchema.parse('refine_output')).toBe('refine_output');
    expect(() => copilotIntentSchema.parse('publish_agent')).toThrow();
  });

  it('keeps validation diagnostics safe and field-scoped', () => {
    expect(safeValidationIssueSchema.parse({
      path: ['candidate', 'goal'],
      code: 'too_small',
    })).toEqual({ path: ['candidate', 'goal'], code: 'too_small' });
    expect(() => safeValidationIssueSchema.parse({
      path: ['candidate'],
      code: 'invalid_type',
      rawResponse: 'secret provider output',
    })).toThrow();
  });
});
```

- [ ] **Step 3: Run the contract test and verify it fails**

Run:

```bash
npm test -- tests/copilot-langgraph-intent.test.ts
```

Expected: FAIL because `src/copilot/graph/state.ts` does not exist.

- [ ] **Step 4: Implement the typed state contracts**

Create `src/copilot/graph/state.ts` defining:

```ts
import { z } from 'zod';
import type { WoodyChatMessage } from '../../routes/copilot.js';
import type {
  CopilotContextSnapshotRecord,
  CopilotEvent,
  CopilotProposalKind,
} from '../types.js';

export const copilotIntentSchema = z.enum([
  'answer_question',
  'refine_output',
  'create_draft_agent',
  'clarify',
  'unsupported',
]);
export type CopilotIntent = z.infer<typeof copilotIntentSchema>;

export const safeValidationIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])).max(12),
  code: z.string().trim().min(1).max(80),
}).strict();
export type SafeValidationIssue = z.infer<typeof safeValidationIssueSchema>;

export type LoadedCopilotTurn = {
  context: CopilotContextSnapshotRecord;
  outputContent: string;
  clarificationRound: number;
};

export type CopilotGraphInput = {
  workspaceId: string;
  actorId: string;
  threadId: string;
  messages: WoodyChatMessage[];
  loaded: LoadedCopilotTurn;
  traceId: string;
};

export type CopilotGraphState = CopilotGraphInput & {
  intent?: CopilotIntent;
  proposalKind?: CopilotProposalKind;
  answer?: string;
  candidate?: unknown;
  validationIssues: SafeValidationIssue[];
  repairCount: 0 | 1;
  proposalId?: string;
  event?: CopilotEvent;
  path: string[];
  repairAttempted: boolean;
  repairSucceeded: boolean;
};

export type CopilotGraphResult = {
  content: string;
  event: CopilotEvent;
  contextSnapshotId: string;
  proposalId?: string;
  traceId: string;
  path: string[];
  repairAttempted: boolean;
  repairSucceeded: boolean;
};
```

- [ ] **Step 5: Run the focused test and backend build**

Run:

```bash
npm test -- tests/copilot-langgraph-intent.test.ts
npm run build
```

Expected: both PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add package.json package-lock.json src/copilot/graph/state.ts tests/copilot-langgraph-intent.test.ts
git commit -m "build: add LangGraph Copilot state contracts"
```

---

### Task 2: Add deterministic intent routing

**Files:**
- Create: `src/copilot/graph/intent.ts`
- Modify: `tests/copilot-langgraph-intent.test.ts`

**Interfaces:**
- Consumes: `WoodyChatMessage[]`, the latest clarification proposal kind, and `CopilotIntent`.
- Produces: `detectDeterministicIntent(messages, outstandingProposalKind)` returning `{ intent, confidence, proposalKind? }`.

- [ ] **Step 1: Add failing routing tests**

Append:

```ts
import { detectDeterministicIntent } from '../src/copilot/graph/intent.js';

describe('deterministic Copilot intent routing', () => {
  it.each([
    ['is there any error?', 'answer_question'],
    ['what does this paragraph mean?', 'answer_question'],
    ['rewrite this for an executive audience', 'refine_output'],
    ['shorten the selected output', 'refine_output'],
    ['create a new research agent', 'create_draft_agent'],
    ['add an agent to handle citations', 'create_draft_agent'],
    ['publish this agent', 'unsupported'],
    ['connect Gmail and grant access', 'unsupported'],
  ] as const)('routes %s to %s', (content, intent) => {
    expect(detectDeterministicIntent([{ role: 'user', content }], null).intent).toBe(intent);
  });

  it('resumes the outstanding clarification kind', () => {
    expect(detectDeterministicIntent(
      [{ role: 'user', content: 'Use senior executives as the audience.' }],
      'output_refinement',
    )).toMatchObject({ intent: 'refine_output', proposalKind: 'output_refinement' });
  });

  it('marks genuinely ambiguous requests for classification', () => {
    expect(detectDeterministicIntent(
      [{ role: 'user', content: 'make it better' }],
      null,
    ).confidence).toBe('ambiguous');
  });
});
```

- [ ] **Step 2: Run the intent tests and verify failure**

Run:

```bash
npm test -- tests/copilot-langgraph-intent.test.ts
```

Expected: FAIL because `detectDeterministicIntent` is missing.

- [ ] **Step 3: Implement rule-first intent detection**

Create `src/copilot/graph/intent.ts` with normalized latest-message matching:

```ts
import type { WoodyChatMessage } from '../../routes/copilot.js';
import type { CopilotProposalKind } from '../types.js';
import type { CopilotIntent } from './state.js';

type IntentDecision = {
  intent?: CopilotIntent;
  confidence: 'deterministic' | 'ambiguous';
  proposalKind?: CopilotProposalKind;
};

const unsupported = /\b(publish|activate|department|connect\s+(gmail|mcp|api)|grant\s+(access|permission)|workflow\s+graph)\b/i;
const draftAgent = /\b(create|add|build|request|generate)\b[\s\S]{0,60}\bagent\b/i;
const refinement = /\b(rewrite|refine|improve|shorten|expand|edit|revise|rephrase|summari[sz]e)\b/i;
const question = /(^|\s)(what|why|how|is|are|does|do|can|could|where|when|which|who)\b|\?$/i;

export function detectDeterministicIntent(
  messages: WoodyChatMessage[],
  outstandingProposalKind: CopilotProposalKind | null,
): IntentDecision {
  const content = messages.at(-1)?.content.trim() ?? '';
  if (outstandingProposalKind) {
    return {
      intent: outstandingProposalKind === 'output_refinement'
        ? 'refine_output'
        : 'create_draft_agent',
      proposalKind: outstandingProposalKind,
      confidence: 'deterministic',
    };
  }
  if (unsupported.test(content)) return { intent: 'unsupported', confidence: 'deterministic' };
  if (draftAgent.test(content)) return { intent: 'create_draft_agent', proposalKind: 'draft_agent', confidence: 'deterministic' };
  if (refinement.test(content)) return { intent: 'refine_output', proposalKind: 'output_refinement', confidence: 'deterministic' };
  if (question.test(content)) return { intent: 'answer_question', confidence: 'deterministic' };
  return { confidence: 'ambiguous' };
}
```

Keep the unsupported rule before agent/refinement rules so permission and
publishing requests cannot be reclassified as safe Draft mutations.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- tests/copilot-langgraph-intent.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/copilot/graph/intent.ts tests/copilot-langgraph-intent.test.ts
git commit -m "feat: route Copilot intents deterministically"
```

---

### Task 3: Add bounded model adapters and candidate repair

**Files:**
- Create: `src/copilot/graph/model.ts`
- Modify: `src/copilot/contracts.ts`
- Create: `tests/copilot-langgraph-graph.test.ts`

**Interfaces:**
- Consumes: `requestCopilotCompletion`, existing Zod generated-turn contracts, bounded messages/context/output.
- Produces: `CopilotModelAdapter` with `classify`, `answer`, `generateProposal`, and `repairProposal`.
- Produces: `safeZodIssues(error)` returning `SafeValidationIssue[]`.

- [ ] **Step 1: Write failing adapter tests with a fake completion**

Create `tests/copilot-langgraph-graph.test.ts` covering:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createCopilotModelAdapter, safeZodIssues } from '../src/copilot/graph/model.js';
import { z } from 'zod';

describe('Copilot graph model adapter', () => {
  it('parses a fenced structured intent response', async () => {
    const complete = vi.fn(async () => ({
      message: '```json\n{"intent":"answer_question"}\n```',
      provider: 'test',
      model: 'test',
      usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
    }));
    const adapter = createCopilotModelAdapter(complete as never);
    await expect(adapter.classify({ workspaceId: 'workspace', messages: [] } as never))
      .resolves.toBe('answer_question');
  });

  it('returns only safe validation paths and codes', () => {
    const parsed = z.object({ goal: z.string().min(2) }).safeParse({ goal: '' });
    if (parsed.success) throw new Error('expected invalid fixture');
    expect(safeZodIssues(parsed.error)).toEqual([
      { path: ['goal'], code: 'too_small' },
    ]);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm test -- tests/copilot-langgraph-graph.test.ts
```

Expected: FAIL because `src/copilot/graph/model.ts` does not exist.

- [ ] **Step 3: Export reusable parsing helpers**

Modify `src/copilot/contracts.ts` to export strict schemas for:

- intent classification: `{ intent: CopilotIntent }`;
- refinement candidate;
- Draft-agent candidate;
- clarification;
- normal message.

Keep application-owned document/version/hash fields outside generated schemas.
Export `parseJsonObject` from the graph model module, accepting plain JSON or one
complete JSON fence and rejecting surrounding prose.

- [ ] **Step 4: Implement the model adapter**

Create `src/copilot/graph/model.ts`:

```ts
export type CopilotModelAdapter = {
  classify(input: ModelTurnInput): Promise<CopilotIntent>;
  answer(input: ModelTurnInput): Promise<string>;
  generateProposal(input: ModelTurnInput & {
    proposalKind: CopilotProposalKind;
  }): Promise<unknown>;
  repairProposal(input: {
    workspaceId: string;
    proposalKind: CopilotProposalKind;
    candidate: unknown;
    issues: SafeValidationIssue[];
  }): Promise<unknown>;
};
```

Requirements:

- inject `requestCopilotCompletion` so unit tests make no provider calls;
- use separate concise system prompts for each method;
- include attachment extracts only in `answer` and `generateProposal`;
- exclude attachments and conversation history from `repairProposal`;
- return raw candidates to graph validation, not directly to persistence;
- convert Zod issues using only `path` and `code`.

- [ ] **Step 5: Add malformed JSON and repair-prompt tests**

Add assertions that:

- surrounding prose throws `SyntaxError`;
- a repair call receives validation paths/codes but not output or attachment text;
- answer output is treated as text and is never parsed as a proposal;
- classification accepts only the five supported intents.

- [ ] **Step 6: Run tests and build**

Run:

```bash
npm test -- tests/copilot-langgraph-graph.test.ts tests/copilot-contracts.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/copilot/graph/model.ts src/copilot/contracts.ts tests/copilot-langgraph-graph.test.ts tests/copilot-contracts.test.ts
git commit -m "feat: add bounded Copilot model adapters"
```

---

### Task 4: Build the LangGraph StateGraph

**Files:**
- Create: `src/copilot/graph/nodes.ts`
- Create: `src/copilot/graph/graph.ts`
- Modify: `src/copilot/types.ts`
- Modify: `tests/copilot-langgraph-graph.test.ts`

**Interfaces:**
- Consumes: `CopilotGraphInput`, `CopilotModelAdapter`, `detectDeterministicIntent`, `createCopilotProposal`.
- Produces: `createCopilotGraph(dependencies)` and `runCopilotGraph(input, dependencies)`.

- [ ] **Step 1: Add failing path tests**

Add fake dependencies and tests proving:

```ts
it('answers a contextual question without generating a proposal', async () => {
  const deps = fakeDependencies();
  const result = await runCopilotGraph(questionInput, deps);
  expect(result.event).toEqual({ type: 'message', content: 'No execution error was found.' });
  expect(deps.model.generateProposal).not.toHaveBeenCalled();
  expect(deps.createProposal).not.toHaveBeenCalled();
});

it('repairs one invalid refinement candidate and persists the repaired proposal', async () => {
  deps.model.generateProposal.mockResolvedValue({
    type: 'refinement_candidate',
    proposedContent: '',
    changeSummary: [],
  });
  deps.model.repairProposal.mockResolvedValue({
    type: 'refinement_candidate',
    proposedContent: '# Improved',
    changeSummary: ['Clarified the result'],
  });
  const result = await runCopilotGraph(refinementInput, deps);
  expect(result.event.type).toBe('refinement_preview');
  expect(deps.model.repairProposal).toHaveBeenCalledTimes(1);
  expect(deps.createProposal).toHaveBeenCalledTimes(1);
});

it('fails with a typed safe event after one unsuccessful repair', async () => {
  const result = await runCopilotGraph(refinementInput, invalidDependencies);
  expect(result.event).toMatchObject({
    type: 'proposal_error',
    code: 'COPILOT_PROPOSAL_SCHEMA_INVALID',
    retryable: true,
  });
  expect(invalidDependencies.createProposal).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm test -- tests/copilot-langgraph-graph.test.ts
```

Expected: FAIL because graph and nodes are missing.

- [ ] **Step 3: Add the typed proposal-error event**

Extend `CopilotEvent` in `src/copilot/types.ts` before implementing the failure
node:

```ts
{
  type: 'proposal_error';
  code: 'COPILOT_INTENT_CLASSIFICATION_FAILED'
    | 'COPILOT_PROPOSAL_SCHEMA_INVALID'
    | 'COPILOT_PROVIDER_FAILED';
  message: string;
  requestId: string;
  retryable: boolean;
}
```

- [ ] **Step 4: Implement focused graph nodes**

Create `src/copilot/graph/nodes.ts` with individually exported node factories:

- `loadIntentNode`;
- `classifyIntentNode`;
- `answerQuestionNode`;
- `clarificationNode`;
- `compileRefinementNode`;
- `compileDraftAgentNode`;
- `validateCandidateNode`;
- `repairCandidateNode`;
- `persistProposalNode`;
- `unsupportedNode`;
- `schemaFailureNode`;
- `finalizeTurnNode`.

Each node returns only a partial graph-state update. No node performs both a
provider call and a database mutation.

- [ ] **Step 5: Construct conditional edges**

Create `src/copilot/graph/graph.ts` using `StateGraph` and a typed state schema.
The compiled graph must implement:

- deterministic route or ambiguous classification;
- answer/unsupported/clarification terminal branches;
- proposal compile → validate;
- validation failure → one repair → validate;
- second validation failure → typed schema failure;
- valid candidate → proposal persistence;
- a path array for safe trace logging.

Do not compile with `MemorySaver` or another checkpointer.

- [ ] **Step 6: Add safety and call-budget tests**

Assert:

- a normal question makes one answer call;
- a deterministic proposal makes one generation call when valid;
- an invalid deterministic proposal makes generation plus one repair;
- ambiguous intent plus invalid proposal makes exactly three calls;
- no path makes four provider calls;
- `persistProposalNode` receives authoritative output IDs/hashes from loaded
  context rather than model output.

- [ ] **Step 7: Run graph tests and backend build**

Run:

```bash
npm test -- tests/copilot-langgraph-intent.test.ts tests/copilot-langgraph-graph.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add src/copilot/types.ts src/copilot/graph/nodes.ts src/copilot/graph/graph.ts tests/copilot-langgraph-graph.test.ts
git commit -m "feat: orchestrate Copilot turns with LangGraph"
```

---

### Task 5: Replace legacy orchestration behind the existing interface

**Files:**
- Modify: `src/copilot/orchestrator.ts`
- Modify: `src/routes/chat-threads.ts`
- Modify: `tests/copilot-orchestrator.test.ts`
- Modify: `tests/copilot-api.integration.test.ts`
- Modify: `tests/copilot-vertical-slice.integration.test.ts`

**Interfaces:**
- Preserves: `orchestrateCopilotTurn(input, dependencies?)`.
- Adds: `proposal_error` event with `code`, `requestId`, `retryable`, and `message`.

- [ ] **Step 1: Change failing parity tests first**

Update the former generic-fallback assertions to:

```ts
expect(result.event).toMatchObject({
  type: 'proposal_error',
  code: 'COPILOT_PROPOSAL_SCHEMA_INVALID',
  retryable: true,
});
```

Add:

```ts
it('answers a question while output context is attached', async () => {
  const result = await orchestrateCopilotTurn({
    ...input,
    messages: [{ role: 'user', content: 'is there any error?' }],
  }, deps);
  expect(result.event).toEqual({
    type: 'message',
    content: 'No error was found in the selected output.',
  });
  expect(createProposal).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and verify expected failures**

Run:

```bash
npm test -- tests/copilot-orchestrator.test.ts
```

Expected: FAIL because the legacy orchestrator still routes every contextual turn
through proposal-only generation.

- [ ] **Step 3: Delegate to the graph**

Keep `loadCopilotTurnContext` in `src/copilot/orchestrator.ts`. Replace
`defaultCopilotTurnGenerator` and manual branching with:

```ts
const loaded = await dependencies.loadTurnContext(input);
return runCopilotGraph({
  ...input,
  loaded,
  traceId: randomUUID(),
}, graphDependencies);
```

Preserve dependency injection used by existing unit and vertical-slice tests.

- [ ] **Step 4: Add safe graph trace logging**

In `src/routes/chat-threads.ts`, log:

- request ID;
- graph trace ID;
- thread/context/proposal IDs;
- path;
- event type;
- repair attempted/succeeded.

Do not log messages, output, attachments, candidates, or provider responses.

- [ ] **Step 5: Run unit and database integration tests**

Run:

```bash
npm test -- tests/copilot-orchestrator.test.ts tests/copilot-proposals.test.ts tests/copilot-domain-seams.test.ts
RUN_INTEGRATION=true DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus \
  npm test -- tests/copilot-api.integration.test.ts tests/copilot-vertical-slice.integration.test.ts
npm run build
```

Expected: all PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/copilot/orchestrator.ts src/routes/chat-threads.ts tests/copilot-orchestrator.test.ts tests/copilot-api.integration.test.ts tests/copilot-vertical-slice.integration.test.ts
git commit -m "feat: route contextual Copilot through LangGraph"
```

---

### Task 6: Deduplicate citations

**Files:**
- Modify: `src/files/context.ts`
- Create: `tests/copilot-citation-deduplication.test.ts`

**Interfaces:**
- Produces: `deduplicateDisplayCitations(citations)` retaining the highest-scored citation for each `fileId + locator`.
- Preserves: multiple distinct chunks for model grounding.

- [ ] **Step 1: Write the failing deduplication test**

```ts
import { describe, expect, it } from 'vitest';
import { deduplicateDisplayCitations } from '../src/files/context.js';

describe('Copilot citation display deduplication', () => {
  it('returns one display citation per file and locator', () => {
    const result = deduplicateDisplayCitations([
      { fileId: 'f1', filename: 'resume.pdf', locator: 'Page 1', content: 'a', score: 0.1 },
      { fileId: 'f1', filename: 'resume.pdf', locator: 'Page 1', content: 'b', score: 0.7 },
      { fileId: 'f1', filename: 'resume.pdf', locator: 'Page 2', content: 'c', score: 0.3 },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ locator: 'Page 1', score: 0.7 });
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm test -- tests/copilot-citation-deduplication.test.ts
```

Expected: FAIL because the export does not exist.

- [ ] **Step 3: Implement display-only deduplication**

Add `deduplicateDisplayCitations` using a `Map<string, FileCitation>` keyed by
`${fileId}\u0000${locator}`. Replace an existing entry only when the next score is
higher.

Return both arrays from retrieval:

```ts
{
  text: contextText(groundingCitations),
  citations: deduplicateDisplayCitations(groundingCitations),
}
```

This keeps all bounded chunks in the prompt but removes repeated UI sources.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- tests/copilot-citation-deduplication.test.ts tests/files.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add src/files/context.ts tests/copilot-citation-deduplication.test.ts
git commit -m "fix: deduplicate Copilot source citations"
```

---

### Task 7: Render actionable proposal failures and retry safely

**Files:**
- Modify: `web-stitch/src/contracts/copilot.ts`
- Modify: `web-stitch/src/features/copilot/CopilotEventCard.tsx`
- Modify: `web-stitch/src/features/copilot/CopilotCards.test.tsx`
- Modify: `web-stitch/src/features/copilot/WoodyChat.tsx`
- Modify: `web-stitch/src/features/copilot/WoodyChat.test.tsx`

**Interfaces:**
- Consumes: backend `proposal_error` event.
- Produces: retry UI that resends the original failed user intent in the same thread and attached context.

- [ ] **Step 1: Write failing card and retry tests**

Add a `proposal_error` fixture and assert:

```tsx
render(<CopilotEventCard
  event={{
    type: 'proposal_error',
    code: 'COPILOT_PROPOSAL_SCHEMA_INVALID',
    message: 'The proposal response was invalid.',
    requestId: 'trace-1',
    retryable: true,
  }}
  onApprove={vi.fn()}
  onReject={vi.fn()}
  onRegenerate={vi.fn()}
  onRetry={retry}
/>);
fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
expect(retry).toHaveBeenCalledTimes(1);
```

In `WoodyChat.test.tsx`, assert the retry uses the failed user message, same
thread ID, and does not call `attachCopilotContext` a second time.

- [ ] **Step 2: Run and verify failure**

Run from `web-stitch`:

```bash
npx vitest run src/features/copilot/CopilotCards.test.tsx src/features/copilot/WoodyChat.test.tsx
```

Expected: FAIL because `proposal_error` and `onRetry` are unsupported.

- [ ] **Step 3: Extend frontend contracts and cards**

Add the exact backend proposal-error union to
`web-stitch/src/contracts/copilot.ts`. Render:

- safe message;
- short error code;
- request ID;
- `Try again` only when `retryable` is true.

Do not render validation paths, candidates, or provider responses.

- [ ] **Step 4: Preserve the failed intent for retry**

Track the most recent user message by assistant response ID in `WoodyChat`.
`onRetry` calls the existing `send` function with that content. Keep the current
thread and `attachedContextRef`; do not create another thread or context snapshot.

- [ ] **Step 5: Run frontend tests, lint, and build**

Run:

```bash
npx vitest run src/features/copilot/CopilotCards.test.tsx src/features/copilot/WoodyChat.test.tsx
npm run lint
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit Task 7**

```bash
git add web-stitch/src/contracts/copilot.ts web-stitch/src/features/copilot/CopilotEventCard.tsx web-stitch/src/features/copilot/CopilotCards.test.tsx web-stitch/src/features/copilot/WoodyChat.tsx web-stitch/src/features/copilot/WoodyChat.test.tsx
git commit -m "feat: retry invalid Copilot proposals safely"
```

---

### Task 8: Full verification and local deployment

**Files:**
- Verify only unless a failing test identifies a scoped correction.

**Interfaces:**
- Verifies the complete user-visible lifecycle and existing deferred-feature boundaries.

- [ ] **Step 1: Run the complete focused backend suite**

```bash
npm test -- \
  tests/copilot-contracts.test.ts \
  tests/copilot-langgraph-intent.test.ts \
  tests/copilot-langgraph-graph.test.ts \
  tests/copilot-orchestrator.test.ts \
  tests/copilot-proposals.test.ts \
  tests/copilot-domain-seams.test.ts \
  tests/copilot-citation-deduplication.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run database integration tests**

```bash
RUN_INTEGRATION=true DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus \
  npm test -- tests/copilot-api.integration.test.ts tests/copilot-vertical-slice.integration.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run frontend verification**

```bash
cd web-stitch
npx vitest run src/features/copilot/CopilotCards.test.tsx src/features/copilot/WoodyChat.test.tsx
npm run lint
npm run build
```

Expected: PASS.

- [ ] **Step 4: Run backend build and dependency audit**

```bash
cd ..
npm run build
npm ls @langchain/langgraph @langchain/core zod
npm audit --omit=dev
git diff --check
```

Expected: build and dependency tree PASS; audit has no high or critical runtime vulnerability introduced by this change.

- [ ] **Step 5: Rebuild and restart the local app**

```bash
docker compose build api web-stitch
docker compose up -d --no-deps api web-stitch
curl -fsS http://localhost:3001/health
curl -fsSI http://localhost:3002 | head -1
```

Expected: API health JSON is `{"status":"ok"}` and frontend returns HTTP 200.

- [ ] **Step 6: Verify the live lifecycle**

In a temporary workspace with a completed output:

1. Open `Refine with Woody`.
2. Ask `is there any error?` and verify a normal answer with no proposal.
3. Request `Rewrite this for a senior executive audience` and verify a refinement preview.
4. Approve it and verify a new output version plus receipt.
5. Request `Create a Draft agent that checks this output for unsupported claims`.
6. Verify a Draft-agent proposal, approve it, and verify a Draft agent plus receipt.
7. Confirm a PDF with four same-page chunks displays one source for that page.
8. Delete the temporary workspace and user.

- [ ] **Step 7: Inspect production logs safely**

```bash
docker compose logs --since=15m api | rg -i "Copilot|proposal|error|failed"
```

Expected:

- safe graph path and trace metadata are present;
- no raw output, attachment content, candidate JSON, or provider response appears;
- no unhandled error is present.

- [ ] **Step 8: Resolve verification failures at their owning task**

If verification finds a defect, return to the task that owns that behavior,
write a failing regression test, implement the smallest correction, rerun that
task's focused commands, and commit the correction with that task's files. Do
not create an unscoped verification-only catch-all commit.
