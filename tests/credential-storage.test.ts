import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../electron/config-store';
import { writeModelsJson } from '../agent-host/models';
import type { AgentHostInit } from '../shared/events';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'qc-credentials-')); dirs.push(d); return d; };
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

it('commits private credentials before notifying and keeps the previous config on write failure', () => {
  const dir = temp(), file = join(dir, 'config.json'), store = new ConfigStore(file);
  store.commit({ agent: { apiKey: 'fixture-old-key' } });
  const listener = vi.fn(() => expect(JSON.parse(readFileSync(file, 'utf8')).agent.apiKey).toBe(store.get().agent.apiKey));
  store.onChange(listener);
  const save = vi.spyOn(store as unknown as { save(c: unknown): void }, 'save').mockImplementation(() => { throw new Error('fixture-disk-error'); });
  expect(() => store.commit({ agent: { apiKey: 'fixture-new-key' } })).toThrow('fixture-disk-error');
  expect(store.get().agent.apiKey).toBe('fixture-old-key'); expect(listener).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(file, 'utf8')).agent.apiKey).toBe('fixture-old-key'); save.mockRestore();
  store.commit({ agent: { apiKey: 'fixture-new-key' } });
  expect(listener).toHaveBeenCalledTimes(1); expect(statSync(file).mode & 0o777).toBe(0o600); expect(statSync(dir).mode & 0o777).toBe(0o700);
});

it('loads the real pi model runtime with only an in-memory key, without starting an agent or persisting credentials', async () => {
  const dir = temp(), key = 'fixture-memory-only-key';
  const config: AgentHostInit = { apiKey: key, baseUrl: 'https://tokendance.space/gateway', api: 'anthropic-messages', model: 'fixture-model', thinkingLevel: 'off', workspace: dir, extraTools: [], agentDir: dir };
  // Replaces the earlier version's key-containing file rather than keeping a second copy / backup.
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ apiKey: 'fixture-legacy-key' }), { mode: 0o644 });
  writeModelsJson(config);
  const models = readFileSync(join(dir, 'models.json'), 'utf8');
  expect(models).not.toMatch(/apiKey|fixture-legacy-key|fixture-memory-only-key/);
  expect(statSync(join(dir, 'models.json')).mode & 0o777).toBe(0o600);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(dir, 'models.json'), modelsStorePath: join(dir, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
  expect(runtime.getModel('tokendance', 'fixture-model')).toBeDefined();
  await runtime.setRuntimeApiKey('tokendance', key);
  expect(await runtime.getAuth('tokendance')).toMatchObject({ auth: { apiKey: key } });
  expect(existsSync(join(dir, 'auth.json'))).toBe(false);
  for (const name of readdirSync(dir)) if (statSync(join(dir, name)).isFile()) expect(readFileSync(join(dir, name), 'utf8')).not.toContain(key);
  await runtime.removeRuntimeApiKey('tokendance');
});
