// Q 版 art for a character (task 09): seedream-5.0-pro draws the chibi picture on #00FF00 using the portrait as the
// image reference, then the main process keys the green out with nativeImage (no ffmpeg / sharp), crops to content,
// pads to a square and writes a PNG. Extracted from scripts/gen-icons.mjs (same chroma key / crop / resize pipeline).
// `generateArt` needs Electron (nativeImage); the pixel helpers below are pure and unit-tested.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { nativeImage } from 'electron';
import { PORTRAIT_MODEL } from './generate';

export const ART_SIZE = '1024x1024';
/** Output side in px (shown at ≤ 96 px in the UI; 2x for retina, 256 leaves room for the dock tag / status avatar). */
export const ART_OUTPUT_PX = 256;

export interface RGBA { width: number; height: number; data: Uint8ClampedArray }

export interface GenerateArtOptions {
  /** data:image/...;base64 of the portrait → seedream image-to-image. */
  referenceDataUri: string;
  prompt: string;
  /** seedream size string, default 1024x1024. */
  size?: string;
  /** Absolute PNG path to write. */
  out: string;
  apiKey: string;
  baseUrl: string;
  /** Output side in px (square), default ART_OUTPUT_PX. */
  outputPx?: number;
  /** Transparent margin around the content as a fraction of the side (default 0.06). */
  margin?: number;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}
export interface ArtResult { out: string; bytes: number; raw: { width: number; height: number; bytes: number }; usage?: unknown; seconds: number }

/** Ask seedream for one image (b64). Shared shape with generate.ts, but generic in prompt / size / reference. */
export async function requestImage(o: { prompt: string; size: string; image?: string; apiKey: string; baseUrl: string; fetcher?: typeof fetch; timeoutMs?: number }): Promise<{ image: Buffer; usage?: unknown }> {
  if (!o.apiKey) throw new Error('未配置 TokenDance API Key');
  const body = { model: PORTRAIT_MODEL, prompt: o.prompt, size: o.size, response_format: 'b64_json', watermark: false, ...(o.image ? { image: o.image } : {}) };
  let res: Response;
  try {
    res = await (o.fetcher ?? fetch)(`${o.baseUrl.replace(/\/$/, '')}/ark/v3/images/generations`, {
      method: 'POST', headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(o.timeoutMs ?? 180_000),
    });
  } catch (e) { throw new Error(`生图请求失败：${(e as Error).message}`); }
  const text = await res.text();
  if (!res.ok) throw new Error(`TokenDance 生图 HTTP ${res.status}：${text.slice(0, 300)}`);
  let json: any; try { json = JSON.parse(text); } catch { throw new Error('生图响应不是 JSON'); }
  const b64: unknown = json?.data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || !b64) throw new Error(`生图响应里没有图片：${text.slice(0, 300)}`);
  return { image: Buffer.from(b64, 'base64'), usage: json.usage };
}

/** Decode to straight (non-premultiplied) RGBA; sources are opaque so a BGRA→RGBA swizzle is enough. */
export function decodeImage(buf: Buffer): RGBA {
  const img = nativeImage.createFromBuffer(buf);
  const { width, height } = img.getSize();
  if (!width || !height) throw new Error('无法解码生成的图片');
  const bgra = img.toBitmap();
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < bgra.length; i += 4) { data[i] = bgra[i + 2]; data[i + 1] = bgra[i + 1]; data[i + 2] = bgra[i]; data[i + 3] = 255; }
  return { width, height, data };
}

/** Straight RGBA → premultiplied BGRA nativeImage, resized to a `size` px square PNG. */
export function encodePng({ width, height, data }: RGBA, size?: number): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    out[i] = (data[i + 2] * a + 127) / 255; out[i + 1] = (data[i + 1] * a + 127) / 255; out[i + 2] = (data[i] * a + 127) / 255; out[i + 3] = a;
  }
  const img = nativeImage.createFromBitmap(out, { width, height });
  return (size ? img.resize({ width: size, height: size, quality: 'best' }) : img).toPNG();
}

