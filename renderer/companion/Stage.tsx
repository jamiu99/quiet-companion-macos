// Pet stage: positions/sizes the avatar body, handles drag (move), the corner handle + ⌥wheel (scale), the lock flags,
// the hover toolbar, the subtitle under her feet, the embedded chat panel placement and the click-through hit-test
// (reports "pointer is over an interactive region" to main via companion.setInteractive).
//
// The body rectangle = the `.stage-figure` box, computed from config.companion.scale (fraction of viewport height) and
// config.companion.anchor (normalized bottom-center). `children` is the `.stage-body` container owned by main.tsx
// (idle image / IdleLayer / live video / keyed canvas); it just fills this box.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { resolveActiveCharacter, type PublicConfig } from '@shared/config';
import type { AppState } from '@shared/events';
import { Panel, type PanelMode } from './panel/Panel';
import { AVATAR_TEXT } from './panel/StatusBar';
import { characterArt } from '../shared/ui-assets';

/** Phases that show the character's Q 版 picture (dozing 小栖 by default) above the「数字人正在创建中…」pill. */
const CONNECTING_PHASES: import('@shared/events').AvatarState['phase'][] = ['creating', 'warming', 'connecting'];
import type { SettingsGroup, SettingsTarget } from './panel/SettingsDrawer';
import { ChatIcon, GearIcon, LockIcon, MoveIcon, PhoneIcon, PhoneOffIcon, ResizeIcon } from './panel/icons';
import { DEFAULT_ASPECT, MAX_SCALE, MIN_SCALE, bodyRect, clamp, clampPlacement, dockTagRect, panelPlacement, panelSize as computePanelSize, type Dock, type PanelSize, type Placement } from './geometry';
import { DockTag } from './DockTag';

import './stage.css';
export { DEFAULT_ASPECT } from './geometry';

const SUBTITLE_MIN_MS = 3000, SUBTITLE_MAX_MS = 5000, SUBTITLE_FADE_MS = 600;

