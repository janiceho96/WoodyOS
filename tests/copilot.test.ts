import { describe, expect, it } from 'vitest';
import { buildWoodySystemPrompt } from '../src/routes/copilot.js';

describe('Woody copilot', () => {
  it('grounds guidance in a minimal workspace summary without granting action authority', () => {
    const prompt = buildWoodySystemPrompt({
      workspace_name: 'Test workspace',
      active_agents: '2',
      total_agents: '3',
      running_tasks: '1',
      completed_tasks: '8',
      workflows: '2',
      documents: '4',
      connected_tools: '1',
      agent_names: ['Researcher', 'Reviewer'],
    });

    expect(prompt).toContain('"activeAgents":2');
    expect(prompt).toContain('Researcher');
    expect(prompt).toContain('This chat is advisory');
    expect(prompt).toContain('Never ask for or repeat API keys');
    expect(prompt).toContain('/solutions');
  });

  it('uses visible page labels and restricts navigation to registered routes', () => {
    const prompt = buildWoodySystemPrompt({
      workspace_name: 'Test workspace',
      active_agents: '0',
      total_agents: '0',
      running_tasks: '0',
      completed_tasks: '1',
      workflows: '0',
      documents: '0',
      connected_tools: '0',
      agent_names: [],
    });

    expect(prompt).toContain('- Outputs (`/executions`): inspect task progress, errors, and output');
    expect(prompt).toContain('Lead with the visible page name');
    expect(prompt).toContain('Never invent or recommend a route outside PRODUCT MAP');
  });
});
