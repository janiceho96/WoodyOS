import { GripVertical, LoaderCircle, LocateFixed, MessageCircle, Send, Trash2, X } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type FileAsset, type WoodyChatMessage } from '../../api';
import { Mascot } from '../../components/Mascot';
import type { MascotExpression } from '../../components/Types';
import { AttachmentPicker } from '../../components/files/AttachmentPicker';
import { AttachmentChip } from '../../components/files/AttachmentChip';

type UiMessage = WoodyChatMessage & {
  id: string;
  attachments?: FileAsset[];
  citations?: Array<{ fileId: string; filename: string; locator: string; score: number }>;
};
type Position = { x: number; y: number };
type DragState = { pointerX: number; pointerY: number; position: Position; bounds: DOMRect };

const positionStorageKey = 'woody_chat_position_v1';

const suggestions = [
  'Turn my work goal into the right agent or agent team.',
  'Review my existing agents and suggest improvements.',
  'Help me design a safe workflow step by step.',
  'Which tools or MCP connections should my agent use?',
  'Help me understand why an agent task failed.',
  'Estimate the API cost before I run a workflow.',
];

const welcome = (name: string): UiMessage => ({
  id: 'welcome',
  role: 'assistant',
  content: `Hi ${name}. I’m Woody, your workflow copilot. Tell me what outcome you want, and I’ll help you choose the agents, workflow, knowledge, and tools to build it safely.`,
});

function messageId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function storedPosition(): Position {
  try {
    const value = JSON.parse(localStorage.getItem(positionStorageKey) ?? 'null') as Partial<Position> | null;
    return value && Number.isFinite(value.x) && Number.isFinite(value.y) ? { x: Number(value.x), y: Number(value.y) } : { x: 0, y: 0 };
  } catch { return { x: 0, y: 0 }; }
}

