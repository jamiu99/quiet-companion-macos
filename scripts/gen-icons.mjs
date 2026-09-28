// Generate the UI illustration set (app icon, tray silhouette, empty/placeholder heroes, quick-task chip icons) with
// TokenDance seedream-5.0-pro, key out the #00FF00 background with Electron's nativeImage (no ffmpeg / sharp needed),
// resize and write PNGs. Every API call (≈0.3 元 / image) is logged to docs/ASSETS.md「界面插画」.
//
// Usage (must run under Electron for nativeImage):
//   node_modules/.bin/electron scripts/gen-icons.mjs                 # all assets, skip ones whose outputs exist
//   node_modules/.bin/electron scripts/gen-icons.mjs hero-empty tasks-a
//   Flags: --force      re-process even if outputs exist (re-uses the cached raw image in .cache/gen-icons/ if present)
//          --regen      also ignore the cached raw image → new API call (costs money)
//          --dry-run    print prompts only
//          --list       list asset names
// Key: TOKENDANCE_API_KEY env var, else the TOKENDANCE_API_KEY= line in project-root .env.
import { app, nativeImage } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const RAW_DIR = join(root, '.cache', 'gen-icons');
const LOG = join(root, 'docs', 'ASSETS.md');
const ENDPOINT = 'https://tokendance.space/gateway/ark/v3/images/generations';
const MODEL = 'seedream-5.0-pro';
const SIZE = '1024x1024';
const COST_PER_IMAGE = 0.3; // 元, estimate (火山方舟 Seedream 5.0 pro 公开价)

// ---- style ---------------------------------------------------------------------------------------------------------
const STYLE = '亮色清新的圆润扁平插画风格，配色只用柔和的奶油色、淡蓝色、淡粉色和少量米黄，所有轮廓是粗细完全一致的深灰色（#4A4A55）圆润描边，不要黑色硬边，不要文字和字母，不要投影，不要纹理，形状简洁圆润，画面干净。';
const GREEN = '纯色正绿色（#00FF00）背景，完全平铺无渐变无阴影无纹理，主体不含任何绿色，也不要与背景相近的颜色。';
const XIAOQI = 'Q版可爱小女孩「小栖」：齐肩浅棕色短发、棕色大眼睛、圆脸、微笑，穿奶白色针织开衫和白色内搭';

