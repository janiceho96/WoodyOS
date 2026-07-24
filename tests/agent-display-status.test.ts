import { describe, expect, it } from 'vitest';
import type { Agent, Task } from '../web-stitch/src/api.js';
import { agentDisplayStatus } from '../web-stitch/src/features/agents/agentStatus.js';

function agent(status: Agent['status']): Agent {
  return {
    id: 'agent-1', name: 'Researcher', role: 'Researcher', goal: 'Research', instructions: '', personality: null,
    status, model: 'test-model', model_config: { temperature: 0.2, maxTokens: 4096, topP: 1 },
    capabilities: { webBrowser: false, codeInterpreter: false, knowledgeBase: true }, tool_ids: [], memory_config: {},
    created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
  };
}

function task(status: Task['status'], updatedAt = '2026-07-23T01:00:00.000Z'): Task {
  return { id: `task-${status}`, agent_id: 'agent-1', title: 'Task', status, created_at: updatedAt, updated_at: updatedAt };
}

describe('agent display status', () => {
  it('separates lifecycle readiness from current work', () => {
    expect(agentDisplayStatus(agent('draft'), [])).toBe('draft');
    expect(agentDisplayStatus(agent('paused'), [task('running')])).toBe('paused');
    expect(agentDisplayStatus(agent('archived'), [])).toBe('archived');
    expect(agentDisplayStatus(agent('active'), [])).toBe('ready');
    expect(agentDisplayStatus(agent('active'), [task('running')])).toBe('working');
    expect(agentDisplayStatus(agent('active'), [task('awaiting_approval')])).toBe('working');
  });

  it('uses only the latest task to determine whether attention is needed', () => {
    expect(agentDisplayStatus(agent('active'), [task('failed')])).toBe('needs_attention');
    expect(agentDisplayStatus(agent('active'), [
      task('failed', '2026-07-23T01:00:00.000Z'),
      task('completed', '2026-07-23T02:00:00.000Z'),
    ])).toBe('ready');
  });
});
