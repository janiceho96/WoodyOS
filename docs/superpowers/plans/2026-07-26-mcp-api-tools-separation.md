# MCP and API Tools Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the combined Integrations experience with separate first-class MCP and API Tools navigation, pages, terminology, and resource presentation.

**Architecture:** Keep `/v1/mcp/*`, `/v1/tools/*`, MCP transport, API Tool runtime, and database storage unchanged. Split only the frontend information architecture and shared resource labels, with `/tools` retained as a redirect to `/api-tools`.

**Tech Stack:** React 19, React Router 7, TanStack Query, TypeScript, Vitest, Testing Library.

## Global Constraints

- No database migration.
- Do not merge MCP connections into the `tools` table.
- Keep backend `/v1/tools` and `/v1/mcp` routes stable.
- Keep credentials and raw connection configuration server-side.
- Preserve shared policy-gateway enforcement.
- `/tools` must redirect to `/api-tools`.

---

## File Structure

- Create `web-stitch/src/features/tools/ApiToolsPage.tsx`: API-only page composition.
- Create `web-stitch/src/features/tools/api-tools-page.test.tsx`: navigation and page-contract tests.
- Create `web-stitch/src/features/tools/api-tools.css`: API Tools page-specific layout.
- Create `web-stitch/src/app/navigation.ts`: testable primary-navigation contracts.
- Modify `web-stitch/src/features/tools/ToolsPage.tsx`: retain reusable API panels and dialog exports; remove MCP aggregation.
- Modify `web-stitch/src/features/mcp/McpMarketplacePage.tsx`: update first-class MCP title, sections, and copy.
- Modify `web-stitch/src/app/AppShell.tsx`: add separate primary navigation entries and labels.
- Modify `web-stitch/src/App.tsx`: add `/api-tools`, redirect `/tools`, retain `/mcp`.
- Modify `web-stitch/src/api.ts`: introduce explicit `ApiTool` naming while retaining a compatibility alias.
- Modify `web-stitch/src/features/agents/AgentBuilderPage.tsx`: separate MCP and API Tool resource groups.
- Modify `web-stitch/src/features/agents/AgentWorkspacePage.tsx`: separate assigned-resource summaries.
- Modify `web-stitch/src/features/workflows/WorkflowsPage.tsx`: update navigation copy only where it says Integrations.
- Modify `web-stitch/src/app/AppShell.tsx`: classify global-search resource results.
- Modify `web-stitch/src/index.css`: remove obsolete combined-Integrations selectors only after replacements exist.

### Task 1: Route and Navigation Contracts

**Files:**
- Create: `web-stitch/src/features/tools/api-tools-page.test.tsx`
- Modify: `web-stitch/src/App.tsx`
- Modify: `web-stitch/src/app/AppShell.tsx`

**Interfaces:**
- Produces routes `/api-tools`, `/mcp`, and legacy redirect `/tools`.
- Produces sidebar labels `MCP` and `API Tools`.

- [ ] **Step 1: Write failing route and navigation tests**

```tsx
import { describe, expect, it } from 'vitest';
import { primaryNavigation, resolveLegacyResourcePath } from '../../app/navigation';

describe('resource navigation', () => {
  it('exposes MCP and API Tools as separate primary destinations', () => {
    expect(primaryNavigation.map((item) => [item.label, item.path])).toEqual(
      expect.arrayContaining([
        ['MCP', '/mcp'],
        ['API Tools', '/api-tools'],
      ]),
    );
  });

  it('redirects the legacy tools path', () => {
    expect(resolveLegacyResourcePath('/tools')).toBe('/api-tools');
  });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
npm --prefix web-stitch exec vitest run src/features/tools/api-tools-page.test.tsx
```

Expected: FAIL because `app/navigation.ts` and the exported contracts do not exist.

- [ ] **Step 3: Extract navigation into a testable module**

Create `web-stitch/src/app/navigation.ts` with:

