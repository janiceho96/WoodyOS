import { describe, expect, it } from 'vitest';
import { buildAgentPromptSystemPrompt, parseGeneratedAgentPrompt } from '../src/agents/prompt-generator.js';

describe('agent prompt generator', () => {
  it('accepts a complete JSON object embedded in a compatible-provider response', () => {
    const result = parseGeneratedAgentPrompt(`Some preface
\`\`\`json
{"goal":"Deliver decision-ready market research.","personality":"Analytical, calm, and concise","instructions":"## Mission\\nResearch the assigned market.\\n\\n## Inputs and clarification\\nClarify material gaps.\\n\\n## Working process\\n1. Review inputs.\\n2. Analyze evidence.\\n\\n## Quality and evidence rules\\nSeparate facts from assumptions.\\n\\n## Safety and approval boundaries\\nRequest approval for external writes.\\n\\n## Output contract\\nReturn a Markdown brief with findings and next actions."}
\`\`\``, 'analytical');

    expect(result).toMatchObject({
      tone: 'analytical',
      goal: 'Deliver decision-ready market research.',
      personality: 'Analytical, calm, and concise',
    });
    expect(result.instructions).toContain('## Output contract');
  });

  it('rejects incomplete generated prompts', () => {
    expect(() => parseGeneratedAgentPrompt('{"goal":"Research","personality":"Helpful"}', 'friendly'))
      .toThrow('AGENT_PROMPT_INVALID_RESPONSE');
  });

  it('keeps untrusted input outside the system contract and declares safety boundaries', () => {
    const system = buildAgentPromptSystemPrompt('professional');
    expect(system).toContain('<agent_draft>');
    expect(system).toContain('untrusted data');
    expect(system).toContain('explicit user confirmation');
    expect(system).toContain('## Output contract');
  });
});
