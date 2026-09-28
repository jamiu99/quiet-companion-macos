import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_CONFIG, mergeConfig, type AppConfig } from '@shared/config';

export function expandHome(p: string): string { return p.startsWith('~') ? join(homedir(), p.slice(1)) : p; }

/** Reads KEY=VALUE lines; used only to seed an empty config from .env / .env.example next to the project. */
function readDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) { const v = m[2].replace(/^["']|["']$/g, ''); if (v) out[m[1]] = v; }
  }
  return out;
}

export class ConfigStore {
  private config: AppConfig;
  private listeners = new Set<(c: AppConfig) => void>();
  constructor(private readonly file: string, seedEnvPaths: string[] = []) {
    this.config = structuredClone(DEFAULT_CONFIG);
    try {
      if (existsSync(file)) this.config = mergeConfig(DEFAULT_CONFIG, JSON.parse(readFileSync(file, 'utf8')));
    } catch { /* corrupt file: fall back to defaults, keep the bad file untouched until next save */ }
    // Seed keys from env / .env files when the stored config has none.
    // Later paths never override earlier ones (first path wins); process.env wins over files.
    const env = { ...seedEnvPaths.map(readDotEnv).reduceRight((a, b) => ({ ...a, ...b }), {}), ...pickEnv(process.env) };
    let dirty = false;
    if (!this.config.vidu.apiKey && env.VIDU_API_KEY) { this.config.vidu.apiKey = env.VIDU_API_KEY; dirty = true; }
    if (env.VIDU_HOST === 'api.vidu.com' || env.VIDU_HOST === 'api.vidu.cn') { if (this.config.vidu.host !== env.VIDU_HOST && !existsSync(file)) { this.config.vidu.host = env.VIDU_HOST; dirty = true; } }
    if (!this.config.agent.apiKey && env.TOKENDANCE_API_KEY) { this.config.agent.apiKey = env.TOKENDANCE_API_KEY; dirty = true; }
    if (env.TOKENDANCE_BASE_URL && !existsSync(file)) { this.config.agent.baseUrl = env.TOKENDANCE_BASE_URL; dirty = true; }
    if (dirty || !existsSync(file)) this.save();
  }
  get(): AppConfig { return this.config; }
  private saveTimer?: ReturnType<typeof setTimeout>;
  update(patch: Record<string, unknown>): AppConfig {
    this.config = mergeConfig(this.config, patch);
    // Sliders call update() on every tick: keep memory current, write the file at most every 250 ms (flush() on quit).
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; this.save(); }, 250);
    this.saveTimer.unref?.();
    for (const l of this.listeners) l(this.config);
    return this.config;
  }
  /** Durably commit credentials before publishing them. A write error leaves the old in-memory config intact. */
  commit(patch: Record<string, unknown>): AppConfig {
    const next = mergeConfig(this.config, patch);
    this.save(next);
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    this.config = next;
    for (const l of this.listeners) l(this.config);
    return this.config;
  }
  /** Write any pending change now (call before quit). */
  flush() { if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; this.save(); } }
  onChange(l: (c: AppConfig) => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  private save(config = this.config) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }); chmodSync(dirname(this.file), 0o700);
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
      renameSync(tmp, this.file); // Atomic replacement also repairs an existing overly permissive file mode.
    } finally { rmSync(tmp, { force: true }); }
  }
}
function pickEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['VIDU_API_KEY', 'VIDU_HOST', 'TOKENDANCE_API_KEY', 'TOKENDANCE_BASE_URL']) if (env[k]) out[k] = env[k]!;
  return out;
}
