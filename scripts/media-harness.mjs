// Offline entry point. Bundles media tests + renderer file policy; never starts main.ts or reads .env / user config.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const value = flag => { const i = args.indexOf(flag); if (i < 0) return undefined; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${flag} needs a value`); return args[i + 1]; };
const temp = mkdtempSync(join(tmpdir(), 'companion-media-'));
try {
  const baseline = value('--baseline');
  const plugins = [];
  if (baseline) {
    const old = spawnSync('git', ['show', `${baseline}:renderer/companion/greenKey.ts`], { cwd: root, encoding: 'utf8' });
    if (old.status !== 0) throw new Error(old.stderr);
    const path = join(temp, 'baseline-green-key.ts'); writeFileSync(path, old.stdout);
    plugins.push({ name: 'baseline-key', setup(b) {
      b.onResolve({ filter: /\/greenKey$/ }, () => ({ path }));
      b.onLoad({ filter: /baseline-green-key\.ts$/ }, () => ({ contents: old.stdout, loader: 'ts', resolveDir: join(root, 'renderer/companion') }));
    } });
  }
  const bundle = join(temp, 'tests.js');
  await build({ entryPoints: [join(root, 'tests/media/green-key.browser.ts')], outfile: bundle, bundle: true, platform: 'browser', format: 'iife', globalName: 'MediaHarness', plugins });
  await build({ entryPoints: [join(root, 'electron/security/renderer.ts')], outfile: join(temp, 'renderer-security.cjs'), bundle: true, platform: 'node', format: 'cjs' });
  const out = resolve(value('--out') ?? join(root, '.cache/media-harness'));
  const video = value('--video');
  const times = (value('--times') ?? (video ? '0.1,1,2,3,4' : '0.5,3,7.7')).split(',').map(Number);
  if (!times.length || times.some(t => !Number.isFinite(t) || t < 0) || times.some((t, i) => i > 0 && t <= times[i - 1])) throw new Error('--times must be nonnegative, strictly increasing seconds');
  const options = { root, bundle, out, temp, baseline, video: video && resolve(video), times, software: args.includes('--software') };
  // Strip app automation hooks / credentials even though this entry point cannot load the production main process.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COMPANION_|VIDU_|TOKENDANCE_|ELECTRON_RUN_AS_NODE)/.test(k)));
  const result = spawnSync(require('electron'), [join(root, 'scripts/media-harness-electron.mjs'), JSON.stringify(options)], { cwd: root, env, stdio: 'inherit', timeout: 120000 });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
