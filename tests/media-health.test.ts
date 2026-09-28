import { describe, expect, it } from 'vitest';
import { MediaProgress } from '../renderer/companion/mediaHealth';
const sample = { width: 768, height: 1344, readyState: 4, decodedFrames: 100, currentTime: 10 };

describe('RTC decoder watchdog', () => {
  it('detects a freeze even if readyState remains 4 and the media clock advances', () => {
    const p = new MediaProgress(0); p.observe(sample, 0);
    expect(p.observe({ ...sample, currentTime: 13 }, 3000)).toEqual({ advanced: false, ageMs: 3000 });
    expect(p.observe({ ...sample, currentTime: 30 }, 20000).ageMs).toBe(20000);
  });
  it('requires an actual new decoded frame to reset the stall timer', () => {
    const p = new MediaProgress(0); p.observe(sample, 0);
    expect(p.observe({ ...sample, decodedFrames: 101 }, 5000)).toEqual({ advanced: true, ageMs: 0 });
  });
  it('treats a valid re-published stream frame counter reset as progress, not a 2x2 placeholder', () => {
    const p = new MediaProgress(0); p.observe(sample, 0);
    expect(p.observe({ ...sample, width: 2, height: 2, decodedFrames: 0 }, 4000).ageMs).toBe(4000);
    expect(p.observe({ ...sample, decodedFrames: 1 }, 4500).advanced).toBe(true);
  });
  it('has a clock fallback only for browsers without playback quality counters', () => {
    const p = new MediaProgress(0);
    p.observe({ ...sample, decodedFrames: undefined }, 0);
    expect(p.observe({ ...sample, decodedFrames: undefined, currentTime: 11 }, 1000).advanced).toBe(true);
  });
});
