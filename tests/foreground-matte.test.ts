import { describe, expect, it } from 'vitest';
import { foregroundProtection } from '../renderer/companion/foregroundMatte';
import { FramingGuard, measureForeground } from '../renderer/companion/framingGuard';
import type { KeyColor } from '../renderer/companion/keyColor';
const KEY: KeyColor = [6, 198, 62], W = 40, H = 60;
const tinted = [100, 176, 100, 255];
function fixture() {
  const p = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) p.set(x >= 10 && x < 30 && y >= 10 && y < 50 ? x === 10 || x === 29 || y === 10 || y === 49 ? [20, 20, 20, 255] : tinted : [...KEY, 255], (y * W + x) * 4);
  return p;
}
describe('foreground topology / matte integrity', () => {
  it('protects enclosed uncertain clothing, not border-connected green shadows', () => {
    const pixels = fixture();
    for (let y = 15; y < 45; y++) for (let x = 0; x < 5; x++) pixels.set([3, 100, 30, 255], (y * W + x) * 4);
    const mask = foregroundProtection(pixels, W, H, KEY);
    expect(mask[30 * W + 20]).toBe(255); expect(mask[30 * W + 2]).toBe(0);
    expect(measureForeground(pixels, W, H, KEY).centerCoverage).toBe(1);
  });
  it('never fills a true screen-colored gap even inside a closed silhouette', () => {
    const pixels = fixture(); pixels.set([...KEY, 255], (30 * W + 20) * 4);
    expect(foregroundProtection(pixels, W, H, KEY)[30 * W + 20]).toBe(0);
  });
  it('does not invent an enclosure when the region connects to the background', () => {
    const pixels = fixture(); pixels.set(tinted, (30 * W + 10) * 4);
    expect(foregroundProtection(pixels, W, H, KEY)[30 * W + 20]).toBe(0);
  });
  it('detects a large central punch-through without treating all enclosed gaps as foreground', () => {
    const pixels = fixture(), normal = measureForeground(pixels, W, H, KEY), guard = new FramingGuard();
    guard.inspect(normal, 0);
    for (let y = 22; y < 42; y++) for (let x = 15; x < 25; x++) pixels.set([...KEY, 255], (y * W + x) * 4);
    const broken = measureForeground(pixels, W, H, KEY);
    expect(broken.centerCoverage).toBeLessThan(0.42);
    expect(guard.inspect(broken, 100)).toMatchObject({ accept: false, reason: 'matte-hole' });
    expect(guard.inspect(broken, 500).fallback).toBe(true);
  });
  it('uses the portrait to reject an already-zoomed first RTC frame, including after reconnect', () => {
    const guard = new FramingGuard();
    guard.setReference({ area: 0.25, width: 0.5, height: 0.85, centerCoverage: 1 });
    const closeup = { area: 0.6, width: 0.9, height: 0.98, centerCoverage: 1 };
    expect(guard.inspect(closeup, 0)).toMatchObject({ accept: false, fallback: true, reason: 'zoom' });
    guard.reset(); expect(guard.inspect(closeup, 1000).accept).toBe(false);
    guard.setReference(undefined); expect(guard.inspect(closeup, 2000).accept).toBe(true);
  });
});
