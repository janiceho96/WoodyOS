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
