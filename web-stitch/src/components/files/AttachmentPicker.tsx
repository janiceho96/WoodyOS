import { useQuery } from '@tanstack/react-query';
import { CloudDownload, FolderOpen, GitCompareArrows, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type FileAsset } from '../../api';
import { AttachmentChip } from './AttachmentChip';
import { FileDropzone } from './FileDropzone';
import { FilePreviewDialog } from './FilePreviewDialog';
import { FileScopeSelector } from './FileScopeSelector';
import { Modal } from '../ui';
import type { FileComparison } from '../../api';

const delay = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function confirmKnowledgeScope(scope: FileAsset['scope'], subject: string) {
  if (scope !== 'knowledge') return true;
  return window.confirm(`Add ${subject} to shared Knowledge? Knowledge-enabled agents in this workspace may retrieve their contents.`);
}

async function runAttachmentAction(setBusy: (busy: boolean) => void, setError: (message: string) => void, fallback: string, action: () => Promise<void>) {
  setBusy(true);
  setError('');
  try {
    await action();
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : fallback);
  } finally {
    setBusy(false);
  }
}

async function uploadFiles(files: File[], scope: FileAsset['scope'], update: (file: FileAsset) => void, waitUntilReady: (file: FileAsset) => Promise<FileAsset>, refetch: () => Promise<unknown>) {
  for (const file of files) {
    const uploaded = await api.uploadFile(file, scope);
    update(uploaded);
    if (scope === 'knowledge') await api.promoteFileToKnowledge(uploaded.id);
    await waitUntilReady(uploaded);
  }
  await refetch();
}

async function importCloudFileToScope(url: string, scope: FileAsset['scope'], update: (file: FileAsset) => void, waitUntilReady: (file: FileAsset) => Promise<FileAsset>, afterReady: () => void, refetch: () => Promise<unknown>) {
  const imported = await api.importFileFromSecureLink(url, scope);
  update(imported);
  if (scope === 'knowledge') await api.promoteFileToKnowledge(imported.id);
  await waitUntilReady(imported);
  afterReady();
  await refetch();
}

