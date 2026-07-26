import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FileClock, LoaderCircle, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type FileAsset } from '../../api';
import { EmptyState, Modal } from '../ui';

const tabularExtensions = new Set(['xlsx', 'xlsm', 'csv']);

function textCell(value: unknown) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function FilePreviewDialog({ file, close }: { file: FileAsset; close: () => void }) {
  const queryClient = useQueryClient();
  const versionInput = useRef<HTMLInputElement>(null);
  const [sheet, setSheet] = useState<string>();
  const preview = useQuery({ queryKey: ['file-preview', file.id], queryFn: () => api.filePreview(file.id) });
  const versions = useQuery({ queryKey: ['file-versions', file.id], queryFn: () => api.fileVersions(file.id) });
  const spreadsheet = useQuery({
    queryKey: ['file-spreadsheet', file.id, sheet],
    queryFn: () => api.spreadsheetPreview(file.id, sheet),
    enabled: file.status === 'ready' && tabularExtensions.has(file.extension),
  });
  const uploadVersion = useMutation({
    mutationFn: (next: File) => api.uploadFileVersion(file.id, next),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['files'] }),
        queryClient.invalidateQueries({ queryKey: ['file-versions', file.id] }),
      ]);
    },
  });

  return <Modal title={file.original_name} close={close} wide>
    <div className="file-preview-dialog">
      <div className="file-version-bar">
        <span><FileClock size={15}/><strong>Version {file.version_number ?? 1}</strong><small>{versions.data?.data.length ?? 1} saved version{(versions.data?.data.length ?? 1) === 1 ? '' : 's'}</small></span>
        <input ref={versionInput} className="sr-only" type="file" onChange={(event) => {
          const selected = event.target.files?.[0];
          if (selected) uploadVersion.mutate(selected);
          event.currentTarget.value = '';
        }}/>
        <button className="button" disabled={uploadVersion.isPending} onClick={() => versionInput.current?.click()}>
          {uploadVersion.isPending ? <LoaderCircle className="spin" size={14}/> : <Upload size={14}/>}Upload new version
        </button>
      </div>
      {uploadVersion.error && <div className="inline-error">{uploadVersion.error.message}</div>}
      {(versions.data?.data.length ?? 0) > 1 && <div className="file-version-list" aria-label="File version history">
        {versions.data?.data.map((version) => <span key={version.id} className={version.id === file.id ? 'active' : ''}>
          v{version.version_number} · {new Date(version.created_at).toLocaleDateString()} · {version.status}
        </span>)}
      </div>}
      {preview.isLoading && <EmptyState Icon={LoaderCircle} title="Preparing preview" text="Loading Woody's extracted, structured representation."/>}
      {preview.error && <EmptyState Icon={AlertTriangle} title="Preview unavailable" text={preview.error.message}/>}
      {spreadsheet.data && <section className="structured-sheet-preview">
        <div className="structured-sheet-toolbar">
          <label>Sheet<select value={spreadsheet.data.sheet ?? ''} onChange={(event) => setSheet(event.target.value)}>
            {spreadsheet.data.sheets.map((item) => <option key={item.name} value={item.name}>{item.name} · {item.rowCount ?? 0} rows</option>)}
          </select></label>
          <small>{spreadsheet.data.rowCount.toLocaleString()} rows · {spreadsheet.data.columnCount.toLocaleString()} columns{spreadsheet.data.truncated ? ' · extraction limit reached' : ''}</small>
        </div>
        <div className="structured-sheet-table"><table><tbody>
          {spreadsheet.data.rows.map((row, rowIndex) => <tr key={rowIndex}>
            <th scope="row">{spreadsheet.data.startRow + rowIndex}</th>
            {row.map((cell, columnIndex) => <td key={columnIndex}>{textCell(cell)}</td>)}
          </tr>)}
        </tbody></table></div>
        {spreadsheet.data.hasMore && <small>Showing the first 100 rows. Woody retrieves only relevant ranges for agents instead of sending the full workbook.</small>}
      </section>}
      {preview.data?.extraction && <>
        <div className="file-preview-meta">
          <span>{file.extension.toUpperCase()}</span>
          <span>{preview.data.extraction.characters.toLocaleString()} characters</span>
          <span>{preview.data.chunks.length} preview chunks</span>
          {preview.data.extraction.truncated && <span>Preview shortened</span>}
        </div>
        <article className="file-preview-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.data.extraction.content}</ReactMarkdown></article>
      </>}
    </div>
  </Modal>;
}
