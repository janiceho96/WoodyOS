import { valueAtPath } from '../definition.js';

export function resolveWorkflowTemplates(value: unknown, state: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const exact = value.match(/^\{\{\s*([^{}]+?)\s*}}$/);
    if (exact) return valueAtPath(state, exact[1]);
    return value.replace(/\{\{\s*([^{}]+?)\s*}}/g, (_, path: string) => {
      const resolved = valueAtPath(state, path);
      return resolved === undefined || resolved === null ? '' : typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveWorkflowTemplates(item, state));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, resolveWorkflowTemplates(item, state)]));
  return value;
}

export function resolveNodeInput(mapping: Record<string, unknown> | undefined, state: Record<string, unknown>) {
  if (!mapping) return state;
  return resolveWorkflowTemplates(mapping, state) as Record<string, unknown>;
}
