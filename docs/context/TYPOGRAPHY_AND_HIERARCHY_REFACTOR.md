# Typography and Hierarchy Refactor

## Goal

Normalize Woody's typography, information hierarchy, card density, status language, and responsive
behavior across the operational application. This is an app-wide system correction informed by the
July 23–24 screenshots, not a collection of screenshot-specific overrides.

The durable product rules live in `docs/context/UX_DESIGN_SYSTEM.md`. This file records the current
implementation audit, decisions, scope, risks, and acceptance evidence.

## Current Architecture

- `web-stitch/src/index.css` owns global tokens and most application layout/component rules.
- `web-stitch/src/typography.css` is loaded after the global stylesheet and normalizes shared reading
  levels and selected feature components.
- `web-stitch/src/components/ui.tsx` owns shared page headers, statuses, notices, empty states, and
  dialogs.
- Feature-specific CSS exists for the agent workspace, MCP marketplace, web research, solutions,
  avatars, and mascot.

This architecture is sufficient for the refactor. Replacing it with CSS-in-JS, Tailwind, or another
design-system framework would increase migration risk without improving the immediate user outcome.

## Audit Findings

### Typography

- The intended Geist and JetBrains Mono families already exist as `--font-sans` and `--font-mono`.
- The intended weights 400, 500, 600, and 700 already exist.
- The current tokens do not match the approved scale: page titles are 28px instead of 32px, section
  titles are 20px, and card titles are 16px.
- A current CSS scan found 456 direct typography declarations (`font-family`, `font-size`,
  `font-weight`, or `letter-spacing`) plus 114 `font` shorthand declarations.
- The scan found 348 references to `--text-caption`, 66 raw pixel font-size declarations, 108
  JetBrains Mono or `--font-mono` references, and 26 uppercase transforms. Many are legitimate
  technical or compact contexts, but the volume explains why a final normalization layer is needed
  while legacy feature CSS is gradually migrated to tokens.
- Many raw sizes remain alongside tokens, including 9px, 10px, 12px, 13px, 14px, 15px, 16px, 18px,
  19px, 20px, 22px, 24px, 26px, 28px, 30px, 32px, 33px, 42px, and several unrelated `clamp()` rules.
- Monospace is still used for navigation counters, live-work status, human-readable metrics, provider
  metadata, category labels, connection states, and other ordinary interface copy.
- Uppercase transforms and expanded letter spacing remain in legacy rules even where the later
  typography layer tries to override them.

The effective typography layer now explicitly restores Geist for ordinary navigation, counts,
statuses, table/category labels, provider copy, MCP access controls, solution metrics, workflow
lifecycle labels, agent activity counts, and human-readable analytics. Technical editors, code,
payloads, endpoints, model IDs, request IDs, and timestamps keep JetBrains Mono.

### Hierarchy and density

- Operational agent headings can grow too large for the available content width.
- Purpose cards use excessive padding and give the purpose statement more visual weight than the next
  action.
- Output records are rendered in a dense two-column grid before enough width is available.
- Repeated run cards prioritize status and metadata while hiding the result action behind a small arrow.
- Knowledge overview cards are taller and wider than their information requires.
- Nested borders are common in summary, integration, settings, and analytics panels.

### Status clarity

- Completed tasks can display `Unavailable` when only cost pricing is unavailable.
- Unknown cost can appear as `$0.0000`, implying free usage rather than missing pricing.
- MCP catalog `Available` is visually close to a connected health state.
- A verified domain is presented without enough explanation that authentication is still required.
- Budget meters remain visible even when no local cap is configured.

### Responsive behavior

- Several grids use fixed minimum widths that clip badges and actions before collapsing.
- Output cards use two columns at widths where their content cannot fit.
- Long agent and output titles do not consistently reserve space for status/action columns.
- Some compact layouts allow human-readable values to wrap into narrow vertical columns.

## Approved Typography Tokens

| Role | Size | Weight | Family |
| --- | ---: | ---: | --- |
| Page title | 32px | 700 | Geist |
| Section title | 22px | 600 | Geist |
| Card title | 17px | 600 | Geist |
| Body | 15px | 400 | Geist |
| Secondary | 14px | 400 | Geist |
| Label | 12px | 500 | Geist |
| Technical | 12–13px | 400–500 | JetBrains Mono |

JetBrains Mono is restricted to code, JSON, logs, endpoints, model IDs, request IDs, technical
timestamps, and values that materially benefit from fixed-width alignment.

## Implementation Scope

### Shared system

- Align root tokens with the approved scale.
- Normalize shared page headers, panel titles, cards, labels, tabs, badges, buttons, empty states, and
  notices.
- Remove monospace from ordinary statuses, provider/company names, navigation, and general metrics.
- Add reusable wrapping, truncation, focus, and responsive behavior.

### Analytics and budget

- Hide inactive budget meters when no local cap exists.
- Label unknown pricing as unavailable rather than zero.
- Separate local usage, configured limits, and upstream provider capacity.
- Prevent human-readable limit values from wrapping into narrow columns.

