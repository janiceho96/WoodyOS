# Workflow Product Specification

## Lifecycle

Draft → Validated → Published → Running → Completed, Failed, or Awaiting approval.

## Required editor features

- Drag-and-drop nodes and typed connections.
- Pan, zoom, minimap, full-screen mode, undo/redo, and keyboard navigation.
- Searchable node palette with exact app logos.
- Node inspector generated from a node schema.
- Data mapping from prior node outputs.
- Validation, permissions, and cost preview before publish.
- Node-level input, output, error, timing, retry, and cost visibility.

## Node categories

- Triggers
- Agents
- Apps/MCP/API actions
- Knowledge
- Browser
- Logic: condition, loop, merge, wait
- Human approval
- Files and output

## Data references

Use safe references, not arbitrary JavaScript:

```text
{{ input.topic }}
{{ nodes.research.text }}
{{ nodes.notion.data.results[0].url }}
{{ variables.customer }}
```

## Output envelope

Each node can return structured data, text, file references, messages, and safe metadata such as duration, cost, and source node.
