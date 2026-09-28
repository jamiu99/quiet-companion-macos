// Generate the idle (standby) loop video for the companion from the green-screen portrait via TokenDance.
// Protocol: Seedance Generations (async: submit → poll → download). No npm deps; Node 20+.
//
// Usage:
//   node scripts/gen-idle-video.mjs                          # defaults: seedance-2.0-fast, 720p, 6s, first+last frame = portrait
//   node scripts/gen-idle-video.mjs --model seedance-2.0 --duration 8 --out assets/characters/xiaoqi-idle.mp4
//   node scripts/gen-idle-video.mjs --prompt "…" | --prompt-file p.txt
//   node scripts/gen-idle-video.mjs --task <TASK_ID> --out x.mp4   # resume polling / re-download an existing task
//   Flags: --image <png> --resolution 480p|720p|1080p --no-last-frame --audio --dry-run
// Key: TOKENDANCE_API_KEY env var, else TOKENDANCE_API_KEY= line in project-root .env.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = 'https://tokendance.space/gateway/ark/v3/generations/tasks';

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] ?? true) : def; };
const has = name => args.includes(`--${name}`);

export const DEFAULT_PROMPT = [
  '画面中的女孩保持原样安静站立，人物五官、发型、服装和纯绿色背景完全不变。',
  '镜头完全固定，不推不拉不摇。',
  '只有极其轻微的动作：胸口随呼吸微微起伏，自然地眨眼一两次，嘴角保持温柔的微笑并有一点点细微变化，头部有几乎察觉不到的轻微晃动，交握的双手基本不动。',
  '不要走动，不要转身，不要挥手，不要大幅动作，不要出现新的物体，背景始终是均匀的纯绿色，没有阴影变化，没有文字，没有字幕，没有镜头运动。',
  '首尾动作一致，适合无缝循环播放。',
].join('');

function apiKey() {
  if (process.env.TOKENDANCE_API_KEY) return process.env.TOKENDANCE_API_KEY.trim();
  const env = join(root, '.env');
  if (existsSync(env)) {
    const m = readFileSync(env, 'utf8').match(/^TOKENDANCE_API_KEY=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('TOKENDANCE_API_KEY not set (env or .env)');
}

function imageDataUrl(path) {
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extname(path).toLowerCase()];
  if (!mime) throw new Error(`unsupported image: ${path}`);
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
}

async function api(key, url, init = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}: ${text.slice(0, 600)}`);
  return json;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function submit({ key, model, prompt, image, duration, resolution, lastFrame, audio }) {
  const img = imageDataUrl(image);
  const content = [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: img }, role: 'first_frame' },
  ];
  // Same portrait as the last frame so the loop point is seamless (first/last frame is supported by Seedance 2.x).
  if (lastFrame) content.push({ type: 'image_url', image_url: { url: img }, role: 'last_frame' });
  const body = { model, content, resolution, ratio: 'adaptive', duration, generate_audio: audio };
  const r = await api(key, BASE, { method: 'POST', body: JSON.stringify(body) });
  if (!r.id) throw new Error(`no task id in response: ${JSON.stringify(r).slice(0, 600)}`);
  return r.id;
}

export async function poll(key, id, { intervalMs = 10_000, timeoutMs = 20 * 60_000, onStatus } = {}) {
  const start = Date.now();
  for (;;) {
    const r = await api(key, `${BASE}/${id}`).catch(e => ({ status: 'transient', error: String(e.message) }));
    onStatus?.(r);
    if (r.status === 'succeeded') return r;
    if (r.status === 'failed' || r.status === 'cancelled' || r.status === 'expired') throw new Error(`task ${id} ${r.status}: ${JSON.stringify(r.error ?? r).slice(0, 800)}`);
    if (Date.now() - start > timeoutMs) throw new Error(`task ${id} timed out after ${Math.round(timeoutMs / 1000)}s (last status ${r.status})`);
    await sleep(intervalMs);
  }
}

export async function download(url, out) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buf);
  return buf.length;
}

async function main() {
  const key = apiKey();
  const model = flag('model', 'seedance-2.0-fast');
  const duration = Number(flag('duration', 6));
  const resolution = flag('resolution', '720p');
  const image = resolve(root, flag('image', 'assets/characters/xiaoqi-green.png'));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const out = resolve(root, flag('out', `assets/characters/xiaoqi-idle-${stamp}.mp4`));
  const prompt = has('prompt-file') ? readFileSync(resolve(root, flag('prompt-file')), 'utf8').trim() : flag('prompt', DEFAULT_PROMPT);
  const lastFrame = !has('no-last-frame');
  const audio = has('audio');
  let id = flag('task', undefined);
  const t0 = Date.now();

  if (!id) {
    const req = { model, duration, resolution, image, lastFrame, audio, prompt };
    console.log('submit', JSON.stringify({ ...req, image: image.replace(root + '/', ''), prompt: prompt.slice(0, 80) + (prompt.length > 80 ? '…' : '') }));
    if (has('dry-run')) return;
    id = await submit({ key, ...req });
    console.log('task', id);
  } else console.log('resume task', id);

  const done = await poll(key, id, { onStatus: r => console.log(`  ${Math.round((Date.now() - t0) / 1000)}s status=${r.status}${r.error ? ' ' + JSON.stringify(r.error).slice(0, 200) : ''}`) });
  const url = done.content?.video_url;
  if (!url) throw new Error(`succeeded but no content.video_url: ${JSON.stringify(done).slice(0, 800)}`);
  const bytes = await download(url, out);
  const summary = { task: id, model, duration, resolution, lastFrame, audio, prompt, out: out.replace(root + '/', ''), bytes, usage: done.usage, seconds: Math.round((Date.now() - t0) / 1000), at: new Date().toISOString() };
  // Append every generation (task id, params, usage) to docs/idle-video-runs.jsonl (task ids + usage) for docs/ASSETS.md bookkeeping.
  appendFileSync(join(root, 'docs/idle-video-runs.jsonl'), JSON.stringify(summary) + '\n');
  console.log('saved', JSON.stringify(summary, null, 1));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error('ERROR', e.message); process.exit(1); });
