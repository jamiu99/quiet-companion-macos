// agent-host: a child process that owns one pi AgentSession and talks JSON lines over stdio.
// stdout is reserved for protocol messages; all logging goes through {type:'log'} or stderr.
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import type { AgentHostInit, AgentToHost, HostToAgent } from '@shared/events';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { writeModelsJson } from './models';
import { redactPayload, rememberSecrets } from '../electron/security/redact';
import { createCompanionSayTool } from './tools/companion-say';
import { macTools } from './tools/mac';
import BUNDLED_PROMPT from './prompts/companion.md';

const send = (m: AgentToHost) => process.stdout.write(JSON.stringify(redactPayload(m)) + '\n');
const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => send({ type: 'log', level, message });
console.log = (...a) => log('info', a.map(String).join(' '));
console.warn = (...a) => log('warn', a.map(String).join(' '));
console.error = (...a) => log('error', a.map(String).join(' '));

const here = dirname(fileURLToPath(import.meta.url));
// Prompt file lookup: dev (dist/agent-host → ../../agent-host/prompts), packaged (Contents/Resources/app/agent-host/prompts,
// or app.asar.unpacked / Resources if the layout changes). Editing the file on disk overrides the bundled copy.
const resourcesPath: string | undefined = (process as any).resourcesPath;
const promptFile = [
  join(here, 'prompts/companion.md'),
  join(here, '../agent-host/prompts/companion.md'),
  join(here, '../../agent-host/prompts/companion.md'),
  ...(resourcesPath ? [join(resourcesPath, 'app/agent-host/prompts/companion.md'), join(resourcesPath, 'app.asar.unpacked/agent-host/prompts/companion.md'), join(resourcesPath, 'agent-host/prompts/companion.md')] : []),
].find(existsSync);
const COMPANION_PROMPT = promptFile ? readFileSync(promptFile, 'utf8') : BUNDLED_PROMPT;

let session: AgentSession | undefined;
let config: AgentHostInit | undefined;
let modelRuntime: ModelRuntime | undefined;
let currentPromptId = '';
let finalText = '';
let aborted = false;

async function init(c: AgentHostInit) {
  rememberSecrets(c.apiKey);
  config = c;
  mkdirSync(c.workspace, { recursive: true });
  writeModelsJson(c);
  modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(c.agentDir, 'models.json'), modelsStorePath: join(c.agentDir, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey('tokendance', c.apiKey);
  await createSession();
}

async function createSession() {
  const c = config!;
  session?.dispose();
  const model = modelRuntime!.getModel('tokendance', c.model);
  if (!model) throw new Error(`模型未注册：tokendance/${c.model}`);
  const loader = new DefaultResourceLoader({
    cwd: c.workspace, agentDir: c.agentDir,
    // Do not load the user's global extensions/skills/prompts; keep the agent minimal and predictable.
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [{ path: '/virtual/COMPANION.md', content: COMPANION_PROMPT + (c.systemPromptExtra ? `\n\n${c.systemPromptExtra}` : '') }] }),
  } as any);
  await loader.reload();
  const customTools = [createCompanionSayTool((text, mood, action) => send({ type: 'companion_say', text, mood, action })), ...macTools];
  const tools = Array.from(new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', ...customTools.map(t => t.name), ...(c.extraTools ?? [])]));
  const result = await createAgentSession({
    cwd: c.workspace, agentDir: c.agentDir, modelRuntime, model, thinkingLevel: c.thinkingLevel,
    tools, customTools, resourceLoader: loader, sessionManager: SessionManager.inMemory(c.workspace),
  });
  session = result.session;
  session.subscribe(onSessionEvent);
  send({ type: 'ready', model: `${model.provider}/${model.id}`, tools });
  send({ type: 'status', status: 'idle' });
}

const summarizeArgs = (name: string, args: any): string => {
  if (!args || typeof args !== 'object') return '';
  const pick = args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.target ?? args.app ?? args.text ?? args.script ?? args.title ?? args.action ?? args.filename ?? '';
  return String(pick).replace(/\s+/g, ' ').slice(0, 120);
};
const summarizeResult = (result: any): string => {
  const t = result?.content?.find?.((c: any) => c.type === 'text')?.text ?? (typeof result === 'string' ? result : '');
  return String(t).replace(/\s+/g, ' ').slice(0, 160);
};

