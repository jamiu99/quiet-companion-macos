import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentHostInit } from '../shared/events';

/** Public model metadata only. Credentials are injected with ModelRuntime.setRuntimeApiKey, never models.json. */
export function modelDefinition(c: AgentHostInit) {
  const anthropic = c.api === 'anthropic-messages';
  return { providers: { tokendance: {
    baseUrl: anthropic ? c.baseUrl : `${c.baseUrl.replace(/\/$/, '')}/v1`, api: c.api,
    compat: anthropic
      ? { supportsEagerToolInputStreaming: false, allowEmptySignature: true, supportsCacheControlOnTools: false, supportsLongCacheRetention: false }
      : { supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens', supportsUsageInStreaming: true },
    models: [{ id: c.model, name: c.model, reasoning: c.thinkingLevel !== 'off', input: c.vision ? ['text', 'image'] : ['text'], contextWindow: 200000, maxTokens: 16384 }],
  } } };
}
export function writeModelsJson(c: AgentHostInit) {
  mkdirSync(c.agentDir, { recursive: true, mode: 0o700 }); chmodSync(c.agentDir, 0o700);
  const file = join(c.agentDir, 'models.json'), tmp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(modelDefinition(c), null, 2), { mode: 0o600, flag: 'wx' }); renameSync(tmp, file); }
  finally { rmSync(tmp, { force: true }); }
  const settings = join(c.agentDir, 'settings.json');
  if (!existsSync(settings)) writeFileSync(settings, JSON.stringify({ defaultProvider: 'tokendance', defaultModel: c.model, compaction: { enabled: true }, enableInstallTelemetry: false, enableAnalytics: false }), { mode: 0o600, flag: 'wx' });
}
