export function outputText(value: unknown) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'text' in value && typeof (value as { text?: unknown }).text === 'string') return (value as { text: string }).text;
  return null;
}

export function failureGuidance(error: unknown, kind: 'task' | 'workflow' = 'task') {
  const raw = outputText(error) ?? (typeof error === 'string' ? error : JSON.stringify(error ?? ''));
  const value = raw.toLowerCase();
  if (value.includes('budget') || value.includes('quota')) return 'The workspace AI budget was reached. Increase the budget or wait for it to reset, then start a new run.';
  if (value.includes('api') || value.includes('provider') || value.includes('model')) return 'The configured AI provider or model could not complete this request. Check the model and AI provider settings before trying again.';
  if (value.includes('tool') || value.includes('mcp') || value.includes('unauthorized')) return 'A connected integration was unavailable or not permitted. Review the assigned agent access, tool allowlist, and connection health.';
  if (value.includes('queue') || value.includes('redis')) return 'The work queue was unavailable. Make sure Docker and the Woody worker are running, then start a new test.';
  if (kind === 'workflow') return 'The workflow stopped before completion. Inspect the failed node below, correct its configuration or input, save the draft, and run another test.';
  return 'The run stopped before it could complete. Open the agent to review its instructions, model, and permitted integrations, then start a new task.';
}