/** name → { prompt, mode: 'chroma' | 'luma' | 'grid', outputs } */
export const ASSETS = {
  'app-icon': {
    mode: 'chroma',
    prompt: `macOS 应用图标：一个大的圆角正方形底板占画面约 82%，居中，底板是从淡奶油色到淡蓝色的柔和渐变，四边有一致的深灰细描边。底板正中是${XIAOQI}的半身像，头部右上方有一个淡粉色的小对话气泡，气泡里有一颗四角小闪光。圆角方形以外的区域全部是背景色。${STYLE}${GREEN}`,
    outputs: [{ file: 'build/icon.png', size: 1024 }, { file: 'assets/ui/app-icon.png', size: 512 }],
  },
  tray: {
    mode: 'luma',
    prompt: '极简纯黑剪影图标，纯白背景：一个小女孩头像的剪影（齐肩短发、圆脸、只有外轮廓，实心填充），右上方有一个小对话气泡剪影，气泡内部留一颗白色四角小星星。整张图只有纯黑色和纯白色两种颜色，没有灰色，没有描边，没有渐变，没有文字。主体居中，占画面约 70%，形状简洁圆润、粗壮，适合缩小到 16 像素的系统托盘图标。',
    outputs: [{ file: 'assets/trayTemplate.png', size: 16 }, { file: 'assets/trayTemplate@2x.png', size: 32 }],
  },
  'hero-empty': {
    mode: 'chroma',
    prompt: `${XIAOQI}，半身像，正面朝观众，一只手举起挥手打招呼，表情开心，头旁飘着两颗淡粉色四角小闪光。单一主体居中，四周留白充足。${STYLE}${GREEN}`,
    outputs: [{ file: 'assets/ui/hero-empty.png', size: 256 }],
  },
  'hero-placeholder': {
    mode: 'chroma',
    prompt: `一个柔和的人形半身剪影（头和肩膀），从淡蓝色到淡紫粉色的柔和渐变填充，没有五官，轮廓是一致的深灰色圆润描边，剪影周围点缀三颗大小不同的淡黄色四角闪光星星，表示"形象正在被创造"。单一主体居中，四周留白充足。${STYLE}${GREEN}`,
    outputs: [{ file: 'assets/ui/hero-placeholder.png', size: 256 }],
  },
  'hero-connecting': {
    mode: 'chroma',
    prompt: `${XIAOQI}，半身像，闭着眼睛安静地打盹，头微微歪向一侧，脸颊有淡粉色，头顶上方飘着三个由小到大的淡蓝色圆点（表示正在加载）。单一主体居中，四周留白充足。${STYLE}${GREEN}`,
    outputs: [{ file: 'assets/ui/hero-connecting.png', size: 256 }],
  },
  // Task 09: 小栖's Q 版 bust for the dock tag / status avatar = the app icon's centre (no API call). Other characters get
  // theirs from electron/characters/art.ts (same key/crop pipeline as this script, run inside the main process).
  'bust-xiaoqi': {
    mode: 'crop',
    from: 'assets/ui/app-icon.png',
    // Fractions of the source: head + shoulders, most of the speech bubble, inside the rounded square.
    rect: { x: 0.19, y: 0.19, w: 0.64, h: 0.64 },
    outputs: [{ file: 'assets/ui/bust-xiaoqi.png', size: 256 }],
  },
  // Quick-task chip icons: 2×2 sheets → 4 files each (cheaper than 8 calls, and the four icons share one style pass).
  'tasks-a': {
    mode: 'grid',
    prompt: `一张 2 行 2 列的图标集，四个图标大小完全一致，各自居中放在四个等分的格子里，图标之间和画面边缘留有很宽的空隙，互不接触，不要画格线、边框或底板。左上：一张淡黄色便签纸和一支斜放的铅笔；右上：一朵奶白色云朵和一个从云后露出的淡橙色太阳；左下：一个淡蓝色文件夹，里面探出一张带风景的小图片；右下：一个浅色浏览器窗口（顶部有三个小圆点），前面叠着一个放大镜。${STYLE}${GREEN}`,
    cells: [
      { id: 'notes-todo', file: 'assets/ui/task-notes-todo.png', size: 128 },
      { id: 'weather-notify', file: 'assets/ui/task-weather-notify.png', size: 128 },
      { id: 'tidy-screenshots', file: 'assets/ui/task-tidy-screenshots.png', size: 128 },
      { id: 'web-headlines', file: 'assets/ui/task-web-headlines.png', size: 128 },
    ],
  },
  'tasks-b': {
    mode: 'grid',
    prompt: `一张 2 行 2 列的图标集，四个图标大小完全一致，各自居中放在四个等分的格子里，图标之间和画面边缘留有很宽的空隙，互不接触，不要画格线、边框或底板。左上：一个带夹子的剪贴板，夹着一张有几条横线的纸；右上：一台电脑显示器，屏幕上画着一只睁开的眼睛；左下：三根高低不同的淡蓝色和淡粉色柱状图柱子，底下一条横线；右下：一台打开的笔记本电脑，屏幕上有一条淡粉色心跳折线。${STYLE}${GREEN}`,
    cells: [
      { id: 'clipboard-md', file: 'assets/ui/task-clipboard-md.png', size: 128 },
      { id: 'screen-describe', file: 'assets/ui/task-screen-describe.png', size: 128 },
      { id: 'csv-report', file: 'assets/ui/task-csv-report.png', size: 128 },
      { id: 'sysinfo-notify', file: 'assets/ui/task-sysinfo-notify.png', size: 128 },
    ],
  },
};

// ---- cli -----------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const names = argv.filter(a => !a.startsWith('--'));
const FORCE = flags.has('--force') || flags.has('--regen');
const REGEN = flags.has('--regen');
const DRY = flags.has('--dry-run');

function apiKey() {
  if (process.env.TOKENDANCE_API_KEY) return process.env.TOKENDANCE_API_KEY.trim();
  const env = join(root, '.env');
  if (existsSync(env)) {
    const m = readFileSync(env, 'utf8').match(/^TOKENDANCE_API_KEY=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('TOKENDANCE_API_KEY not set (env or .env)');
}

function outputsOf(a) { return a.outputs ?? a.cells; }

// ---- api -----------------------------------------------------------------------------------------------------------
async function generate(name, prompt) {
  const started = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt, size: SIZE, response_format: 'b64_json', watermark: false }),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const b64 = json?.data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || !b64) throw new Error(`no image in response: ${text.slice(0, 300)}`);
  const buf = Buffer.from(b64, 'base64');
  const elapsed = Math.round((Date.now() - started) / 1000);
  const usage = json.usage?.total_tokens ?? json.usage?.output_tokens ?? '?';
  appendLog(`- ${localStamp()} · \`${name}\` · ${MODEL} ${SIZE} · ${usage} tokens · ${elapsed} s · ≈${COST_PER_IMAGE} 元`);
  return buf;
}

function localStamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function appendLog(line) {
  const marker = '<!-- gen-icons log -->';
  let md = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
  if (!md.includes(marker)) {
    md = md.replace(/\s*$/, '\n') + `\n## 界面插画（\`scripts/gen-icons.mjs\`）\n\n` +
      `App 图标、托盘剪影、空状态 / 占位 / 连接中插画和快捷任务 chip 图标由 \`seedream-5.0-pro\`（\`POST /gateway/ark/v3/images/generations\`，1024x1024，b64_json）生成，` +
      `在 #00FF00 背景上出图后由脚本用 Electron \`nativeImage\` 抠绿（绿溢色抑制 + 边缘 1 px 收缩）、缩放、写入 \`assets/ui/\`、\`build/icon.png\`、\`assets/trayTemplate*.png\`。` +
      `托盘图标不抠绿：生成黑白剪影后按亮度转 alpha。快捷任务图标 4 个一张 2×2 图集再切分。原图缓存在 \`.cache/gen-icons/\`（不入库）。\n\n### 生成记录（每张 ≈0.3 元，新的在上）\n\n${marker}\n`;
  }
  md = md.replace(marker, `${marker}\n${line}`);
  writeFileSync(LOG, md);
}

// ---- pixels --------------------------------------------------------------------------------------------------------
/** Decode to straight (non-premultiplied) RGBA; sources are opaque so BGRA→RGBA swizzle is enough. */
function decode(buf) {
  const img = nativeImage.createFromBuffer(buf);
  const { width, height } = img.getSize();
  if (!width || !height) throw new Error('could not decode image');
  const bgra = img.toBitmap();
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < bgra.length; i += 4) { rgba[i] = bgra[i + 2]; rgba[i + 1] = bgra[i + 1]; rgba[i + 2] = bgra[i]; rgba[i + 3] = 255; }
  return { width, height, data: rgba };
}

/** Straight RGBA → premultiplied BGRA nativeImage. */
function toImage({ width, height, data }) {
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    out[i] = (data[i + 2] * a + 127) / 255; out[i + 1] = (data[i + 1] * a + 127) / 255; out[i + 2] = (data[i] * a + 127) / 255; out[i + 3] = a;
  }
  return nativeImage.createFromBitmap(out, { width, height });
}

/** Chroma key: pixels whose green clearly dominates red/blue become transparent, with a soft ramp, spill suppression
 *  near the edge and a 1 px alpha erosion so the fringe (JPEG artefacts + AA blend with green) does not survive. */
function chromaKey(img, { lo = 35, hi = 90 } = {}) {
  const { width, height, data } = img;
  const n = width * height;
  const alpha = new Uint8ClampedArray(n);
  for (let p = 0; p < n; p++) {
    const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
    const greenness = g - Math.max(r, b);
    alpha[p] = greenness >= hi ? 0 : greenness <= lo ? 255 : Math.round(255 * (1 - (greenness - lo) / (hi - lo)));
  }
  // Edge zone = any pixel within 3 px of a non-opaque pixel → clamp G to max(R,B) (kills the green cast).
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
  // 1 px erosion (min over 3×3) so the outermost blended ring goes away.
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

/** Black-on-white silhouette → black with alpha (for a macOS template image). */
function lumaKey(img) {
  const { data } = img;
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const a = l > 215 ? 0 : l < 60 ? 255 : Math.round(255 * (215 - l) / 155);
    data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = a;
  }
  return img;
}

function crop(img, x0, y0, w, h) {
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

/** Bounding box of alpha > thr inside [x0,y0,w,h]; null if empty. */
function bbox(img, x0, y0, w, h, thr = 24) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    if (img.data[(y * img.width + x) * 4 + 3] > thr) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Crop a region to its content, pad to a square with `margin` (fraction of the side) of transparent space. */
function squareCrop(img, region, margin = 0.08) {
  const b = bbox(img, region.x, region.y, region.w, region.h);
  if (!b) throw new Error('region is empty after keying');
  const side = Math.round(Math.max(b.w, b.h) * (1 + margin * 2));
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return { img: crop(img, Math.round(cx - side / 2), Math.round(cy - side / 2), side, side), bbox: b };
}

function writePng(img, file, size) {
  const native = toImage(img).resize({ width: size, height: size, quality: 'best' });
  const abs = join(root, file);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, native.toPNG());
  console.log('  wrote', file, `${size}x${size}`);
}