### Outputs

- Derive a human-readable output availability state from task status and recorded output/artifacts.
- Show a visible `View result`, `View progress`, or `Review error` action.
- Remove the contradictory generic `Unavailable` label.
- Use one column until the viewport can support two complete records.
- Preserve access to every task and artifact.

### Knowledge

- Rename `Ready to retrieve` to `Ready for agents`.
- Compact the overview cards.
- Explain workspace-wide access and link to agent configuration.
- Preserve upload, processing, search, inspection, and deletion behavior.

### Agents

- Reduce and constrain operational page titles.
- Compact the purpose card and clarify capability chips.
- Keep current task, output, and live activity visually dominant.
- Preserve the unified workspace/activity state model.

### Integrations and MCP

- Use `Supported Apps` and `Community MCP` as the primary catalog choices.
- Distinguish available, authentication required, connected, needs attention, and disabled.
- Explain verified-domain meaning.
- Show a state-appropriate primary action.
- Preserve OAuth, health testing, discovery, allowlists, permissions, confirmations, and logs.

Installed MCP state mapping:

| Evidence | Display state | Primary next action |
| --- | --- | --- |
| OAuth is not authorized | Authentication required | Authorize account |
| Connection is intentionally disabled | Disabled | Enable, after a healthy test |
| Enabled and last health is healthy | Connected | Optional test/discovery |
| Enabled but untested, unhealthy, or carrying an error | Needs attention | Repair: test again |

Catalog availability uses `Ready to connect`, not `Connected`, and no longer uses the same emerald
visual treatment reserved for successful connected health.

## Screenshot Correction Matrix

| Reference | Observed problem | Implemented correction |
| --- | --- | --- |
| July 24 11:13:03 | No-limit values wrap vertically; inactive tracks imply a cap; unknown price appears as zero | No-limit rows use an auto-sized value column, omit the track, and show `Pricing unavailable` when token pricing is unknown |
| July 24 11:13:14 | Oversized output cards; `Completed` beside `Unavailable`; result hidden behind an arrow | One-column compact output records derive a result state and expose a labeled result/progress/error action |
| July 24 11:13:27 | Oversized Knowledge summary and technical retrieval language without an access action | Compact `Ready for agents` summary, workspace-access explanation, and `Review agent access` link |
| July 23 11:31:05 | Agent title and purpose clip; hierarchy and whitespace overwhelm the next action | Two-line accessible title, compact purpose card, smaller goal copy, plain capability labels, and visible next action |
| July 23 11:34:55 | Redundant Top Apps/Curated/Community Registry/Advanced hierarchy | `Supported Apps` and `Community MCP` catalog choices |
| July 23 11:35:02 | `Available` and verified domain appear to imply a connected account | `Ready to connect`, non-success availability color, explicit sign-in note, and separate installed health states |
| July 23 11:43:24 | Two-column output records clip titles, statuses, and metadata | Output index stays one column and now shows workflow/agent origin, completion timing, formats, and a visible action |

Output records are not collapsed solely because titles look alike: each run is an audit record and may
contain a different result, approval, or error. The compact one-column design differentiates records
with origin, timing, status, artifact formats, and action without hiding history.

Woody currently has no artifact-expiration lifecycle: artifacts are pending, queued, generating,
ready, failed, skipped, or explicitly deleted. The UI therefore does not invent an `Expired` state.
If storage retention is introduced later, expiration must first become an authoritative backend state
and then be mapped in the output summary.

## Responsive Rules

- Validate at 1440px, 1280px, 1024px, 768px, and 390px.
- No accidental document-level horizontal overflow.
- Collapse output and integration grids before badges or actions clip.
- Allow long titles to wrap with sensible maximum lines; provide full accessible text.
- Keep primary actions visible.
- Use drawers or stacked regions for secondary panels below desktop widths.

## Risks

- `index.css` contains many unrelated user changes in a dirty worktree; edits must remain localized.
- Some cost fields are genuinely numeric zero while others are estimates with unknown pricing. UI
  helpers must distinguish `known zero` from `unavailable`.
- Existing MCP states come from multiple backend fields. Presentation changes must not claim a
  connection is healthy without authentication and health evidence.
- Responsive visual verification requires the running Docker frontend and authenticated workspace.

## Acceptance Criteria

- Geist is the default for ordinary interface copy and statuses.
- Monospace is limited to explicitly technical content.
- Important headings, statuses, values, and actions do not clip at target widths.
- Page purpose, current state, and next action are understandable within a few seconds.
- Cards are more compact without reducing usable target sizes.
- Completed outputs expose a clear result state and visible action.
- Unknown cost is never presented as confirmed `$0.0000`.
- Integration availability cannot be mistaken for authentication or connection.
- Light and dark modes remain readable.
- Existing backend-connected behavior remains available.
- The frontend TypeScript and production build pass.