/** Chroma key: pixels whose green clearly dominates red/blue become transparent (soft ramp between `lo` and `hi`),
 *  green spill near the edge is clamped, and a 1 px alpha erosion removes the blended fringe. Mutates and returns img. */
export function chromaKey(img: RGBA, { lo = 35, hi = 90 } = {}): RGBA {
  const { width, height, data } = img;
  const n = width * height;
  const alpha = new Uint8ClampedArray(n);
  for (let p = 0; p < n; p++) {
    const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
    const greenness = g - Math.max(r, b);
    alpha[p] = greenness >= hi ? 0 : greenness <= lo ? 255 : Math.round(255 * (1 - (greenness - lo) / (hi - lo)));
  }
  const edge = new Uint8Array(n);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (alpha[y * width + x] === 255) continue;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < height && xx >= 0 && xx < width) edge[yy * width + xx] = 1;
    }
  }
  for (let p = 0; p < n; p++) {
    if (!edge[p]) continue;
    const i = p * 4, m = Math.max(data[i], data[i + 2]);
    if (data[i + 1] > m) data[i + 1] = m;
  }
  const eroded = new Uint8ClampedArray(n);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let m = 255;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = Math.min(height - 1, Math.max(0, y + dy)), xx = Math.min(width - 1, Math.max(0, x + dx));
      m = Math.min(m, alpha[yy * width + xx]);
    }
    eroded[y * width + x] = Math.round((alpha[y * width + x] + m) / 2);
  }
  for (let p = 0; p < n; p++) data[p * 4 + 3] = eroded[p];
  return img;
}

export function crop(img: RGBA, x0: number, y0: number, w: number, h: number): RGBA {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = y0 + y;
    if (sy < 0 || sy >= img.height) continue;
    for (let x = 0; x < w; x++) {
      const sx = x0 + x;
      if (sx < 0 || sx >= img.width) continue;
      const si = (sy * img.width + sx) * 4, di = (y * w + x) * 4;
      out[di] = img.data[si]; out[di + 1] = img.data[si + 1]; out[di + 2] = img.data[si + 2]; out[di + 3] = img.data[si + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/** Bounding box of alpha > thr; null when the image is fully transparent. */
export function bbox(img: RGBA, thr = 24): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (img.data[(y * img.width + x) * 4 + 3] > thr) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Crop to content and pad to a square with `margin` (fraction of the side) of transparent space on every side. */
export function squareCrop(img: RGBA, margin = 0.06): RGBA {
  const b = bbox(img);
  if (!b) throw new Error('抠像后画面是空的（背景可能不是纯绿）');
  const side = Math.round(Math.max(b.w, b.h) * (1 + margin * 2));
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return crop(img, Math.round(cx - side / 2), Math.round(cy - side / 2), side, side);
}

/** Share of pixels that look like the key colour — a sanity check that the model honoured the green background. */
export function greenShare(img: RGBA, thr = 90): number {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 1] - Math.max(img.data[i], img.data[i + 2]) >= thr) n++;
  return n / (img.width * img.height);
}

/** seedream → chroma key → crop → square PNG at `out`. */
export async function generateArt(o: GenerateArtOptions): Promise<ArtResult> {
  const t0 = Date.now();
  const { image, usage } = await requestImage({ prompt: o.prompt, size: o.size ?? ART_SIZE, image: o.referenceDataUri, apiKey: o.apiKey, baseUrl: o.baseUrl, fetcher: o.fetcher, timeoutMs: o.timeoutMs });
  const raw = decodeImage(image);
  if (greenShare(raw) < 0.2) throw new Error('生成结果的背景不是绿幕，无法抠像');
  const keyed = squareCrop(chromaKey(raw), o.margin);
  const png = encodePng(keyed, o.outputPx ?? ART_OUTPUT_PX);
  mkdirSync(dirname(o.out), { recursive: true });
  writeFileSync(o.out, png);
  return { out: o.out, bytes: png.length, raw: { width: raw.width, height: raw.height, bytes: image.length }, usage, seconds: Math.round((Date.now() - t0) / 1000) };
}
