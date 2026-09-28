import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, protocol, screen, shell, nativeImage } from 'electron';
import { basename, extname, join } from 'node:path';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { DEFAULT_CHARACTER_APPEARANCE, DEFAULT_CHARACTER_NAME, migrateCharacters, resolveActiveCharacter, toPublicConfig, type AppConfig, type CompanionLayer } from '@shared/config';
import { IPC } from '@shared/ipc';
import type { CharacterJob } from '@shared/events';
import { ConfigStore, expandHome } from './config-store';
import { TokenDanceAuth, AUTH_APP_URL } from './auth/tokendance';
import { requireRtcSdk } from './security/rtc-sdk';
import { TOKENDANCE_GATEWAY } from '@shared/auth';
import { Orchestrator } from './orchestrator';
import { applyLayer, companionPageURL, createCompanionWindow, devUrl, fitCompanionToPrimaryDisplay, setInteractive } from './windows';
import { LocalAssetAccess, serveLocalAsset } from './security/local-assets';
import { assertTrustedSender, secureServiceURL } from './security/renderer';
import { redactPayload, redactSecrets, rememberSecrets } from './security/redact';
export { redactSecrets } from './security/redact'; // Trusted main-process diagnostics only, never preload.
import { plainRecord, sanitizeCharacterInput, sanitizeConfigPatch } from '@shared/configValidation';
import { createTray, type CompanionTray } from './tray';
import { initLog, log } from './log';
import { CharacterStore } from './characters/store';
import { CharacterJobs } from './characters/jobs';
import { generatePortrait } from './characters/generate';
import { buildArtPrompt, buildIdlePrompt } from './characters/prompts';
import { generateArt } from './characters/art';
import { downloadVideo, imageDataUrl, pollTask, statusToJob, submitIdleVideo } from './characters/seedance';

