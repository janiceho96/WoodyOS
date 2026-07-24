# Actionable Proposal Notification Context

## Objective

Make the success notification shown after Prompt-to-Agent compilation actionable. When Woody says
`Generated a 1-agent proposal for review`, the user must be able to select `Review proposal` and arrive
at the generated proposal without losing the unsaved proposal state.

## Current Flow

1. `PromptCompiler` in `web-stitch/src/features/solutions/StarterSolutionsPage.tsx` calls
   `api.compileAgentSolution`.
2. The returned proposal is stored only in the component's local `proposal` state.
3. `PromptCompiler` calls `report(message)`.
4. `AppShell` stores only a string notice.
5. `Notice` in `web-stitch/src/components/ui.tsx` renders the string and a dismiss button.

The notification cannot navigate or focus content because the shared notice contract contains no
action. Navigating to another route would also be unsafe because the generated proposal has not been
saved to the backend yet.

## Chosen Design

Extend the existing transient notice model with one optional action:

```ts
type NoticeAction = {
  label: string;
  onClick: () => void;
};
```

`report(message, action?)` remains backward-compatible for every existing caller. `AppShell` owns and
clears both the message and action. `Notice` renders an accessible action button only when provided.

For Prompt-to-Agent, the action scrolls the proposal review panel into view and moves keyboard focus to
its heading. It does not navigate away, persist unreviewed content, or regenerate the proposal.

## UX and Accessibility

- The toast keeps its current status semantics.
- The action is a real keyboard-accessible button labelled `Review proposal`.
- Selecting it scrolls smoothly unless reduced motion is preferred.
- Focus moves to the proposal review region so keyboard and screen-reader users receive the same context.
- Dismiss remains independent.
- Existing non-actionable success and error notices remain unchanged.

## Acceptance Checks

- Generating a proposal still displays the existing success message.
- The notification includes `Review proposal`.
- Activating it reveals and focuses the current proposal.
- The proposal remains editable and is not installed automatically.
- Dismissing the notification clears its action.
- Existing `report(message)` calls continue to compile and behave as before.
- Frontend type checking and production build pass.
