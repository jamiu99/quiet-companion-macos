import { useEffect, useRef, useState } from 'react';
import { resolveActiveCharacter, type PublicConfig } from '@shared/config';
import type { AgentState, AvatarState } from '@shared/events';
import { ArrowUpIcon, PhoneOffIcon, SparkIcon, StopIcon } from './icons';
import { TASK_ICONS } from '../../shared/ui-assets';

export function QuickChips({ config, avatar, agent }: { config: PublicConfig; avatar: AvatarState; agent: AgentState }) {
  const canConnect = config.vidu.hasKey && Boolean(resolveActiveCharacter(config).imagePath);
  const idle = avatar.phase === 'idle' || avatar.phase === 'error';
  return (
    <div className="chips-row">
      <div className="chips">
        {config.quickTasks.map(q => (
          <button key={q.id} className="chip" title={q.prompt} disabled={!config.agent.hasKey} onClick={() => void window.companion.runQuickTask(q.id)}>
            {TASK_ICONS[q.id] ? <img className="chip-icon" src={TASK_ICONS[q.id]} alt="" draggable={false} /> : <SparkIcon width={12} height={12} />}{q.label}
          </button>
        ))}
        {config.quickTasks.length === 0 && <span className="chips-empty">还没有快捷任务，可在设置里添加</span>}
      </div>
      <div className="chips-actions">
        {agent.status === 'running' && (
          <button className="chip danger" onClick={() => void window.companion.abortAgent()}><StopIcon width={12} height={12} />停止</button>
        )}
        {idle
          ? <button className="chip accent" disabled={!canConnect} title={canConnect ? '开始实时对话' : '需要先配置 Vidu Key 和形象'} onClick={() => void window.companion.connectAvatar()}>连接数字人</button>
          : <button className="chip danger" disabled={avatar.phase === 'stopping'} onClick={() => void window.companion.disconnectAvatar()}><PhoneOffIcon width={12} height={12} />{avatar.phase === 'live' ? '挂断' : avatar.phase === 'stopping' ? '挂断中' : '取消连接'}</button>}
      </div>
    </div>
  );
}

export function Composer({ placeholder, compact, autoFocus = true }: { placeholder: string; compact?: boolean; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  // Auto-grow the textarea between 1 and ~5 rows.
  useEffect(() => {
    const el = ref.current; if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, compact ? 22 : 110)}px`;
  }, [text, compact]);
  const send = () => {
    const t = text.trim(); if (!t) return;
    setText('');
    void window.companion.sendText(t);
  };
  return (
    <form className={`composer${compact ? ' compact' : ''}`} onSubmit={e => { e.preventDefault(); send(); }}>
      <textarea ref={ref} rows={1} value={text} placeholder={placeholder} autoFocus={autoFocus} onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          // Enter sends, Shift+Enter inserts a newline; ignore Enter while an IME (拼音) composition is in flight.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
        }} />
      <button type="submit" className="send" aria-label="发送" disabled={!text.trim()}><ArrowUpIcon width={14} height={14} strokeWidth={2.5} /></button>
    </form>
  );
}
