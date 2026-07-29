# Workspace Model Enforcement Design

## Goal

When a workspace owner saves a provider and default model, Woody applies that model to every agent in that workspace and ensures future workflow executions use it.

## Scope

- Apply the selected model to all current workspace agents, regardless of their prior provider or model.
- Publish replacement versions for agents that already have published versions, preserving version history while making the current model executable in future runs.
- Update draft workflow agent references when they pin an older agent version.
- Make solution installation and Prompt-to-Agent use the workspace provider model when their proposal does not explicitly name a model.
- Preserve immutable historical workflow runs, agent versions, audit records, and usage records.

## User experience

Saving a changed provider or model presents an explicit confirmation: “Apply this model to every agent in this workspace.” The confirmation reports the number of agents and published versions affected. A successful save reports the selected provider/model and counts changed. A failure leaves both the provider configuration and agent state unchanged.

## Data flow and invariants

1. The provider save endpoint validates the provider credentials and model input as it does today.
2. Within one database transaction, it saves the workspace configuration, updates every `agents.model`, and creates new immutable `agent_versions` snapshots only for agents with an existing published version. Workflow definitions reference agent IDs and therefore resolve the new published versions without rewriting their definitions.
3. Published workflows and completed workflow runs are never rewritten. New tests and new runs resolve to the updated agent model/version.
4. Installers resolve their unspecified model through `configuredAiProviderForWorkspace`, not `LLM_DEFAULT_MODEL`.
5. The workspace default model remains the sole source for all unspecified models.

## Failure handling

- No bulk model update occurs if the provider save fails validation or database work fails.
- If a provider accepts the connection test but later rejects an individual model request, Woody returns the provider error without falling back to another model.
- A workspace cannot mix a newly saved default with partially updated agents after an unsuccessful transaction.

## Security and compatibility

- API keys remain encrypted and are never returned by the bulk-update response, audit payload, or tests.
- The existing runtime configuration route remains available; its success response gains only aggregate, non-sensitive update counts.
- Historical execution manifests retain their original model identity for traceability.

## Acceptance criteria

1. Saving `glm-4.6` updates all workspace agents from Claude, DeepSeek, or any other prior model to `glm-4.6`.
2. A newly installed solution uses the workspace default model rather than the environment Claude fallback.
3. A future test run of a workflow that previously referenced a Claude agent uses the new model.
4. Prior published versions and completed runs remain unchanged and inspectable.
5. A forced database failure rolls back the provider configuration and all related agent/version/workflow changes.
