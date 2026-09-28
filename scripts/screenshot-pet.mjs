// Dev tool: render the companion (pet) page with mock data (renderer/shared/mock.ts) and save PNGs to docs/screenshots/.
// Usage: npx vite --config vite.config.ts &   then   node_modules/.bin/electron scripts/screenshot-pet.mjs [shot...]
// Shots: live (她 + 左侧面板) | collapsed (单行输入条) | toolbar (悬停工具条) | settings (设置抽屉) | running | empty
import { app, BrowserWindow } from 'electron';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'docs/screenshots');
const url = process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5183';
const args = process.argv.slice(2).filter(a => !a.startsWith('-'));
const shots = args.length ? args : ['live', 'collapsed', 'toolbar', 'settings'];
// Primary display logical size on the dev MacBook; the pet window covers the whole display.
const SIZE = { w: 1470, h: 956 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Real generated Q 版 pictures of 阿澈 kept under docs/screenshots (served by vite via /@fs/ in dev).
const ACHE_ART = encodeURIComponent(`/@fs${root}/docs/screenshots/characters-ache`);
// Query flags are dev-only (Stage.tsx debugFlags): hover=1 shows the toolbar, panel=collapsed|hidden, settings=1&group=…
const SHOTS = {
  live: 'mock=live',
  collapsed: 'mock=live&panel=collapsed',
  toolbar: 'mock=live&hover=1',
  settings: 'mock=running&settings=1&group=display',
  vidulog: 'mock=live&settings=1&group=vidulog',
  running: 'mock=running',
  empty: 'mock=empty',
  hidden: 'mock=live&panel=hidden&hover=1',
  // Task 07: 「角色」 settings group (cards + form + assets), the same with a running idle-video job, and a character
  // without a portrait standing on the desktop (placeholder).
  'characters-settings': 'mock=idle&settings=1&group=characters',
  'characters-job': 'mock=idle&settings=1&group=characters&job=idle',
  'characters-new': 'mock=idle&active=new&panel=hidden',
  // Task 09: 「角色」 group scrolled to the Q 版 tiles; the pet docked as an edge tag (right / left; fullwin keeps screen
  // coordinates so the tag shows at the real edge); 阿澈 with his generated Q 版 art (docs/screenshots/characters-ache-*).
  'characters-art': 'mock=idle&settings=1&group=characters&job=art',
  docked: 'mock=live&docked=right&fullwin=1',
  'docked-left': `mock=running&active=ache&docked=left&fullwin=1&art=${ACHE_ART}`,
  'empty-ache': `mock=idle&active=ache&clear=1&art=${ACHE_ART}`,
};
/** characters-* shots keep their name; everything else is pet-<shot>.png. */
const fileFor = shot => join(out, shot.startsWith('characters') ? `${shot}.png` : `pet-${shot}.png`);

app.dock?.hide();
app.on('window-all-closed', () => { /* keep running between shots */ });
app.whenReady().then(main).catch(e => { console.error(e); app.exit(1); });
setTimeout(() => { console.error('screenshot timeout'); app.exit(3); }, 90_000);

async function main() {
  mkdirSync(out, { recursive: true });
  for (const shot of shots) {
    const q = SHOTS[shot]; if (!q) { console.error('unknown shot', shot); continue; }
    const win = new BrowserWindow({ width: SIZE.w, height: SIZE.h, show: false, frame: false, transparent: true, backgroundColor: '#00000000', webPreferences: { offscreen: true } });
    win.webContents.setZoomFactor(1);
    const page = `${url}/companion/index.html?${q}&bg=1`;
    await win.loadURL(page).catch(() => sleep(800).then(() => win.loadURL(page)));
    await sleep(900);
    await win.webContents.insertCSS('* { transition: none !important; animation-duration: 0s !important; animation-delay: 0s !important; }');
    if (shot === 'toolbar') await win.webContents.executeJavaScript(`[...document.querySelectorAll('.tool-group > button')].slice(-1).forEach(b => b.click())`);
    // The assets / progress section of the 「角色」 group sits below the fold of the 440 px drawer.
    if (shot === 'characters-job' || shot === 'characters-art') await win.webContents.executeJavaScript(`document.querySelector('.drawer-body').scrollTop = 1e5`);
    await sleep(400);
    const img = await win.webContents.capturePage();
    const file = fileFor(shot);
    writeFileSync(file, img.toPNG());
    console.log('saved', file, img.getSize());
    win.destroy();
  }
  app.quit();
}