export function AttachmentPicker({
  value,
  onChange,
  defaultScope = 'task',
  allowedScopes = ['task', 'saved', 'knowledge'],
  compact = false,
  uploadLabel,
}: {
  value: FileAsset[];
  onChange: (files: FileAsset[]) => void;
  defaultScope?: FileAsset['scope'];
  allowedScopes?: FileAsset['scope'][];
  compact?: boolean;
  uploadLabel?: string;
}) {
  const [scope, setScope] = useState<FileAsset['scope']>(defaultScope);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<FileAsset | null>(null);
  const [cloudUrl, setCloudUrl] = useState('');
  const [cloudOpen, setCloudOpen] = useState(false);
  const [comparison, setComparison] = useState<FileComparison | null>(null);
  const valueRef = useRef(value);
  useEffect(() => { valueRef.current = value; }, [value]);
  const library = useQuery({ queryKey: ['files'], queryFn: api.files, staleTime: 15_000 });
  const selected = useMemo(() => new Set(value.map((file) => file.id)), [value]);
  const reusable = (library.data?.data ?? []).filter((file) => file.status === 'ready' && ['saved', 'knowledge'].includes(file.scope) && !selected.has(file.id));

  const replace = (files: FileAsset[]) => { valueRef.current = files; onChange(files); };
  const update = (file: FileAsset) => {
    const current = valueRef.current;
    replace(current.some((item) => item.id === file.id) ? current.map((item) => item.id === file.id ? file : item) : [...current, file]);
  };
  const waitUntilReady = async (initial: FileAsset) => {
    let current = initial;
    for (let attempt = 0; attempt < 90 && !['ready', 'failed'].includes(current.status); attempt += 1) {
      await delay(1_000);
      current = await api.file(current.id);
      update(current);
    }
    return current;
  };
  const receive = async (files: File[]) => {
    if (!confirmKnowledgeScope(scope, 'these files')) return;
    await runAttachmentAction(setBusy, setError, 'Could not prepare the attachment.', () => uploadFiles(files, scope, update, waitUntilReady, library.refetch));
  };
  const importCloudFile = async () => {
    if (!cloudUrl.trim() || !confirmKnowledgeScope(scope, 'this imported file')) return;
    await runAttachmentAction(setBusy, setError, 'Could not import the secure cloud link.', async () => {
      await importCloudFileToScope(cloudUrl.trim(), scope, update, waitUntilReady, () => {
        setCloudUrl('');
        setCloudOpen(false);
      }, library.refetch);
    });
  };
  const compare = async () => {
    const ready = valueRef.current.filter((file) => file.status === 'ready');
    if (ready.length !== 2) return;
    await runAttachmentAction(setBusy, setError, 'Could not compare these files.', async () => {
      setComparison(await api.compareFiles([ready[0].id, ready[1].id]));
    });
  };
  return <section className={`attachment-picker ${compact ? 'compact' : ''}`}>
    {!compact && <FileScopeSelector value={scope} onChange={setScope} allowed={allowedScopes}/>}
    <div className="attachment-picker-actions">
      <FileDropzone busy={busy} compact={compact} label={uploadLabel} onFiles={(files) => void receive(files)}/>
      {reusable.length > 0 && <label className="saved-file-picker"><FolderOpen size={14}/><span>{compact ? 'Saved' : 'Add saved file'}</span><select value="" onChange={(event) => {
        const file = reusable.find((item) => item.id === event.target.value);
        if (file) replace([...valueRef.current, file]);
      }}><option value="">Choose…</option>{reusable.map((file) => <option key={file.id} value={file.id}>{file.original_name}</option>)}</select></label>}
      <button type="button" className="button file-secondary-action" disabled={busy} onClick={() => setCloudOpen((current) => !current)}><CloudDownload size={14}/>Cloud link</button>
      {value.filter((file) => file.status === 'ready').length === 2 && <button type="button" className="button file-secondary-action" disabled={busy} onClick={() => void compare()}><GitCompareArrows size={14}/>Compare</button>}
    </div>
    {cloudOpen && <div className="cloud-import-row">
      <label><span>Secure HTTPS file link</span><input type="url" value={cloudUrl} onChange={(event) => setCloudUrl(event.target.value)} placeholder="https://…/report.pdf"/></label>
      <button type="button" className="button primary" disabled={busy || !cloudUrl.trim()} onClick={() => void importCloudFile()}>{busy ? <LoaderCircle className="spin" size={14}/> : <CloudDownload size={14}/>}Import</button>
      <small>Public or signed links only. Private-network addresses, login redirects, executables, and files over 25 MB are blocked.</small>
    </div>}
    {value.length > 0 && <div className="attachment-list">{value.map((file) => <AttachmentChip key={file.id} file={file} onPreview={() => setPreview(file)} onRemove={() => replace(valueRef.current.filter((item) => item.id !== file.id))}/>)}</div>}
    {error && <div className="inline-error">{error}</div>}
    {preview && <FilePreviewDialog file={preview} close={() => setPreview(null)}/>}
    {comparison && <Modal title="Local file comparison" close={() => setComparison(null)} wide>
      <div className="file-comparison">
        <div className="comparison-score"><strong>{comparison.similarityPercent}%</strong><span>lexical similarity</span></div>
        <div className="comparison-columns">{comparison.files.map((file) => <article key={file.id}>
          <h3>{file.original_name}</h3>
          <p><strong>Distinctive terms</strong></p>
          <div className="comparison-terms">{(comparison.distinctiveTerms[file.id] ?? []).map((term) => <span key={term}>{term}</span>)}</div>
          {(comparison.samples[file.id] ?? []).slice(0, 3).map((sample) => <blockquote key={`${sample.locator}-${sample.excerpt}`}><small>{sample.locator}</small>{sample.excerpt}</blockquote>)}
        </article>)}</div>
        {comparison.sharedTerms.length > 0 && <div><strong>Shared terms</strong><div className="comparison-terms">{comparison.sharedTerms.map((term) => <span key={term}>{term}</span>)}</div></div>}
        <small>{comparison.method}</small>
      </div>
    </Modal>}
  </section>;
}
