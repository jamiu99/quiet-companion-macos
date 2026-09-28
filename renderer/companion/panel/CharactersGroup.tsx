// Settings → 「角色」: card strip of all characters (click = make active), edit form for the selected one (saves on
// blur), reference image, the two TokenDance generation buttons with live progress, and delete with confirmation.
// Data comes from PublicConfig.characters (pushed by main on every change); job progress from AppState.characterJobs.
import { useEffect, useState, type ReactNode } from 'react';
import { CHARACTER_STYLES, VIDU_VOICE_PRESETS, type Character, type PublicConfig } from '@shared/config';
import type { CharacterJob } from '@shared/events';
import { Field } from './SettingsDrawer';
import { CheckIcon, PlusIcon } from './icons';

/** Kept for docs/tests; the UI no longer shows prices (TokenDance 估算见 docs/ASSETS.md). */
export const COST_PORTRAIT = '≈0.3 元', COST_IDLE = '≈5 元', COST_ART = '≈0.6 元';
const PHASE_TEXT: Record<CharacterJob['phase'], string> = { submitted: '已提交', queued: '排队中', running: '生成中', downloading: '下载中', done: '完成', failed: '失败' };

/** Strip Electron's IPC error wrapper so the UI shows the message main threw. */
export function ipcError(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
const api = () => window.companion;
const asset = (p?: string) => (p ? window.companion.assetUrl(p) : undefined);

function Thumb({ src, name, video, className = '', title }: { src?: string; name: string; video?: boolean; className?: string; title?: string }) {
  if (!src) return <span className={`char-thumb empty ${className}`} aria-hidden title={title}>{name.slice(0, 1) || '?'}</span>;
  if (video) return <video className={`char-thumb ${className}`} src={src} muted loop autoPlay playsInline title={title} />;
  return <img className={`char-thumb ${className}`} src={src} alt="" title={title} />;
}

function JobLine({ job }: { job?: CharacterJob }) {
  if (!job) return null;
  const active = job.phase !== 'done' && job.phase !== 'failed';
  const pct = job.progress != null ? Math.round(job.progress * 100) : undefined;
  return (
    <div className={`job ${job.phase}`} role="status">
      {active && <span className="progress"><span className={`bar${pct == null ? ' indeterminate' : ''}`} style={pct != null ? { width: `${pct}%` } : undefined} /></span>}
      <span className="job-text">{job.phase === 'failed' ? `失败：${job.error ?? job.message ?? ''}` : `${job.message ?? PHASE_TEXT[job.phase]}${pct != null && active ? ` ${pct}%` : ''}`}</span>
    </div>
  );
}

function AssetTile({ label, children, preview }: { label: string; preview: ReactNode; children: ReactNode }) {
  return (
    <div className="asset-tile">
      <div className="asset-preview">{preview}</div>
      <div className="asset-side"><span className="asset-label">{label}</span>{children}</div>
    </div>
  );
}

/** Voice picker: Vidu presets + cloned voices on the account (GET /live/v1/voices) + a free-text fallback. */
function VoiceField({ value, onChange }: { value: string; onChange(v: string): void }) {
  const [cloned, setCloned] = useState<string[]>([]);
  const [custom, setCustom] = useState(false);
  useEffect(() => { let alive = true; void api().listVoices?.().then(v => { if (alive) setCloned(v ?? []); }).catch(() => {}); return () => { alive = false; }; }, []);
  const known = [...VIDU_VOICE_PRESETS.map(p => p.id), ...cloned];
  const isKnown = known.includes(value);
  const preset = VIDU_VOICE_PRESETS.find(p => p.id === value);
  const hint = custom || !isKnown ? '填 Vidu 音色 ID（预设或你克隆的音色名）' : preset?.hint ?? (cloned.includes(value) ? '你在 Vidu 账号里克隆的音色' : '');
  return (
    <Field label="音色" hint={hint}>
      {custom || !isKnown
        ? <span className="inline"><input value={value} spellCheck={false} placeholder="Tina" onChange={e => onChange(e.target.value)} onBlur={() => { if (known.includes(value)) setCustom(false); }} /><button type="button" className="link" onClick={() => { setCustom(false); if (!isKnown) onChange(VIDU_VOICE_PRESETS[0].id); }}>选列表</button></span>
        : <span className="inline"><select value={value} onChange={e => (e.target.value === '__custom' ? setCustom(true) : onChange(e.target.value))}>
            <optgroup label="Vidu 预设">{VIDU_VOICE_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</optgroup>
            {cloned.length > 0 && <optgroup label="我的克隆音色">{cloned.map(v => <option key={v} value={v}>{v}</option>)}</optgroup>}
            <option value="__custom">自定义 ID…</option>
          </select></span>}
    </Field>
  );
}

/** Editable copy of the selected character; commits on blur, re-syncs when main pushes a newer version. */
function useDraft(c: Character | undefined) {
  const [draft, setDraft] = useState<Character | undefined>(c);
  useEffect(() => { setDraft(c); }, [c?.id, c?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  return [draft, setDraft] as const;
}

export function CharactersGroup({ config, jobs = [], target }: { config: PublicConfig; jobs?: CharacterJob[]; /** data-field to highlight (from EmptyState). */ target?: string }) {
  const list = config.characters ?? [];
  const activeId = config.activeCharacterId ?? '';
  const [selectedId, setSelectedId] = useState(activeId);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selected = list.find(c => c.id === selectedId) ?? list.find(c => c.id === activeId) ?? list[0];
  const [draft, setDraft] = useDraft(selected);
  useEffect(() => { setConfirmDelete(false); setError(''); }, [selected?.id]);
  // Follow the active character when it changes elsewhere (tray / another card) unless the user is editing another one.
  useEffect(() => { if (!list.some(c => c.id === selectedId)) setSelectedId(activeId); }, [activeId, list.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown> | undefined) => { setError(''); try { await fn(); } catch (e) { setError(ipcError(e)); } };
  const jobOf = (id: string, kind: CharacterJob['kind']) => jobs.find(j => j.characterId === id && j.kind === kind);
  const busy = (id: string) => jobs.some(j => j.characterId === id && j.phase !== 'done' && j.phase !== 'failed');

  const select = (c: Character) => {
    setSelectedId(c.id);
    if (c.id !== activeId) void run(() => api().setActiveCharacter?.(c.id));
  };
  const create = () => run(async () => { const c = await api().saveCharacter?.({ name: '' }); if (c) setSelectedId(c.id); });
  const commit = (patch: Partial<Character>) => {
    if (!selected) return;
    const changed = (Object.keys(patch) as (keyof Character)[]).some(k => (patch[k] ?? '') !== (selected[k] ?? ''));
    if (changed) void run(() => api().saveCharacter?.({ id: selected.id, ...patch }));
  };
  const edit = (patch: Partial<Character>) => setDraft(d => (d ? { ...d, ...patch } : d));

  return (
    <div className="chars">
      <h4>角色</h4>
      <div className="char-cards" role="listbox" aria-label="角色列表">
        {list.map(c => (
          <button key={c.id} type="button" role="option" aria-selected={c.id === selected?.id} className={`char-card${c.id === selected?.id ? ' selected' : ''}${c.id === activeId ? ' active' : ''}`}
            title={c.id === activeId ? `${c.name}（当前）` : `切换到 ${c.name}`} onClick={() => select(c)}>
            <Thumb src={asset(c.portraitPath)} name={c.name} />
            <span className="char-name">{c.name || '未命名'}</span>
            {c.id === activeId && <span className="char-badge" aria-label="当前角色"><CheckIcon width={10} height={10} strokeWidth={3} /></span>}
            {busy(c.id) && <span className="char-busy" aria-label="生成中" />}
          </button>
        ))}
        <button type="button" className="char-card new" onClick={() => void create()} title="新建角色"><span className="char-thumb plus"><PlusIcon width={16} height={16} /></span><span className="char-name">新角色</span></button>
      </div>
      {error && <p className="char-error" role="alert">{error}</p>}
      {!selected && <p className="field-hint">还没有角色。点「新角色」创建一个，填好外观描述后生成绿幕立绘。</p>}
      {selected && draft && (
        <>
          <Field label="名字" field="character.name"><input value={draft.name} placeholder="她叫什么" maxLength={40} onChange={e => edit({ name: e.target.value })} onBlur={() => commit({ name: draft.name })} /></Field>
          <Field label="性格" hint="一两句，拼进数字人的人设里"><textarea rows={2} value={draft.personality} placeholder="例如：温柔、自然、有分寸" onChange={e => edit({ personality: e.target.value })} onBlur={() => commit({ personality: draft.personality })} /></Field>
          <Field label="外观" field="character.appearance" hint="用于生成立绘：发型、五官、服装、气质…"><textarea rows={3} value={draft.appearance} placeholder="例如：短发戴圆框眼镜穿深蓝卫衣的男生" onChange={e => edit({ appearance: e.target.value })} onBlur={() => commit({ appearance: draft.appearance })} /></Field>
          <Field label="风格"><select value={draft.style} onChange={e => { const style = e.target.value as Character['style']; edit({ style }); commit({ style }); }}>{CHARACTER_STYLES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
          <VoiceField value={draft.voice} onChange={v => { edit({ voice: v }); commit({ voice: v }); }} />
          <Field label="参考图" hint="可选。选了参考图会按它的人物特征、发型、服装来画">
            <span className="inline">
              <Thumb src={asset(selected.referenceImagePath)} name="参" className="small" />
              <button type="button" className="btn" onClick={() => void run(() => api().pickReferenceImage?.(selected.id))}>{selected.referenceImagePath ? '更换…' : '选择…'}</button>
              {selected.referenceImagePath && <button type="button" className="btn" onClick={() => void run(() => api().saveCharacter?.({ id: selected.id, referenceImagePath: '' }))}>清除</button>}
            </span>
          </Field>
          <h4>素材</h4>
          <div className="assets" data-field={target === 'character.portrait' ? 'character.portrait' : undefined}>
            <div className="asset-row">
              <button type="button" className="btn accent" disabled={busy(selected.id) || !selected.appearance.trim()}
                title={selected.appearance.trim() ? '按上面的外观、风格和参考图，先画绿幕立绘，再由立绘生成 8 秒循环待机视频（约 3 分钟）和两张 Q 版小图（半身、挥手）' : '先填外观描述'}
                onClick={() => void run(() => api().generateAssets?.(selected.id))}>
                {selected.portraitPath || selected.idleVideoPath ? '重新生成素材' : '一键生成素材'}
              </button>
              <span className="field-hint">立绘 + 待机视频 + Q 版小图，一次完成</span>
            </div>
            <JobLine job={jobOf(selected.id, 'portrait')} />
            <JobLine job={jobOf(selected.id, 'idle')} />
            <JobLine job={jobOf(selected.id, 'art')} />
            <div className="asset-previews">
              <AssetTile label="绿幕立绘" preview={<Thumb src={asset(selected.portraitPath)} name={selected.name} className="large" />}>
                <button type="button" className="link" onClick={() => void run(async () => { const p = await api().pickImage(); if (p) await api().saveCharacter?.({ id: selected.id, portraitPath: p }); })}>用已有图片…</button>
              </AssetTile>
              <AssetTile label="待机视频" preview={<Thumb src={asset(selected.idleVideoPath)} name={selected.name} video className="large" />}>
                {selected.portraitPath && <button type="button" className="link" disabled={busy(selected.id)} onClick={() => void run(() => api().generateIdleVideo?.(selected.id))}>只重做待机视频</button>}
                <button type="button" className="link" onClick={() => void run(async () => { const p = await api().pickVideo?.(); if (p) await api().saveCharacter?.({ id: selected.id, idleVideoPath: p }); })}>用已有视频…</button>
              </AssetTile>
            </div>
            {/* Task 09: Q 版半身（侧边收纳标签、状态条头像）+ 挥手（空状态、连接中）。没有时界面回退到内置的小栖插画。 */}
            <div className="asset-tile art-tiles" data-field="character.art">
              <div className="asset-preview">
                <Thumb src={asset(selected.artBustPath)} name="半" className="art" title="Q 版半身" />
                <Thumb src={asset(selected.artHeroPath)} name="挥" className="art" title="Q 版挥手" />
              </div>
              <div className="asset-side">
                <span className="asset-label">Q 版小图</span>
                <span className="field-hint">半身用在侧边收纳标签和状态条，挥手图用在空状态和连接中{!selected.artBustPath && !selected.artHeroPath ? '；现在显示的是内置的小栖插画' : ''}</span>
                {selected.portraitPath && <button type="button" className="link" disabled={busy(selected.id)} onClick={() => void run(() => api().generateArt?.(selected.id))}>{selected.artBustPath || selected.artHeroPath ? '重画 Q 版小图' : '按立绘画 Q 版小图'}</button>}
              </div>
            </div>
          </div>
          <div className="char-danger">
            {confirmDelete
              ? <><span>删除「{selected.name}」和她的素材？</span><button type="button" className="btn danger" onClick={() => void run(async () => { await api().deleteCharacter?.(selected.id); setConfirmDelete(false); })}>删除</button><button type="button" className="btn" onClick={() => setConfirmDelete(false)}>取消</button></>
              : <button type="button" className="link danger" disabled={busy(selected.id)} onClick={() => setConfirmDelete(true)}>删除角色</button>}
          </div>
        </>
      )}
    </div>
  );
}
