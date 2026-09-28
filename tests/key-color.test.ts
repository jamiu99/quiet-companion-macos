import { describe, expect, it } from 'vitest';
import { estimateBackground, interiorAlpha, type KeyColor } from '../renderer/companion/keyColor';

const key: KeyColor = [6, 198, 62];
const patch = (color: KeyColor) => Array.from({ length: 16 }, () => [...color, 255]).flat();

describe('green-key color confidence', () => {
  it.each<KeyColor>([[183, 198, 178], [160, 184, 165], [222, 234, 218], [230, 180, 160], [24, 31, 36], [160, 180, 50]])('preserves low-saturation foreground %j far from any outline', (r, g, b) => {
    expect(interiorAlpha(r, g, b, key)).toBe(1);
  });
  it.each<KeyColor>([key, [0, 255, 0], [5, 189, 57]])('removes a real screen-colored pixel %j even inside an enclosed arm gap', (r, g, b) => {
    expect(interiorAlpha(r, g, b, key)).toBe(0);
  });
  it('has bounded, continuous opacity through the uncertain edge band', () => {
    let previous = 1;
    for (let g = 90; g <= 198; g++) {
      const a = interiorAlpha(90, g, 62, key);
      expect(a).toBeGreaterThanOrEqual(0); expect(a).toBeLessThanOrEqual(previous);
      expect(previous - a).toBeLessThan(0.08); previous = a;
    }
  });
  it('honors the existing tolerance as a foreground allowance', () => {
    expect(interiorAlpha(45, 80, 40, key, 40)).toBe(1);
  });
});

describe('auto-key consensus', () => {
  it('uses the actual stream green instead of the reference green', () => {
    expect(estimateBackground([patch(key), patch(key), patch(key), patch(key)])).toEqual(key);
  });
  it('ignores skin and tinted clothing covering two sample patches', () => {
    expect(estimateBackground([patch([190, 200, 175]), patch([220, 150, 100]), patch(key), patch(key)])).toEqual(key);
  });
  it('does not guess from a single exposed corner', () => {
    expect(estimateBackground([patch(key), patch([180, 193, 172])])).toBeUndefined();
  });
  it('rejects two conflicting groups rather than averaging green clothing into the screen', () => {
    const clothing: KeyColor = [20, 110, 25];
    expect(estimateBackground([patch(key), patch(key), patch(clothing), patch(clothing)])).toBeUndefined();
  });
  it('rejects non-uniform patches', () => {
    const mixed = [...patch(key).slice(0, 32), ...patch([20, 110, 25]).slice(0, 32)];
    expect(estimateBackground([mixed, mixed])).toBeUndefined();
  });
});
