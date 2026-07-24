import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { outputText } from '../lib/recovery';

export const OutputViewer = memo(function OutputViewer({ value, error = false }: { value: unknown; error?: boolean }) {
  const text = outputText(value);
  return text !== null
    ? <div className={`markdown-output ${error ? 'error-output' : ''}`}><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
    : <pre className={`json-output ${error ? 'error-output' : ''}`}>{JSON.stringify(value, null, 2)}</pre>;
});
