import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Clock3, Copy, Edit3, Eye, FileText, History, LoaderCircle, RotateCcw, Save, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type OutputDocumentDetail, type OutputVersion, type TaskDetail } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { OutputViewer } from '../OutputViewer';

type EditorMode = 'view' | 'edit' | 'history';
type EditorTab = 'source' | 'preview';

const conflictCode = 'OUTPUT_VERSION_CONFLICT';

function isVersionConflict(cause: unknown) {
  const message = cause instanceof Error ? cause.message : '';
  return message.includes(conflictCode) || message.includes('Another editor saved');
}

export function EditableOutput({ task, refreshTask }: { task: TaskDetail; refreshTask: () => void }) {
  const queryClient = useQueryClient();
  const { report, reportError } = useWorkspace();
  const queryKey = ['output-document', task.id] as const;
  const documentQuery = useQuery({
    queryKey,
    queryFn: () => api.outputDocumentForTask(task.id),
    enabled: task.status === 'completed',
  });
  const document = documentQuery.data?.document ?? null;
  const [mode, setMode] = useState<EditorMode>('view');
  const [tab, setTab] = useState<EditorTab>('source');
  const [draft, setDraft] = useState('');
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const selectedVersion = useMemo(
    () => document?.versions.find((version) => version.id === selectedVersionId) ?? document?.currentVersion ?? null,
    [document, selectedVersionId],
  );
  const savedContent = document?.currentVersion.content ?? '';
  const dirty = mode === 'edit' && draft !== savedContent;

  useEffect(() => {
    if (mode !== 'edit' && document) setDraft(document.currentVersion.content);
  }, [document, mode]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const updateDocument = (next: OutputDocumentDetail) => {
    queryClient.setQueryData(queryKey, { document: next });
    setDraft(next.currentVersion.content);
    setSelectedVersionId(next.currentVersion.id);
    setConflict(false);
    refreshTask();
  };

  const initialize = useMutation({
    mutationFn: () => api.initializeOutputDocument(task.id),
    onSuccess: (next) => {
      updateDocument(next);
      setMode('edit');
      setTab('source');
    },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not prepare this output for editing'),
  });

  const save = useMutation({
    mutationFn: () => {
      if (!document) throw new Error('Editable output is not initialized');
      return api.saveOutputVersion(document.id, {
        content: draft,
        baseVersionNumber: document.current_version_number,
      });
    },
    onSuccess: (next) => {
      updateDocument(next);
      setMode('view');
      report(`Saved output version ${next.current_version_number}`);
    },
    onError: (cause) => {
      if (isVersionConflict(cause)) {
        setConflict(true);
        return;
      }
      reportError(cause instanceof Error ? cause.message : 'Could not save this output version');
    },
  });

  const revert = useMutation({
    mutationFn: (version: OutputVersion) => {
      if (!document) throw new Error('Editable output is not initialized');
      return api.revertOutputVersion(document.id, {
        versionId: version.id,
        baseVersionNumber: document.current_version_number,
      });
    },
    onSuccess: (next) => {
      updateDocument(next);
      setMode('view');
      report(`Restored as output version ${next.current_version_number}`);
    },
    onError: (cause) => {
      if (isVersionConflict(cause)) {
        setConflict(true);
        return;
      }
      reportError(cause instanceof Error ? cause.message : 'Could not restore this output version');
    },
  });

  const startEditing = () => {
    if (!document) {
      initialize.mutate();
      return;
    }
    setDraft(document.currentVersion.content);
    setConflict(false);
    setMode('edit');
    setTab('source');
  };

  const cancelEditing = () => {
    if (dirty && !window.confirm('Discard your unsaved output changes?')) return;
    setDraft(savedContent);
    setConflict(false);
    setMode('view');
  };

  const reloadLatest = async () => {
    const result = await documentQuery.refetch();
    if (result.data?.document) {
      setDraft(result.data.document.currentVersion.content);
      setConflict(false);
    }
  };

  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      report('Copied your unsaved draft');
    } catch {
      reportError('Your browser blocked clipboard access. Select and copy the draft from the editor instead.');
    }
  };

  const previewVersion = selectedVersion ?? document?.currentVersion;
  const currentText = document?.currentVersion.content;

  return <section className="output-section editable-output">
    <div className="editable-output-header">
      <div>
        <span className="eyebrow">Editable result</span>
        <h3>Agent result</h3>
        <small>{document ? `Version ${document.current_version_number} · original run preserved` : 'Original agent output · not edited'}</small>
      </div>
      <div>
        {document && <button className="button" type="button" onClick={() => { setSelectedVersionId(document.currentVersion.id); setMode('history'); }}><History size={14}/>History</button>}
        {mode === 'view' && <button className="button primary" type="button" disabled={initialize.isPending || documentQuery.isLoading} onClick={startEditing}>{initialize.isPending ? <LoaderCircle className="spin" size={14}/> : <Edit3 size={14}/>}Edit output</button>}
      </div>
    </div>

    {documentQuery.error && <div className="inline-error"><AlertTriangle size={15}/><span>{documentQuery.error.message}</span></div>}

    {mode === 'view' && (currentText
      ? <div className="editable-output-rendered"><ReactMarkdown remarkPlugins={[remarkGfm]}>{currentText}</ReactMarkdown></div>
      : <OutputViewer value={task.output}/>)}

    {mode === 'edit' && <div className="output-editor-shell">
      <div className="output-editor-toolbar">
        <div role="tablist" aria-label="Output editor view">
          <button role="tab" aria-selected={tab === 'source'} className={tab === 'source' ? 'active' : ''} onClick={() => setTab('source')}><FileText size={14}/>Source</button>
          <button role="tab" aria-selected={tab === 'preview'} className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}><Eye size={14}/>Preview</button>
        </div>
        <span>{draft.length.toLocaleString()} / 100,000 characters</span>
      </div>

      {conflict && <div className="output-conflict" role="alert">
        <AlertTriangle size={18}/>
        <span><strong>A newer version was saved elsewhere</strong><small>Your draft is still here. Copy it before reloading if you need to compare changes.</small></span>
        <button className="button" type="button" onClick={() => void copyDraft()}><Copy size={14}/>Copy my draft</button>
        <button className="button" type="button" onClick={() => void reloadLatest()}><RotateCcw size={14}/>Reload latest</button>
      </div>}

      <div className="output-editor-grid">
        <label className={tab === 'preview' ? 'mobile-hidden' : ''}>
          <span>Markdown source</span>
          <textarea value={draft} maxLength={100_000} onChange={(event) => setDraft(event.target.value)} aria-label="Editable output Markdown"/>
        </label>
        <article className={`output-editor-preview ${tab === 'source' ? 'mobile-hidden' : ''}`} aria-label="Rendered output preview">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown>
        </article>
      </div>
      <div className="output-editor-actions">
        <button className="button" type="button" onClick={cancelEditing}><X size={14}/>Cancel</button>
        <button className="button" type="button" disabled={!dirty} onClick={() => setDraft(savedContent)}><RotateCcw size={14}/>Undo changes</button>
        <button className="button primary" type="button" disabled={!dirty || !draft.trim() || draft.length > 100_000 || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <LoaderCircle className="spin" size={14}/> : <Save size={14}/>}Save new version</button>
      </div>
    </div>}

    {mode === 'history' && document && <div className="output-history">
      <aside aria-label="Output version history">
        <div><strong>Version history</strong><button className="icon-button" type="button" aria-label="Close version history" onClick={() => setMode('view')}><X size={14}/></button></div>
        {document.versions.map((version) => <button type="button" className={previewVersion?.id === version.id ? 'active' : ''} key={version.id} onClick={() => setSelectedVersionId(version.id)}>
          <span><strong>Version {version.version_number}</strong>{version.id === document.currentVersion.id && <i><Check size={11}/>Current</i>}</span>
          <small><Clock3 size={11}/>{new Date(version.created_at).toLocaleString()}</small>
          <small>{version.created_by_name ?? 'Workspace member'}</small>
        </button>)}
      </aside>
      <article>
        <div><span><strong>Version {previewVersion?.version_number}</strong><small>Read-only preview</small></span>{previewVersion && previewVersion.id !== document.currentVersion.id && <button className="button" type="button" disabled={revert.isPending} onClick={() => { if (window.confirm(`Restore version ${previewVersion.version_number} as a new version?`)) revert.mutate(previewVersion); }}><RotateCcw size={14}/>Restore as new version</button>}</div>
        <div className="editable-output-rendered"><ReactMarkdown remarkPlugins={[remarkGfm]}>{previewVersion?.content ?? ''}</ReactMarkdown></div>
      </article>
    </div>}
  </section>;
}
