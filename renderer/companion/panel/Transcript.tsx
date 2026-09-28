import { memo, useState, type ReactNode } from 'react';
import type { TranscriptItem } from '@shared/events';
import { useStickToBottom } from './hooks';
import { ChevronRightIcon, TerminalIcon } from './icons';

type Block = { kind: 'item'; item: TranscriptItem } | { kind: 'tools'; id: string; items: TranscriptItem[] };

/** Consecutive tool lines collapse into one expandable group. */
function groupBlocks(items: TranscriptItem[]): Block[] {
  const out: Block[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.role === 'tool') {
      if (last?.kind === 'tools') last.items.push(it);
      else out.push({ kind: 'tools', id: it.id, items: [it] });
    } else out.push({ kind: 'item', item: it });
  }
  return out;
}

function ToolGroup({ items }: { items: TranscriptItem[] }) {
  const [open, setOpen] = useState(false);
  const last = items[items.length - 1];
  const failed = items.filter(i => i.ok === false).length;
  const running = last.text.startsWith('▶');
  return (
    <div className={`tool-group${open ? ' open' : ''}${failed ? ' has-fail' : ''}`}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <ChevronRightIcon className="chev" width={12} height={12} />
        <TerminalIcon width={12} height={12} />
        <span className="tool-text">{last.text.replace(/^[▶✓✗]\s*/, '')}</span>
        {running && <span className="tool-spin" aria-hidden />}
        {items.length > 1 && <span className="tool-count">{items.length}</span>}
        {failed > 0 && <span className="tool-fail">{failed} 失败</span>}
      </button>
      {open && (
        <ul>
          {items.map(i => <li key={i.id} className={i.ok === false ? 'bad' : i.ok === true ? 'ok' : ''}>{i.text}</li>)}
        </ul>
      )}
    </div>
  );
}

function TranscriptImpl({ items, empty, showDetails = false }: { items: TranscriptItem[]; empty?: ReactNode; /** Include the agent's own replies and tool calls. */ showDetails?: boolean }) {
  // Default view is a two-party conversation: the user and the avatar. The agent is "her hands"; what it says aloud
  // arrives as her transcript, so its own text / tool lines only add noise unless the user asks for them.
  const visible = showDetails ? items : items.filter(i => i.role !== 'agent' && i.role !== 'tool');
  const ref = useStickToBottom<HTMLDivElement>(visible.length);
  const blocks = groupBlocks(visible);
  return (
    <div className="transcript" ref={ref}>
      {items.length === 0 && empty}
      {blocks.map(b => b.kind === 'tools'
        ? <ToolGroup key={b.id} items={b.items} />
        : <Message key={b.item.id} item={b.item} />)}
    </div>
  );
}

function Message({ item }: { item: TranscriptItem }) {
  if (item.role === 'system') return <div className="msg system">{item.text}</div>;
  return (
    <div className={`msg ${item.role}`}>
      {item.role === 'agent' && <span className="msg-tag">操作</span>}
      <div className="msg-body">{item.text}</div>
    </div>
  );
}

/** Every AppState push hands us a fresh array; skip the render when nothing visible changed. */
export const Transcript = memo(TranscriptImpl, (a, b) => {
  if (a.showDetails !== b.showDetails || a.empty !== b.empty) return false;
  if (a.items.length !== b.items.length) return false;
  const la = a.items[a.items.length - 1], lb = b.items[b.items.length - 1];
  return la?.id === lb?.id && la?.text === lb?.text && la?.ok === lb?.ok;
});