const root = join(__dirname, '..', '..');
// Dev (name=quiet-companion-mac) and packaged (productName=栖伴) builds must share one userData dir.
// COMPANION_USER_DATA=<dir> (dev only): run against a separate config / characters dir, e.g. to generate assets while
// the packaged app is in use without the two processes overwriting each other's config.json.
app.setPath('userData', process.env.COMPANION_USER_DATA || join(app.getPath('appData'), 'quiet-companion-mac'));
const userData = app.getPath('userData');
// One visible pet / config writer per profile. Isolated test profiles may still run independently. Exit BEFORE
// seeding credentials or creating any runtime; relaunching must not stack two transparent pets or bill twice.
if (!app.requestSingleInstanceLock()) { app.exit(0); process.exit(0); }
initLog(join(userData, 'logs', 'main.log'));
// Seed order (first hit wins per key): project .env (dev) → userData/.env → ~/.config/quiet-companion/.env → .env.example.
// The packaged app has no project .env, so users drop a .env into one of the two user-level locations (docs/PACKAGING.md).
const store = new ConfigStore(join(userData, 'config.json'), [join(root, '.env'), join(userData, '.env'), join(app.getPath('home'), '.config', 'quiet-companion', '.env'), join(root, '.env.example')]);
rememberSecrets(store.get().vidu.apiKey, store.get().agent.apiKey);
let authPreparing = false, authGeneration = 0;
let authConfig: { apiKey: string; baseUrl: string } | undefined;
const tokenDanceAuth = new TokenDanceAuth({
  // Development-only override for local integration tests; packaged attribution comes from publication.json.
  appUrl: AUTH_APP_URL || (!app.isPackaged ? process.env.COMPANION_AUTH_APP_URL : undefined),
  openBrowser: url => shell.openExternal(url),
  saveKey: key => {
    const current = store.get().agent;
    rememberSecrets(key);
    if (!authConfig || current.apiKey !== authConfig.apiKey || current.baseUrl !== authConfig.baseUrl) throw new Error('授权期间配置已变化');
    // Never deliver this new credential to a previously configured custom gateway.
    store.commit({ agent: { apiKey: key, baseUrl: TOKENDANCE_GATEWAY } });
    authConfig = undefined;
  },
});
// Bundled default portrait (assets/ is copied to dist/renderer by vite; in dev use the source path).
const defaultPortrait = [join(root, 'assets', 'characters', 'xiaoqi-green.png'), join(__dirname, '..', 'renderer', 'characters', 'xiaoqi-green.png')].find(existsSync);
if (defaultPortrait && !store.get().vidu.imagePath) store.update({ vidu: { imagePath: defaultPortrait } });
// Bundled idle loop video (same locations as the portrait); only filled in when the user has not picked one.
const defaultIdleVideo = ['xiaoqi-idle.mp4', 'xiaoqi-idle.webm'].flatMap(name => [join(root, 'assets', 'characters', name), join(__dirname, '..', 'renderer', 'characters', name)]).find(existsSync);
if (defaultIdleVideo && !store.get().companion.idleVideoPath) store.update({ companion: { idleVideoPath: defaultIdleVideo } });
// Task 07: the legacy single character (vidu.imagePath / persona / companion.idleVideoPath) becomes the first entry of
// `characters` and is made active; existing behaviour is unchanged because the active character resolves to the same files.
{ const patch = migrateCharacters(store.get()); if (patch) { store.update(patch); log('characters migrated', { count: patch.characters?.length, active: patch.activeCharacterId }); } }
const agentEntry = join(__dirname, '..', 'agent-host', 'index.mjs');
const agentDir = join(userData, 'pi-agent');
// Portraits above ~1.2 MB are downscaled (PNG, max 1280 px tall) before being inlined into the Vidu create request:
// smaller payload = faster session creation; the original file is still used for the idle image on screen.
const MAX_INLINE_IMAGE_BYTES = 1.2 * 1024 * 1024, INLINE_IMAGE_MAX_HEIGHT = 1280;
async function encodePortrait(path: string): Promise<string | undefined> {
  if (statSync(path).size <= MAX_INLINE_IMAGE_BYTES) return undefined;
  const img = nativeImage.createFromPath(path);
  if (img.isEmpty()) return undefined;
  const { width, height } = img.getSize();
  const scaled = height > INLINE_IMAGE_MAX_HEIGHT ? img.resize({ height: INLINE_IMAGE_MAX_HEIGHT, quality: 'best' }) : img;
  const png = scaled.toPNG();
  log('portrait downscaled', { from: `${width}x${height}`, to: `${scaled.getSize().width}x${scaled.getSize().height}`, bytes: png.length });
  return `data:image/png;base64,${png.toString('base64')}`;
}
// Main-process-only export for the explicit, paid integration harness; never exposed through preload / IPC.
export const orchestrator = new Orchestrator(store.get(), agentEntry, agentDir, { encodeImage: encodePortrait, beforeConnect: () => requireRtcSdk([join(__dirname, '..', 'renderer', 'vendor', 'aliyun-rtc-sdk.js'), ...(!app.isPackaged ? [join(root, 'assets', 'vendor', 'aliyun-rtc-sdk.js')] : [])]) });
// Characters (task 07): CRUD over the config + userData/characters/<id>/ asset dirs. Switching is refused while a Vidu
// session is active; deleting / switching a character is refused while one of its generation jobs runs.
const characters = new CharacterStore(store, join(userData, 'characters'), { avatarActive: () => orchestrator.vidu.isActive, busy: id => characterBusy(id) });
const jobs = new CharacterJobs();
const characterBusy = (id: string) => jobs.busy(id);
{ const n = characters.recover(); if (n) log('characters recovered from character.json', { n }); }
// Make sure every character (incl. the migrated one) has its character.json mirror, so an older build that drops the
// `characters` field from config.json cannot lose them.
characters.mirrorAll();
// Task 09: the bundled default character (小栖) gets the bundled Q 版 illustrations (assets/ui/hero-empty.png as the
// waving hero, bust-xiaoqi.png cut from the app icon as the bust) instead of a paid generation. Other characters draw
// theirs via the 'art' job; the UI falls back to the same bundled pictures while a character has none.
{
  const uiDir = [join(root, 'assets', 'ui'), join(__dirname, '..', 'renderer', 'ui')].find(existsSync);
  const hero = uiDir && join(uiDir, 'hero-empty.png'), bust = uiDir && join(uiDir, 'bust-xiaoqi.png');
  if (hero && bust && existsSync(hero) && existsSync(bust)) {
    for (const c of characters.list()) {
      const isDefault = (c.portraitPath && basename(c.portraitPath) === 'xiaoqi-green.png') || (c.name === DEFAULT_CHARACTER_NAME && c.appearance === DEFAULT_CHARACTER_APPEARANCE);
      const stale = (p?: string) => !p || !existsSync(p); // e.g. the repo moved / another build's bundle path
      if (isDefault && (stale(c.artHeroPath) || stale(c.artBustPath))) { characters.save({ id: c.id, artHeroPath: stale(c.artHeroPath) ? hero : c.artHeroPath, artBustPath: stale(c.artBustPath) ? bust : c.artBustPath }); log('default character art filled', { id: c.id, hero, bust }); }
    }
  }
}
/** Generated portraits are stored as PNG, at most 1600 px tall (Vidu reference + idle image). */
const PORTRAIT_MAX_HEIGHT = 1600;
function toPortraitPng(image: Buffer): Buffer {
  const img = nativeImage.createFromBuffer(image);
  if (img.isEmpty()) throw new Error('无法解码生成的图片');
  const { height } = img.getSize();
  return (height > PORTRAIT_MAX_HEIGHT ? img.resize({ height: PORTRAIT_MAX_HEIGHT, quality: 'best' }) : img).toPNG();
}
const tokendance = () => { const a = store.get().agent; if (!a.apiKey) throw new Error('未配置 TokenDance API Key（设置 → Agent）'); return { apiKey: a.apiKey, baseUrl: a.baseUrl }; };
/** seedream-5.0-pro → userData/characters/<id>/portrait-<ts>.png; progress via jobs. Resolves once the job is registered. */
function startPortraitJob(id: string) {
  const c = characters.require(id);
  if (!c.appearance.trim()) throw new Error('请先填写外观描述');
  const td = tokendance();
  return jobs.start(id, 'portrait', async report => {
    const ref = c.referenceImagePath && existsSync(c.referenceImagePath) ? imageDataUrl(c.referenceImagePath) : undefined;
    const t0 = Date.now();
    const r = await generatePortrait({ character: c, ...td, referenceDataUri: ref, onProgress: report });
    const out = characters.assetPath(id, 'portrait');
    writeFileSync(out, toPortraitPng(r.image));
    characters.setAsset(id, 'portrait', out);
    log('portrait generated', { id, name: c.name, out, bytes: r.image.length, mime: r.mime, reference: Boolean(ref), seconds: Math.round((Date.now() - t0) / 1000), usage: r.usage, prompt: r.prompt });
  });
}
/** One-shot pipeline: portrait, then (on success) the idle video and the Q 版 art. The art job (task 09) runs alongside
 *  the ~3 min idle-video job — both only need the portrait — and its failure does not affect the other two. */
