// Dev: vite dev server (renderer HMR) + esbuild watch (main/preload/agent-host) + electron with VITE_DEV_SERVER_URL.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildMain, buildAgentHost } from './build.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const url = 'http://127.0.0.1:5183';

await buildMain({ watch: true });
await buildAgentHost({ watch: true });
const vite = spawn('npx', ['vite', '--config', join(root, 'vite.config.ts')], { stdio: 'inherit', cwd: root });
await new Promise(resolve => setTimeout(resolve, 1500));
const electronBin = join(root, 'node_modules/.bin/electron');
const electron = spawn(electronBin, ['.'], { stdio: 'inherit', cwd: root, env: { ...process.env, VITE_DEV_SERVER_URL: url, COMPANION_DEV: '1' } });
const stop = () => { vite.kill(); electron.kill(); process.exit(0); };
electron.on('exit', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
