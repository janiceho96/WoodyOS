# Woody UX Design System

## How to use this file

This is the human-editable source of truth for Woody's interface and experience. Edit these rules when
the desired product behavior or visual direction changes, then ask Codex to implement and verify the
updated specification.

Editing this Markdown file does not change the running application automatically. Reusable design
tokens and component behavior must still be implemented in `web-stitch`.

Keep API keys, credentials, temporary debugging output, and private user data out of this file.

## User-editable UI/UX preferences

Edit this section when you want to change Woody's visual direction or interaction style. Write the
desired outcome in plain language; exact CSS or component names are optional. After editing, ask
Codex to review this file, explain any important trade-offs, implement the changes through shared
tokens and components, and visually verify the affected pages.

### Brand direction

- Product name: Woody.
- Desired character: calm, intelligent, friendly, premium, and slightly playful.
- Visual mood: focused AI workspace with restrained indigo, cyan, and emerald accents.
- Avoid: childish decoration, excessive glow, noisy gradients, and overly technical language.

### Interface density

- Preferred density: compact and professional.
- Card padding: 16–20px.
- Page spacing: 16–24px between major sections.
- Information priority: current task and result first; configuration and technical logs second.
- Repeated records: prefer compact one-column rows until a wider grid remains easy to scan.

### Typography preferences

- Primary interface font: Geist.
- Technical font: JetBrains Mono, only for code and machine-readable values.
- Preferred page-title size: 32px.
- Preferred body size: 15px.
- Heading style: sentence case with limited letter spacing.
- Avoid: mixing decorative fonts, excessive uppercase labels, oversized headings, and using
  monospace for ordinary interface text.

### Color and surface preferences

- Primary action color: indigo.
- Information and processing color: cyan.
- Success color: emerald.
- Warning and attention color: amber.
- Error and destructive color: rose.
- Surface style: neutral, subtle borders, minimal shadows, and limited gradients.
- Theme support: both light and dark mode must communicate the same hierarchy.

### Navigation preferences

- Maximum primary sidebar destinations: six.
- Keep these concepts separate: Agents, Workflows, Outputs, Knowledge, and Integrations.
- Keep Outputs close to Agents and Workflows.
- Put low-frequency settings and technical controls in contextual menus or Settings.
- Use labels understandable to a non-technical user.

### Page-specific preferences

You may add or revise instructions in this format:

```md
- Page: Agents
  - Main thing I want to see: current task, progress, and result.
  - Primary action: start or continue a task.
  - Keep visible: live activity.
  - Move to secondary area: model and advanced permissions.
  - Problem to fix: long agent names are clipped.
```

Useful properties to specify for any page:

- The first thing the user should notice.
- The page's single primary action.
- Information that must remain visible while working.
- Information that may be collapsed or moved into a drawer.
- Preferred list, table, card, canvas, or split-panel layout.
- Empty, loading, running, approval, completed, and error behavior.
- Mobile stacking order.
- Wording that feels unclear or too technical.

### Motion and mascot preferences

- Motion intensity: subtle.
- Use animation to explain loading, success, errors, or state changes.
- Keep Woody's mascot available for guidance, onboarding, and empty states.
- Do not use the mascot as a replacement for the product logo.
- Respect reduced-motion preferences.

### Rules that should not be weakened

These are product safeguards rather than visual preferences:

- Do not expose API keys, credentials, or private data.
- Do not create fake buttons, fake data, or pretend that an unavailable function works.
- Preserve keyboard navigation, visible focus, labels, contrast, and reduced-motion support.
- Keep destructive and external-write actions behind clear confirmation.
- Keep important backend-connected functionality during visual refactors.
- Do not hide errors or approvals merely to make a screen look cleaner.
- Do not allow text clipping, accidental horizontal scrolling, or unusably small touch targets.
- Use consistent status meanings throughout the application.

### Change request template

Copy and edit this block when asking Codex to implement a UI/UX change:

```md
## UI/UX change request

- Page or feature:
- Current problem:
- Desired outcome:
- Most important information:
- Primary action:
- Content that should stay visible:
- Content that can be secondary:
- Desktop preference:
- Mobile preference:
- Light/dark mode notes:
- Reference image or app:
- Functionality that must not change:
```