function onSessionEvent(event: any) {
  switch (event.type) {
    case 'agent_start': finalText = ''; aborted = false; send({ type: 'status', status: 'running', activity: '思考中…' }); send({ type: 'event', event: { type: 'agent_start', promptId: currentPromptId } }); break;
    case 'message_update': {
      const e = event.assistantMessageEvent;
      if (e?.type === 'text_delta') send({ type: 'event', event: { type: 'text_delta', delta: e.delta } });
      else if (e?.type === 'thinking_delta') send({ type: 'event', event: { type: 'thinking_delta', delta: e.delta } });
      break;
    }
    case 'tool_execution_start': send({ type: 'event', event: { type: 'tool_start', toolCallId: event.toolCallId, name: event.toolName, summary: summarizeArgs(event.toolName, event.args) } }); break;
    case 'tool_execution_end': send({ type: 'event', event: { type: 'tool_end', toolCallId: event.toolCallId, name: event.toolName, ok: !event.isError, summary: summarizeResult(event.result) } }); break;
    case 'turn_end': {
      const m = event.message;
      const text = Array.isArray(m?.content) ? m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') : '';
      if (text.trim()) finalText = text.trim();
      send({ type: 'event', event: { type: 'turn_end', text } });
      break;
    }
    case 'agent_end': {
      if (event.willRetry) break;
      const last = [...(event.messages ?? [])].reverse().find((m: any) => m.role === 'assistant');
      // pi marks the assistant message 'aborted' only when the abort lands mid-stream; an abort during tool
      // execution leaves stopReason='toolUse', so we also remember our own abort request (set in handle()).
      if (last?.stopReason === 'aborted') aborted = true;
      if (last?.errorMessage) send({ type: 'event', event: { type: 'error', message: String(last.errorMessage).slice(0, 500) } });
      send({ type: 'event', event: { type: 'agent_end', promptId: currentPromptId, finalText, aborted } });
      send({ type: 'status', status: 'idle' });
      break;
    }
    case 'auto_retry_start': send({ type: 'status', status: 'running', activity: `模型请求重试 ${event.attempt}/${event.maxAttempts}` }); break;
  }
}

async function handle(m: HostToAgent) {
  switch (m.type) {
    case 'init': await init(m.config); break;
    case 'prompt': {
      if (!session) throw new Error('session 未就绪');
      currentPromptId = m.id;
      // steer/followUp only make sense while the agent is streaming: pi queues them and never drains the queue when
      // idle. The host's view of "running" can lag behind agent_end by a few ms, so decide here, on the real state.
      const streaming = session.isStreaming;
      if (!streaming) void session.prompt(m.text).catch(e => send({ type: 'event', event: { type: 'error', message: String(e?.message ?? e).slice(0, 500) } }));
      else if (m.behavior === 'followUp') await session.followUp(m.text);
      else await session.steer(m.text);
      break;
    }
    case 'abort': aborted = true; await session?.abort(); break;
    case 'reset': await createSession(); break;
    case 'shutdown': session?.dispose(); process.exit(0);
  }
}

const rl = createInterface({ input: process.stdin });
let queue: Promise<void> = Promise.resolve();
rl.on('line', line => {
  if (!line.trim()) return;
  let m: HostToAgent;
  try { m = JSON.parse(line); } catch { log('warn', '收到无效协议消息，已忽略'); return; }
  queue = queue.then(() => handle(m)).catch(e => { const msg = String(e?.stack ?? e).slice(0, 1000); if (m.type === 'init') send({ type: 'fatal', message: msg }); else send({ type: 'event', event: { type: 'error', message: msg } }); });
});
rl.on('close', () => { session?.dispose(); process.exit(0); });
process.on('uncaughtException', e => { send({ type: 'fatal', message: `uncaught: ${String(e?.stack ?? e).slice(0, 1000)}` }); });
process.on('unhandledRejection', e => { log('error', `unhandledRejection: ${String((e as any)?.stack ?? e).slice(0, 1000)}`); });

// Standalone dev mode: `node dist/agent-host/index.mjs --cwd DIR` reads keys from env and runs an interactive stdin loop of raw text.
if (process.argv.includes('--cwd')) {
  const cwd = process.argv[process.argv.indexOf('--cwd') + 1];
  const apiKey = process.env.TOKENDANCE_API_KEY ?? '';
  if (!apiKey) { process.stderr.write('TOKENDANCE_API_KEY missing\n'); process.exit(1); }
  await init({ apiKey, baseUrl: process.env.TOKENDANCE_BASE_URL ?? 'https://tokendance.space/gateway', api: 'anthropic-messages', model: process.env.COMPANION_MODEL ?? 'kimi-k2.7-code', thinkingLevel: 'low', workspace: cwd, extraTools: [], agentDir: join(cwd, '.pi-agent'), vision: process.env.COMPANION_VISION === '1' });
  process.stderr.write('ready; type a prompt as raw text (or JSON protocol lines)\n');
  rl.removeAllListeners('line');
  rl.on('line', line => { if (line.trim().startsWith('{')) void handle(JSON.parse(line)); else if (line.trim()) void handle({ type: 'prompt', id: String(Date.now()), text: line, behavior: 'auto' }); });
}
