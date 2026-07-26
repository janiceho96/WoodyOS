import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('file preview browser isolation', () => {
  it('keeps generated HTML inside a fully sandboxed iframe', async () => {
    const source = await readFile(
      new URL('../web-stitch/src/components/files/HtmlArtifactPreview.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain('sandbox=""');
    expect(source).toContain('referrerPolicy="no-referrer"');
    expect(source).toContain('srcDoc={html}');
    expect(source).not.toContain('dangerouslySetInnerHTML');
  });

  it('keeps editable output as Markdown and preserves conflict and unsaved-draft recovery', async () => {
    const source = await readFile(
      new URL('../web-stitch/src/components/outputs/EditableOutput.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain('ReactMarkdown');
    expect(source).toContain('OUTPUT_VERSION_CONFLICT');
    expect(source).toContain('beforeunload');
    expect(source).toContain('Undo');
    expect(source).not.toContain('dangerouslySetInnerHTML');
    expect(source).not.toContain('allow-scripts');
  });

  it('integrates editable output into completed task details', async () => {
    const source = await readFile(
      new URL('../web-stitch/src/features/execution/ExecutionPage.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain("import { EditableOutput }");
    expect(source).toContain('<EditableOutput task={task} refreshTask={refresh}/>');
    expect(source).toContain('api.requestOutputArtifacts');
    expect(source).toContain('Current revision');
    expect(source).toContain('Older revision');
  });

  it('shows the editable result in the primary agent workspace', async () => {
    const source = await readFile(
      new URL('../web-stitch/src/features/agents/AgentWorkspacePage.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain("import { EditableOutput }");
    expect(source).toContain('<EditableOutput task={execution.task} refreshTask={() => void execution.refresh()}/>');
  });
});
