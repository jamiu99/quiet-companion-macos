import { describe, expect, it } from 'vitest';
import { FramingGuard, measureForeground, type ForegroundGeometry } from '../renderer/companion/framingGuard';
import { makeCreatePayload, REALTIME_FRAMING_RULE } from '../electron/vidu/config';
import { DEFAULT_CONFIG, mergeConfig, toPublicConfig } from '../shared/config';

const normal: ForegroundGeometry = { area: 0.25, width: 0.5, height: 0.85 };
const zoom: ForegroundGeometry = { area: 0.55, width: 0.9, height: 1 };

describe('live framing guard', () => {
  it('accepts breathing and wider arms without treating a gesture as zoom', () => {
    const g = new FramingGuard();
    expect(g.inspect(normal, 0).accept).toBe(true);
    expect(g.inspect({ area: 0.31, width: 0.95, height: 0.88 }, 1000).accept).toBe(true);
  });
  it('holds the first anomalous frame, falls back after 350 ms, and debounces recovery', () => {
    const g = new FramingGuard(); g.inspect(normal, 0);
    expect(g.inspect(zoom, 100)).toMatchObject({ accept: false, fallback: false, reason: 'zoom' });
    expect(g.inspect(zoom, 450)).toMatchObject({ accept: false, fallback: true });
    expect(g.inspect(normal, 500)).toMatchObject({ accept: false, fallback: true, reason: 'recovering' });
    expect(g.inspect(normal, 899).accept).toBe(false);
    expect(g.inspect(normal, 900)).toMatchObject({ accept: true, fallback: false });
  });
  it('does not learn prolonged or gradual zoom into the baseline', () => {
    const g = new FramingGuard(); g.inspect(normal, 0);
    g.inspect({ area: 0.36, width: 0.65, height: 0.9 }, 500);
    for (let t = 1000; t < 15000; t += 500) expect(g.inspect(zoom, t).accept).toBe(false);
  });
  it('does not flicker to idle on a single-frame glitch', () => {
    const g = new FramingGuard(); g.inspect(normal, 0); g.inspect(zoom, 100);
    expect(g.inspect(normal, 140)).toMatchObject({ accept: true, fallback: false });
  });
  it('restarts the recovery interval after another bad frame', () => {
    const g = new FramingGuard(); g.inspect(normal, 0); g.inspect(zoom, 100); g.inspect(zoom, 500);
    g.inspect(normal, 600); g.inspect(zoom, 900);
    expect(g.inspect(normal, 1000).accept).toBe(false);
    expect(g.inspect(normal, 1400).accept).toBe(true);
  });
  it.each([0, 0.001, NaN])('fails closed on an empty/invalid initial frame (area=%s)', area => {
    expect(new FramingGuard().inspect({ ...normal, area }, 0)).toMatchObject({ accept: false, fallback: true, reason: 'empty' });
  });
  it('rejects full-frame matte floods and disappearance', () => {
    const g = new FramingGuard(); g.inspect(normal, 0);
    expect(g.inspect({ area: 1, width: 1, height: 1 }, 500).reason).toBe('flood');
    expect(g.inspect({ ...normal, area: 0.02 }, 600).reason).toBe('empty');
  });
  it('can reset for a new RTC session / character', () => {
    const g = new FramingGuard(); g.inspect(normal, 0); g.inspect(zoom, 500); g.reset();
    expect(g.inspect(zoom, 1000)).toMatchObject({ accept: true, fallback: false, areaRatio: 1 });
  });
});

it('measures normalized foreground including tinted clothes, ignoring isolated border speckles', () => {
  const pixels = new Uint8ClampedArray(100 * 100 * 4);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) pixels.set(x >= 30 && x < 70 && y >= 10 && y < 90 ? [180, 196, 172, 255] : [6, 198, 62, 255], (y * 100 + x) * 4);
  pixels.set([0, 0, 0, 255], 0);
  const measured = measureForeground(pixels, 100, 100, [6, 198, 62]);
  expect(measured.area).toBeCloseTo(0.32, 3);
  expect(measured.width).toBe(0.4); expect(measured.height).toBe(0.8);
});

it('adds visual instructions to requests, including custom personas, without rewriting saved config', () => {
  const c = { ...DEFAULT_CONFIG.vidu, persona: '自定义人设' };
  expect(makeCreatePayload(c, 'data:image/png;base64,test').avatar.persona).toBe(`${c.persona}\n${REALTIME_FRAMING_RULE}`);
  expect(c.persona).toBe('自定义人设');
  expect(makeCreatePayload({ ...c, persona: 'a'.repeat(50000) }, '').avatar.persona.length).toBeLessThanOrEqual(50000);
});

it('persists the optional framing switch while keeping secrets out of PublicConfig', () => {
  const config = mergeConfig(DEFAULT_CONFIG, { companion: { framingGuard: false }, vidu: { apiKey: 'vda_test_secret' }, agent: { apiKey: 'sk_test_secret' } });
  const pub = toPublicConfig(config);
  expect(pub.companion.framingGuard).toBe(false);
  expect(pub.vidu).not.toHaveProperty('apiKey'); expect(pub.agent).not.toHaveProperty('apiKey');
});
