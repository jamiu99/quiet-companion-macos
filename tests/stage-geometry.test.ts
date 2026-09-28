import { describe, expect, it } from 'vitest';
import { DOCK_TAG_H, DOCK_TAG_W, EDGE_VISIBLE, MAX_SCALE, MIN_SCALE, PANEL_GAP, PANEL_MAX_H, PANEL_MAX_W, PANEL_MIN_W, PANEL_W, SCREEN_PAD, bodyRect, clampPlacement, dockFromPlacement, dockTagRect, dockYFromTop, panelPlacement, panelSize } from '../renderer/companion/geometry';

const VW = 1470, VH = 956, ASPECT = 9 / 16;

describe('bodyRect', () => {
  it('anchor is the bottom-center, height = scale * vh', () => {
    const r = bodyRect(VW, VH, { scale: 0.5, anchor: { x: 0.5, y: 1 } }, ASPECT);
    expect(r.height).toBeCloseTo(478);
    expect(r.width).toBeCloseTo(478 * ASPECT);
    expect(r.left + r.width / 2).toBeCloseTo(VW / 2);
    expect(r.top + r.height).toBeCloseTo(VH);
  });
});

describe('clampPlacement', () => {
  it('clamps scale to [0.2, 1]', () => {
    expect(clampPlacement(VW, VH, { scale: 0.05, anchor: { x: 0.5, y: 0.9 } }, ASPECT).scale).toBe(MIN_SCALE);
    expect(clampPlacement(VW, VH, { scale: 3, anchor: { x: 0.5, y: 0.9 } }, ASPECT).scale).toBe(MAX_SCALE);
  });
  it('keeps at least 40px visible on each axis', () => {
    const far = clampPlacement(VW, VH, { scale: 0.5, anchor: { x: -2, y: -2 } }, ASPECT);
    const r = bodyRect(VW, VH, far, ASPECT);
    expect(r.left + r.width).toBeCloseTo(EDGE_VISIBLE);
    expect(r.top + r.height).toBeCloseTo(EDGE_VISIBLE);
    const far2 = clampPlacement(VW, VH, { scale: 0.5, anchor: { x: 3, y: 3 } }, ASPECT);
    const r2 = bodyRect(VW, VH, far2, ASPECT);
    expect(r2.left).toBeCloseTo(VW - EDGE_VISIBLE);
    expect(r2.top).toBeCloseTo(VH - EDGE_VISIBLE);
  });
  it('leaves an in-bounds placement untouched', () => {
    const p = { scale: 0.6, anchor: { x: 0.78, y: 0.98 } };
    const c = clampPlacement(VW, VH, p, ASPECT);
    expect(c.scale).toBe(p.scale);
    expect(c.anchor.x).toBeCloseTo(p.anchor.x, 10);
    expect(c.anchor.y).toBeCloseTo(p.anchor.y, 10);
  });
});

describe('panelPlacement', () => {
  it('goes left of the body with a 16px gap, bottom edges aligned', () => {
    const r = bodyRect(VW, VH, { scale: 0.6, anchor: { x: 0.78, y: 0.98 } }, ASPECT);
    const p = panelPlacement(VW, VH, r);
    expect(p.side).toBe('left');
    expect(p.left).toBeCloseTo(r.left - PANEL_GAP - PANEL_W);
    expect(VH - p.bottom).toBeCloseTo(r.top + r.height);
  });
  it('flips to the right when she hugs the left edge', () => {
    const r = bodyRect(VW, VH, { scale: 0.6, anchor: { x: 0.1, y: 0.98 } }, ASPECT);
    const p = panelPlacement(VW, VH, r);
    expect(p.side).toBe('right');
    expect(p.left).toBeCloseTo(r.left + r.width + PANEL_GAP);
  });
  it('never pushes the panel above the screen top', () => {
    const r = bodyRect(VW, VH, { scale: 0.3, anchor: { x: 0.8, y: 0.3 } }, ASPECT);
    const p = panelPlacement(VW, VH, r);
    expect(VH - p.bottom).toBeGreaterThanOrEqual(PANEL_MAX_H + SCREEN_PAD);
  });
});

describe('panelSize', () => {
  const VW = 1470, VH = 956;
  it('adapts to the screen and the figure by default', () => {
    const body = { left: 1000, top: 300, width: 360, height: 640 };
    const s = panelSize(VW, VH, body);
    expect(s.width).toBe(Math.round(VW * 0.26));
    expect(s.height).toBe(640);
    const small = panelSize(VW, VH, { ...body, height: 200 });
    expect(small.height).toBe(320);
  });
  it('clamps a user-chosen size and feeds it to panelPlacement', () => {
    const body = { left: 1000, top: 300, width: 360, height: 640 };
    const s = panelSize(VW, VH, body, { width: 9999, height: 9999 });
    expect(s.width).toBe(PANEL_MAX_W);
    expect(s.height).toBeLessThanOrEqual(VH - 2 * SCREEN_PAD);
    expect(panelSize(VW, VH, body, { width: 10, height: 10 }).width).toBe(PANEL_MIN_W);
    const p = panelPlacement(VW, VH, body, s);
    expect(p.left).toBeCloseTo(body.left - PANEL_GAP - s.width);
  });
});

describe('dock tag (task 09)', () => {
  it('picks the nearest edge and keeps her vertical center', () => {
    expect(dockFromPlacement({ scale: 0.6, anchor: { x: 0.78, y: 0.98 } })).toEqual({ side: 'right', y: 0.98 - 0.3 });
    expect(dockFromPlacement({ scale: 0.4, anchor: { x: 0.2, y: 0.5 } })).toEqual({ side: 'left', y: 0.3 });
    expect(dockFromPlacement({ scale: 1, anchor: { x: 0.5, y: 0.2 } }).y).toBe(0);
  });
  it('tag is flush with the edge, centred on y, clamped inside the screen', () => {
    const r = dockTagRect(VW, VH, { side: 'right', y: 0.5 });
    expect(r).toEqual({ left: VW - DOCK_TAG_W, top: VH / 2 - DOCK_TAG_H / 2, width: DOCK_TAG_W, height: DOCK_TAG_H });
    expect(dockTagRect(VW, VH, { side: 'left', y: 0 }).left).toBe(0);
    expect(dockTagRect(VW, VH, { side: 'left', y: 0 }).top).toBe(SCREEN_PAD);
    expect(dockTagRect(VW, VH, { side: 'left', y: 1 }).top).toBe(VH - DOCK_TAG_H - SCREEN_PAD);
  });
  it('dockYFromTop inverts dockTagRect within the clamped range', () => {
    for (const y of [0.1, 0.42, 0.9]) {
      const r = dockTagRect(VW, VH, { side: 'left', y });
      expect(dockYFromTop(VH, r.top)).toBeCloseTo(y, 6);
    }
    expect(dockTagRect(VW, VH, { side: 'left', y: dockYFromTop(VH, -500) }).top).toBe(SCREEN_PAD);
  });
});
