import type { AgentState, AvatarState } from '@shared/events';
import { useNow, useOverflow } from './hooks';
import { ChevronDownIcon, CloseIcon, GearIcon, TrashIcon } from './icons';

export const AVATAR_TEXT: Record<AvatarState['phase'], string> = {
  idle: '待机', creating: '数字人正在创建中…', warming: '数字人正在创建中…', connecting: '数字人正在创建中…', live: '实时中', stopping: '正在挂断', error: '出错了',
};
const CONNECTING: AvatarState['phase'][] = ['creating', 'warming', 'connecting', 'stopping'];

export function formatCountdown(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const AGENT_TEXT: Record<AgentState['status'], string> = { stopped: '未启动', starting: '正在启动', idle: '就绪', running: '工作中', error: '出错了' };

export function avatarTone(phase: AvatarState['phase']) {
  if (phase === 'live') return 'ok';
  if (phase === 'error') return 'bad';
  if (phase === 'idle') return 'off';
  return 'busy';
}
export function agentTone(status: AgentState['status']) {
  if (status === 'idle') return 'ok';
  if (status === 'error') return 'bad';
  if (status === 'stopped') return 'off';
  return 'busy';
}

export function StatusDot({ tone, breathing }: { tone: string; breathing?: boolean }) {
  return <span className={`dot ${tone}${breathing ? ' breathing' : ''}`} />;
}

/** Text that scrolls horizontally when it doesn't fit (marquee). */
export function Marquee({ text, className = '' }: { text: string; className?: string }) {
  const [ref, overflow] = useOverflow<HTMLSpanElement>(text);
  const style = overflow ? ({ '--marquee-shift': `-${overflow + 24}px`, '--marquee-dur': `${Math.max(6, overflow / 25)}s` } as React.CSSProperties) : undefined;
  return (
    <span className={`marquee ${className}`}>
      <span ref={ref} className={overflow ? 'marquee-run' : ''} style={style}>{text}</span>
    </span>
  );
}

export function StatusBar({ avatar, agent, name = '小栖', bust, onSettings, onCollapse, onHide, onClear }: {
  avatar: AvatarState; agent: AgentState; /** Active character's display name. */ name?: string;
  /** Task 09: character-bound Q 版 bust URL → 20 px round avatar left of the name (nothing when the character has none). */
  bust?: string;
  onSettings(): void; onCollapse(): void; onHide(): void; onClear?(): void;
}) {
  const now = useNow(avatar.phase === 'live' && avatar.deadline != null);
  const remain = avatar.phase === 'live' && avatar.deadline != null ? avatar.deadline - now : null;
  const connecting = CONNECTING.includes(avatar.phase);
  const avatarLine = remain != null ? `实时中 · 剩余 ${formatCountdown(remain)}`
    : avatar.phase === 'live' ? AVATAR_TEXT.live
    : connecting ? AVATAR_TEXT[avatar.phase]
    : avatar.phase === 'error' ? avatar.message || AVATAR_TEXT.error
    : avatar.message || AVATAR_TEXT.idle;
  const agentLine = agent.status === 'running' ? agent.activity || '思考中…'
    : agent.status === 'error' ? agent.lastError || AGENT_TEXT.error
    : agent.status === 'starting' ? agent.activity || AGENT_TEXT.starting
    : agent.status === 'idle' ? AGENT_TEXT.idle
    : AGENT_TEXT[agent.status];
  return (
    <header className={`status drag${connecting || agent.status === 'running' || agent.status === 'starting' ? ' busy' : ''}`}>
      <div className="status-item who" title={avatar.message}>
        <StatusDot tone={avatarTone(avatar.phase)} breathing={connecting} />
        {bust && <img className="status-avatar" src={bust} alt="" draggable={false} />}
        <b>{name}</b>
        <Marquee className={`sub${remain != null && remain < 60_000 ? ' warn' : ''}${connecting ? ' shimmer' : ''}`} text={avatarLine} />
      </div>
      <span className="status-sep" />
      <div className="status-item agent">
        <StatusDot tone={agentTone(agent.status)} breathing={agent.status === 'running' || agent.status === 'starting'} />
        <b>Agent</b>
        <Marquee className="sub" text={agentLine} />
      </div>
      <div className="status-actions no-drag">
        {onClear && <button className="icon-btn" aria-label="清除会话" title="清除会话（对话记录清空，agent 重新开始）" onClick={onClear}><TrashIcon /></button>}
        <button className="icon-btn" aria-label="设置" title="设置（⌘,）" onClick={onSettings}><GearIcon /></button>
        <button className="icon-btn" aria-label="收起" title="收起成单行输入条" onClick={onCollapse}><ChevronDownIcon /></button>
        <button className="icon-btn" aria-label="隐藏" title="隐藏（Esc / ⌥Space）" onClick={onHide}><CloseIcon /></button>
      </div>
    </header>
  );
}
