import { describe, expect, it } from 'vitest';
import type { WorkflowNodeCatalogEntry } from '../../api';
import { groupInspectorFields } from './NodeInspector';

const definition = (type: WorkflowNodeCatalogEntry['type'], fields: string[], sections: WorkflowNodeCatalogEntry['inspectorSections']): WorkflowNodeCatalogEntry => ({
  type,
  category: type === 'trigger' ? 'trigger' : 'ai',
  title: type,
  description: type,
  icon: type,
  adapter: type === 'agent' ? 'agent' : 'logic',
  risk: 'read',
  available: true,
  retryable: false,
  inputPorts: [],
  outputPorts: [],
  supportsInputMapping: type === 'agent',
  supportsStructuredOutput: type === 'agent',
  supportsDynamicHandles: false,
  inspectorSections: sections,
  configFields: fields.map((key) => ({ key, label: key, control: 'json' })),
});

describe('workflow node inspector sections', () => {
  it('groups agent controls into relevant inputs, configuration, and execution sections', () => {
    expect(groupInspectorFields(definition(
      'agent',
      ['agentId', 'inputMapping', 'responsibility', 'expectedOutput', 'outputContract'],
      ['inputs', 'configuration', 'execution'],
    ))).toEqual({
      inputs: ['inputMapping'],
      configuration: ['responsibility', 'expectedOutput', 'outputContract'],
      execution: ['agentId'],
    });
  });

  it('hides unsupported sections and groups trigger input collection separately', () => {
    expect(groupInspectorFields(definition(
      'trigger',
      ['inputSchema', 'variables'],
      ['input_collection', 'variables'],
    ))).toEqual({
      input_collection: ['inputSchema'],
      variables: ['variables'],
    });
  });
});
