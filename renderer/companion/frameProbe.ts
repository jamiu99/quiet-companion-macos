import { estimateBackground, type KeyColor } from './keyColor';
import { foregroundProtection } from './foregroundMatte';
import { measureForeground } from './framingGuard';

/** Shared CPU probe for the real shader and reference-portrait calibration; no full-size GPU readback. */
export function createFrameProbe() {
  const sample = document.createElement('canvas'); sample.width = 4; sample.height = 4;
  const sampler = sample.getContext('2d', { willReadFrequently: true });
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
  return {
    background(source: CanvasImageSource, width: number, height: number): KeyColor | undefined {
      if (!sampler) throw new Error('FRAME_PROBE_UNAVAILABLE');
      const pw = Math.max(4, Math.round(width * 0.06)), ph = Math.max(4, Math.round(height * 0.04)), inset = 4;
      const patches = [];
      for (const [x, y] of [[inset, inset], [width - pw - inset, inset], [inset, Math.round(height * 0.45)], [width - pw - inset, Math.round(height * 0.45)]]) {
        sampler.clearRect(0, 0, 4, 4); sampler.drawImage(source, x, y, pw, ph, 0, 0, 4, 4);
        patches.push(sampler.getImageData(0, 0, 4, 4).data);
      }
      return estimateBackground(patches);
    },
    measure(source: CanvasImageSource, width: number, height: number, key: KeyColor, tolerance = 3, edge = 3) {
      if (!ctx) throw new Error('FRAME_PROBE_UNAVAILABLE');
      const factor = Math.min(1, 160 / Math.max(width, height));
      const w = Math.max(1, Math.round(width * factor)), h = Math.max(1, Math.round(height * factor));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      const e = Math.max(0, Math.min(edge, (width - 1) / 2, (height - 1) / 2));
      ctx.clearRect(0, 0, w, h); ctx.drawImage(source, e, e, width - 2 * e, height - 2 * e, 0, 0, w, h);
      const pixels = ctx.getImageData(0, 0, w, h).data;
      const protection = foregroundProtection(pixels, w, h, key, tolerance);
      return { width: w, height: h, protection, geometry: measureForeground(pixels, w, h, key, tolerance, protection) };
    },
  };
}
