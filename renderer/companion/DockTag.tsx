// Task 09: the pet tucked away as a small tag on the left / right screen edge. Shows the character's Q 版 bust (or her
// portrait's head, keyed on a tiny canvas, when she has no bust yet), can be dragged up and down, click restores.
// Position math lives in geometry.ts (dockTagRect / dockYFromTop); persistence is config.companion.docked (main).
import { useEffect, useRef, useState } from 'react';
import { DOCK_TAG_H, DOCK_TAG_W, dockTagRect, dockYFromTop, type Dock, type Rect } from './geometry';

/** Head crop of a green-screen portrait as a transparent data URL (simple chroma key on a 128 px canvas). */
export function useKeyedHead(src: string | undefined): string | undefined {
  const [out, setOut] = useState<string | undefined>(undefined);
  useEffect(() => {
    setOut(undefined);
    if (!src) return;
    let alive = true;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (!alive) return;
      try {
        const S = 128, side = img.naturalWidth * 0.62; // head + shoulders: top-centre square, ~62 % of the width
        const c = document.createElement('canvas'); c.width = c.height = S;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, (img.naturalWidth - side) / 2, img.naturalHeight * 0.02, side, side, 0, 0, S, S);
        const d = ctx.getImageData(0, 0, S, S), px = d.data;
        for (let i = 0; i < px.length; i += 4) {
          const g = px[i + 1] - Math.max(px[i], px[i + 2]);
          if (g > 60) px[i + 3] = 0; else if (g > 30) { px[i + 3] = Math.round(255 * (1 - (g - 30) / 30)); px[i + 1] = Math.max(px[i], px[i + 2]); }
        }
        ctx.putImageData(d, 0, 0);
        setOut(c.toDataURL('image/png'));
      } catch { setOut(undefined); }
    };
    img.src = src;
    return () => { alive = false; };
  }, [src]);
  return out;
}

export function DockTag({ vw, vh, dock, bust, portrait, name, tone, onRestore, onMove, onDragging, onContextMenu }: {
  vw: number; vh: number; dock: Dock;
  /** Character-bound Q 版 bust URL (preferred). */
  bust?: string;
  /** Green-screen portrait URL, used (head crop, keyed) when there is no bust. */
  portrait?: string;
  name: string;
  /** Status dot tone ('ok' live, 'busy' connecting / agent working, 'off' idle). */
  tone: 'ok' | 'busy' | 'off' | 'bad';
  onRestore(): void;
  /** Vertical drag committed (normalized y). */
  onMove(dock: Dock): void;
  /** Drag started / ended (Stage widens the window to the full screen while dragging). */
  onDragging(on: boolean): void;
  onContextMenu(): void;
}) {
  const [draft, setDraft] = useState<Rect | null>(null);
  const drag = useRef<{ startY: number; startTop: number; moved: boolean } | null>(null);
  const rect = draft ?? dockTagRect(vw, vh, dock);
  const head = useKeyedHead(bust ? undefined : portrait);
  const img = bust ?? head;
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { startY: e.screenY, startTop: rect.top, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dy = e.screenY - d.startY;
    if (!d.moved && Math.abs(dy) < 3) return;
    if (!d.moved) { d.moved = true; onDragging(true); }
    setDraft(dockTagRect(vw, vh, { side: dock.side, y: dockYFromTop(vh, d.startTop + dy) }));
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    drag.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* released */ }
    if (d.moved) { const top = (draft ?? rect).top; setDraft(null); onDragging(false); onMove({ side: dock.side, y: dockYFromTop(vh, top) }); }
    else onRestore();
  };
  return (
    <div className={`dock-tag interactive side-${dock.side}${drag.current?.moved ? ' dragging' : ''}`} role="button" tabIndex={0}
      style={{ left: rect.left, top: rect.top, width: DOCK_TAG_W, height: DOCK_TAG_H }}
      title={`${name} · 点击唤出，上下拖动移位，右键更多`} aria-label={`唤出${name}`}
      onPointerDown={onDown} onPointerMove={onPointerMove} onPointerUp={onUp} onPointerCancel={onUp}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRestore(); } }}
      onContextMenu={e => { e.preventDefault(); onContextMenu(); }}>
      {img ? <img src={img} alt="" draggable={false} /> : <span className="dock-initial" aria-hidden>{name.slice(0, 1)}</span>}
      <span className="dock-name">{name}</span>
      <span className={`dock-dot ${tone}`} />
    </div>
  );
}