## Personality

Calm, intelligent, friendly, premium, and slightly playful.

Woody should feel:

- Capable without feeling intimidating.
- Friendly without becoming childish.
- Professional without becoming visually cold.
- Information-dense without becoming noisy or cramped.
- Calm during loading, errors, approvals, and long-running work.

## Typography

### Font families

- Use Geist for approximately 95% of the interface.
- Use JetBrains Mono only for code, JSON, logs, API endpoints, model IDs, request IDs, and technical
  values that benefit from fixed-width alignment.
- Do not use monospace for navigation, provider names, ordinary statistics, buttons, empty-state
  explanations, category labels, or human-readable statuses.

### Type scale

- Page title: 32px, weight 700.
- Section title: 22px, weight 600.
- Card title: 17px, weight 600.
- Body text: 15px, weight 400.
- Secondary text: 14px, weight 400.
- Labels and metadata: 12px, weight 500.
- Technical content: 12–13px, JetBrains Mono.

### Typography rules

- Use no more than four general weights: 400, 500, 600, and 700.
- Reserve weight 700 primarily for page titles and essential outcomes.
- Avoid excessive uppercase text and wide letter spacing.
- Do not use oversized display headings inside operational application pages.
- Long titles must wrap or truncate intentionally without covering actions or statuses.
- Keep body copy at a readable line length and line height.
- Use responsive `clamp()` sizes only where they materially improve the layout.

## Color and appearance

- Support both light and dark mode with the same semantic hierarchy.
- Use indigo for primary actions.
- Use cyan for information and active processing.
- Use emerald for confirmed success.
- Use amber for warnings and attention required.
- Use rose for errors and destructive actions.
- Use neutral surfaces and text for ordinary content.
- Never rely on color alone to communicate meaning; include text or an icon.
- Maintain accessible contrast for text, controls, borders, and focus indicators.
- Prefer subtle gradients and hairline borders over heavy shadows.

## Spacing and density

- Prefer a compact professional layout.
- Use 16–20px normal card padding.
- Use approximately 8px between closely related elements.
- Use 16–24px between page sections.
- Avoid cards that are substantially taller than their useful content requires.
- Do not use empty space as a replacement for clear hierarchy.
- Keep touch and click targets large enough to operate comfortably.

## Cards and panels

- Use subtle borders and minimal shadows.
- Avoid cards nested inside cards unless the hierarchy requires it.
- Make the outcome or primary action more prominent than supporting metadata.
- Clickable cards must have visible hover, active, and keyboard-focus states.
- Do not make a card appear clickable unless it has a meaningful action.
- Repeated records should be compact and easy to compare.
- Group duplicate-looking records when grouping preserves access to individual results.

## Navigation

- Use no more than six primary sidebar destinations.
- Keep labels short and understandable to non-technical users.
- Keep Knowledge and Integrations as separate primary concepts.
- Keep Outputs close to Agents and Workflows.
- Move low-frequency and advanced functions into contextual menus or settings.
- Clearly indicate the active page and current agent.
- Preserve the selected agent and task context while moving between related sections.
- Use a persistent desktop sidebar and a usable drawer on smaller screens.
- Keep the top bar visually light so it does not compete with page content.

## Status terminology

Use these meanings consistently:

- `Available`: The integration or template can be installed.
- `Authentication required`: The integration exists but has not completed authentication.
- `Connected`: Authentication succeeded and the connection passed its health test.
- `Needs attention`: A previously configured connection is currently unhealthy or incomplete.
- `Disabled`: The connection or capability was intentionally turned off.
- `Draft`: Saved but not published or active.
- `Queued`: Accepted and waiting to begin.
- `Running`: Currently executing.
- `Waiting for approval`: Paused until the user decides.
- `Completed`: Execution finished successfully.
- `Output ready`: A usable result can be opened or downloaded.
- `Output unavailable`: No usable result was produced; always explain why.
- `Failed`: Execution stopped because of an error.
- `Cancelled`: Execution was intentionally stopped.

Additional rules:

- Never show `Completed` beside an unexplained `Unavailable`.
- Do not use `Available` to imply that an integration is authenticated or connected.
- A verified provider domain does not mean the user's connection is authenticated.
- Unknown cost must appear as `Cost unavailable` or `Pricing not configured`, not `$0.0000`.
- Human-readable statuses use Geist, not JetBrains Mono.