```ts
import { Activity, Bot, BookOpen, Braces, Blocks, LayoutDashboard, Workflow } from 'lucide-react';

export const primaryNavigation = [
  { id: 'home', path: '/dashboard', label: 'Home', Icon: LayoutDashboard },
  { id: 'agents', path: '/agents', label: 'Agents', Icon: Bot },
  { id: 'workflows', path: '/workflows', label: 'Workflows', Icon: Workflow },
  { id: 'outputs', path: '/executions', label: 'Outputs', Icon: Activity },
  { id: 'knowledge', path: '/knowledge', label: 'Knowledge', Icon: BookOpen },
  { id: 'mcp', path: '/mcp', label: 'MCP', Icon: Blocks },
  { id: 'api-tools', path: '/api-tools', label: 'API Tools', Icon: Braces },
] as const;

export function resolveLegacyResourcePath(path: string) {
  return path === '/tools' ? '/api-tools' : path;
}
```

Use `primaryNavigation` from `AppShell.tsx`. Add:

```tsx
<Route path="/api-tools" element={<ApiToolsRoute/>}/>
<Route path="/tools" element={<Navigate to="/api-tools" replace/>}/>
<Route path="/mcp" element={<McpMarketplacePage/>}/>
```

The Department plan adds its navigation item and route atomically. This plan must not ship a dead Department destination.

- [ ] **Step 4: Run tests and frontend build**

```bash
npm --prefix web-stitch exec vitest run src/features/tools/api-tools-page.test.tsx
npm --prefix web-stitch run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web-stitch/src/app/navigation.ts web-stitch/src/app/AppShell.tsx web-stitch/src/App.tsx web-stitch/src/features/tools/api-tools-page.test.tsx
git commit -m "feat: separate MCP and API Tool navigation"
```

### Task 2: API Tools Page Extraction

**Files:**
- Create: `web-stitch/src/features/tools/ApiToolsPage.tsx`
- Create: `web-stitch/src/features/tools/api-tools.css`
- Modify: `web-stitch/src/features/tools/ToolsPage.tsx`
- Modify: `web-stitch/src/App.tsx`

**Interfaces:**
- Consumes `api.tools`, `api.webResearchCatalog`, `api.jobToolCatalog`, and demo/custom API methods.
- Produces `ApiToolsPage({ openConnect })`.
- Preserves `ToolDialogBody`.

- [ ] **Step 1: Add failing API-only page assertions**

Extend the page test:

```tsx
it('defines API-only sections', () => {
  expect(API_TOOL_SECTIONS.map((section) => section.id)).toEqual([
    'installed',
    'add',
    'providers',
    'activity',
  ]);
  expect(API_TOOL_SECTIONS.map((section) => section.label)).not.toContain('MCP');
});
```

- [ ] **Step 2: Verify the test fails**

```bash
npm --prefix web-stitch exec vitest run src/features/tools/api-tools-page.test.tsx
```

Expected: FAIL because `API_TOOL_SECTIONS` does not exist.

- [ ] **Step 3: Implement the API-only composition**

Export:

```ts
export const API_TOOL_SECTIONS = [
  { id: 'installed', label: 'Installed' },
  { id: 'add', label: 'Add API' },
  { id: 'providers', label: 'Providers' },
  { id: 'activity', label: 'Activity' },
] as const;
```

Move API-only composition into `ApiToolsPage.tsx`. Reuse or extract the existing:

- Installed tool list.
- `WebResearchPanel`.
- `JobSearchPanel`.
- `DemoApiGallery`.
- `ToolDialogBody`.

Remove `api.mcpConnections()` from API Tools. The page title and description are:

```text
API Tools
Connect HTTPS endpoints and read-only providers that agents may call.
```

- [ ] **Step 4: Verify page tests, build, and lint**

```bash
npm --prefix web-stitch exec vitest run src/features/tools/api-tools-page.test.tsx
npm --prefix web-stitch run build
npm --prefix web-stitch run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web-stitch/src/features/tools/ApiToolsPage.tsx web-stitch/src/features/tools/ToolsPage.tsx web-stitch/src/features/tools/api-tools.css web-stitch/src/App.tsx
git commit -m "feat: create API Tools workspace"
```

### Task 3: First-Class MCP Information Architecture

**Files:**
- Modify: `web-stitch/src/features/mcp/McpMarketplacePage.tsx`
- Test: `web-stitch/src/features/tools/api-tools-page.test.tsx`

**Interfaces:**
- Produces MCP sections `discover`, `connected`, `access`, `activity`.
- Preserves all existing MCP connector API calls.

- [ ] **Step 1: Add failing MCP section contract test**

