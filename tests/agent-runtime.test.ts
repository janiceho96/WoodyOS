import { describe, expect, it } from 'vitest';
import { normalizeModelConfig, resolveAgentRuntimePolicy } from '../src/lib/agent-runtime.js';
import type { ToolRecord } from '../src/tools/runtime.js';

function tool(id: string, name: string, permissions: string[]): ToolRecord {
  return {
    id,
    name,
    kind: 'api',
    config: { version: 1, iv: '', tag: '', data: '' },
    permissions,
  };
}

describe('agent runtime policy', () => {
  it('normalizes generation settings at the worker boundary', () => {
    expect(normalizeModelConfig({ temperature: 9, maxTokens: 12.5, topP: -1 })).toEqual({
      temperature: 2,
      maxTokens: 128,
      topP: 0,
    });
    expect(normalizeModelConfig(null)).toEqual({ temperature: 0.2, maxTokens: 4096, topP: 1 });
  });

  it('filters assigned tools using explicit agent capabilities', () => {
    const browser = tool('browser', 'Browser', ['web.read']);
    const code = tool('code', 'Code runner', ['code.execute']);
    const knowledge = tool('knowledge', 'Knowledge API', ['knowledge.read']);
    const crm = tool('crm', 'CRM', ['crm.read']);
    const policy = resolveAgentRuntimePolicy({
      model_config: {},
      capabilities: { webBrowser: false, codeInterpreter: true, knowledgeBase: false },
      memory_config: { knowledgeBase: true },
      tool_ids: ['browser', 'code', 'knowledge', 'crm'],
    }, [browser, code, knowledge, crm]);

    expect(policy.tools.map((item) => item.id)).toEqual(['code', 'crm']);
    expect(policy.deniedTools.map((item) => item.id)).toEqual(['browser', 'knowledge']);
    expect(policy.knowledgeEnabled).toBe(false);
  });

  it('requires both capability and memory policy for knowledge retrieval', () => {
    const policy = resolveAgentRuntimePolicy({
      model_config: {},
      capabilities: { knowledgeBase: true },
      memory_config: { knowledgeBase: false },
      tool_ids: [],
    }, []);
    expect(policy.knowledgeEnabled).toBe(false);
  });
});