## Verification Evidence

### Source and behavior

- Root tokens now match the approved 32/22/17/15/14/12px scale.
- Shared typography rules restore Geist for ordinary navigation, statuses, counts, cards, settings,
  analytics, integrations, MCP, agent, workflow, and chatbot copy.
- JetBrains Mono remains available for endpoints, code, JSON, identifiers, technical timestamps, and
  machine payloads.
- Output records now expose `Output ready`, `Generating output`, `Review error`, and other explicit
  states with a visible next action.
- Knowledge overview copy now explains agent eligibility and links to Agent configuration.
- Local budget tracks render only for configured limits. Unknown model cost is labeled
  `Pricing unavailable`.
- MCP catalog and connection language now separates `Ready to connect`, `Authentication required`,
  `Connected`, `Needs attention`, and `Disabled`.
- Responsive source rules stack Outputs, Knowledge, Analytics, MCP, Agent Activity, and Settings
  before their content columns become too narrow.
- Shared page headers now give copy a shrinkable column and wrap long titles instead of allowing them
  to collide with actions.

### Automated validation

- `cd web-stitch && npm run build`: passed on July 24, 2026 after the final MCP and typography audit.
- `cd web-stitch && npm run lint`: passed with five pre-existing Fast Refresh warnings in
  `AgentAvatar.tsx` and no errors.
- `npm run build`: backend TypeScript build passed.
- `npm test`: 28 test files passed, 1 skipped; 102 tests passed, 13 skipped.
- `git diff --check`: passed.
- The generated production CSS contains `--text-page: 2rem`, the new output-result layout, and the
  no-limit budget treatment.
- Database integration coverage now checks the task-list workflow name and artifact summary used by
  the Outputs index. That database-backed test cannot run while Docker/Postgres/Redis are offline.

### Visual validation status

- An earlier inspection found the old port `3002` bundle readable in light and dark mode, but its
  computed `--text-page` was still `1.75rem`, proving it was stale and not evidence for this refactor.
- Port `3002` is currently offline. Docker socket access is denied in this task, and Docker Desktop
  plus Terminal control was not approved/available. A relative-path production bundle was generated
  successfully in `/tmp`, but browser safety does not expose local-file rendering as evidence for the
  authenticated pages.
- Therefore the new authenticated pages cannot honestly be claimed as visually verified yet.
- Required next command:

  ```bash
  cd "/Users/macjanice/Documents/New project"
  docker compose up -d --build
  ```

- After rebuilding, visually inspect authenticated Outputs, Knowledge, Agent workspace, Analytics,
  Settings/Budget, and MCP pages at 1440, 1280, 1024, 768, and 390px in both themes. Confirm document
  `scrollWidth <= clientWidth`, title/status/action visibility, keyboard focus, and the state wording
  in the screenshot matrix. Source and automated checks are complete; this final live visual pass
  remains required before the goal can be marked complete.

## Completion Audit

| Requirement group | Current evidence | Status |
| --- | --- | --- |
| Pre-implementation audit and context file | Architecture, declaration inventory, risks, tokens, scope, and acceptance criteria recorded before implementation | Proven |
| Typography families and scale | Root 32/22/17/15/14/12px tokens plus the effective Geist/technical-mono normalization layer are present in the production CSS | Proven by source and build |
| Shared hierarchy and accessibility | Shared headers wrap, cards/actions use common tokens, focus styles remain, dialogs retain focus trapping, and mobile inputs remain readable | Proven by source and build |
| Budget and analytics language | Inactive tracks are omitted, no-limit values stay intact, local/upstream capacity is separated, and unknown pricing is labeled consistently | Proven by source and build |
| Outputs | Result states/actions, workflow/agent origin, timing, formats, one-column records, and task-list metadata are implemented | Source/build proven; database response pending |
| Knowledge | Clear language, compact cards, access explanation/action, and existing upload/search/inspect/delete flows remain | Proven by source and build |
| Agent workspace | Constrained title, compact purpose/capability treatment, next action, and synchronized activity workspace remain | Proven by source and build |
| MCP | Simplified catalog labels, distinct state mapping, state-appropriate actions, security controls, allowlists, confirmation, and logs remain | Proven by source and build |
| Unknown cost app-wide | Task, Agent history, Analytics, and Workflow usage use `Pricing unavailable` when tokens exist without a usable price | Proven by source and build |
| Backend compatibility | Backend TypeScript build and non-database suite pass; task-list integration assertion exists | Partially proven |
| Database-backed behavior | Postgres and Redis ports are closed; forced integration run fails before registration because the database is unavailable | Missing external runtime |
| Responsive widths and both themes | Breakpoint rules exist for every affected layout | Source proven; rendered evidence missing |
| Every supplied screenshot | Each observed defect maps to a source correction above | Source mapping proven; post-change visual comparison missing |

Do not mark this refactor complete until the final two rendered/runtime rows are proven against the
rebuilt Docker application.
