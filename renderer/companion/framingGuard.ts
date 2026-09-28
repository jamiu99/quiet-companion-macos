import { interiorAlpha, type KeyColor } from './keyColor';
import { foregroundProtection } from './foregroundMatte';

export interface ForegroundGeometry {
  /** Fraction of the encoded frame, independent of CSS size / resolution. */
  area: number;
  width: number;
  height: number;
  /** Mean matte opacity in the upper central body, not the normal gap between legs. */
  centerCoverage?: number;
}

/** Small CPU thumbnail only; never read the full-size WebGL framebuffer on the production path.
 *  Trim 1% of foreground mass from each axis so isolated codec speckles do not control the bounds. */
export function measureForeground(pixels: ArrayLike<number>, width: number, height: number, key: KeyColor, tolerance = 3, protection = foregroundProtection(pixels, width, height, key, tolerance)): ForegroundGeometry {
  const cols = new Uint32Array(width), rows = new Uint32Array(height), alpha = new Float32Array(width * height);
  let count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const p = y * width + x;
    alpha[p] = pixels[i + 3] / 255 * (protection[p] ? 1 : interiorAlpha(pixels[i], pixels[i + 1], pixels[i + 2], key, tolerance));
    if (alpha[p] < 0.5) continue;
    count++; cols[x]++; rows[y]++;
  }
  const span = (bins: Uint32Array) => {
    if (!count) return [0, 0] as const;
    const trim = count * 0.01;
    let l = 0, r = bins.length - 1, sum = 0;
    while (l < r && sum + bins[l] <= trim) sum += bins[l++];
    sum = 0;
    while (r > l && sum + bins[r] <= trim) sum += bins[r--];
    return [l, r + 1] as const;
  };
  const [left, right] = span(cols), [top, bottom] = span(rows);
  // Median foreground mass, not bbox midpoint: a waving hand must not shift the torso probe into empty space.
  let center = left, mass = 0;
  while (center < right - 1 && mass + cols[center] < count / 2) mass += cols[center++];
  const half = Math.max(1, Math.round((right - left) * 0.1));
  const y0 = Math.floor(top + (bottom - top) * 0.28), y1 = Math.ceil(top + (bottom - top) * 0.62);
  let sum = 0, samples = 0;
  for (let y = y0; y < y1; y++) for (let x = Math.max(0, center - half); x <= Math.min(width - 1, center + half); x++) { sum += alpha[y * width + x]; samples++; }
  return { area: count / (width * height), width: (right - left) / width, height: (bottom - top) / height, centerCoverage: samples ? sum / samples : 0 };
}

export interface FramingDecision {
  accept: boolean;
  fallback: boolean;
  reason: 'ok' | 'zoom' | 'empty' | 'flood' | 'matte-hole' | 'recovering';
  areaRatio: number;
}
export const FRAMING_HOLD_MS = 350;
export const FRAMING_RECOVER_MS = 400;

/** Presentation safety, NOT a person detector / digital zoom. Prefer the portrait, otherwise the first plausible live frame.
 *  A bad frame never becomes the new baseline. Brief glitches hold the last good frame; persistent ones show idle.
 *  Normal gestures (wider arms without a large area increase) are deliberately allowed. */
export class FramingGuard {
  private baseline?: ForegroundGeometry;
  private reference?: ForegroundGeometry;
  private badSince?: number;
  private goodSince?: number;
  private fallback = false;

  reset() { this.baseline = undefined; this.badSince = undefined; this.goodSince = undefined; this.fallback = false; }

  /** A trusted portrait catches a first live frame that is already a close-up. Reset a session, not this reference. */
  setReference(geometry?: ForegroundGeometry) {
    this.reference = geometry && Number.isFinite(geometry.area + geometry.width + geometry.height) && geometry.area >= 0.01 && geometry.area < 0.9 && geometry.height >= 0.1 ? { ...geometry } : undefined;
    this.reset();
  }

  inspect(geometry: ForegroundGeometry, now: number): FramingDecision {
    const base = this.reference ?? this.baseline;
    const areaRatio = base ? geometry.area / base.area : 1;
    let reason: FramingDecision['reason'] = 'ok';
    if (!Number.isFinite(geometry.area + geometry.width + geometry.height) || geometry.area < 0.01 || geometry.height < 0.1 || (base && areaRatio < 0.35)) reason = 'empty';
    else if (geometry.area > 0.9) reason = 'flood';
    else if ((base?.centerCoverage ?? 0) >= 0.75 && geometry.centerCoverage !== undefined && geometry.centerCoverage < 0.42) reason = 'matte-hole';
    else if (base && areaRatio > 1.7 && (geometry.width > base.width * 1.25 || geometry.height > base.height * 1.2)) reason = 'zoom';

    if (reason !== 'ok') {
      this.goodSince = undefined;
      this.badSince ??= now;
      if (!this.baseline || now - this.badSince >= FRAMING_HOLD_MS) this.fallback = true;
      return { accept: false, fallback: this.fallback, reason, areaRatio };
    }
    if (this.fallback) {
      this.goodSince ??= now;
      if (now - this.goodSince < FRAMING_RECOVER_MS) return { accept: false, fallback: true, reason: 'recovering', areaRatio };
    }
    this.baseline ??= { ...geometry };
    this.badSince = undefined; this.goodSince = undefined; this.fallback = false;
    return { accept: true, fallback: false, reason: 'ok', areaRatio };
  }
}
