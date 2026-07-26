import { Monitor, Smartphone, Tablet } from 'lucide-react';
import { useState } from 'react';
import { Modal } from '../ui';

const previewSizes = [
  { id: 'desktop', label: 'Desktop', Icon: Monitor },
  { id: 'tablet', label: 'Tablet', Icon: Tablet },
  { id: 'mobile', label: 'Mobile', Icon: Smartphone },
] as const;

type PreviewSize = typeof previewSizes[number]['id'];

export function HtmlArtifactPreview({ title, html, close }: { title: string; html: string; close: () => void }) {
  const [previewSize, setPreviewSize] = useState<PreviewSize>('desktop');

  return <Modal title={`Safe preview · ${title}`} close={close} wide>
    <div className="html-preview-shell">
      <div className="security-note">Static sandbox preview · scripts, forms, external requests, and navigation are disabled.</div>
      <div className="html-preview-toolbar">
        <strong>Preview size</strong>
        <div role="group" aria-label="HTML preview size">
          {previewSizes.map(({ id, label, Icon }) => <button
            className={previewSize === id ? 'active' : ''}
            type="button"
            key={id}
            aria-pressed={previewSize === id}
            onClick={() => setPreviewSize(id)}
          ><Icon size={14}/>{label}</button>)}
        </div>
      </div>
      <div className="html-preview-stage">
        <iframe
          className={`html-preview-frame ${previewSize}`}
          title={`Preview of ${title}`}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={html}
        />
      </div>
    </div>
  </Modal>;
}
