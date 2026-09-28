// Explicit paid, bounded integration run. Uses production main / renderer and a fresh private profile.
import { build } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildMain, buildAgentHost, buildRenderer } from './build.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url))), require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const get = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1]; };
if (!args.includes('--paid')) throw new Error('This creates ONE paid Vidu session. Pass --paid explicitly.');
const seconds = Number(get('--seconds', '480')), sampleMs = Number(get('--sample-ms', '3000'));
if (!Number.isInteger(seconds) || seconds < 30 || seconds > 540 || !Number.isInteger(sampleMs) || sampleMs < 1000 || sampleMs > 30000) throw new Error('seconds: 30–540; sample-ms: 1000–30000');
mkdirSync(join(root, '.cache/live-soak'), { recursive: true, mode: 0o700 });
const requestedOut = get('--out', '');
const out = requestedOut ? resolve(requestedOut) : mkdtempSync(join(root, '.cache/live-soak/run-'));
mkdirSync(out, { recursive: true, mode: 0o700 });
if (readdirSync(out).length) throw new Error('--out must be empty; do not mix evidence from different runs');
const profile = join(out, 'private-profile'); mkdirSync(profile, { recursive: true, mode: 0o700 });
try {
  await buildMain(); await buildAgentHost(); buildRenderer();
  await build({ entryPoints: [join(root, 'shared/config.ts')], outfile: join(profile, 'defaults.cjs'), bundle: true, platform: 'node', format: 'cjs' });
  const config = structuredClone(require(join(profile, 'defaults.cjs')).DEFAULT_CONFIG);
  const reference = get('--image', '');
  if (reference) {
    const path = resolve(reference), stat = statSync(path);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024 || !/\.(png|jpe?g|webp)$/i.test(path)) throw new Error('--image requires a local PNG/JPEG/WebP <=10 MiB');
    config.vidu.imagePath = path; config.companion.idleImagePath = path;
    // A custom portrait must not inherit the default character's idle video during migration.
    config.characters = [{ id: 'soak-fixture', name: '测试角色', personality: '自然、轻松', appearance: '保留参考图的角色外观', style: 'follow-reference', voice: config.vidu.voice, portraitPath: path, createdAt: Date.now(), updatedAt: Date.now() }];
    config.activeCharacterId = 'soak-fixture';
  }
  config.vidu.maxMinutes = Math.min(10, Math.ceil(seconds / 60) + 1);
  config.agent.workspace = join(profile, 'workspace');
  config.companion.scale = 0.5; config.companion.lockMove = true; config.companion.lockSize = true;
  config.ui.autoConnectOnMessage = false; config.ui.toggleBarHotkey = '';
  writeFileSync(join(profile, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  const old = spawnSync('git', ['show', '53898ed:renderer/companion/greenKey.ts'], { cwd: root, encoding: 'utf8' });
  if (old.status !== 0) throw new Error('Historical shader 53898ed is required for this comparison harness');
  await build({ entryPoints: [join(root, 'scripts/live-soak-browser.ts')], outfile: join(out, 'sampler.js'), bundle: true, platform: 'browser', format: 'iife', globalName: 'LiveSoak', plugins: [{ name: 'legacy-key', setup(b) {
    b.onResolve({ filter: /^legacy-green-key$/ }, () => ({ path: 'legacy', namespace: 'legacy' }));
    b.onLoad({ filter: /.*/, namespace: 'legacy' }, () => ({ contents: old.stdout, loader: 'ts' }));
  } }] });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COMPANION_|ELECTRON_RUN_AS_NODE|VITE_DEV_SERVER_URL)/.test(k)));
  Object.assign(env, { COMPANION_USER_DATA: profile, COMPANION_SMOKE_NO_AGENT: '1' });
  // ConfigStore reads the project's .env itself; never copy it or print its values here.
  console.log(`PAID SOAK: one session, ${seconds}s after first frame; output=${out}`);
  process.exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(require('electron'), [join(root, 'scripts/live-soak-electron.mjs'), JSON.stringify({ root, out, seconds, sampleMs })], { cwd: root, env, stdio: 'inherit' });
    let killTimer;
    const stop = () => { child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 120000); };
    const deadline = setTimeout(stop, seconds * 1000 + 240000);
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const cleanup = () => { clearTimeout(deadline); clearTimeout(killTimer); process.off('SIGINT', stop); process.off('SIGTERM', stop); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', code => { cleanup(); resolveExit(code ?? 1); });
  });
} finally {
  // All normal exits / handled signals erase credentials. SIGKILL / power loss cannot run any finally handler.
  rmSync(profile, { recursive: true, force: true });
}
