// Shared by the WebGL shader and the low-resolution framing probe. No DOM / GPU dependencies.
export type KeyColor = [number, number, number];
export const KEY_FOREGROUND = 0.30;
export const KEY_BACKGROUND = 0.85;

/** Green excess alone confuses tinted white clothes with the screen. Require relative saturation as well.
 *  Both ratios are relative to the measured screen, not to the reference image's nominal #00FF00. */
export function screenStrength(r: number, g: number, b: number, key: KeyColor): number {
  const excess = Math.max(0, g - Math.max(r, b));
  const screen = Math.max(1, key[1] - Math.max(key[0], key[2]));
  return Math.min(excess / screen, (excess / Math.max(1, g)) / (screen / Math.max(1, key[1])));
}

/** Conservative opacity when no nearby foreground sample exists (not a complete replacement for edge unmixing). */
export function interiorAlpha(r: number, g: number, b: number, key: KeyColor, tolerance = 3): number {
  if (g - Math.max(r, b) <= tolerance) return 1;
  const t = Math.max(0, Math.min(1, (screenStrength(r, g, b, key) - KEY_FOREGROUND) / (KEY_BACKGROUND - KEY_FOREGROUND)));
  return 1 - t * t * (3 - 2 * t);
}

/** Independent, mostly uniform green patches must agree. A covered corner must not drag the key towards clothing.
 *  Returns undefined on low confidence: callers keep the previous key, rather than guessing from the whole frame. */
export function estimateBackground(patches: ArrayLike<number>[]): KeyColor | undefined {
  const candidates: KeyColor[] = [];
  for (const pixels of patches) {
    const colors: KeyColor[] = [];
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
      if (pixels[i + 3] > 200 && g - Math.max(r, b) > 40 && (g - Math.max(r, b)) / Math.max(1, g) > 0.3) colors.push([r, g, b]);
    }
    if (colors.length < pixels.length / 4 * 0.75) continue;
    const mean = [0, 1, 2].map(ch => colors.reduce((sum, c) => sum + c[ch], 0) / colors.length) as KeyColor;
    if (colors.some(c => c.some((v, ch) => Math.abs(v - mean[ch]) > 25))) continue;
    candidates.push(mean);
  }
  const distance = (a: KeyColor, b: KeyColor) => Math.max(...a.map((v, ch) => Math.abs(v - b[ch])));
  const clusters = candidates.map(c => candidates.filter(other => distance(c, other) <= 25)).sort((a, b) => b.length - a.length);
  const best = clusters[0];
  if (!best || best.length < 2) return;
  // Equal, incompatible groups (e.g. two corners covered by green clothing) are ambiguous.
  if (clusters.some(c => c.length === best.length && distance(c[0], best[0]) > 25)) return;
  return [0, 1, 2].map(ch => Math.round(best.reduce((sum, c) => sum + c[ch], 0) / best.length)) as KeyColor;
}
