import { Eye, FileSpreadsheet, FileText, Image, Presentation, X } from 'lucide-react';
import type { FileAsset } from '../../api';
import { AttachmentStatus } from './AttachmentStatus';

function icon(file: FileAsset) {
  if (['xlsx', 'xlsm', 'csv'].includes(file.extension)) return <FileSpreadsheet size={16}/>;
  if (file.extension === 'pptx') return <Presentation size={16}/>;
  if (['png', 'jpg', 'jpeg', 'webp'].includes(file.extension)) return <Image size={16}/>;
  return <FileText size={16}/>;
}

export function AttachmentChip({
  file,
  onRemove,
  onPreview,
}: {
  file: FileAsset;
  onRemove?: () => void;
  onPreview?: () => void;
}) {
  return <div className={`attachment-chip ${file.status}`}>
    <span className="attachment-icon">{icon(file)}</span>
    <span className="attachment-copy">
      <strong title={file.original_name}>{file.original_name}</strong>
      <small>{file.extension.toUpperCase()} · {fileSize(file.size_bytes)}</small>
    </span>
    <AttachmentStatus file={file}/>
    {onPreview && file.status === 'ready' && <button type="button" className="icon-button" onClick={onPreview} aria-label={`Preview ${file.original_name}`}><Eye size={14}/></button>}
    {onRemove && <button type="button" className="icon-button" onClick={onRemove} aria-label={`Remove ${file.original_name}`}><X size={14}/></button>}
    {file.error_message && <em>{file.error_message}</em>}
  </div>;
}

function fileSize(value: string | number) {
  const size = Number(value);
  if (size < 1_024) return `${size} B`;
  if (size < 1_024 * 1_024) return `${(size / 1_024).toFixed(1)} KB`;
  return `${(size / 1_024 / 1_024).toFixed(1)} MB`;
}
