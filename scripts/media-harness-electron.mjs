// Invoked by media-harness.mjs with an isolated profile; no production preload, SDK, agent or API credentials.
import { app, BrowserWindow, session } from 'electron';
import { readFileSync, mkdirSync, writeFileSync, statSync, symlinkSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, extname } from 'node:path';

const options = JSON.parse(process.argv[2]);
app.setPath('userData', join(options.temp, 'profile'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (options.software) { app.commandLine.appendSwitch('use-angle', 'swiftshader'); app.commandLine.appendSwitch('enable-unsafe-swiftshader'); }
app.dock?.hide();
const dataUrl = path => {
  if (statSync(path).size > 64 * 1024 * 1024) throw new Error('Use a short local clip (at most 64 MiB)');
  const mime = { '.png': 'image/png', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' }[extname(path).toLowerCase()];
  if (!mime) throw new Error(`Unsupported local media: ${extname(path)}`);
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
};
setTimeout(() => { console.error('media harness timeout'); app.exit(2); }, 110000);
app.whenReady().then(async () => {
  const blocked = [];
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, cb) => { blocked.push(new URL(details.url).origin); cb({ cancel: true }); });
  const win = new BrowserWindow({ show: false, width: 800, height: 800, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadURL('data:text/html,<meta charset=utf-8><body style="margin:0"></body>');
  const input = {
    portrait: dataUrl(join(options.root, 'assets/characters/xiaoqi-green.png')),
    video: dataUrl(options.video ?? ['xiaoqi-idle.mp4', 'xiaoqi-idle.webm'].map(name => join(options.root, 'assets/characters', name)).find(existsSync)),
    customVideo: Boolean(options.video), times: options.times,
  };
  const result = await win.webContents.executeJavaScript(`${readFileSync(options.bundle, 'utf8')}\nMediaHarness.run(${JSON.stringify(input)})`);
  // file:// is privileged in Electron: sandbox + CSP 'self' alone still permits local file fetch. Exercise the
  // actual production request gate against synthetic files; the optional offline observer also keeps network blocked.
  const fileTest = { name: 'Electron file-origin cannot bypass media authorization or follow an escaping symlink', ok: false };
  try {
    const { hardenRenderer } = createRequire(import.meta.url)(join(options.temp, 'renderer-security.cjs'));
    const base = join(options.temp, 'file-fixture'), renderer = join(base, 'renderer'), page = join(renderer, 'companion', 'index.html');
    mkdirSync(join(renderer, 'companion'), { recursive: true });
    writeFileSync(page, '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; connect-src \'self\'">');
    const visible = join(renderer, 'fixture.txt'), secret = join(base, 'private.txt'), alias = join(renderer, 'alias.txt');
    writeFileSync(visible, 'public-fixture'); writeFileSync(secret, 'synthetic-private-fixture'); symlinkSync(secret, alias);
    hardenRenderer(win.webContents, pathToFileURL(page).href, url => blocked.push(new URL(url).origin));
    await win.loadFile(page);
    const fetchFile = path => win.webContents.executeJavaScript(`fetch(${JSON.stringify(pathToFileURL(path).href)}, {cache:'no-store'}).then(r=>r.text()).catch(()=>null)`);
    if (await fetchFile(visible) !== 'public-fixture') throw new Error('legitimate bundled renderer file blocked');
    if (await fetchFile(secret) !== null) throw new Error('private file readable outside renderer directory');
    if (await fetchFile(alias) !== null) throw new Error('symlink escaped renderer directory');
    fileTest.ok = true;
  } catch (e) { fileTest.error = String(e.message); }
  result.tests.push(fileTest);
  mkdirSync(options.out, { recursive: true });
  for (const artifact of result.artifacts) writeFileSync(join(options.out, `${artifact.name}.png`), Buffer.from(artifact.png.split(',')[1], 'base64'));
  const report = { ...result, artifacts: result.artifacts.map(a => `${a.name}.png`), blockedNetworkRequests: blocked, electron: process.versions.electron, baseline: options.baseline ?? null, software: options.software };
  writeFileSync(join(options.out, 'report.json'), JSON.stringify(report, null, 2));
  for (const test of result.tests) console.log(`${test.ok ? 'PASS' : 'FAIL'} ${test.name}${test.error ? `: ${test.error}` : ''}`);
  console.log(`Media harness: ${result.tests.filter(t => t.ok).length}/${result.tests.length}; network attempts=${blocked.length}; artifacts: ${options.out}`);
  win.destroy();
  app.exit(result.tests.every(t => t.ok) && blocked.length === 0 ? 0 : 1);
}).catch(e => { console.error(e); app.exit(1); });
