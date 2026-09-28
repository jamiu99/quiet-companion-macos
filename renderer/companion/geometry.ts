// Pure geometry for the pet stage (no DOM): body rectangle from scale/anchor, edge clamping, panel placement.
// Kept free of React/CSS imports so it can be unit-tested (tests/stage-geometry.test.ts).

export const MIN_SCALE = 0.2, MAX_SCALE = 1.0;
/** At least this many px of the body must stay on screen on each axis. */
export const EDGE_VISIBLE = 40;
export const PANEL_W = 360, PANEL_MAX_H = 440, PANEL_GAP = 16, SCREEN_PAD = 8;
export const PANEL_MIN_W = 300, PANEL_MAX_W = 560, PANEL_MIN_H = 240;
export interface PanelSize { width: number; height: number }
/** Adaptive default: width follows the screen (~26 %), height follows the figure (never shorter than 320, never taller
 *  than the screen). A user-chosen size (config.companion.panelSize) wins but is clamped to the same limits. */
export function panelSize(vw: number, vh: number, body: Rect, chosen?: Partial<PanelSize>): PanelSize {
  const maxH = Math.max(PANEL_MIN_H, vh - 2 * SCREEN_PAD - 48);
  const width = clamp(Math.round(chosen?.width ?? vw * 0.26), PANEL_MIN_W, Math.min(PANEL_MAX_W, vw - 2 * SCREEN_PAD));
  const height = clamp(Math.round(chosen?.height ?? Math.max(320, body.height)), PANEL_MIN_H, maxH);
  return { width, height };
}
/** Fallback body aspect (w/h) until the media reports its own: the portrait (900×1600) and S2 (768×1344) are ~9:16. */
export const DEFAULT_ASPECT = 9 / 16;

export interface Placement { scale: number; anchor: { x: number; y: number } }
export interface Rect { left: number; top: number; width: number; height: number }

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Body rectangle in viewport px for a placement. */
export function bodyRect(vw: number, vh: number, p: Placement, aspect: number): Rect {
  const height = p.scale * vh, width = height * aspect;
  return { left: p.anchor.x * vw - width / 2, top: p.anchor.y * vh - height, width, height };
}
/** Clamp scale to [MIN,MAX] and the anchor so that ≥ EDGE_VISIBLE px of the body stay on screen on both axes. */
export function clampPlacement(vw: number, vh: number, p: Placement, aspect: number): Placement {
  const scale = clamp(p.scale, MIN_SCALE, MAX_SCALE);
  const height = scale * vh, width = height * aspect;
  const left = clamp(p.anchor.x * vw - width / 2, EDGE_VISIBLE - width, vw - EDGE_VISIBLE);
  const top = clamp(p.anchor.y * vh - height, EDGE_VISIBLE - height, vh - EDGE_VISIBLE);
  return { scale, anchor: { x: (left + width / 2) / vw, y: (top + height) / vh } };
}
/** Where the chat panel goes: left of the body (bottom edges aligned, 16 px gap), or right when she hugs the left edge. */
export function panelPlacement(vw: number, vh: number, body: Rect, size: PanelSize = { width: PANEL_W, height: PANEL_MAX_H }): { left: number; bottom: number; side: 'left' | 'right' } {
  const leftSide = body.left - PANEL_GAP - size.width >= SCREEN_PAD;
  const left = leftSide ? body.left - PANEL_GAP - size.width : clamp(body.left + body.width + PANEL_GAP, SCREEN_PAD, vw - SCREEN_PAD - size.width);
  const bottomY = clamp(body.top + body.height, Math.min(vh - SCREEN_PAD, size.height + SCREEN_PAD), vh - SCREEN_PAD);
  return { left, bottom: vh - bottomY, side: leftSide ? 'left' : 'right' };
}


// ---- task 09: docked edge tag ----
export const DOCK_TAG_W = 64, DOCK_TAG_H = 80;
export interface Dock { side: 'left' | 'right'; y: number }
/** Where the pet goes when tucked away: the screen edge nearest to her (by center x), keeping her vertical center. */
export function dockFromPlacement(p: Placement): Dock {
  return { side: p.anchor.x < 0.5 ? 'left' : 'right', y: clamp(p.anchor.y - p.scale / 2, 0, 1) };
}
/** Tag rectangle in screen px: flush with the chosen edge, vertically centred on `dock.y`, fully on screen. */
export function dockTagRect(vw: number, vh: number, dock: Dock, w = DOCK_TAG_W, h = DOCK_TAG_H): Rect {
  const top = clamp(dock.y * vh - h / 2, SCREEN_PAD, Math.max(SCREEN_PAD, vh - h - SCREEN_PAD));
  return { left: dock.side === 'left' ? 0 : vw - w, top, width: w, height: h };
}
/** Normalized y for a tag whose top is at `top` px (inverse of dockTagRect for vertical drags). */
export function dockYFromTop(vh: number, top: number, h = DOCK_TAG_H): number {
  return clamp((clamp(top, SCREEN_PAD, Math.max(SCREEN_PAD, vh - h - SCREEN_PAD)) + h / 2) / vh, 0, 1);
}