function visibleBounds(host: HTMLDivElement) {
  const items = [host.querySelector('.woody-chat-trigger'), host.querySelector('.woody-chat-panel')]
    .filter((item): item is Element => Boolean(item))
    .map((item) => item.getBoundingClientRect());
  if (!items.length) return host.getBoundingClientRect();
  const left = Math.min(...items.map((item) => item.left));
  const top = Math.min(...items.map((item) => item.top));
  const right = Math.max(...items.map((item) => item.right));
  const bottom = Math.max(...items.map((item) => item.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

export function WoodyChat({ displayName }: { displayName: string }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<UiMessage[]>(() => [welcome(displayName)]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [attachments, setAttachments] = useState<FileAsset[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<Position>(storedPosition());
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);

  const expression = useMemo<MascotExpression>(() => {
    if (pending) return 'processing';
    if (error) return 'worried';
    return open ? 'listening' : 'happy';
  }, [pending, error, open]);

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 80);
  }, [open]);
  useEffect(() => {
    if (!open || historyLoaded) return;
    let cancelled = false;
    const load = async () => {
      try {
        const threads = await api.chatThreads();
        if (cancelled || !threads.data[0]) return;
        const thread = await api.chatThread(threads.data[0].id);
        if (cancelled) return;
        setThreadId(thread.id);
        if (thread.messages?.length) setMessages(thread.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          attachments: message.attachments,
          citations: message.metadata?.citations,
        })));
      } catch {
        // Keep the fresh welcome if older history is temporarily unavailable.
      } finally {
        if (!cancelled) setHistoryLoaded(true);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [historyLoaded, open]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, pending, error]);
  useEffect(() => {
    const keepVisible = () => {
      const host = hostRef.current; if (!host) return;
      const bounds = visibleBounds(host);
      const padding = 8;
      const correctionX = bounds.left < padding ? padding - bounds.left : bounds.right > window.innerWidth - padding ? window.innerWidth - padding - bounds.right : 0;
      const correctionY = bounds.top < padding ? padding - bounds.top : bounds.bottom > window.innerHeight - padding ? window.innerHeight - padding - bounds.bottom : 0;
      if (!correctionX && !correctionY) return;
      positionRef.current = { x: positionRef.current.x + correctionX, y: positionRef.current.y + correctionY };
      host.style.transform = `translate3d(${positionRef.current.x}px,${positionRef.current.y}px,0)`;
      localStorage.setItem(positionStorageKey, JSON.stringify(positionRef.current));
    };
    const frame = window.requestAnimationFrame(keepVisible);
    window.addEventListener('resize', keepVisible);
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener('resize', keepVisible); };
  }, [open]);

  const send = async (content: string) => {
    const clean = content.trim();
    if (!clean || pending || attachments.some((file) => file.status !== 'ready')) return;
    const selectedAttachments = attachments;
    const userMessage: UiMessage = { id: messageId(), role: 'user', content: clean, attachments: selectedAttachments };
    const next = [...messages, userMessage];
    setMessages(next); setDraft(''); setAttachments([]); setPending(true); setError('');
    try {
      let activeThread = threadId;
      if (!activeThread) {
        const created = await api.createChatThread();
        activeThread = created.id;
        setThreadId(created.id);
      }
      const result = await api.sendChatThreadMessage(activeThread, clean, selectedAttachments.map((file) => file.id));
      setMessages((current) => [...current, {
        id: result.assistant.id,
        role: 'assistant',
        content: result.assistant.content,
        citations: result.citations,
      }]);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : 'Woody could not answer right now.';
      setError(detail === 'AI_NOT_CONFIGURED' ? 'Connect an AI provider in Settings before chatting with Woody.' : detail);
    } finally { setPending(false); }
  };

  const submit = (event: FormEvent) => { event.preventDefault(); void send(draft); };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(draft); }
  };
  const clear = async () => {
    if (threadId) await api.deleteChatThread(threadId).catch(() => undefined);
    setThreadId(null); setMessages([welcome(displayName)]); setAttachments([]); setError(''); setDraft('');
  };
  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !hostRef.current) return;
    dragRef.current = { pointerX: event.clientX, pointerY: event.clientY, position: { ...positionRef.current }, bounds: visibleBounds(hostRef.current) };
    suppressClickRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    hostRef.current.classList.add('dragging');
  };
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current; const host = hostRef.current; if (!drag || !host) return;
    const rawX = event.clientX - drag.pointerX;
    const rawY = event.clientY - drag.pointerY;
    if (Math.abs(rawX) > 3 || Math.abs(rawY) > 3) suppressClickRef.current = true;
    const padding = 8;
    const deltaX = Math.max(padding - drag.bounds.left, Math.min(rawX, window.innerWidth - padding - drag.bounds.right));
    const deltaY = Math.max(padding - drag.bounds.top, Math.min(rawY, window.innerHeight - padding - drag.bounds.bottom));
    positionRef.current = { x: drag.position.x + deltaX, y: drag.position.y + deltaY };
    host.style.transform = `translate3d(${positionRef.current.x}px,${positionRef.current.y}px,0)`;
  };
  const finishDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    hostRef.current?.classList.remove('dragging');
    localStorage.setItem(positionStorageKey, JSON.stringify(positionRef.current));
  };
  const resetPosition = () => {
    positionRef.current = { x: 0, y: 0 };
    if (hostRef.current) hostRef.current.style.transform = 'translate3d(0,0,0)';
    localStorage.removeItem(positionStorageKey);
  };
  const toggleOpen = () => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    setOpen((value) => !value);
  };

  return <div ref={hostRef} className={`woody-chat ${open ? 'open' : ''}`} style={{ transform: `translate3d(${positionRef.current.x}px,${positionRef.current.y}px,0)` }}>
    {open && <section className="woody-chat-panel" role="dialog" aria-label="Chat with Woody" aria-modal="false">
      <header className="woody-chat-header">
        <div className="woody-chat-drag-handle" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={finishDrag} title="Drag to move Woody">
          <Mascot expression={expression} size={74} loading={pending} floating={!pending} blink decorative/>
          <div><strong>Woody</strong><span><i className={pending ? 'busy' : ''}/>{pending ? 'Thinking…' : 'Workflow copilot'}</span></div>
          <GripVertical size={17}/>
        </div>
        <button type="button" onClick={resetPosition} aria-label="Reset Woody position" title="Reset position"><LocateFixed size={16}/></button>
        <button type="button" onClick={() => void clear()} aria-label="Clear conversation" title="Clear conversation"><Trash2 size={16}/></button>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close Woody chat"><X size={18}/></button>
      </header>
      <div className="woody-chat-messages" ref={scrollRef} aria-live="polite">
        {messages.map((message) => <article className={message.role} key={message.id}>
          {message.role === 'assistant' && <span className="woody-message-avatar"><Mascot expression="happy" size={34} floating={false} blink={false} decorative/></span>}
          <div><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>{message.attachments?.length ? <div className="woody-message-attachments">{message.attachments.map((file) => <AttachmentChip key={file.id} file={file}/>)}</div> : null}{message.citations?.length ? <div className="woody-message-citations"><strong>Sources used</strong>{message.citations.map((citation, index) => <span key={`${citation.fileId}-${citation.locator}-${index}`}>{citation.filename} · {citation.locator}</span>)}</div> : null}</div>
        </article>)}
        {messages.length === 1 && <div className="woody-chat-suggestions">{suggestions.map((suggestion) => <button type="button" key={suggestion} onClick={() => void send(suggestion)}>{suggestion}</button>)}</div>}
        {pending && <div className="woody-typing"><LoaderCircle className="spin" size={14}/><span>Woody is thinking carefully…</span></div>}
        {error && <div className="woody-chat-error"><strong>I couldn’t answer that.</strong><span>{error}</span></div>}
      </div>
      <form className="woody-chat-composer" onSubmit={submit}>
        <AttachmentPicker value={attachments} onChange={setAttachments} defaultScope="conversation" allowedScopes={['conversation', 'saved', 'knowledge']} compact/>
        <textarea ref={inputRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} maxLength={8_000} rows={2} placeholder="Ask about agents, workflows, tools, errors, cost, or an attached file…" aria-label="Message Woody"/>
        <button type="submit" disabled={pending || !draft.trim() || attachments.some((file) => file.status !== 'ready')} aria-label="Send message"><Send size={17}/></button>
        <small>Enter to send · Shift+Enter for a new line</small>
      </form>
    </section>}
    <button className="woody-chat-trigger" type="button" onClick={toggleOpen} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={finishDrag} aria-expanded={open} aria-label={open ? 'Close Woody chat' : 'Chat with Woody'} title="Click to chat · drag to move">
      <Mascot expression={expression} size={98} loading={pending} floating={!open && !pending} blink decorative/>
      {!open && <span><MessageCircle size={13}/>Ask Woody</span>}
    </button>
  </div>;
}