/** The stage works in screen coordinates (the display the window lives on); the window itself is shrink-wrapped. */
const screenSize = () => ({ vw: window.screen.width || window.innerWidth, vh: window.screen.height || window.innerHeight });
function useViewport() {
  const [v, setV] = useState(screenSize);
  useEffect(() => {
    const on = () => setV(screenSize());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return v;
}

/** Latest companion line as a subtitle (only while live), fades after 3–5 s depending on length. */
function useSubtitle(state: AppState | null, live: boolean) {
  const last = state?.transcript.filter(t => t.role === 'companion').at(-1);
  const [sub, setSub] = useState<{ id: string; text: string; visible: boolean } | null>(null);
  useEffect(() => {
    if (!last || !live) { setSub(null); return; }
    setSub({ id: last.id, text: last.text, visible: true });
    const hold = Math.min(SUBTITLE_MAX_MS, Math.max(SUBTITLE_MIN_MS, last.text.length * 180));
    const t1 = setTimeout(() => setSub(s => s && s.id === last.id ? { ...s, visible: false } : s), hold);
    const t2 = setTimeout(() => setSub(s => s && s.id === last.id ? null : s), hold + SUBTITLE_FADE_MS);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [last?.id, live]);
  return sub;
}

type Drag =
  | { kind: 'move'; startX: number; startY: number; start: Placement; moved: boolean }
  | { kind: 'size'; left: number; top: number; start: Placement };

/** Dev-only URL flags for screenshots: ?hover=1 (toolbar shown), ?panel=collapsed|hidden, ?settings=1[&group=display],
 *  ?fullwin=1 (keep the window full-screen so screen coordinates show as-is, e.g. the docked edge tag). */
function debugFlags() {
  if (!import.meta.env.DEV) return { hover: false, panel: null as PanelMode | null, settings: false, group: undefined as SettingsGroup | undefined, fullwin: false };
  const q = new URLSearchParams(location.search);
  const panel = q.get('panel');
  return {
    fullwin: q.get('fullwin') === '1',
    hover: q.get('hover') === '1',
    panel: panel === 'collapsed' || panel === 'hidden' || panel === 'full' ? panel : null,
    settings: q.get('settings') === '1',
    group: (q.get('group') as SettingsGroup | null) ?? undefined,
  };
}

export function Stage({ config, state, setConfig, live, visualFallback = false, aspect = DEFAULT_ASPECT, children }: {
  config: PublicConfig; state: AppState; setConfig(patch: Record<string, unknown>): Promise<void>;
  /** True once the live stream is presenting frames (subtitles only make sense then). */
  live: boolean;
  visualFallback?: boolean;
  /** Body width / height. */
  aspect?: number;
  children: ReactNode;
}) {
  const dbg = useRef(debugFlags()).current;
  const { vw, vh } = useViewport();
  const c = config.companion;
  const lockMove = Boolean(c.lockMove), lockSize = Boolean(c.lockSize);
  // Local placement mirrors config; while dragging only this changes, config is written on release.
  const [placement, setPlacement] = useState<Placement>({ scale: c.scale, anchor: c.anchor });
  const dragRef = useRef<Drag | null>(null);
  useEffect(() => { if (!dragRef.current) setPlacement({ scale: c.scale, anchor: c.anchor }); }, [c.scale, c.anchor.x, c.anchor.y]);
  const figureRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(dbg.hover);
  const [panelMode, setPanelMode] = useState<PanelMode>(dbg.panel === 'collapsed' ? 'collapsed' : 'full');
  const [settings, setSettings] = useState(dbg.settings);
  const [target, setTarget] = useState<SettingsTarget>({ group: dbg.group ?? 'avatar', nonce: 0 });
  // Task 09: tucked away as an edge tag (config.companion.docked). The figure stays mounted but hidden so a live
  // stream keeps playing (audio continues); the panel is not rendered while docked (barVisible is left untouched).
  const docked: Dock | undefined = c.docked ?? undefined;
  const panelVisible = docked ? false : dbg.panel === 'hidden' ? false : state.barVisible;
  const subtitle = useSubtitle(state, live);

  const commit = useCallback((p: Placement) => {
    const patch: Record<string, unknown> = {};
    if (p.scale !== c.scale) patch.scale = p.scale;
    if (p.anchor.x !== c.anchor.x || p.anchor.y !== c.anchor.y) patch.anchor = p.anchor;
    if (Object.keys(patch).length) void setConfig({ companion: patch });
  }, [c.scale, c.anchor.x, c.anchor.y, setConfig]);

  const rect = bodyRect(vw, vh, placement, aspect);
  // Panel size: adaptive default, or the user's drag-chosen size (local while dragging, config on release).
  const [panelDraft, setPanelDraft] = useState<PanelSize | null>(null);
  const pSize = computePanelSize(vw, vh, rect, panelDraft ?? c.panelSize);
  const panelPos = panelPlacement(vw, vh, rect, pSize);
  const [dragging, setDragging] = useState(false);
  const panelDragRef = useRef<{ startX: number; startY: number; start: PanelSize; side: 'left' | 'right' } | null>(null);
  const onPanelResizeDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    panelDragRef.current = { startX: e.screenX, startY: e.screenY, start: pSize, side: panelPos.side };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPanelResizeMove = (e: React.PointerEvent) => {
    const d = panelDragRef.current; if (!d) return;
    // Outer-top corner: dragging away from the figure widens; dragging up grows height.
    const dx = (e.screenX - d.startX) * (d.side === 'left' ? -1 : 1), dy = d.startY - e.screenY;
    setPanelDraft(computePanelSize(vw, vh, rect, { width: d.start.width + dx, height: d.start.height + dy }));
  };
  const onPanelResizeUp = (e: React.PointerEvent) => {
    const d = panelDragRef.current; if (!d) return;
    panelDragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* released */ }
    setDragging(false);
    const final = panelDraft ?? pSize; setPanelDraft(null);
    if (final.width !== c.panelSize?.width || final.height !== c.panelSize?.height) void setConfig({ companion: { panelSize: final } });
  };

  // ---- shrink-wrapped window: cover only figure (+ toolbar above, subtitle below) and the panel; full screen while dragging ----
  const fullBounds = { x: 0, y: 0, width: vw, height: vh };
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const requestBounds = useCallback((b: { x: number; y: number; width: number; height: number }) => {
    setOrigin(o => (o.x === b.x && o.y === b.y ? o : { x: b.x, y: b.y }));
    void window.companion.setWindowBounds?.(b).catch(() => { /* mock / no main */ });
  }, []);
  const wanted = (() => {
    if (dragging || dbg.hover || dbg.panel !== null || dbg.fullwin) return fullBounds;
    const TOOLBAR = 40, SUBTITLE = 96, PAD = 12;
    if (docked) {
      const t = dockTagRect(vw, vh, docked);
      return { x: clamp(Math.floor(t.left - PAD), 0, vw), y: clamp(Math.floor(t.top - PAD), 0, vh), width: Math.min(vw, Math.ceil(t.width + 2 * PAD)), height: Math.min(vh, Math.ceil(t.height + 2 * PAD)) };
    }
    let l = rect.left - PAD, t = rect.top - TOOLBAR, r = rect.left + rect.width + PAD, b = rect.top + rect.height + SUBTITLE;
    if (panelVisible) {
      const pl = panelPos.left, pr = pl + pSize.width, pb = vh - panelPos.bottom, pt = pb - pSize.height;
      l = Math.min(l, pl - PAD); r = Math.max(r, pr + PAD); t = Math.min(t, pt - PAD); b = Math.max(b, pb + PAD);
    }
    l = clamp(Math.floor(l), 0, vw); t = clamp(Math.floor(t), 0, vh); r = clamp(Math.ceil(r), 0, vw); b = clamp(Math.ceil(b), 0, vh);
    return { x: l, y: t, width: Math.max(64, r - l), height: Math.max(64, b - t) };
  })();
  // Re-request whenever the window is resized by someone else (main re-fits it to the display on startup / display
  // changes); converges in one round-trip because main ignores identical bounds.
  const [resizeTick, setResizeTick] = useState(0);
  useEffect(() => { const on = () => setResizeTick(t => t + 1); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on); }, []);
  useEffect(() => { requestBounds(wanted); }, [wanted.x, wanted.y, wanted.width, wanted.height, resizeTick, requestBounds]);
  // Latest placement for commit-on-release (state may lag one render behind the last move).
  const placementRef = useRef(placement); placementRef.current = placement;

  // ---- drag to move / handle to resize (pointer capture on the figure) ----
  const onBodyDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || lockMove) return;
    dragRef.current = { kind: 'move', startX: e.screenX, startY: e.screenY, start: placement, moved: false };
    figureRef.current?.setPointerCapture(e.pointerId);
    setDragging(true);
    requestBounds(fullBounds); // the window must cover the whole screen while she is being dragged
  };
  const onHandleDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || lockSize) return;
    e.stopPropagation();
    dragRef.current = { kind: 'size', left: rect.left, top: rect.top, start: placement };
    figureRef.current?.setPointerCapture(e.pointerId);
    setDragging(true);
    requestBounds(fullBounds);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d) return;
    if (d.kind === 'move') {
      const dx = e.screenX - d.startX, dy = e.screenY - d.startY;
      if (!d.moved && Math.hypot(dx, dy) < 3) return;
      d.moved = true;
      setPlacement(clampPlacement(vw, vh, { scale: d.start.scale, anchor: { x: d.start.anchor.x + dx / vw, y: d.start.anchor.y + dy / vh } }, aspect));
    } else {
      // Top-left corner stays put; the bottom-right corner follows the pointer (whichever axis asks for more).
      const h = Math.max(e.screenY - d.top, (e.screenX - d.left) / aspect);
      const scale = clamp(h / vh, MIN_SCALE, MAX_SCALE), height = scale * vh, width = height * aspect;
      setPlacement(clampPlacement(vw, vh, { scale, anchor: { x: (d.left + width / 2) / vw, y: (d.top + height) / vh } }, aspect));
    }
  };
  const onUp = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d) return;
    dragRef.current = null;
    try { figureRef.current?.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (d.kind === 'size' || d.moved) commit(placementRef.current);
    setDragging(false);
  };
  // ⌥ + wheel over the body: scale around the anchor (native listener: React's onWheel is passive).
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const el = figureRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey || lockSize) return;
      e.preventDefault();
      const next = clampPlacement(vw, vh, { ...placementRef.current, scale: placementRef.current.scale * Math.exp(-e.deltaY * 0.002) }, aspect);
      setPlacement(next); placementRef.current = next;
      clearTimeout(wheelTimer.current);
      wheelTimer.current = setTimeout(() => commit(placementRef.current), 400);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { el.removeEventListener('wheel', onWheel); clearTimeout(wheelTimer.current); };
  }, [vw, vh, aspect, lockSize, commit]);

  // ---- click-through hit-test: tell main whether the pointer is over an interactive region ----
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const interactive = useRef(false);
  const report = useCallback((on: boolean) => {
    if (on === interactive.current) return;
    interactive.current = on;
    void window.companion.setInteractive(on).catch(() => { /* mock / no main */ });
  }, []);
  const hitTest = useCallback(() => {
    if (dragRef.current) return report(true);
    const p = lastPointer.current; if (!p) return report(false);
    const el = document.elementFromPoint(p.x, p.y);
    report(Boolean(el?.closest('.interactive')));
  }, [report]);
  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => { lastPointer.current = { x: e.clientX, y: e.clientY }; hitTest(); };
    // relatedTarget null = the pointer left the window entirely.
    const onPointerOut = (e: PointerEvent) => { if (!e.relatedTarget && !dragRef.current) { lastPointer.current = null; report(false); } };
    window.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerout', onPointerOut);
    return () => { window.removeEventListener('pointermove', onPointerMove); document.removeEventListener('pointerout', onPointerOut); };
  }, [hitTest, report]);
  // Layout changed under a resting pointer (panel hidden / collapsed / she moved) → re-evaluate without waiting for a move.
  useLayoutEffect(() => { const id = requestAnimationFrame(hitTest); return () => cancelAnimationFrame(id); }, [panelVisible, panelMode, settings, rect.left, rect.top, rect.width, rect.height, docked?.side, docked?.y, hitTest]);

  // ---- keys: Esc closes settings, else hides the panel; ⌘, opens settings ----
  const openSettings = (group?: SettingsGroup, field?: string) => {
    setTarget(t => ({ group: group ?? t.group, field, nonce: t.nonce + 1 }));
    setSettings(true); setPanelMode('full');
    if (!state.barVisible) void window.companion.toggleBar(true);
  };
  // Context menu (task 09) → 「设置…」: main pushes push:open-settings after restoring / showing the panel.
  useEffect(() => window.companion.onOpenSettings?.(() => openSettings()) ?? undefined, [state.barVisible]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (settings) { e.preventDefault(); setSettings(false); }
        else if (panelVisible) { e.preventDefault(); void window.companion.toggleBar(false); }
      } else if (e.metaKey && e.key === ',') { e.preventDefault(); openSettings(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settings, panelVisible, state.barVisible]);

  const { avatar } = state;
  const avatarIdle = avatar.phase === 'idle' || avatar.phase === 'error';
  const canConnect = config.vidu.hasKey && Boolean(resolveActiveCharacter(config).imagePath);
  const art = characterArt(config);
  const showChrome = hover || Boolean(dragRef.current);
  const figureStyle: React.CSSProperties = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  const contextMenu = (e: React.MouseEvent) => { e.preventDefault(); void window.companion.showContextMenu?.().catch(() => { /* mock */ }); };
  const setDocked = (d: Dock | null) => void window.companion.setDocked?.(d).catch(() => { /* mock */ });
  const active = resolveActiveCharacter(config);

  return (
    <div className="stage-screen" style={{ width: vw, height: vh, transform: `translate(${-origin.x}px, ${-origin.y}px)` }}>
      {docked && (
        <DockTag vw={vw} vh={vh} dock={docked} name={active.name} bust={art.ownBust ? art.bust : undefined} portrait={!art.ownBust && active.imagePath ? window.companion.assetUrl(active.imagePath) : undefined}
          tone={avatar.phase === 'live' ? 'ok' : avatar.phase === 'error' ? 'bad' : avatar.phase !== 'idle' || state.agent.status === 'running' ? 'busy' : 'off'}
          onRestore={() => setDocked(null)} onMove={d => setDocked(d)} onDragging={setDragging} onContextMenu={() => void window.companion.showContextMenu?.().catch(() => { /* mock */ })} />
      )}
      <div ref={figureRef} className={`stage-figure${docked ? ' docked' : ' interactive'}${dragRef.current ? ' dragging' : ''}${lockMove ? ' locked' : ''}`} style={figureStyle}
        onPointerEnter={() => setHover(true)} onPointerLeave={() => { if (!dbg.hover) setHover(false); }}
        onPointerDown={onBodyDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onContextMenu={contextMenu}>
        {/* Toolbar zone sits flush above the body so moving the pointer up into the toolbar never leaves the figure. */}
        <div className={`stage-toolbar-zone${showChrome ? ' show' : ''}`} onPointerDown={e => e.stopPropagation()}>
          <div className="stage-toolbar" role="toolbar" aria-label="数字人工具条">
            <button type="button" className={`tb${lockMove ? ' on' : ''}`} aria-label={lockMove ? '解锁位置' : '锁定位置'} title={lockMove ? '已锁定位置 · 点击解锁' : '锁定位置（禁止拖动）'} aria-pressed={lockMove}
              onClick={() => void setConfig({ companion: { lockMove: !lockMove } })}>{lockMove ? <LockIcon filled /> : <MoveIcon />}</button>
            <button type="button" className={`tb${lockSize ? ' on' : ''}`} aria-label={lockSize ? '解锁大小' : '锁定大小'} title={lockSize ? '已锁定大小 · 点击解锁' : '锁定大小（禁止缩放）'} aria-pressed={lockSize}
              onClick={() => void setConfig({ companion: { lockSize: !lockSize } })}>{lockSize ? <LockIcon filled /> : <ResizeIcon />}</button>
            <span className="tb-sep" />
            {avatarIdle
              ? <button type="button" className="tb" aria-label="连接数字人" disabled={!canConnect} title={canConnect ? '连接数字人' : '需要先配置 Vidu Key 和形象'} onClick={() => void window.companion.connectAvatar()}><PhoneIcon /></button>
              : <button type="button" className="tb danger" aria-label="挂断" disabled={avatar.phase === 'stopping'} title={avatar.phase === 'live' ? '挂断' : '取消连接'} onClick={() => void window.companion.disconnectAvatar()}><PhoneOffIcon /></button>}
            <button type="button" className={`tb${panelVisible ? ' on' : ''}`} aria-label={panelVisible ? '隐藏面板' : '显示面板'} title={panelVisible ? '隐藏对话面板' : '显示对话面板'} aria-pressed={panelVisible}
              onClick={() => void window.companion.toggleBar(!state.barVisible)}><ChatIcon filled={panelVisible} /></button>
            <button type="button" className="tb" aria-label="设置" title="设置（⌘,）" onClick={() => openSettings()}><GearIcon /></button>
          </div>
        </div>
        {children}
        {visualFallback && <div className="stage-media-notice" role="status">画面保护中 · 声音继续</div>}
        {!lockSize && (
          <div className={`stage-handle interactive${showChrome ? ' show' : ''}`} aria-label="拖动缩放" title="拖动缩放（也可 ⌥+滚轮）" onPointerDown={onHandleDown}><ResizeIcon /></div>
        )}
        {/* Under her feet (10 px below the body box, outside it): subtitle while live, phase message while connecting. */}
        {c.showSubtitles && subtitle && live && (
          <div className="stage-subtitle" style={{ opacity: subtitle.visible ? 1 : 0, transition: `opacity ${SUBTITLE_FADE_MS}ms ease` }}>{subtitle.text}</div>
        )}
        {avatar.phase !== 'idle' && avatar.phase !== 'live' && (
          <div className={`stage-subtitle status${CONNECTING_PHASES.includes(avatar.phase) ? ' connecting' : ''}`}>
            {CONNECTING_PHASES.includes(avatar.phase) && <img src={art.connecting} alt="" draggable={false} />}
            {avatar.phase === 'error' ? avatar.message : AVATAR_TEXT[avatar.phase]}
          </div>
        )}
      </div>
      {panelVisible && (
        <Panel
          state={state} config={config} setConfig={setConfig}
          style={{ left: panelPos.left, bottom: panelPos.bottom, '--panel-w': `${pSize.width}px`, '--panel-h': `${pSize.height}px` } as React.CSSProperties} side={panelPos.side}
          resizeHandle={<div className={`panel-resize interactive side-${panelPos.side}${panelDragRef.current ? ' active' : ''}`} title="拖动调整面板大小" onPointerDown={onPanelResizeDown} onPointerMove={onPanelResizeMove} onPointerUp={onPanelResizeUp} onPointerCancel={onPanelResizeUp} />}
          mode={panelMode} onMode={m => { setPanelMode(m); if (m === 'collapsed') setSettings(false); }}
          settings={settings} onSettings={setSettings} target={target} onTarget={setTarget} openSettings={openSettings}
          onHide={() => void window.companion.toggleBar(false)}
        />
      )}
    </div>
  );
}