function startAssetsJob(id: string) {
  startPortraitJob(id);
  const onJob = (j: CharacterJob) => {
    if (j.characterId !== id || j.kind !== 'portrait') return;
    if (j.phase === 'done') {
      jobs.off('job', onJob);
      try { startIdleJob(id); } catch (e) { log('assets pipeline: idle step not started', String((e as Error).message)); }
      try { startArtJob(id); } catch (e) { log('assets pipeline: art step not started', String((e as Error).message)); }
    } else if (j.phase === 'failed') jobs.off('job', onJob);
  };
  jobs.on('job', onJob);
}
/** Task 09: Q 版半身 + 挥手图 (seedream-5.0-pro, portrait as image reference, keyed + cropped to 256 px PNGs) → art-bust-<ts>.png,
 *  art-hero-<ts>.png. One job of kind 'art'; the bust is saved as soon as it is done even if the hero then fails. */
function startArtJob(id: string) {
  const c = characters.require(id);
  if (!c.portraitPath || !existsSync(c.portraitPath)) throw new Error('请先生成或选择立绘');
  const td = tokendance();
  return jobs.start(id, 'art', async report => {
    const referenceDataUri = await encodePortrait(c.portraitPath!) ?? imageDataUrl(c.portraitPath!);
    const steps: { kind: 'bust' | 'hero'; label: string }[] = [{ kind: 'bust', label: '半身' }, { kind: 'hero', label: '挥手' }];
    for (const [i, step] of steps.entries()) {
      const started = Date.now();
      report({ phase: 'running', message: `绘制 Q 版形象（${step.label}）`, progress: i / steps.length + 0.02 });
      const tick = setInterval(() => report({ phase: 'running', message: `绘制 Q 版形象（${step.label}）${Math.round((Date.now() - started) / 1000)}s`, progress: Math.min((i + 0.9) / steps.length, i / steps.length + 0.02 + 0.45 * (Date.now() - started) / 60_000) }), 1000);
      let r;
      try { r = await generateArt({ ...td, referenceDataUri, prompt: buildArtPrompt(step.kind, c), out: characters.assetPath(id, step.kind) }); }
      finally { clearInterval(tick); }
      characters.setAsset(id, step.kind, r.out);
      log('character art generated', { id, name: c.name, kind: step.kind, out: r.out, bytes: r.bytes, raw: r.raw, seconds: r.seconds, usage: r.usage });
    }
  });
}
/** Cloned voices registered on the Vidu account (GET /live/v1/voices); presets live in shared/config. */
async function listViduVoices(): Promise<string[]> {
  const v = store.get().vidu;
  if (!v.apiKey) return [];
  try {
    const r = await fetch(`https://${v.host}/live/v1/voices`, { headers: { Authorization: `Token ${v.apiKey.trim().replace(/^Token\s+/, '')}` }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return [];
    const j = await r.json() as { voices?: Array<{ voice?: string; name?: string; id?: string } | string> };
    return (j.voices ?? []).map(x => typeof x === 'string' ? x : x.voice ?? x.name ?? x.id ?? '').filter(Boolean);
  } catch (e) { log('listViduVoices failed', String((e as Error).message)); return []; }
}
/** seedance-2.0-fast, first+last frame = the portrait → idle-<ts>.mp4. */
function startIdleJob(id: string) {
  const c = characters.require(id);
  if (!c.portraitPath || !existsSync(c.portraitPath)) throw new Error('请先生成或选择立绘');
  const td = tokendance();
  return jobs.start(id, 'idle', async report => {
    const t0 = Date.now();
    const prompt = buildIdlePrompt(c);
    report({ phase: 'submitted', message: '提交给 seedance-2.0-fast' });
    const task = await submitIdleVideo({ ...td, imagePath: c.portraitPath!, prompt });
    log('idle video task submitted', { id, task });
    const done = await pollTask(task, { ...td, onStatus: (s, elapsed) => { report(statusToJob(s, elapsed)); log('idle video status', { task, status: s.status, elapsed: Math.round(elapsed / 1000) }); } });
    const url = done.content?.video_url;
    if (!url) throw new Error('任务成功但没有 video_url');
    const video = await downloadVideo(url);
    const out = characters.assetPath(id, 'idle');
    writeFileSync(out, video);
    characters.setAsset(id, 'idle', out);
    log('idle video generated', { id, name: c.name, task, out, bytes: video.length, seconds: Math.round((Date.now() - t0) / 1000), usage: done.usage, prompt });
  });
}

const assetAccess = new LocalAssetAccess();
assetAccess.setConfigured(store.get());
let companionWin: BrowserWindow | undefined;
let tray: CompanionTray | undefined;
app.on('second-instance', () => { if (companionWin && !companionWin.isDestroyed()) { companionWin.show(); toggleBar(true); } });

// Local images (portrait / idle) are served via a custom scheme so the renderer never needs file:// access.
// corsEnabled + the ACAO header below: the renderer is file:// and uploads these images/videos into WebGL textures
// (green key); without CORS the texture upload throws SecurityError (tainted source) and the canvas stays blank.
protocol.registerSchemesAsPrivileged([{ scheme: 'companion-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

const broadcast = (channel: string, payload: unknown) => { if (companionWin && !companionWin.isDestroyed()) companionWin.webContents.send(channel, channel === IPC.rtc ? payload : redactPayload(payload)); };
orchestrator.on('state', s => broadcast(IPC.state, s));
// Job progress: push each change and mirror the list into AppState so a freshly opened panel sees running jobs.
jobs.on('job', j => { broadcast(IPC.characterJob, j); log('character job', { id: j.characterId, kind: j.kind, phase: j.phase, progress: j.progress, message: j.message, error: j.error }); });
jobs.on('change', list => { orchestrator.state.characterJobs = list; broadcast(IPC.state, orchestrator.state); });
orchestrator.on('rtc', e => broadcast(IPC.rtc, e));
orchestrator.on('log', line => log(line));
orchestrator.on('state', s => log('state', { avatar: s.avatar.phase, agent: s.agent.status, activity: s.agent.activity, err: s.agent.lastError }));
process.on('uncaughtException', e => log('uncaught', String(e?.stack ?? e)));
process.on('unhandledRejection', e => log('unhandledRejection', String((e as any)?.stack ?? e)));
let hotkey = '';
/** (Re)register the global panel hotkey; on failure (taken by another app / invalid) tell the user in the panel. */
function registerHotkey(accelerator: string) {
  if (hotkey) { try { globalShortcut.unregister(hotkey); } catch { /* ignore */ } hotkey = ''; }
  const acc = accelerator.trim();
  if (!acc) return;
  let ok = false, err = '';
  try { ok = globalShortcut.register(acc, () => toggleBar()); } catch (e) { err = String((e as Error).message ?? e); }
  if (ok) hotkey = acc;
  log('hotkey', { accelerator: acc, ok, err });
  if (!ok) orchestrator.notify(`快捷键 ${acc} 注册失败${err ? `（${err}）` : '（可能被其它应用占用）'}，请在设置里换一个`);
  tray?.rebuild();
}
store.onChange(c => {
  rememberSecrets(c.vidu.apiKey, c.agent.apiKey);
  assetAccess.setConfigured(c);
  orchestrator.setConfig(c);
  broadcast(IPC.config, toPublicConfig(c));
  if (c.ui.toggleBarHotkey !== hotkey) registerHotkey(c.ui.toggleBarHotkey);
});

/** Show / hide the chat panel embedded in the companion window (AppState.barVisible = panel visibility). Showing
 *  also focuses the window so the renderer can put the caret in the input; hiding hands focus back to the previous app. */
function toggleBar(visible?: boolean) {
  // Docked (task 09): summoning the panel first brings her back from the edge (the panel is never shown while docked).
  const docked = Boolean(store.get().companion.docked);
  const show = docked ? true : visible ?? !orchestrator.state.barVisible;
  if (docked) setDocked(null);
  orchestrator.setBarVisible(show);
  if (!companionWin || companionWin.isDestroyed()) return;
  if (show) companionWin.focus();
  else if (companionWin.isFocused()) companionWin.blur();
}

// ---- task 09: 收到侧边 ----
type Dock = NonNullable<AppConfig['companion']['docked']>;
/** Persist the dock state; the renderer draws the edge tag / the figure from config.companion.docked. */
function setDocked(dock: Dock | null) {
  const clean = dock && (dock.side === 'left' || dock.side === 'right') && Number.isFinite(dock.y) ? { side: dock.side, y: Math.min(1, Math.max(0, dock.y)) } : undefined;
  store.update({ companion: { docked: clean } });
  log('docked', clean ?? 'restored');
  tray?.rebuild();
}
/** Tuck her away on the nearest screen edge (by her center x), keeping her vertical center. */
function dockToEdge() {
  const { anchor, scale } = store.get().companion;
  setDocked({ side: anchor.x < 0.5 ? 'left' : 'right', y: Math.min(1, Math.max(0, anchor.y - scale / 2)) });
}
function toggleDocked() { if (store.get().companion.docked) setDocked(null); else dockToEdge(); }
/** Bring the panel up (undocking if needed) and ask the renderer to open the settings drawer. */
function openSettings() {
  toggleBar(true);
  setTimeout(() => broadcast(IPC.openSettings, null), 50);
}
/** Right-click on the pet body / the edge tag: native menu at the cursor. */
function showContextMenu() {
  if (!companionWin || companionWin.isDestroyed()) return;
  const c = store.get().companion;
  const docked = Boolean(c.docked);
  const avatarActive = orchestrator.vidu.isActive;
  const canConnect = Boolean(store.get().vidu.apiKey) && Boolean(resolveActiveCharacter(store.get()).imagePath);
  const menu = Menu.buildFromTemplate([
    docked ? { label: '从侧边唤出', click: () => setDocked(null) } : { label: '收到侧边', click: () => dockToEdge() },
    { type: 'separator' },
    { label: '锁定位置', type: 'checkbox', checked: Boolean(c.lockMove), click: () => store.update({ companion: { lockMove: !c.lockMove } }) },
    { label: '锁定大小', type: 'checkbox', checked: Boolean(c.lockSize), click: () => store.update({ companion: { lockSize: !c.lockSize } }) },
    { type: 'separator' },
    { label: orchestrator.state.barVisible && !docked ? '隐藏对话面板' : '显示对话面板', accelerator: store.get().ui.toggleBarHotkey || undefined, click: () => toggleBar(docked ? true : undefined) },
    avatarActive
      ? { label: orchestrator.state.avatar.phase === 'live' ? '挂断' : '取消连接', click: () => orchestrator.disconnectAvatar() }
      : { label: '连接数字人', enabled: canConnect, click: () => void orchestrator.connectAvatar() },
    { type: 'separator' },
    { label: '设置…', accelerator: 'Cmd+,', click: () => openSettings() },
    { type: 'separator' },
    { label: '退出栖伴', click: () => { (app as any).isQuitting = true; app.quit(); } },
  ]);
  menu.popup({ window: companionWin });
}

function setLayer(layer: CompanionLayer) {
  store.update({ companion: { layer } });
  if (companionWin) applyLayer(companionWin, layer);
  tray?.rebuild();
}

/** ipcMain.handle with timing: anything over 40 ms on the main thread is a jank suspect and gets logged. */
function handle(channel: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(channel, async (...args: any[]) => {
    assertTrustedSender(args[0], companionWin?.webContents, companionPageURL);
    const t = performance.now();
    try { return redactPayload(await fn(...args)); }
    catch (error) { throw new Error(redactSecrets(error instanceof Error ? error.message : '请求失败')); }
    finally { const ms = performance.now() - t; if (ms > 40) log('slow ipc', { channel, ms: Math.round(ms) }); }
  });
}

app.whenReady().then(() => {
  log('ready', { userData, agentEntry, exec: process.execPath, versions: process.versions.electron });
  app.dock?.hide();
  protocol.handle('companion-asset', req => serveLocalAsset(req, assetAccess, devUrl));
  mkdirSync(expandHome(store.get().agent.workspace), { recursive: true });

  companionWin = createCompanionWindow(store.get().companion.layer);
  companionWin.once('ready-to-show', () => setTimeout(() => log('companion window', { layer: store.get().companion.layer, bounds: companionWin?.getBounds(), alwaysOnTop: companionWin?.isAlwaysOnTop(), focusable: companionWin?.isFocusable(), debugFill: process.env.COMPANION_DEBUG_FILL === '1' }), 500));
  // Keep the companion covering the primary display when resolution / arrangement changes.
  const refit = () => { if (companionWin) fitCompanionToPrimaryDisplay(companionWin); };
  screen.on('display-metrics-changed', refit);
  screen.on('display-added', refit);
  screen.on('display-removed', refit);
  setTimeout(() => log('windows', { companionVisible: companionWin?.isVisible(), companionBounds: companionWin?.getBounds(), panelVisible: orchestrator.state.barVisible }), 4000);
  tray = createTray({
    toggleBar, connectAvatar: () => void orchestrator.connectAvatar(), disconnectAvatar: () => orchestrator.disconnectAvatar(),
    setLayer, getLayer: () => store.get().companion.layer, avatarLive: () => orchestrator.vidu.isActive,
    toggleDocked, isDocked: () => Boolean(store.get().companion.docked),
    getToggleBarHotkey: () => store.get().ui.toggleBarHotkey,
    openWorkspace: () => { const w = expandHome(store.get().agent.workspace); mkdirSync(w, { recursive: true }); void shell.openPath(w); },
    openLogs: () => void shell.openPath(join(userData, 'logs')),
    openConfig: () => void shell.openPath(join(userData, 'config.json')),
  });
  orchestrator.on('state', () => tray?.rebuild());
  registerHotkey(store.get().ui.toggleBarHotkey);
  if (!process.env.COMPANION_SMOKE_NO_AGENT) orchestrator.startAgent();
  if (!app.isPackaged) { setupDevAutomation(); setupIdleSnap(); setupDevCharacterJobs(); }

  // ---- IPC ----
  handle(IPC.getConfig, () => toPublicConfig(store.get()));
  handle(IPC.getTokenDanceAuth, () => tokenDanceAuth.getStatus());
  handle(IPC.cancelTokenDanceAuth, () => { authGeneration++; authConfig = undefined; return tokenDanceAuth.cancel(); });
  handle(IPC.beginTokenDanceAuth, async () => {
    if (tokenDanceAuth.busy) return tokenDanceAuth.getStatus();
    if (authPreparing) throw new Error('正在准备授权，请勿重复点击');
    authPreparing = true; const generation = ++authGeneration;
    try {
      const answer = await dialog.showMessageBox(companionWin!, { type: 'question', message: '使用 TokenDance 浏览器授权？',
        detail: '将打开 tokendance.space，由你登录并确认新 Key 的额度、有效期与 RPM。成功后替换本机 Agent Key，并将 Agent / 素材生成地址设为 TokenDance 官方网关；如 Agent 正在运行会重启，可能中断当前任务。不会删除旧 Key，不会连接 Vidu。Key 存在本机 0600 权限配置中，尚未使用 Keychain 加密。',
        buttons: ['取消', '打开浏览器授权'], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response !== 1 || generation !== authGeneration) return { phase: 'cancelled', message: '已取消授权' };
      const { apiKey, baseUrl } = store.get().agent; authConfig = { apiKey, baseUrl };
      return await tokenDanceAuth.start();
    } finally { authPreparing = false; }
  });
  handle(IPC.setConfig, async (_e, patch) => {
    const clean = sanitizeConfigPatch(patch, true);
    if ('characters' in clean || 'activeCharacterId' in clean) throw new Error('角色修改必须通过角色接口');
    if (plainRecord(clean.vidu)) assetAccess.assertAssignment(clean.vidu.imagePath, 'image');
    if (plainRecord(clean.companion)) {
      assetAccess.assertAssignment(clean.companion.idleImagePath, 'image');
      assetAccess.assertAssignment(clean.companion.idleVideoPath, 'video');
    }
    if (plainRecord(clean.agent) && typeof clean.agent.baseUrl === 'string') {
      const next = secureServiceURL(clean.agent.baseUrl), old = secureServiceURL(store.get().agent.baseUrl);
      if (next.origin !== old.origin && store.get().agent.apiKey) {
        const answer = await dialog.showMessageBox(companionWin!, { type: 'warning', message: '更改模型服务地址', detail: `现有 API Key 将用于 ${next.origin}。仅允许你信任的服务。`, buttons: ['取消', '允许'], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response !== 1) throw new Error('已取消服务地址修改');
      }
    }
    const changesCredentials = plainRecord(clean.agent) && ('apiKey' in clean.agent || 'baseUrl' in clean.agent) || plainRecord(clean.vidu) && 'apiKey' in clean.vidu;
    if (changesCredentials) {
      authGeneration++; authConfig = undefined; tokenDanceAuth.cancel();
      if (plainRecord(clean.agent) && typeof clean.agent.apiKey === 'string') rememberSecrets(clean.agent.apiKey);
      if (plainRecord(clean.vidu) && typeof clean.vidu.apiKey === 'string') rememberSecrets(clean.vidu.apiKey);
    }
    return toPublicConfig(changesCredentials ? store.commit(clean) : store.update(clean));
  });
  handle(IPC.getState, () => orchestrator.state);
  handle(IPC.sendText, (_e, text: string) => { if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('消息需为 1–2000 字'); return orchestrator.sendUserText(text); });
  handle(IPC.runQuickTask, (_e, id: string) => orchestrator.runQuickTask(id));
  handle(IPC.abortAgent, () => orchestrator.abortAgent());
  handle(IPC.resetAgent, () => orchestrator.resetAgent());
  handle(IPC.clearSession, () => orchestrator.clearSession());
  handle(IPC.restartAgent, () => orchestrator.startAgent());
  handle(IPC.connectAvatar, () => orchestrator.connectAvatar());
  handle(IPC.disconnectAvatar, () => orchestrator.disconnectAvatar());
  handle(IPC.interruptAvatar, () => orchestrator.interruptAvatar());
  handle(IPC.mediaReady, (_e, liveId: string) => orchestrator.mediaReady(liveId));
  handle(IPC.mediaFailed, (_e, liveId: string, reason: string) => orchestrator.mediaFailed(liveId, String(reason)));
  handle(IPC.toggleBar, (_e, visible?: boolean) => toggleBar(visible));
  handle(IPC.setLayer, (_e, layer: CompanionLayer) => { if (layer !== 'float' && layer !== 'desktop') throw new Error('显示图层无效'); setLayer(layer); });
  handle(IPC.resizeBar, () => { /* bar window removed; panel is embedded and sizes itself */ });
  handle(IPC.setInteractive, (_e, on: boolean) => { if (companionWin) setInteractive(companionWin, Boolean(on)); });
  handle(IPC.setSpeaking, (_e, on: boolean) => orchestrator.setAvatarSpeaking(Boolean(on)));
  handle(IPC.mediaLog, (_e, tag: string, text: string) => orchestrator.mediaLog(String(tag).slice(0, 40), String(text)));
  handle(IPC.clearViduLog, () => orchestrator.clearViduLog());
  handle(IPC.setWindowBounds, (_e, r: { x: number; y: number; width: number; height: number }) => {
    // The renderer keeps the window as small as the figure + panel need (a full-screen transparent window costs ~3x GPU).
    if (!companionWin || companionWin.isDestroyed() || process.env.COMPANION_FULLSCREEN_WINDOW === '1') return;
    if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite)) throw new Error('窗口坐标无效');
    const screenBounds = screen.getPrimaryDisplay().bounds;
    const width = Math.min(screenBounds.width, Math.max(64, Math.round(r.width))), height = Math.min(screenBounds.height, Math.max(64, Math.round(r.height)));
    const b = { x: Math.min(screenBounds.x + screenBounds.width - 40, Math.max(screenBounds.x - width + 40, Math.round(r.x))), y: Math.min(screenBounds.y + screenBounds.height - 40, Math.max(screenBounds.y - height + 40, Math.round(r.y))), width, height };
    const cur = companionWin.getBounds();
    if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) { log('window bounds', b); companionWin.setBounds(b, false); }
  });
  handle(IPC.openExternal, (_e, url: string) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); });
  handle(IPC.log, (_e, line: string) => log('[companion]', String(line).slice(0, 2000)));
  handle(IPC.pickImage, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (r.canceled) return null;
    assetAccess.select(r.filePaths[0]); return r.filePaths[0];
  });
  handle(IPC.pickVideo, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '视频', extensions: ['mp4', 'webm', 'mov'] }] });
    if (r.canceled) return null;
    assetAccess.select(r.filePaths[0]); return r.filePaths[0];
  });
  // ---- characters (task 07) ----
  handle(IPC.listCharacters, () => characters.list());
  handle(IPC.saveCharacter, (_e, c) => {
    const clean = sanitizeCharacterInput(c);
    for (const field of ['portraitPath', 'referenceImagePath', 'artBustPath', 'artHeroPath']) assetAccess.assertAssignment(clean[field], 'image');
    assetAccess.assertAssignment(clean.idleVideoPath, 'video');
    return characters.save(clean);
  });
  handle(IPC.deleteCharacter, (_e, id: string) => characters.remove(String(id)));
  handle(IPC.setActiveCharacter, (_e, id: string) => { characters.setActive(String(id)); log('character switched', { id }); });
  handle(IPC.generatePortrait, (_e, id: string) => { startPortraitJob(String(id)); });
  handle(IPC.generateIdleVideo, (_e, id: string) => { startIdleJob(String(id)); });
  handle(IPC.generateAssets, (_e, id: string) => { startAssetsJob(String(id)); });
  handle(IPC.generateArt, (_e, id: string) => { startArtJob(String(id)); });
  // ---- task 09 ----
  handle(IPC.showContextMenu, () => showContextMenu());
  handle(IPC.setDocked, (_e, dock: Dock | null) => setDocked(dock ?? null));
  handle(IPC.listVoices, () => listViduVoices());
  handle(IPC.pickReferenceImage, async (_e, id: string) => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (r.canceled) return null;
    return characters.setReferenceImage(String(id), r.filePaths[0]).referenceImagePath ?? null;
  });
  handle(IPC.pickFolder, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
});

