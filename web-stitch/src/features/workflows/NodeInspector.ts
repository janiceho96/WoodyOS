import type { WorkflowNodeCatalogEntry } from '../../api';

export type InspectorSection = WorkflowNodeCatalogEntry['inspectorSections'][number];

export const inspectorSectionLabels: Record<InspectorSection, string> = {
  inputs: 'Inputs',
  configuration: 'Configuration',
  conditions: 'Conditions',
  execution: 'Execution',
  input_collection: 'Input collection',
  variables: 'Variables',
};

function sectionForField(key: string): InspectorSection {
  if (key === 'inputSchema') return 'input_collection';
  if (key === 'variables' || ['itemVariable', 'indexVariable'].includes(key)) return 'variables';
  if (['input', 'inputMapping', 'query', 'fromNodeId'].includes(key)) return 'inputs';
  if (['path', 'operator', 'value', 'condition', 'mode', 'collectionPath', 'maxIterations', 'onLimit', 'passingScore'].includes(key)) return 'conditions';
  if (['agentId', 'toolId', 'mcpToolId'].includes(key)) return 'execution';
  return 'configuration';
}

export function groupInspectorFields(definition: WorkflowNodeCatalogEntry): Partial<Record<InspectorSection, string[]>> {
  const supported = new Set(definition.inspectorSections);
  const grouped: Partial<Record<InspectorSection, string[]>> = {};
  for (const field of definition.configFields) {
    const section = sectionForField(field.key);
    if (!supported.has(section)) continue;
    (grouped[section] ??= []).push(field.key);
  }
  return Object.fromEntries(definition.inspectorSections
    .filter((section) => grouped[section]?.length)
    .map((section) => [section, grouped[section]])) as Partial<Record<InspectorSection, string[]>>;
}
