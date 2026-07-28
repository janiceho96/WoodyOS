import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BookOpen, CheckCircle2, Database, Eye, FileCode2, FileText, HardDriveUpload, Info, LoaderCircle, Search, Sparkles, Trash2, Upload } from 'lucide-react';
import { type DragEvent, type FormEvent, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Document, type KnowledgeDocumentDetail, type KnowledgeResult } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { EmptyState, Modal, PageHeader, Status } from '../../components/ui';
import { relative } from '../../lib/format';

const accepted = '.pdf,.docx,.pptx,.xlsx,.xlsm,.csv,.txt,.md,.html,.png,.jpg,.jpeg,.webp';

export function KnowledgePage({ openText }: { openText: () => void }) {
  const { data, report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KnowledgeResult[] | null>(null);
  const [searchMode, setSearchMode] = useState<'semantic' | 'full_text' | null>(null);
  const [selected, setSelected] = useState<Document | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => {
      if (file.size > 25 * 1024 * 1024) throw new Error('File must be 25 MB or smaller.');
      return api.uploadDocument(file);
    },
    onSuccess: async (document) => { report(`${document.name} uploaded and queued for indexing`); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Upload failed'),
    onSettled: () => { if (fileRef.current) fileRef.current.value = ''; },
  });
  const search = useMutation({
    mutationFn: () => {
      if (query.trim().length < 2) throw new Error('Enter at least 2 characters to search knowledge.');
      return api.searchKnowledge(query.trim());
    },
    onSuccess: (response) => { setResults(response.data); setSearchMode(response.mode); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Knowledge search failed'),
  });
  const remove = useMutation({
    mutationFn: api.deleteDocument,
    onSuccess: async () => { report('Document and indexed chunks deleted'); setSelected(null); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not delete document'),
  });
  const receiveFile = (file?: File) => { if (file && !upload.isPending) upload.mutate(file); };
  const drop = (event: DragEvent<HTMLElement>) => { event.preventDefault(); receiveFile(event.dataTransfer.files[0]); };
  const submitSearch = (event: FormEvent) => { event.preventDefault(); search.mutate(); };
  const ready = data.documents.filter((doc) => doc.status === 'ready').length;
  const processing = data.documents.filter((doc) => ['waiting_file', 'queued', 'processing'].includes(doc.status)).length;

  return <div className="knowledge-page knowledge-redesign">
    <PageHeader eyebrow="Resources" title="Knowledge" description="Trusted workspace context your enabled agents can retrieve when it is relevant." actions={<><Link className="button" to="/knowledge/memory">Manage memories</Link><button className="button" onClick={openText}><FileText size={15}/>Add text</button></>}/>
    <section className="knowledge-overview"><article className="panel"><Database size={19}/><span><small>Ready for agents</small><strong>{ready}</strong><em>indexed documents</em></span></article><article className="panel"><LoaderCircle size={19} className={processing ? 'spin' : ''}/><span><small>Processing</small><strong>{processing}</strong><em>upload or indexing jobs</em></span></article><article className="panel knowledge-scope"><Info size={19}/><span><strong>Workspace-wide library</strong><em>Only agents with Knowledge enabled can retrieve these documents.</em><Link to="/agents">Review agent access</Link></span></article></section>
    <section className={`upload-zone ${upload.isPending ? 'busy' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={drop}>
      <input ref={fileRef} type="file" accept={accepted} onChange={(event) => receiveFile(event.target.files?.[0])}/>
      <span>{upload.isPending ? <LoaderCircle className="spin" size={28}/> : <HardDriveUpload size={28}/>}</span><h2>{upload.isPending ? 'Uploading and preparing your document…' : 'Drop a file to add trusted context'}</h2><p>Woody securely stores, scans, extracts, chunks, and indexes PDF, Word, PowerPoint, Excel, CSV, Markdown, text, HTML, and images up to 25 MB.</p><div><button className="button primary" onClick={() => fileRef.current?.click()} disabled={upload.isPending}><Upload size={15}/>Choose file</button><button className="text-button" onClick={openText}>Paste text instead</button></div>
    </section>
    <section className="panel knowledge-library">
      <div className="panel-header knowledge-library-head"><div><span className="eyebrow">Workspace library</span><h2>Documents</h2></div><form className="inline-search" onSubmit={submitSearch}><Search size={15}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Test retrieval with a question…"/><button className="button" disabled={search.isPending}>{search.isPending ? <LoaderCircle className="spin" size={14}/> : 'Search'}</button></form></div>
      {results !== null && <div className="search-results retrieval-results"><div className="section-title"><div><h3>Retrieval test</h3><small>{searchMode === 'semantic' ? 'Semantic similarity search' : 'Full-text search fallback'}</small></div><button className="text-button" onClick={() => { setResults(null); setSearchMode(null); }}>Clear</button></div>{results.length ? results.map((result) => <article key={result.id}><div><span><Sparkles size={14}/><strong>{result.document_name}</strong></span><span>{Math.max(0, Number(result.score) * 100).toFixed(0)}% match · chunk {Number(result.ordinal) + 1}</span></div><p>{result.content}</p></article>) : <EmptyState Icon={Search} title="No matching passages" text="Try a broader phrase or wait for queued documents to finish indexing."/>}</div>}
      {data.documents.length
        ? <div className="knowledge-document-grid">{data.documents.map((doc) => <article className="knowledge-document-card" key={doc.id}><div className="document-card-head"><span className="document-type-icon"><FileCode2 size={18}/></span><Status value={doc.status}/></div><span className="eyebrow">{documentType(doc.source_type)}</span><h3>{doc.name}</h3><p>{documentDescription(doc)}</p><div className="document-card-meta"><span>Added {relative(doc.created_at)}</span>{typeof doc.metadata?.characters === 'number' && <span>{Number(doc.metadata.characters).toLocaleString()} characters</span>}</div><div className="document-card-actions"><button className="button" onClick={() => setSelected(doc)}><Eye size={14}/>Inspect</button><button className="icon-button danger" title="Delete document" aria-label={`Delete ${doc.name}`} disabled={remove.isPending} onClick={() => { if (window.confirm(`Delete “${doc.name}”? This permanently removes its indexed chunks.`)) remove.mutate(doc.id); }}><Trash2 size={15}/></button></div></article>)}</div>
        : <EmptyState Icon={BookOpen} title="No knowledge yet" text="Upload a file or create a text document to give enabled agents trusted workspace context." action={<button className="button primary" onClick={() => fileRef.current?.click()}>Upload a file</button>}/>
      }
    </section>
    {selected && <DocumentInspector document={selected} close={() => setSelected(null)} deleteDocument={() => { if (window.confirm(`Delete “${selected.name}”? This permanently removes its indexed chunks.`)) remove.mutate(selected.id); }} deleting={remove.isPending}/>}
  </div>;
}

function DocumentInspector({ document, close, deleteDocument, deleting }: { document: Document; close: () => void; deleteDocument: () => void; deleting: boolean }) {
  const detail = useQuery({ queryKey: ['knowledge-document', document.id], queryFn: () => api.document(document.id) });
  return <Modal title="Document details" close={close} wide><div className="document-inspector">{detail.isLoading ? <EmptyState Icon={LoaderCircle} title="Loading document" text="Retrieving its extracted text and indexed chunks."/> : detail.data ? <DocumentDetail detail={detail.data} close={close} deleteDocument={deleteDocument} deleting={deleting}/> : <EmptyState Icon={AlertTriangle} title="Document unavailable" text="The document may have been deleted or you may no longer have access."/>}</div></Modal>;
}

function DocumentDetail({ detail, close, deleteDocument, deleting }: { detail: KnowledgeDocumentDetail; close: () => void; deleteDocument: () => void; deleting: boolean }) {
  const error = typeof detail.metadata?.error === 'string' ? detail.metadata.error : null;
  return <><section className="document-inspector-head"><span className="document-type-icon"><FileCode2 size={22}/></span><div><span className="eyebrow">{documentType(detail.source_type)} · {detail.status}</span><h2>{detail.name}</h2><p>{detail.status === 'ready' ? `${detail.chunk_count} indexed chunks are available to enabled agents across this workspace.` : error ? `Indexing failed: ${error}` : 'This document is still being prepared for retrieval.'}</p></div><Status value={detail.status}/></section><div className="document-inspector-tabs"><section><div className="section-title"><div><h3>Extracted text</h3><small>Stored server-side and used to build retrieval chunks.</small></div></div>{detail.content ? <pre>{detail.content.slice(0, 20_000)}{detail.content.length > 20_000 ? '\n\n[Preview limited to 20,000 characters.]' : ''}</pre> : <p className="muted-note">Text is not available until extraction completes.</p>}</section><section><div className="section-title"><div><h3>Indexed chunks</h3><small>{detail.chunk_count} shown · chunks improve focused retrieval and limit context sent to the model.</small></div></div>{detail.chunks.length ? <div className="chunk-list">{detail.chunks.map((chunk) => <article key={chunk.id}><span>#{Number(chunk.ordinal) + 1}</span><p>{chunk.content}</p></article>)}</div> : <p className="muted-note">No chunks are available yet.</p>}</section></div><div className="form-actions"><button className="button danger" disabled={deleting} onClick={deleteDocument}><Trash2 size={14}/>Delete document</button><span/><button className="button" onClick={close}>Close</button></div></>;
}

function documentType(sourceType: string) { return sourceType === 'text' ? 'Text note' : sourceType === 'csv' ? 'Spreadsheet / CSV' : sourceType.toUpperCase(); }
function documentDescription(document: Document) { if (document.status === 'ready') return 'Ready for enabled agents to retrieve when relevant.'; if (document.status === 'failed') return typeof document.metadata?.error === 'string' ? String(document.metadata.error) : 'Processing failed. Inspect details to review the error.'; return 'Extracting text and building retrieval chunks.'; }

export function TextDocumentDialogBody({ close }: { close: () => void }) {
  const queryClient = useQueryClient();
  const { report, reportError } = useWorkspace();
  const mutation = useMutation({
    mutationFn: api.createDocument,
    onSuccess: async () => { report('Text document queued for indexing'); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); close(); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not create document'),
  });
  const send = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); mutation.mutate({ name: String(form.get('name')), sourceType: 'text', content: String(form.get('content')) }); };
  return <form className="form-grid" onSubmit={send}><div className="security-note"><CheckCircle2 size={17}/><span>Once indexed, this text becomes workspace knowledge for agents whose Knowledge capability is enabled.</span></div><label>Document name<input name="name" required placeholder="Company handbook"/></label><label>Text content<textarea name="content" required className="large-textarea" placeholder="Paste a note, policy, or trusted source text."/></label>{mutation.error && <div className="inline-error"><AlertTriangle size={15}/>{mutation.error.message}</div>}<div className="form-actions"><button className="button" type="button" onClick={close}>Cancel</button><button className="button primary" disabled={mutation.isPending}>{mutation.isPending ? <LoaderCircle className="spin" size={15}/> : <Database size={15}/>}Index knowledge</button></div></form>;
}
