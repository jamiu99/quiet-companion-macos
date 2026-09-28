// Offline rasterization + VP8 encoding; no production main, no credentials, no desktop capture.
import { app, BrowserWindow, session } from 'electron';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { mascot, cover } from './public-art.mjs';
const { out, profile } = JSON.parse(process.argv[2]);
app.setPath('userData', profile); app.dock?.hide();
let attempts = 0;
const save = (path, bytes) => { const dest = join(out, path); if (existsSync(dest)) throw new Error(`Refusing to overwrite ${path}`); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, bytes, { flag: 'wx' }); return { path, sha256: createHash('sha256').update(bytes).digest('hex') }; };
const timeout = setTimeout(() => app.exit(2), 60000);
// Minimal WebM muxer: finite duration, one cluster per frame, VP8 blocks. No external codec binaries or copied clip.
const bytes = n => { const a = []; do { a.unshift(n & 255); n = Math.floor(n / 256); } while (n); return Buffer.from(a); };
function size(n) { for (let len = 1; len <= 8; len++) if (n < 2 ** (7 * len) - 1) { const b = Buffer.alloc(len); let x = n; for (let i = len - 1; i >= 0; i--) { b[i] = x & 255; x = Math.floor(x / 256); } b[0] |= 1 << (8 - len); return b; } throw new Error('EBML too large'); }
const element = (id, data) => { const b = Array.isArray(data) ? Buffer.concat(data) : typeof data === 'string' ? Buffer.from(data) : typeof data === 'number' ? bytes(data) : data; return Buffer.concat([bytes(id), size(b.length), b]); };
function webm(frames) {
  const duration = Buffer.alloc(8); duration.writeDoubleBE(8000);
  return Buffer.concat([element(0x1a45dfa3, [element(0x4286, 1), element(0x42f7, 1), element(0x42f2, 4), element(0x42f3, 8), element(0x4282, 'webm'), element(0x4287, 2), element(0x4285, 2)]), element(0x18538067, [
    element(0x1549a966, [element(0x2ad7b1, 1000000), element(0x4489, duration), element(0x4d80, 'Quiet Companion fixture'), element(0x5741, 'Quiet Companion fixture')]),
    element(0x1654ae6b, [element(0xae, [element(0xd7, 1), element(0x73c5, 1), element(0x83, 1), element(0x86, 'V_VP8'), element(0xe0, [element(0xb0, 180), element(0xba, 320)])])]),
    ...frames.map(f => element(0x1f43b675, [element(0xe7, Math.round(f.timestamp / 1000)), element(0xa3, Buffer.concat([Buffer.from([0x81, 0, 0, f.key ? 0x80 : 0]), Buffer.from(f.data)]))])),
  ])]);
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_d, cb) => { attempts++; cb({ cancel: true }); });
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } });
  const page = join(profile, 'canvas.html'); writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>Offline artwork</title>');
  await win.loadFile(page); // file:// is a trustworthy context for WebCodecs; opaque data: is not.
  const sources = [{ path: 'assets/characters/xiaoqi-green.png', svg: mascot({ green: true }), w: 360, h: 640 }, { path: 'docs/media/social-preview.png', svg: cover(), w: 1280, h: 640 }];
  for (const name of ['app-icon', 'hero-empty', 'hero-placeholder', 'hero-connecting', 'bust-xiaoqi']) sources.push({ path: `assets/ui/${name}.png`, svg: mascot(), w: 256, h: 256 });
  for (const [i, id] of ['notes-todo', 'tidy-screenshots', 'weather-notify', 'web-headlines', 'clipboard-md', 'screen-describe', 'csv-report', 'sysinfo-notify'].entries()) sources.push({ path: `assets/ui/task-${id}.png`, w: 128, h: 128, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect x="8" y="8" width="112" height="112" rx="30" fill="#d8f1eb"/><text x="64" y="85" text-anchor="middle" fill="#183745" font-size=" sixty" font-family="sans-serif">${['N','F','☀','W','C','S','T','I'][i]}</text></svg>`.replace(' sixty','60') });
  sources.push({ path: 'build/icon.png', svg: mascot(), w: 1024, h: 1024 });
  for (const n of [16, 32]) sources.push({ path: `assets/trayTemplate${n === 32 ? '@2x' : ''}.png`, w: n, h: n, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path fill="black" d="M5 25V8l7 4h8l7-4v17z"/><circle cx="12" cy="20" r="2" fill="white"/><circle cx="21" cy="20" r="2" fill="white"/></svg>' });
  const result = await win.webContents.executeJavaScript(`(${async function (sources, framesSvg) {
    const image = svg => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
    const pngs = [];
    for (const s of sources) { const c = document.createElement('canvas'); c.width = s.w; c.height = s.h; const img = await image(s.svg); const scale = Math.min(s.w / img.width, s.h / img.height); c.getContext('2d').drawImage(img, (s.w-img.width*scale)/2, (s.h-img.height*scale)/2, img.width*scale, img.height*scale); pngs.push(c.toDataURL('image/png').split(',')[1]); }
    const frames = [], c = document.createElement('canvas'); c.width = 180; c.height = 320;
    const encoder = new VideoEncoder({ output: chunk => { const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data); frames.push({ timestamp: chunk.timestamp, key: chunk.type === 'key', data: Array.from(data) }); }, error: e => { throw e; } });
    encoder.configure({ codec: 'vp8', width: 180, height: 320, bitrate: 350000, framerate: 12, hardwareAcceleration: 'prefer-software' });
    for (let n = 0; n < 96; n++) { c.getContext('2d').drawImage(await image(framesSvg[n % framesSvg.length]), 0, 0, 180, 320); const f = new VideoFrame(c, { timestamp: Math.round(n * 1000000 / 12), duration: Math.round(1000000 / 12) }); encoder.encode(f, { keyFrame: n % 12 === 0 }); f.close(); if (encoder.encodeQueueSize > 6) await encoder.flush(); }
    await encoder.flush(); encoder.close(); return { pngs, frames };
  }.toString()})(${JSON.stringify(sources)}, ${JSON.stringify(Array.from({ length: 24 }, (_, i) => mascot({ green: true, bob: 3 * Math.sin(i / 24 * Math.PI * 2) })))})`);
  if (attempts || result.frames.length !== 96) throw new Error('Unexpected network / incomplete video');
  const files = sources.map((s, i) => save(s.path, Buffer.from(result.pngs[i], 'base64')));
  files.push(save('assets/characters/xiaoqi-idle.webm', webm(result.frames)), save('docs/media/cover.svg', Buffer.from(cover())));
  save('assets/PROVENANCE.json', Buffer.from(JSON.stringify({ generator: 'scripts/public-art.mjs + scripts/public-art-electron.mjs', source: 'Original geometric drawing; no third-party media, personal likeness, external font files or generative-service output', networkAttempts: attempts, files }, null, 2)));
  clearTimeout(timeout); win.destroy(); app.exit(0);
}).catch(e => { console.error(e.message); app.exit(1); });
