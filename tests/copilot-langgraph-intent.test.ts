import { describe, expect, it } from 'vitest';
import { copilotIntentSchema, safeValidationIssueSchema } from '../src/copilot/graph/state.js';
import { detectDeterministicIntent } from '../src/copilot/graph/intent.js';

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