## Buttons and actions

- Show one clear primary action per page section.
- Use secondary buttons for safe supporting actions.
- Use destructive styling only for actions that delete, revoke, cancel, or overwrite.
- Require confirmation before destructive actions and external writes.
- Disabled actions must explain why through nearby text or an accessible tooltip.
- Icon-only buttons require an accessible label and a recognizable icon.
- Small arrows must not be the only way to open an important result.
- Every visible primary action must work or clearly explain why it is unavailable.

## Application states

Every backend-connected section must handle:

- Loading.
- Empty.
- Queued.
- Running.
- Waiting for approval.
- Completed.
- Partial success.
- Failed.
- Cancelled.
- Connection unavailable.

Error messages should explain:

1. What happened.
2. Whether any work was saved.
3. What the user can do next.

Do not show large raw JSON responses by default. Keep technical details available through progressive
disclosure.

## Responsive behavior

- Wide desktop: 1280px and above.
- Compact desktop and tablet: 768–1279px.
- Mobile: below 768px.
- Test important pages around 1440px, 1280px, 1024px, 768px, and 390px.
- Switch two-column card grids to one column before content becomes cramped or clipped.
- Never permit accidental horizontal page scrolling.
- Do not allow headings, statuses, or actions to disappear outside the viewport.
- Move secondary inspectors and activity panels into drawers or bottom sheets on smaller screens.
- Do not permanently compress the main workspace into an unusable width.
- Preserve meaningful content order when layouts collapse.

## Accessibility

- Support keyboard navigation for all interactive elements.
- Use visible `:focus-visible` indicators.
- Give dialogs, drawers, icon buttons, and form fields accessible labels.
- Preserve logical heading order and landmark structure.
- Use text and icons in addition to color for status.
- Respect reduced-motion preferences.
- Avoid unnecessary or continuous animation.
- Keep text contrast and control contrast accessible in light and dark mode.
- Move focus to newly revealed important content, errors, or approval requests when appropriate.

## Page priorities

### Home

Show system health, active work, important warnings, and the next useful action. Avoid making low-value
metrics visually equal to urgent work.

### Agents

Show the selected agent's purpose, current task, current status, capabilities, live activity, and next
action. Keep configuration secondary while an agent is running.

### Workflows

Prioritize the workflow structure, validation state, current step, and safe test/publish actions. Keep
the canvas and execution activity synchronized.

### Outputs

Prioritize the generated result, producing agent or workflow, completion time, available formats, and
open/download actions. Use one column until there is enough width for a genuinely usable two-column
layout.

### Knowledge

Prioritize documents that are ready for agents, processing problems, search, and document management.
Use `Ready for agents` instead of unnecessarily technical retrieval language. Explain which agents can
access workspace knowledge.

### Integrations

Prioritize connection state, authentication requirements, health, agent assignment, and permissions.
Use clear actions such as `Connect`, `Authenticate`, `Test connection`, `Configure access`, and
`Repair`.

Prefer the primary categories:

- Supported Apps.
- Community MCP.
- Custom APIs.

Keep protocol-level settings available but secondary.

### Analytics and budget

Separate actual usage, local limits, estimated cost, and upstream provider capacity. Do not display an
active limit meter when no limit is configured. Clearly explain when provider pricing or quota data is
unavailable.

### Settings

Group settings by user outcome rather than internal architecture. Preserve unsaved-change warnings and
keep sensitive credentials server-side.

## Mascot and motion

- The Woody mascot assists the product; it does not replace the Woody logo.
- Use the mascot for onboarding, waiting, empty states, success, and gentle guidance.
- Keep motion subtle and purposeful.
- Do not animate every card or control.
- Loading and processing animations must not make the interface feel anxious.

## Implementation and review rules

- Prefer shared tokens and components over page-specific CSS overrides.
- Do not replace working backend-connected pages with static mockups.
- Do not add fake actions.
- Preserve existing important functionality during visual refactors.
- Validate both light and dark mode.
- Check responsive overflow and text clipping after every app-wide style change.
- Run the frontend type check and production build.
- Visually review affected pages against the current design references.