function cornerReport(img) {
  const at = (x, y) => { const i = (y * img.width + x) * 4; return `${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`; };
  return [at(2, 2), at(img.width - 3, 2), at(2, img.height - 3), at(img.width - 3, img.height - 3)].join(' | ');
}

// ---- main ----------------------------------------------------------------------------------------------------------
async function processAsset(name, a) {
  const outs = outputsOf(a);
  if (!FORCE && outs.every(o => existsSync(join(root, o.file)))) { console.log(`[${name}] exists, skip (--force to redo)`); return; }
  if (DRY) { console.log(`[${name}] (${a.mode})\n${a.prompt ?? `crop ${a.from}`}\n`); return; }
  if (a.mode === 'crop') {
    // Derived asset: cut a region out of an existing (already keyed) PNG; alpha is taken from the source.
    const src = nativeImage.createFromPath(join(root, a.from));
    const { width, height } = src.getSize();
    const bgra = src.toBitmap();
    const img = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    for (let i = 0; i < bgra.length; i += 4) { const al = bgra[i + 3] || 1; img.data[i] = Math.min(255, bgra[i + 2] * 255 / al); img.data[i + 1] = Math.min(255, bgra[i + 1] * 255 / al); img.data[i + 2] = Math.min(255, bgra[i] * 255 / al); img.data[i + 3] = bgra[i + 3]; }
    const r = a.rect;
    const side = Math.round(Math.max(r.w * width, r.h * height));
    const out = crop(img, Math.round(r.x * width), Math.round(r.y * height), side, side);
    for (const o of a.outputs) writePng(out, o.file, o.size);
    return;
  }
  mkdirSync(RAW_DIR, { recursive: true });
  const rawFile = join(RAW_DIR, `${name}.raw`);
  let raw;
  if (!REGEN && existsSync(rawFile)) { raw = readFileSync(rawFile); console.log(`[${name}] using cached raw ${rawFile}`); }
  else {
    console.log(`[${name}] generating…`);
    raw = await generate(name, a.prompt);
    writeFileSync(rawFile, raw);
    // Also keep a viewable copy for inspection.
    writeFileSync(join(RAW_DIR, `${name}.raw.png`), nativeImage.createFromBuffer(raw).toPNG());
  }
  const img = decode(raw);
  console.log(`  raw ${img.width}x${img.height}, corners rgb: ${cornerReport(img)}`);

  if (a.mode === 'luma') {
    lumaKey(img);
    const { img: sq } = squareCrop(img, { x: 0, y: 0, w: img.width, h: img.height }, 0.04);
    for (const o of a.outputs) writePng(sq, o.file, o.size);
    return;
  }
  chromaKey(img);
  writeFileSync(join(RAW_DIR, `${name}.keyed.png`), toImage(img).toPNG());
  if (a.mode === 'chroma') {
    // Keep the whole canvas for the app icon (the rounded square must stay centred); crop heroes to content.
    const src = name === 'app-icon' ? img : squareCrop(img, { x: 0, y: 0, w: img.width, h: img.height }, 0.06).img;
    for (const o of a.outputs) writePng(src, o.file, o.size);
    return;
  }
  if (a.mode === 'grid') {
    const hw = img.width / 2, hh = img.height / 2;
    const regions = [{ x: 0, y: 0 }, { x: hw, y: 0 }, { x: 0, y: hh }, { x: hw, y: hh }];
    a.cells.forEach((cell, i) => {
      const { img: sq, bbox: b } = squareCrop(img, { ...regions[i], w: hw, h: hh }, 0.08);
      const touches = b.x <= regions[i].x + 2 || b.y <= regions[i].y + 2 || b.x + b.w >= regions[i].x + hw - 2 || b.y + b.h >= regions[i].y + hh - 2;
      console.log(`  cell ${cell.id}: bbox ${b.w}x${b.h}${touches ? '  ⚠ touches the cell border (icons may have merged)' : ''}`);
      writePng(sq, cell.file, cell.size);
    });
  }
}

async function main() {
  if (flags.has('--list')) { console.log(Object.keys(ASSETS).join('\n')); return; }
  const todo = names.length ? names : Object.keys(ASSETS);
  for (const name of todo) {
    const a = ASSETS[name];
    if (!a) { console.error(`unknown asset "${name}" (see --list)`); process.exitCode = 2; continue; }
    try { await processAsset(name, a); } catch (e) { console.error(`[${name}] FAILED: ${e.message}`); process.exitCode = 1; }
  }
}

app.dock?.hide();
app.whenReady().then(main).catch(e => { console.error(e); process.exitCode = 1; }).finally(() => app.exit(process.exitCode ?? 0));
