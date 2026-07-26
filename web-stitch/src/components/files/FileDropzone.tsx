import { FileUp, LoaderCircle } from 'lucide-react';
import { useRef } from 'react';

export const acceptedFileTypes = '.pdf,.docx,.pptx,.xlsx,.xlsm,.csv,.md,.txt,.html,.png,.jpg,.jpeg,.webp';

export function FileDropzone({
  busy,
  compact = false,
  label,
  onFiles,
}: {
  busy: boolean;
  compact?: boolean;
  label?: string;
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const receive = (files: FileList | null) => {
    if (!files || busy) return;
    onFiles(Array.from(files).slice(0, 10));
  };
  return <div
    className={`file-dropzone ${compact ? 'compact' : ''} ${busy ? 'busy' : ''}`}
    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
    onDrop={(event) => { event.preventDefault(); receive(event.dataTransfer.files); }}
  >
    <input ref={inputRef} type="file" multiple accept={acceptedFileTypes} onChange={(event) => { receive(event.target.files); event.target.value = ''; }} hidden/>
    <button type="button" className={compact && !label ? 'icon-button' : 'button'} onClick={() => inputRef.current?.click()} disabled={busy} aria-label="Attach files">
      {busy ? <LoaderCircle className="spin" size={15}/> : <FileUp size={15}/>}
      {(!compact || label) && (busy ? 'Preparing files…' : label ?? 'Choose or drop files')}
    </button>
    {!compact && <small>PDF, Office, CSV, Markdown, text, HTML, or images · 25 MB each</small>}
  </div>;
}
