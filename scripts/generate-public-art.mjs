import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = dirname(dirname(fileURLToPath(import.meta.url))), args = process.argv.slice(2), at = args.indexOf('--out');
if (at < 0 || !args[at + 1]) throw new Error('Usage: npm run assets:public -- --out /new/staging-directory');
const profile = mkdtempSync(join(tmpdir(), 'qc-original-art-'));
try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VIDU_|TOKENDANCE_|COMPANION_|ELECTRON_RUN_AS_NODE)/.test(k)));
  const result = spawnSync(createRequire(import.meta.url)('electron'), [join(root, 'scripts/public-art-electron.mjs'), JSON.stringify({ out: resolve(args[at + 1]), profile })], { cwd: root, env, stdio: 'inherit', timeout: 65000 });
  if (result.error) throw result.error; if (result.status !== 0) throw new Error('Original artwork generation failed');
  console.log('Original artwork generated offline; existing files were not overwritten.');
} finally { rmSync(profile, { recursive: true, force: true }); }
