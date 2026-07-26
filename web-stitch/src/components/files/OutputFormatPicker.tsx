import type { ArtifactFormat } from '../../api';

const outputFormats: Array<{ format: ArtifactFormat; label: string; group: string }> = [
  { format: 'pdf', label: 'PDF', group: 'Document' },
  { format: 'docx', label: 'Word', group: 'Document' },
  { format: 'md', label: 'Markdown', group: 'Document' },
  { format: 'txt', label: 'Text', group: 'Document' },
  { format: 'pptx', label: 'PowerPoint', group: 'Presentation' },
  { format: 'xlsx', label: 'Excel', group: 'Data' },
  { format: 'csv', label: 'CSV', group: 'Data' },
  { format: 'json', label: 'JSON', group: 'Data' },
  { format: 'html', label: 'Web page', group: 'Web' },
];

export function OutputFormatPicker({ value, onChange }: { value: ArtifactFormat[]; onChange: (formats: ArtifactFormat[]) => void }) {
  return <fieldset className="artifact-format-picker output-format-picker">
    <legend>Downloadable output <small>Optional</small></legend>
    <p>Woody saves the Markdown result, then generates any selected formats.</p>
    <div>{outputFormats.map(({ format, label, group }) => <label key={format} title={group}>
      <input type="checkbox" checked={value.includes(format)} onChange={(event) => onChange(event.target.checked ? [...value, format] : value.filter((item) => item !== format))}/>
      <span><strong>{label}</strong><small>{group}</small></span>
    </label>)}</div>
  </fieldset>;
}
