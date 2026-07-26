import { Database, FolderOpen, MessageSquareText, TimerReset } from 'lucide-react';
import { useId } from 'react';
import type { FileAsset } from '../../api';

const options: Array<{ value: FileAsset['scope']; label: string; text: string; Icon: typeof FolderOpen }> = [
  { value: 'task', label: 'This task only', text: 'Private task context, retained for 30 days.', Icon: TimerReset },
  { value: 'conversation', label: 'This conversation', text: 'Available only inside this Woody chat.', Icon: MessageSquareText },
  { value: 'saved', label: 'Save to Files', text: 'Reusable without becoming agent Knowledge.', Icon: FolderOpen },
  { value: 'knowledge', label: 'Add to Knowledge', text: 'Shared with Knowledge-enabled agents after confirmation.', Icon: Database },
];

export function FileScopeSelector({
  value,
  onChange,
  allowed = ['task', 'saved', 'knowledge'],
}: {
  value: FileAsset['scope'];
  onChange: (value: FileAsset['scope']) => void;
  allowed?: FileAsset['scope'][];
}) {
  const groupName = useId();
  return <fieldset className="file-scope-selector">
    <legend>File access</legend>
    <div>{options.filter((option) => allowed.includes(option.value)).map(({ value: optionValue, label, text, Icon }) => <label key={optionValue}>
      <input type="radio" name={groupName} value={optionValue} checked={value === optionValue} onChange={() => onChange(optionValue)}/>
      <span><Icon size={15}/><strong>{label}</strong><small>{text}</small></span>
    </label>)}</div>
  </fieldset>;
}
