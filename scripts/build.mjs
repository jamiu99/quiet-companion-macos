// Builds: electron main + preload (cjs), agent-host (esm bundle, pi SDK kept external), renderer (vite).
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7);
const watch = process.argv.includes('--watch');
const want = name => !only || only === name;

export async function buildMain({ watch = false } = {}) {
  const common = { bundle: true, platform: 'node', target: 'node24', sourcemap: true, logLevel: 'info', alias: { '@shared': join(root, 'shared') } };
  const jobs = [
    { entryPoints: [join(root, 'electron/main.ts')], outfile: join(root, 'dist/electron/main.cjs'), format: 'cjs', external: ['electron'] },
    { entryPoints: [join(root, 'electron/preload.ts')], outfile: join(root, 'dist/electron/preload.cjs'), format: 'cjs', external: ['electron'] },
  ];
  if (watch) {
    const { context } = await import('esbuild');
    for (const job of jobs) { const ctx = await context({ ...common, ...job }); await ctx.watch(); }
  } else for (const job of jobs) await build({ ...common, ...job });
}

export async function buildAgentHost({ watch = false } = {}) {
  const job = {
    entryPoints: [join(root, 'agent-host/index.ts')], outfile: join(root, 'dist/agent-host/index.mjs'),
    bundle: true, platform: 'node', target: 'node24', format: 'esm', sourcemap: true, logLevel: 'info',
    alias: { '@shared': join(root, 'shared') },
    // prompts/companion.md is embedded as a string fallback so the packaged app never depends on the file lookup.
    loader: { '.md': 'text' },
    // pi SDK stays external: it is large, has its own shrinkwrap, and resolves from node_modules at runtime.
    external: ['@earendil-works/*', 'typebox'],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  };
  if (watch) { const { context } = await import('esbuild'); const ctx = await context(job); await ctx.watch(); }
  else await build(job);
}

export function buildRenderer() {
  const result = spawnSync('npx', ['vite', 'build', '--config', join(root, 'vite.config.ts')], { stdio: 'inherit', cwd: root });
  if (result.status !== 0) throw new Error('vite build failed');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (want('main')) await buildMain({ watch });
  if (want('agent-host')) await buildAgentHost({ watch });
  if (want('renderer') && !watch) buildRenderer();
}