// Dev-only, no paid session: COMPANION_IDLE_SNAP=/dir captures the companion window (idle layer) at t=1s and t=3s
// after the window is shown, writes idle-1s.png / idle-3s.png and quits. Used to verify the keyed idle video plays.
function setupIdleSnap() {
  const dir = process.env.COMPANION_IDLE_SNAP;
  if (!dir || !companionWin) return;
  const snap = async (name: string) => {
    if (!companionWin || companionWin.isDestroyed()) return;
    const img = await companionWin.webContents.capturePage();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.png`), img.toPNG());
    // Evidence alongside the pixels: which source the idle layer uses, whether it is keyed, and the video clock.
    const dom = await companionWin.webContents.executeJavaScript(`(() => { const l = document.querySelector('[data-idle-layer]'), v = l?.querySelector('video'), c = l?.querySelector('canvas'); return { layer: l?.dataset.idleLayer ?? null, keyed: l?.dataset.keyed ?? null, rect: l ? [...Object.values(l.getBoundingClientRect().toJSON())].map(Math.round) : null, video: v ? { t: +v.currentTime.toFixed(2), paused: v.paused, ready: v.readyState, err: v.error?.code ?? null, size: [v.videoWidth, v.videoHeight] } : null, canvas: c ? [c.width, c.height] : null, root: document.getElementById('root')?.innerHTML.length ?? 0 }; })()`).catch((e: Error) => ({ error: e.message }));
    // The keyed canvas itself (read back inside a rAF, i.e. the same frame the key loop drew it): exact pixels with
    // alpha, independent of what the window compositor shows.
    const png: string | null = await companionWin.webContents.executeJavaScript(`new Promise(r => requestAnimationFrame(() => { const c = document.querySelector('[data-idle-layer] canvas'); r(c && c.width > 300 ? c.toDataURL('image/png') : null); }))`).catch(() => null);
    if (png) writeFileSync(join(dir, `${name}-canvas.png`), Buffer.from(png.split(',')[1], 'base64'));
    log('idle-snap', { file: join(dir, `${name}.png`), size: img.getSize(), canvasPng: Boolean(png), ...dom });
  };
  // t=0 is the moment the idle video (or image) has pixels; poll the renderer for that, then snap at +1s and +3s.
  const started = Date.now();
  const ready = () => companionWin?.webContents.executeJavaScript(`(() => { const l = document.querySelector('[data-idle-layer]'); const v = l?.querySelector('video'); return l ? (v ? v.readyState >= 2 && v.currentTime > 0 : Boolean(l.querySelector('img')?.complete)) : false; })()`).catch(() => false) as Promise<boolean>;
  const waitReady = async () => { while (Date.now() - started < 15000) { if (await ready()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
  companionWin.once('ready-to-show', () => void (async () => {
    const ok = await waitReady();
    log('idle-snap source ready', { ok, afterMs: Date.now() - started });
    await new Promise(r => setTimeout(r, 1000)); await snap('idle-1s');
    await new Promise(r => setTimeout(r, 2000)); await snap('idle-3s');
    app.quit();
  })());
  setTimeout(() => { log('idle-snap timeout'); app.quit(); }, 25000);
}

// Dev-only (task 07), no UI needed — the generation flow cannot be triggered over IPC from outside:
//   COMPANION_DEV_CHARACTER='{"name":…,"appearance":…}'  create (or update when "id" is given) a character; id logged as `dev character`
//   COMPANION_DEV_SET_ACTIVE=<id|new>                     make it active
//   COMPANION_DEV_GEN_PORTRAIT=<id|new|active>            run the portrait job (paid, ≈0.3 元)
//   COMPANION_DEV_GEN_IDLE=<id|new|active>                run the idle-video job after it (paid, ≈5 元)
//   COMPANION_DEV_GEN_ART=<id|new|active>                 run the Q 版 art job (bust + hero, paid, ≈0.6 元; task 09)
// Quits when the jobs are done unless COMPANION_DEV_KEEP=1. `new` = the character created by COMPANION_DEV_CHARACTER.
function setupDevCharacterJobs() {
  const env = process.env;
  if (!env.COMPANION_DEV_CHARACTER && !env.COMPANION_DEV_GEN_PORTRAIT && !env.COMPANION_DEV_GEN_IDLE && !env.COMPANION_DEV_GEN_ART && !env.COMPANION_DEV_SET_ACTIVE) return;
  let created: string | undefined;
  try {
    if (env.COMPANION_DEV_CHARACTER) { const c = characters.save(JSON.parse(env.COMPANION_DEV_CHARACTER)); created = c.id; log('dev character', c); }
    const pick = (v?: string) => (v === 'new' ? created : v === 'active' ? characters.activeId : v);
    const active = pick(env.COMPANION_DEV_SET_ACTIVE);
    if (active) { characters.setActive(active); log('dev set active', { id: active }); }
    const portraitId = pick(env.COMPANION_DEV_GEN_PORTRAIT), idleId = pick(env.COMPANION_DEV_GEN_IDLE), artId = pick(env.COMPANION_DEV_GEN_ART);
    const finish = (why: string) => { log('dev character jobs finished', why); if (env.COMPANION_DEV_KEEP !== '1') setTimeout(() => app.quit(), 1500); };
    const waitJob = (id: string, kind: CharacterJob['kind']) => new Promise<boolean>(resolve => {
      const onJob = (j: CharacterJob) => {
        if (j.characterId !== id || j.kind !== kind) return;
        if (j.phase === 'done' || j.phase === 'failed') { jobs.off('job', onJob); resolve(j.phase === 'done'); }
      };
      jobs.on('job', onJob);
    });
    void (async () => {
      if (portraitId) { const p = waitJob(portraitId, 'portrait'); startPortraitJob(portraitId); if (!(await p)) return finish('portrait failed'); }
      if (idleId) { const p = waitJob(idleId, 'idle'); startIdleJob(idleId); if (!(await p)) return finish('idle failed'); }
      if (artId) { const p = waitJob(artId, 'art'); startArtJob(artId); if (!(await p)) return finish('art failed'); }
      finish(portraitId || idleId || artId ? 'ok' : 'nothing to generate');
    })().catch(e => { log('dev character jobs error', String((e as Error)?.message ?? e)); finish('error'); });
  } catch (e) { log('dev character setup failed', String((e as Error)?.message ?? e)); setTimeout(() => app.quit(), 1000); }
}

// Dev-only scripted run (no UI needed): COMPANION_AUTOCONNECT=1 connects 3s after ready, COMPANION_AUTOTEXT is sent
// once the first frame is presented, COMPANION_AUTOSTOP_MS hangs up and quits. Paid session: keep AUTOSTOP short.
function setupDevAutomation() {
  const env = process.env;
  if (!env.COMPANION_AUTOCONNECT) return;
  const stopMs = Number(env.COMPANION_AUTOSTOP_MS || 60000);
  const hardCapMs = 3000 + 150000 + stopMs; // creation may take a while; never run longer than this from launch
  log('dev-auto', { autotext: env.COMPANION_AUTOTEXT ?? null, stopMs, hardCapMs });
  setTimeout(() => { log('dev-auto connect'); void orchestrator.connectAvatar(); }, 3000);
  let sent = false, snapped = false, stopTimer: ReturnType<typeof setTimeout> | undefined;
  const stopAndQuit = (why: string) => {
    if (stopTimer) clearTimeout(stopTimer); stopTimer = undefined;
    log('dev-auto stop', why);
    orchestrator.disconnectAvatar();
    // give the hangup a moment to go out, then quit (before-quit stops the agent)
    setTimeout(() => { log('dev-auto quit', { avatar: orchestrator.state.avatar.phase }); app.quit(); }, 2500);
  };
  // stopMs counts from the first presented frame (billing starts at the ack, but creation time is not under our control)
  let liveSeen = false;
  orchestrator.on('state', s => {
    if (!liveSeen && s.avatar.phase === 'live' && s.avatar.presented) { liveSeen = true; stopTimer = setTimeout(() => stopAndQuit('autostop'), stopMs); }
    if (liveSeen && (s.avatar.phase === 'idle' || s.avatar.phase === 'error') && stopTimer) stopAndQuit(`session ended: ${s.avatar.message}`);
  });
  setTimeout(() => stopAndQuit('hard cap'), hardCapMs);
  // COMPANION_AUTOSNAP=/dir: capture the companion window (keyed, then raw) a few seconds after the first frame.
  const snap = async (name: string) => {
    if (!companionWin || companionWin.isDestroyed()) return;
    const img = await companionWin.webContents.capturePage();
    const file = join(env.COMPANION_AUTOSNAP!, `${name}.png`);
    mkdirSync(env.COMPANION_AUTOSNAP!, { recursive: true });
    writeFileSync(file, img.toPNG());
    log('dev-auto snap', { file, size: img.getSize() });
  };
  orchestrator.on('state', s => {
    if (s.avatar.phase !== 'live' || !s.avatar.presented) return;
    if (!sent && env.COMPANION_AUTOTEXT) {
      sent = true;
      setTimeout(() => { log('dev-auto text', env.COMPANION_AUTOTEXT); void orchestrator.sendUserText(env.COMPANION_AUTOTEXT!); }, 1500);
    }
    if (!snapped && env.COMPANION_AUTOSNAP) {
      snapped = true;
      const wasKeyed = store.get().companion.greenKey;
      setTimeout(async () => {
        try {
          await snap('keyed');
          store.update({ companion: { greenKey: false } });
          await new Promise(r => setTimeout(r, 1500));
          await snap('raw');
          store.update({ companion: { greenKey: wasKeyed } });
        } catch (e) { log('dev-auto snap failed', String((e as Error)?.message ?? e)); }
      }, 4000);
    }
  });
}

app.on('window-all-closed', () => { /* tray app: keep running */ });
app.on('before-quit', () => {
  authGeneration++; authConfig = undefined; tokenDanceAuth.cancel();
  store.flush(); (app as any).isQuitting = true; orchestrator.disconnectAvatar(); orchestrator.stopAgent(); globalShortcut.unregisterAll(); });
if (!existsSync(agentEntry)) console.warn('agent-host bundle missing; run npm run build first');