```tsx
it('defines first-class MCP sections', () => {
  expect(MCP_SECTIONS.map((section) => section.id)).toEqual([
    'discover',
    'connected',
    'access',
    'activity',
  ]);
});
```

- [ ] **Step 2: Verify failure**

```bash
npm --prefix web-stitch exec vitest run src/features/tools/api-tools-page.test.tsx
```

Expected: FAIL because `MCP_SECTIONS` is not exported.

- [ ] **Step 3: Update MCP page structure**

Export `MCP_SECTIONS`, rename `Installed` to `Connected`, and provide a dedicated `Agent Access` section that selects a connection before showing its existing `AgentAccessEditor`. Preserve discovery, OAuth callback handling, health checks, tool review, confirmations, and activity.

Use:

```text
MCP
Connect application servers, review their exact actions, and grant least-privilege agent access.
```

- [ ] **Step 4: Verify**

```bash
npm --prefix web-stitch exec vitest run src/features/tools/api-tools-page.test.tsx
npm --prefix web-stitch run build
npm --prefix web-stitch run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web-stitch/src/features/mcp/McpMarketplacePage.tsx web-stitch/src/features/tools/api-tools-page.test.tsx
git commit -m "feat: promote MCP to a first-class workspace"
```

### Task 4: Explicit Resource Naming

**Files:**
- Modify: `web-stitch/src/api.ts`
- Modify: `web-stitch/src/features/agents/AgentBuilderPage.tsx`
- Modify: `web-stitch/src/features/agents/AgentWorkspacePage.tsx`
- Modify: `web-stitch/src/app/AppShell.tsx`
- Test: `web-stitch/src/features/tools/api-tools-page.test.tsx`

**Interfaces:**
- Produces `ApiTool`.
- Retains `type Tool = ApiTool` during the compatibility period.
- Produces global-search kinds `MCP Connection`, `MCP Action`, and `API Tool`.

- [ ] **Step 1: Add failing classification tests**

```ts
it('classifies resources by user-facing domain', () => {
  expect(resourceSearchKind({ domain: 'api' })).toBe('API Tool');
  expect(resourceSearchKind({ domain: 'mcp-connection' })).toBe('MCP Connection');
  expect(resourceSearchKind({ domain: 'mcp-action' })).toBe('MCP Action');
});
```

- [ ] **Step 2: Verify failure**

```bash
npm --prefix web-stitch exec vitest run src/features/tools/api-tools-page.test.tsx
```

- [ ] **Step 3: Add explicit types and presentation groups**

In `api.ts`:

```ts
export type ApiTool = {
  id: string;
  name: string;
  kind: 'api' | 'plugin' | 'internal';
  description: string;
  permissions: string[];
  enabled: boolean;
};

/** Temporary compatibility alias; remove after call sites migrate. */
export type Tool = ApiTool;
```

Keep MCP types independent. Update agent pages so API `tool_ids` and MCP allowlists appear under separate headings. Do not imply that an MCP connection ID belongs in `tool_ids`.

- [ ] **Step 4: Run relevant verification**

```bash
npm --prefix web-stitch exec vitest run src/features/tools/api-tools-page.test.tsx
npm --prefix web-stitch run build
npm --prefix web-stitch run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web-stitch/src/api.ts web-stitch/src/features/agents/AgentBuilderPage.tsx web-stitch/src/features/agents/AgentWorkspacePage.tsx web-stitch/src/app/AppShell.tsx web-stitch/src/features/tools/api-tools-page.test.tsx
git commit -m "refactor: distinguish MCP resources from API Tools"
```

### Task 5: Full Separation Regression Gate

**Files:**
- Verify only. Return to the owning task before changing a file when a check fails.

- [ ] **Step 1: Run frontend verification**

```bash
npm --prefix web-stitch exec vitest run
npm --prefix web-stitch run build
npm --prefix web-stitch run lint
```

- [ ] **Step 2: Run backend policy regressions**

```bash
npm test -- tests/mcp-permissions.test.ts tests/tools-validation.test.ts tests/api-validation.test.ts
```

- [ ] **Step 3: Perform live acceptance**

Verify at port 3002:

```text
/tools redirects to /api-tools
/api-tools contains no MCP connection management
/mcp contains no custom REST API form
Agent Builder separates MCP from API Tool access
Workflow API and MCP nodes remain distinct
No browser response includes credentials or raw server configuration
```
