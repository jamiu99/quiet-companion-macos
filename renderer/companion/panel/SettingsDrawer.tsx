import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PublicConfig, QuickTask } from '@shared/config';
import { TOKENDANCE_MODEL_PRESETS } from '@shared/config';
import { CheckIcon, CloseIcon, PlusIcon, TrashIcon } from './icons';
import type { CharacterJob, ViduLogItem } from '@shared/events';
import { CharactersGroup } from './CharactersGroup';
import { TokenDanceAccess } from './TokenDanceAccess';
import { resolveActiveCharacter } from '@shared/config';

type SetConfig = (patch: Record<string, unknown>) => Promise<void>;
export type SettingsGroup = 'characters' | 'avatar' | 'agent' | 'display' | 'quick' | 'vidulog';
/** Where to land when the drawer opens (e.g. from the empty-state guide). `nonce` re-triggers focus. */
export interface SettingsTarget { group: SettingsGroup; field?: string; nonce: number }

const GROUPS: { id: SettingsGroup; label: string }[] = [
  { id: 'characters', label: '角色' }, { id: 'avatar', label: '数字人' }, { id: 'agent', label: 'Agent' }, { id: 'display', label: '显示' }, { id: 'quick', label: '快捷任务' }, { id: 'vidulog', label: 'Vidu 日志' },
];

export function Field({ label, children, hint, field }: { label: string; children: ReactNode; hint?: string; field?: string }) {
  return (
    <label className="field" data-field={field}>
      <span className="field-label">{label}</span>
      <span className="field-control">{children}{hint && <small className="field-hint">{hint}</small>}</span>
    </label>
  );
}

function RangeField({ label, value, min, max, step, format, onChange }: { label: string; value: number; min: number; max: number; step: number; format(v: number): string; onChange(v: number): void }) {
  return (
    <Field label={label}>
      <span className="inline">
        <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} />
        <span className="range-value">{format(value)}</span>
      </span>
    </Field>
  );
}

/** Manual key entry is transient; explicit save, no blur/clipboard auto-save, no full-key echo. */
function KeyField({ label, field, hasKey, masked, placeholder, onSave, autoEdit }: {
  label: string; field: string; hasKey: boolean; masked: string; placeholder: string; onSave(v: string): Promise<void>; autoEdit?: boolean;
}) {
  const [editing, setEditing] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoEdit) setEditing(true); }, [autoEdit]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  const cancel = () => { if (ref.current) ref.current.value = ''; setEditing(false); setError(''); };
  const commit = async () => {
    if (saving) return;
    const v = ref.current?.value.trim();
    if (!v || /\s/.test(v) || /^(?:Bearer|Token)\s/i.test(v)) { setError('只填写完整 Key 本身，不要添加 Token / Bearer 前缀或空格。'); return; }
    setSaving(true); setError('');
    try { await onSave(v); cancel(); } catch { setError('保存失败，请检查 Key 格式或本机配置目录权限。'); }
    finally { setSaving(false); }
  };
  return (
    <Field label={label} field={field}>
      {editing ? (
        <><input ref={ref} type="password" placeholder={placeholder} spellCheck={false} autoComplete="off" autoCapitalize="none" maxLength={4096} disabled={saving}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void commit(); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!saving) cancel(); } }} />
          <span className="btn-row"><button type="button" className="btn" disabled={saving} onClick={() => void commit()}>{saving ? '保存中…' : '保存'}</button><button type="button" className="btn" disabled={saving} onClick={cancel}>取消</button></span>
          {error && <small role="alert" className="field-hint">{error}</small>}</>
      ) : (
        <span className="inline key-row">
          <span className={`key-masked${hasKey ? '' : ' none'}`}>{hasKey ? <><CheckIcon width={12} height={12} />{masked}</> : '未设置'}</span>
          <button type="button" className="btn" onClick={() => setEditing(true)}>{hasKey ? '修改' : '填写'}</button>
        </span>
      )}
    </Field>
  );
}

