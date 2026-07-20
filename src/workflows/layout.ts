import { z } from 'zod';
import type { WorkflowDefinition } from './definition.js';

export const workflowNodePositionSchema = z.object({
  nodeId: z.string().min(1).max(100),
  x: z.number().finite().min(-100_000).max(100_000),
  y: z.number().finite().min(-100_000).max(100_000),
});

export const workflowViewportSchema = z.object({
  x: z.number().finite().min(-100_000).max(100_000),
  y: z.number().finite().min(-100_000).max(100_000),
  zoom: z.number().finite().min(0.1).max(4),
});

export const workflowLayoutInputSchema = z.object({
  schemaVersion: z.number().int().min(1).max(100).default(1),
  positions: z.array(workflowNodePositionSchema).max(200).refine(
    (positions) => new Set(positions.map((position) => position.nodeId)).size === positions.length,
    'Every node can have only one saved position',
  ),
  viewport: workflowViewportSchema.default({ x: 0, y: 0, zoom: 1 }),
});

export type WorkflowEditorLayout = z.infer<typeof workflowLayoutInputSchema>;

export function workflowLayoutErrors(layout: WorkflowEditorLayout, definition: WorkflowDefinition) {
  const nodeIds = new Set(definition.nodes.map((node) => node.id));
  return layout.positions
    .filter((position) => !nodeIds.has(position.nodeId))
    .map((position) => `Layout references unknown node ${position.nodeId}`);
}

