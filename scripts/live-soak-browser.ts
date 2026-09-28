// Injected only by the explicit paid harness. Samples the production RTC <video>, never desktop pixels or audio.
import { createGreenKey } from '../renderer/companion/greenKey';
import { createGreenKey as createLegacyKey } from 'legacy-green-key';
import { measureForeground } from '../renderer/companion/framingGuard';

const raw = document.createElement('canvas'), current = document.createElement('canvas'), legacy = document.createElement('canvas');
const readback = document.createElement('canvas'), matte = document.createElement('canvas');
const image = new Image(), errors: string[] = []; // Retained callbacks must report errors on later samples too.
let key: ReturnType<typeof createGreenKey> | undefined, old: ReturnType<typeof createLegacyKey> | undefined;
const pixels = (c: HTMLCanvasElement) => {
  readback.width = c.width; readback.height = c.height;
  const ctx = readback.getContext('2d', { willReadFrequently: true })!; ctx.drawImage(c, 0, 0); return ctx.getImageData(0, 0, c.width, c.height).data;
};
export async function sample() {
  const started = performance.now(), v = document.querySelector<HTMLVideoElement>('.stage-body > video');
  if (!v || v.readyState < 2 || v.videoWidth < 64 || v.videoHeight < 64) return { skipped: true, ready: v?.readyState, size: v && [v.videoWidth, v.videoHeight] };
  const ratio = Math.min(1, 672 / v.videoHeight);
  raw.width = Math.round(v.videoWidth * ratio); raw.height = Math.round(v.videoHeight * ratio);
  const ctx = raw.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(v, 0, 0, raw.width, raw.height);
  const rawPng = raw.toDataURL('image/png');
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('snapshot decode failed')); image.src = rawPng; });
  key ??= createGreenKey(image, current, { key: [0, 255, 0], onError: e => errors.push(e.message) });
  old ??= createLegacyKey(image, legacy, { key: [0, 255, 0], onError: e => errors.push(e.message) });
  key.update({}); old.update({});
  const a = pixels(current), b = pixels(legacy);
  let newAlpha = 0, oldAlpha = 0, restored = 0;
  for (let i = 3; i < a.length; i += 4) { newAlpha += a[i] / 255; oldAlpha += b[i] / 255; if (a[i] >= 240 && b[i] < 32) restored++; }
  const count = a.length / 4;
  matte.width = current.width; matte.height = current.height;
  const mctx = matte.getContext('2d')!, mask = mctx.createImageData(matte.width, matte.height);
  for (let i = 0; i < a.length; i += 4) { mask.data[i] = mask.data[i + 1] = mask.data[i + 2] = a[i + 3]; mask.data[i + 3] = 255; }
  mctx.putImageData(mask, 0, 0);
  const figure = document.querySelector('.stage-figure')?.getBoundingClientRect();
  return {
    skipped: false, videoTime: v.currentTime, source: [v.videoWidth, v.videoHeight], decoded: v.getVideoPlaybackQuality().totalVideoFrames,
    key: key.key.map(Math.round), geometry: measureForeground(ctx.getImageData(0, 0, raw.width, raw.height).data, raw.width, raw.height, key.key),
    meanAlpha: newAlpha / count, legacyMeanAlpha: oldAlpha / count, restoredFraction: restored / count,
    fallback: Boolean(document.querySelector('.stage-media-notice')),
    figure: figure && { width: figure.width, height: figure.height, left: figure.left, top: figure.top },
    images: { raw: rawPng, keyed: current.toDataURL(), legacy: legacy.toDataURL(), alpha: matte.toDataURL() },
    sampleCostMs: Math.round(performance.now() - started), errors,
  };
}
export function stop() { key?.stop(); old?.stop(); }