function QuickTasksEditor({ tasks, onChange }: { tasks: QuickTask[]; onChange(next: QuickTask[]): void }) {
  const [draft, setDraft] = useState(tasks);
  const key = JSON.stringify(tasks);
  useEffect(() => { setDraft(tasks); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = (i: number, patch: Partial<QuickTask>) => setDraft(d => d.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const commit = () => { const clean = draft.filter(t => t.label.trim() || t.prompt.trim()); if (JSON.stringify(clean) !== key) onChange(clean); };
  const remove = (i: number) => { const next = draft.filter((_, j) => j !== i); setDraft(next); onChange(next); };
  const add = () => setDraft(d => [...d, { id: `qt-${Date.now().toString(36)}`, label: '', prompt: '' }]);
  return (
    <div className="quick-editor">
      <p className="field-hint">点击 chip 会把「提示词」原样交给 agent 执行。修改后失焦即保存。</p>
      {draft.map((t, i) => (
        <div className="quick-item" key={t.id}>
          <div className="inline">
            <input value={t.label} placeholder="按钮文字" onChange={e => update(i, { label: e.target.value })} onBlur={commit} />
            <button type="button" className="icon-btn danger" aria-label="删除" title="删除" onClick={() => remove(i)}><TrashIcon width={14} height={14} /></button>
          </div>
          <textarea rows={2} value={t.prompt} placeholder="交给 agent 的提示词" onChange={e => update(i, { prompt: e.target.value })} onBlur={commit} />
        </div>
      ))}
      <button type="button" className="btn" onClick={add}><PlusIcon width={12} height={12} />添加快捷任务</button>
    </div>
  );
}

export function SettingsDrawer({ open, target, onGroup, config, setConfig, onClose, jobs, viduLog = [] }: {
  open: boolean; target: SettingsTarget; onGroup(g: SettingsGroup): void; config: PublicConfig; setConfig: SetConfig; onClose(): void;
  /** Character generation jobs (AppState.characterJobs). */
  jobs?: CharacterJob[];
  /** Vidu-side log lines (AppState.viduLog). */
  viduLog?: ViduLogItem[];
}) {
  // Keep the body mounted only while visible (plus the slide-out): a hidden drawer still decoded its <video> thumbnails.
  const [mounted, setMounted] = useState(open);
  const [serviceError, setServiceError] = useState('');
  useEffect(() => { if (open) { setMounted(true); return; } const t = setTimeout(() => setMounted(false), 300); return () => clearTimeout(t); }, [open]);
  const body = useRef<HTMLDivElement>(null);
  // Scroll the targeted field into view and flash it.
  useEffect(() => {
    if (!open || !target.field) return;
    const t = setTimeout(() => {
      const el = body.current?.querySelector<HTMLElement>(`[data-field="${target.field}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200);
      el.querySelector<HTMLElement>('input:not([readonly]), select, textarea, button')?.focus();
    }, 280);
    return () => clearTimeout(t);
  }, [open, target.nonce, target.field]);
  const g = target.group;
  const c = config;
  // With an active character the portrait / persona / idle video come from the 「角色」 group; the legacy fields stay as fallback.
  const active = resolveActiveCharacter(c);
  const byCharacter = Boolean(active.character);
  const characterHint = (what: string) => <p className="field-hint by-character">{what}由「角色」里的当前角色（{active.name}）决定。<button type="button" className="link" onClick={() => onGroup('characters')}>去角色设置</button></p>;
  return (
    <>
      <div className={`scrim${open ? ' show' : ''}`} onClick={onClose} />
      <aside className={`drawer${open ? ' open' : ''}`} aria-hidden={!open}>{mounted && (<>
        <div className="drawer-head">
          <div className="segmented" role="tablist">
            {GROUPS.map(x => <button key={x.id} role="tab" type="button" data-group={x.id} aria-selected={g === x.id} className={g === x.id ? 'on' : ''} onClick={() => onGroup(x.id)}>{x.label}</button>)}
          </div>
          <button className="icon-btn" aria-label="关闭设置" title="关闭（Esc）" onClick={onClose}><CloseIcon /></button>
        </div>
        <div className="drawer-body" ref={body}>
          {g === 'characters' && <CharactersGroup config={c} jobs={jobs} target={target.field} />}
          {g === 'avatar' && (
            <>
              <h4>Vidu S2 实时数字人</h4>
              <p className="field-hint">用于实时人物、声音与动作，和 TokenDance 是两套独立服务 / 额度。到 Vidu 开放平台创建 API Key，只填 Key 本身（通常以 vda_ 开头），不要填网页登录密码或 Token 前缀。</p>
              <KeyField label="Vidu Key" field="vidu.apiKey" hasKey={c.vidu.hasKey} masked={c.vidu.apiKeyMasked} placeholder="粘贴 Vidu API Key" autoEdit={open && target.field === 'vidu.apiKey'} onSave={v => setConfig({ vidu: { apiKey: v } })} />
              <p className="field-hint">选择与 Key 所属账户一致的国内 / 国际站点。保存 Key 不等于连接；开启「自动连接」后发第一条消息会创建按秒计费会话。</p>
              <Field label="站点"><select value={c.vidu.host} onChange={e => setConfig({ vidu: { host: e.target.value } })}><option>api.vidu.cn</option><option>api.vidu.com</option></select></Field>
              {byCharacter ? characterHint('参考图、音色和人设') : <>
                <Field label="参考图" field="vidu.imagePath" hint="建议纯绿背景的半身人物图，便于抠像">
                  <span className="inline"><input readOnly value={c.vidu.imagePath} placeholder="尚未选择" title={c.vidu.imagePath} /><button type="button" className="btn" onClick={async () => { const p = await window.companion.pickImage(); if (p) void setConfig({ vidu: { imagePath: p } }); }}>选择…</button></span>
                </Field>
                <Field label="音色"><input value={c.vidu.voice} onChange={e => setConfig({ vidu: { voice: e.target.value } })} /></Field>
              </>}
              <Field label="单次上限" hint="按秒计费，到点自动挂断"><span className="inline"><input type="number" min={1} max={10} value={c.vidu.maxMinutes} onChange={e => setConfig({ vidu: { maxMinutes: Number(e.target.value) } })} /><span className="range-value">分钟</span></span></Field>
              <Field label="自动连接" hint="发第一条消息时自动开始实时会话"><input className="switch" type="checkbox" checked={c.ui.autoConnectOnMessage} onChange={e => setConfig({ ui: { autoConnectOnMessage: e.target.checked } })} /></Field>
              {!byCharacter && <Field label="人设"><textarea rows={6} value={c.vidu.persona} onChange={e => setConfig({ vidu: { persona: e.target.value } })} /></Field>}
            </>
          )}
          {g === 'agent' && (
            <>
              <h4>pi agent · TokenDance</h4>
              <p className="field-hint">用于 Agent 对话 / 执行任务，以及立绘、待机视频和 Q 版素材生成。不替代 Vidu 实时数字人的 Key。</p>
              <TokenDanceAccess hasKey={c.agent.hasKey} />
              <h4>或手动填写已有 Key</h4>
              <p className="field-hint">从 TokenDance 的 Key 管理页复制完整 Key，粘贴后点击保存。不填授权码、登录密码，也不加 Bearer 前缀；取消或关闭设置不会保存输入。</p>
              <KeyField label="Agent Key" field="agent.manualKey" hasKey={c.agent.hasKey} masked={c.agent.apiKeyMasked} placeholder="粘贴完整 API Key" onSave={v => setConfig({ agent: { apiKey: v } })} />
              <Field label="服务地址" hint="TokenDance 填 https://tokendance.space/gateway，不加 /v1 或 /chat/completions。自定义服务只填可信地址，现有 Key 会发往该服务。">
                <input key={c.agent.baseUrl} defaultValue={c.agent.baseUrl} spellCheck={false} onBlur={async e => {
                  const input = e.currentTarget, v = input.value.trim(); setServiceError('');
                  if (!v || v === c.agent.baseUrl) { input.value = c.agent.baseUrl; return; }
                  try { await setConfig({ agent: { baseUrl: v } }); }
                  catch { input.value = c.agent.baseUrl; setServiceError('服务地址未保存，请检查 HTTPS 地址并在系统提示中确认。'); }
                }} />
                {serviceError && <small role="alert" className="field-hint">{serviceError}</small>}
              </Field>
              <Field label="模型"><select value={TOKENDANCE_MODEL_PRESETS.some(p => p.id === c.agent.model) ? c.agent.model : '__custom'} onChange={e => { if (e.target.value === '__custom') return; const m = TOKENDANCE_MODEL_PRESETS.find(p => p.id === e.target.value); void setConfig({ agent: { model: e.target.value, api: m?.api ?? c.agent.api } }); }}>
                {TOKENDANCE_MODEL_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                <option value="__custom">自定义…</option>
              </select></Field>
              <Field label="模型 ID" hint="TokenDance 目录里的任意模型 ID"><input key={c.agent.model} defaultValue={c.agent.model} spellCheck={false} onBlur={e => { const v = e.target.value.trim(); if (v && v !== c.agent.model) void setConfig({ agent: { model: v } }); }} /></Field>
              <Field label="接口"><select value={c.agent.api} onChange={e => setConfig({ agent: { api: e.target.value } })}><option value="anthropic-messages">anthropic-messages</option><option value="openai-completions">openai-completions</option></select></Field>
              <Field label="思考强度"><select value={c.agent.thinkingLevel} onChange={e => setConfig({ agent: { thinkingLevel: e.target.value } })}>{['off', 'minimal', 'low', 'medium', 'high'].map(l => <option key={l}>{l}</option>)}</select></Field>
              <Field label="工作目录"><span className="inline"><input readOnly value={c.agent.workspace} title={c.agent.workspace} /><button type="button" className="btn" onClick={async () => { const p = await window.companion.pickFolder(); if (p) void setConfig({ agent: { workspace: p } }); }}>选择…</button></span></Field>
              <RangeField label="进度播报" value={c.agent.progressReportIntervalMs} min={0} max={60000} step={1000} format={v => (v ? `每 ${v / 1000}s` : '关闭')} onChange={v => void setConfig({ agent: { progressReportIntervalMs: v } })} />
              <h4>会话</h4>
              <Field label="显示操作过程" hint="在对话里显示 agent 的工具调用和内部回复；关闭时只显示你和数字人"><input className="switch" type="checkbox" checked={Boolean(c.ui.showAgentDetails)} onChange={e => setConfig({ ui: { showAgentDetails: e.target.checked } })} /></Field>
              <div className="btn-row"><button type="button" className="btn" onClick={() => window.companion.restartAgent()}>重启 agent</button><button type="button" className="btn" onClick={() => window.companion.resetAgent()}>新会话</button></div>
            </>
          )}
          {g === 'vidulog' && <ViduLogView items={viduLog} />}
          {g === 'display' && (
            <>
              <h4>数字人窗口</h4>
              <Field label="图层" hint="置顶：始终最前，面板外点击穿透；沉到桌面：在桌面图标之上、所有窗口之下"><select value={c.companion.layer} onChange={e => window.companion.setLayer(e.target.value as 'desktop' | 'float')}><option value="float">置顶（桌宠）</option><option value="desktop">沉到桌面</option></select></Field>
              <RangeField label="大小" value={c.companion.scale} min={0.2} max={1} step={0.02} format={v => `${Math.round(v * 100)}%`} onChange={v => void setConfig({ companion: { scale: v } })} />
              <RangeField label="横向位置" value={c.companion.anchor.x} min={0} max={1} step={0.01} format={v => `${Math.round(v * 100)}%`} onChange={v => void setConfig({ companion: { anchor: { ...c.companion.anchor, x: v } } })} />
              <RangeField label="纵向位置" value={c.companion.anchor.y} min={0} max={1} step={0.01} format={v => `${Math.round(v * 100)}%`} onChange={v => void setConfig({ companion: { anchor: { ...c.companion.anchor, y: v } } })} />
              <Field label="锁定位置" hint="禁止拖动；也可用她头顶工具条切换"><input className="switch" type="checkbox" checked={Boolean(c.companion.lockMove)} onChange={e => setConfig({ companion: { lockMove: e.target.checked } })} /></Field>
              <Field label="锁定大小" hint="禁止右下角把手与 ⌥+滚轮缩放"><input className="switch" type="checkbox" checked={Boolean(c.companion.lockSize)} onChange={e => setConfig({ companion: { lockSize: e.target.checked } })} /></Field>
              <Field label="绿幕抠像"><input className="switch" type="checkbox" checked={c.companion.greenKey} onChange={e => setConfig({ companion: { greenKey: e.target.checked } })} /></Field>
              {c.companion.greenKey && <>
                <Field label="实时构图保护" hint="突变放大时暂用待机形象，声音继续；恢复正常后自动切回。大幅表演可关闭。"><input className="switch" type="checkbox" checked={c.companion.framingGuard !== false} onChange={e => setConfig({ companion: { framingGuard: e.target.checked } })} /></Field>
                <RangeField label="容差" value={c.companion.keyTolerance ?? 3} min={0} max={40} step={1} format={v => String(v)} onChange={v => void setConfig({ companion: { keyTolerance: v } })} />
                <RangeField label="边缘半径" value={c.companion.keyRadius ?? 3} min={1} max={4} step={1} format={v => String(v)} onChange={v => void setConfig({ companion: { keyRadius: v } })} />
                <RangeField label="去绿溢色" value={c.companion.keySpill ?? 1} min={0} max={1} step={0.05} format={v => v.toFixed(2)} onChange={v => void setConfig({ companion: { keySpill: v } })} />
              </>}
              {byCharacter ? characterHint('待机视频') : <Field label="待机视频" field="companion.idleVideoPath" hint="未连接时循环播放的绿幕短视频（mp4/webm），同样抠像；留空则显示参考图">
                <span className="inline"><input readOnly value={c.companion.idleVideoPath ?? ''} placeholder="使用内置待机视频 / 参考图" title={c.companion.idleVideoPath ?? ''} /><button type="button" className="btn" onClick={async () => { const p = await window.companion.pickVideo?.(); if (p) void setConfig({ companion: { idleVideoPath: p } }); }}>选择…</button>{c.companion.idleVideoPath && <button type="button" className="btn" title="清除，改用参考图" onClick={() => void setConfig({ companion: { idleVideoPath: '' } })}>清除</button>}</span>
              </Field>}
              <Field label="显示字幕"><input className="switch" type="checkbox" checked={c.companion.showSubtitles} onChange={e => setConfig({ companion: { showSubtitles: e.target.checked } })} /></Field>
              <h4>对话面板</h4>
              <Field label="快捷键" hint="呼出 / 隐藏对话面板，例如 Alt+Space、Cmd+Shift+K；失焦保存，立即生效"><input defaultValue={c.ui.toggleBarHotkey} placeholder="Alt+Space" onBlur={e => { const v = e.target.value.trim(); if (v && v !== c.ui.toggleBarHotkey) void setConfig({ ui: { toggleBarHotkey: v } }); }} /></Field>
            </>
          )}
          {g === 'quick' && <QuickTasksEditor tasks={c.quickTasks} onChange={next => void setConfig({ quickTasks: next })} />}
        </div>
      </>)}</aside>
    </>
  );
}


const DIR_LABEL: Record<ViduLogItem['dir'], string> = { out: '我们 → Vidu', in: 'Vidu → 我们', media: '媒体', app: '应用' };
/** mm:ss.d — short enough for a 300 px panel; the full timestamp is in main.log. */
const fmtTime = (t: number) => { const d = new Date(t); return `${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${Math.floor(d.getMilliseconds() / 100)}`; };

/** Settings → 「Vidu 日志」: control signalling both ways + media milestones, newest at the bottom, filter by lane. */
function ViduLogView({ items }: { items: ViduLogItem[] }) {
  const [lanes, setLanes] = useState<Record<ViduLogItem['dir'], boolean>>({ out: true, in: true, media: true, app: true });
  const [follow, setFollow] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const shown = items.filter(i => lanes[i.dir]);
  useEffect(() => { if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [shown.length, follow]);
  const copy = () => { void navigator.clipboard?.writeText(shown.map(i => `${fmtTime(i.at)} [${DIR_LABEL[i.dir]}] ${i.tag}: ${i.text}`).join('\n')); };
  return (
    <>
      <h4>与 Vidu 的往来</h4>
      <div className="vlog-bar">
        {(Object.keys(DIR_LABEL) as ViduLogItem['dir'][]).map(d => (
          <label key={d} className={`vlog-lane lane-${d}${lanes[d] ? ' on' : ''}`}><input type="checkbox" checked={lanes[d]} onChange={e => setLanes(l => ({ ...l, [d]: e.target.checked }))} />{DIR_LABEL[d]}</label>
        ))}
        <span className="spacer" />
        <label className="vlog-lane"><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />跟随</label>
        <button type="button" className="btn" onClick={copy}>复制</button>
        <button type="button" className="btn" onClick={() => void window.companion.clearViduLog?.()}>清空</button>
      </div>
      <div className="vlog" ref={ref} onScroll={e => { const el = e.currentTarget; setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24); }}>
        {shown.length === 0 && <p className="field-hint">还没有记录。连接数字人后，这里会显示创建会话、conn_init、发出的文字/提词、收到的转写、打断、挂断，以及入会、订阅、首帧、断流和码率统计。</p>}
        {shown.map(i => (
          <div key={i.id} className={`vlog-row lane-${i.dir}`}>
            <span className="vlog-time">{fmtTime(i.at)}</span>
            <span className="vlog-dir">{i.dir === 'out' ? '→' : i.dir === 'in' ? '←' : i.dir === 'media' ? '◎' : '·'}</span>
            <span className="vlog-tag">{i.tag}</span>
            <span className="vlog-text">{i.text}</span>
          </div>
        ))}
      </div>
    </>
  );
}
