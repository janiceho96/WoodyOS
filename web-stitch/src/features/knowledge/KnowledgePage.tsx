import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BookOpen, Database, FileCode2, FileText, HardDriveUpload, LoaderCircle, Search, Trash2, Upload } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { api, type KnowledgeResult } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { EmptyState, PageHeader, Status } from '../../components/ui';
import { relative } from '../../lib/format';

export function KnowledgePage({ openText }: { openText: () => void }) {
  const { data, report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KnowledgeResult[] | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => {
      if (file.size > 25 * 1024 * 1024) throw new Error('File must be 25 MB or smaller.');
      return api.uploadDocument(file);
    },
    onSuccess: async () => { report('File uploaded and queued for indexing'); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Upload failed'),
    onSettled: () => { if (fileRef.current) fileRef.current.value = ''; },
  });
  const search = useMutation({
    mutationFn: () => {
      if (query.trim().length < 2) throw new Error('Enter at least 2 characters to search knowledge.');
      return api.searchKnowledge(query.trim());
    },
    onSuccess: (response) => setResults(response.data),
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Knowledge search failed'),
  });
  const remove = useMutation({
    mutationFn: api.deleteDocument,
    onSuccess: async () => { report('Document deleted'); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not delete document'),
  });
  const submitSearch = (event: FormEvent) => { event.preventDefault(); search.mutate(); };
  return <div className="knowledge-page">
    <PageHeader eyebrow="Grounding" title="Knowledge Hub" description="Upload, index, and search the real context available to your agents." actions={<button className="button" onClick={openText}><FileText size={15}/>Add text document</button>}/>
    <section className={`upload-zone ${upload.isPending ? 'busy' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) upload.mutate(file); }}>
      <input ref={fileRef} type="file" accept=".pdf,.docx,.xlsx,.xlsm,.csv,.txt,.md,.png,.jpg,.jpeg,.webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) upload.mutate(file); }}/>
      <span>{upload.isPending ? <LoaderCircle className="spin" size={28}/> : <HardDriveUpload size={28}/>}</span><h2>{upload.isPending ? 'Extracting and indexing…' : 'Drop a file here or choose one'}</h2><p>PDF, DOCX, Excel, CSV, TXT, Markdown, and images up to 25 MB.</p><button className="button primary" onClick={() => fileRef.current?.click()} disabled={upload.isPending}><Upload size={15}/>Choose file</button>
    </section>
    <section className="panel knowledge-library">
      <div className="panel-header"><div><span className="eyebrow">Semantic memory</span><h2>Indexed documents</h2></div><form className="inline-search" onSubmit={submitSearch}><Search size={15}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search indexed knowledge…"/><button className="button" disabled={search.isPending}>{search.isPending ? <LoaderCircle className="spin" size={14}/> : 'Search'}</button></form></div>
      {results !== null && <div className="search-results"><div className="section-title"><h3>Search results</h3><button className="text-button" onClick={() => setResults(null)}>Clear</button></div>{results.length ? results.map((result) => <article key={result.id}><div><strong>{result.document_name}</strong><span>{Math.max(0, Number(result.score) * 100).toFixed(0)}% match</span></div><p>{result.content}</p></article>) : <EmptyState Icon={Search} title="No matching passages" text="Try a broader phrase or wait for queued documents to finish indexing."/>}</div>}
      <div className="document-table"><div className="table-head"><span>Document</span><span>Type</span><span>Status</span><span>Added</span><span>Actions</span></div>{data.documents.map((doc) => <div className="table-row" key={doc.id}><span><FileCode2 size={17}/><strong>{doc.name}</strong></span><span className="mono">{doc.source_type}</span><span><Status value={doc.status}/></span><span>{relative(doc.created_at)}</span><span><button className="icon-button danger" title="Delete document" aria-label={`Delete ${doc.name}`} onClick={() => { if (window.confirm(`Delete “${doc.name}”? This also removes its indexed chunks.`)) remove.mutate(doc.id); }}><Trash2 size={15}/></button></span></div>)}</div>
      {!data.documents.length && <EmptyState Icon={BookOpen} title="No knowledge documents" text="Upload a file or create a text document to ground your agents." action={<button className="button" onClick={openText}>Add text document</button>}/>}
    </section>
  </div>;
}

export function TextDocumentDialogBody({ close }: { close: () => void }) {
  const queryClient = useQueryClient();
  const { report, reportError } = useWorkspace();
  const mutation = useMutation({
    mutationFn: api.createDocument,
    onSuccess: async () => { report('Document queued for indexing'); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); close(); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not create document'),
  });
  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    mutation.mutate({ name: String(form.get('name')), sourceType: 'text', content: String(form.get('content')) });
  };
  return <form className="form-grid" onSubmit={send}><label>Document name<input name="name" required placeholder="Company handbook"/></label><label>Text content<textarea name="content" required className="large-textarea" placeholder="Paste a note, policy, or trusted source text."/></label>{mutation.error && <div className="inline-error"><AlertTriangle size={15}/>{mutation.error.message}</div>}<div className="form-actions"><button className="button" type="button" onClick={close}>Cancel</button><button className="button primary" disabled={mutation.isPending}>{mutation.isPending ? <LoaderCircle className="spin" size={15}/> : <Database size={15}/>}Index knowledge</button></div></form>;
}
