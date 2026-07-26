import { AlertTriangle, CheckCircle2, LoaderCircle, ScanSearch } from 'lucide-react';
import type { FileAsset } from '../../api';

export function AttachmentStatus({ file }: { file: FileAsset }) {
  if (file.status === 'ready') return <span className="attachment-status ready"><CheckCircle2 size={12}/>Ready</span>;
  if (file.status === 'failed') return <span className="attachment-status failed"><AlertTriangle size={12}/>{file.scan_status === 'infected' ? 'Rejected' : 'Failed'}</span>;
  if (file.status === 'scanning') return <span className="attachment-status pending"><ScanSearch size={12}/>Scanning</span>;
  return <span className="attachment-status pending"><LoaderCircle className="spin" size={12}/>Extracting</span>;
}
