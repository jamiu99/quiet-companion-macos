import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { redactSecrets } from './security/redact';
import { dirname } from 'node:path';
let file = '', bytes = 0;
const MAX_BYTES = 5 * 1024 * 1024;
export function initLog(path: string) {
  file = path; mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(file)) { chmodSync(file, 0o600); bytes = statSync(file).size; } else bytes = 0;
  log('---- start', new Date().toISOString());
}
export function log(...parts: unknown[]) {
  const text = parts.map(p => { try { return typeof p === 'string' ? p : JSON.stringify(p); } catch { return '[unserializable]'; } }).join(' ');
  const line = `${new Date().toISOString()} [${process.pid}] ${redactSecrets(text).slice(0, 16000)}\n`;
  if (process.env.COMPANION_DEV) console.log(line.trimEnd());
  if (file) { try {
    const size = Buffer.byteLength(line);
    if (bytes + size > MAX_BYTES) { rmSync(`${file}.1`, { force: true }); if (existsSync(file)) renameSync(file, `${file}.1`); bytes = 0; }
    appendFileSync(file, line, { mode: 0o600 }); bytes += size;
  } catch { /* logging must not crash the app */ } }
}
