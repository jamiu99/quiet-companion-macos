// Scripted test harness for agent-host (no Electron). Spawns dist/agent-host/index.mjs, speaks the JSON-lines
// protocol, and prints a timeline + summary for each run. Never touches Vidu.
//
//   node scripts/agent-bench.mjs --task all --runs 3            # every quick task in DEFAULT_CONFIG, 3× each
//   node scripts/agent-bench.mjs --task weather                 # one quick task
//   node scripts/agent-bench.mjs --prompt "读剪贴板告诉我"       # ad-hoc prompt
//   node scripts/agent-bench.mjs --model glm-5.3-flashx [--api openai-completions]
//   node scripts/agent-bench.mjs --scenario steer|abort         # stability scenarios
// Env: TOKENDANCE_API_KEY (required), TOKENDANCE_BASE_URL, BENCH_WS (workspace, default /tmp/qc-agent-ws)
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const has = name => process.argv.includes(`--${name}`);

const envFile = join(root, '.env');
const dotenv = existsSync(envFile) ? Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => l.split('=').map(s => s.trim()))) : {};
const apiKey = process.env.TOKENDANCE_API_KEY || dotenv.TOKENDANCE_API_KEY;
if (!apiKey) { console.error('TOKENDANCE_API_KEY missing'); process.exit(1); }

const model = arg('model', 'kimi-k2.7-code');
const api = arg('api', 'anthropic-messages');
const runs = Number(arg('runs', 1));
const thinkingLevel = arg('thinking', 'low');
const ws = process.env.BENCH_WS || arg('ws', '/tmp/qc-agent-ws');
const perRunTimeout = Number(arg('timeout', 90)) * 1000;
mkdirSync(ws, { recursive: true });

// Load DEFAULT_CONFIG from shared/config.ts (bundled on the fly so this script has no TS dependency).
async function loadSharedConfig() {
  const out = join(ws, '.bench-config.mjs');
  await build({ entryPoints: [join(root, 'shared/config.ts')], outfile: out, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
  return import(`file://${out}?t=${Date.now()}`);
}
const shared = await loadSharedConfig();
// Same rule as the orchestrator: image input follows the model preset unless overridden.
const vision = has('no-vision') ? false : has('vision') ? true : Boolean(shared.TOKENDANCE_MODEL_PRESETS.find(p => p.id === model)?.vision);

// ---- child process wrapper ----
class Host {
  constructor() {
    this.child = spawn(process.execPath, [join(root, 'dist/agent-host/index.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PI_OFFLINE: '1', NO_COLOR: '1' }, cwd: ws });
    this.listeners = new Set();
    let buf = '';
    this.child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { console.log('  [non-json stdout]', line.slice(0, 200)); continue; }
        for (const l of this.listeners) l(m);
      }
    });
    this.child.stderr.on('data', d => { const s = String(d).trim(); if (s && has('verbose')) console.log('  [stderr]', s.slice(0, 300)); });
    this.exited = new Promise(r => this.child.on('exit', r));
  }
  send(m) { this.child.stdin.write(JSON.stringify(m) + '\n'); }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  waitFor(pred, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(new Error('timeout')); }, ms);
      const off = this.on(m => { if (pred(m)) { clearTimeout(t); off(); resolve(m); } });
    });
  }
  async init() {
    this.send({ type: 'init', config: { apiKey, baseUrl: process.env.TOKENDANCE_BASE_URL || dotenv.TOKENDANCE_BASE_URL || 'https://tokendance.space/gateway', api, model, thinkingLevel, workspace: ws, extraTools: [], agentDir: join(ws, '.pi-agent'), vision, systemPromptExtra: `当前时间：${new Date().toLocaleString('zh-CN')}。` } });
    const m = await this.waitFor(m => m.type === 'ready' || m.type === 'fatal', 30000);
    if (m.type === 'fatal') throw new Error(`fatal: ${m.message}`);
    return m;
  }
  async reset() { this.send({ type: 'reset' }); await this.waitFor(m => m.type === 'ready', 30000); }
  shutdown() { this.send({ type: 'shutdown' }); setTimeout(() => this.child.kill('SIGKILL'), 3000).unref(); return this.exited; }
}

const fmt = ms => `${(ms / 1000).toFixed(1)}s`;

/** Run one prompt to agent_end; returns a record with timeline data. */
async function runPrompt(host, text, { label = '', quiet = false } = {}) {
  const rec = { label, text, t0: Date.now(), says: [], tools: [], errors: [], retries: 0, finalText: '', aborted: false, ended: false, ms: 0 };
  const id = `p${Date.now()}`;
  const off = host.on(m => {
    const dt = Date.now() - rec.t0;
    if (m.type === 'companion_say') { rec.says.push({ dt, text: m.text }); if (!quiet) console.log(`  [${fmt(dt)}] SAY  ${m.text}`); }
    else if (m.type === 'status' && m.activity?.includes('重试')) { rec.retries++; if (!quiet) console.log(`  [${fmt(dt)}] RETRY ${m.activity}`); }
    else if (m.type === 'log' && m.level !== 'debug' && has('verbose')) console.log(`  [${fmt(dt)}] LOG(${m.level}) ${m.message.slice(0, 200)}`);
    else if (m.type === 'event') {
      const e = m.event;
      if (e.type === 'tool_start') { rec.tools.push({ dt, name: e.name, summary: e.summary }); if (!quiet) console.log(`  [${fmt(dt)}] TOOL ${e.name} ${e.summary}`); }
      else if (e.type === 'tool_end') { if (!e.ok) rec.errors.push(`tool ${e.name}: ${e.summary}`); if (!quiet) console.log(`  [${fmt(dt)}]   ${e.ok ? '✓' : '✗'} ${e.summary.slice(0, 100)}`); }
      else if (e.type === 'error') { rec.errors.push(e.message); if (!quiet) console.log(`  [${fmt(dt)}] ERROR ${e.message.slice(0, 200)}`); }
      else if (e.type === 'agent_end') { rec.finalText = e.finalText; rec.aborted = e.aborted; rec.ended = true; rec.ms = dt; if (!quiet) console.log(`  [${fmt(dt)}] END${e.aborted ? ' (aborted)' : ''} ${e.finalText.replace(/\s+/g, ' ').slice(0, 200)}`); }
    }
  });
  host.send({ type: 'prompt', id, text, behavior: 'auto' });
  try { await host.waitFor(m => m.type === 'event' && m.event.type === 'agent_end', perRunTimeout); }
  catch { rec.errors.push(`timeout ${fmt(perRunTimeout)}`); rec.ms = Date.now() - rec.t0; host.send({ type: 'abort' }); }
  off();
  return rec;
}

// OK = finished with an answer and no tool errors; 'recovered' = a tool call failed (e.g. grep exit 1) but the agent
// carried on and still answered; FAIL = timeout / abort / no answer / model error.
const toolErrors = rec => rec.errors.filter(e => e.startsWith('tool ')).length;
const finished = rec => rec.ended && !rec.aborted && rec.finalText.trim().length > 0 && rec.errors.every(e => e.startsWith('tool '));
const okRun = rec => finished(rec);
const verdict = rec => !finished(rec) ? 'FAIL' : toolErrors(rec) ? `OK(recovered:${toolErrors(rec)})` : 'OK';
/** Reporting rhythm: a task longer than 12 s should have an opening companion_say within 5 s. */
const rhythm = rec => rec.ms <= 12000 ? (rec.says.length === 0 ? 'ok' : 'chatty') : rec.says[0] && rec.says[0].dt <= 5000 ? 'ok' : 'late';

async function benchTasks(tasks) {
  const host = new Host();
  const ready = await host.init();
  console.log(`model=${ready.model} vision=${vision} thinking=${thinkingLevel} tools=${ready.tools.length} ws=${ws}\n`);
  const results = [];
  for (const task of tasks) {
    for (let i = 1; i <= runs; i++) {
      console.log(`▶ ${task.id} #${i}: ${task.prompt.slice(0, 80)}`);
      if (results.length) await host.reset();
      const rec = await runPrompt(host, task.prompt, { label: `${task.id}#${i}` });
      results.push({ task: task.id, run: i, rec });
      console.log(`  → ${verdict(rec)} ${fmt(rec.ms)} tools=${rec.tools.length} says=${rec.says.length}${rec.says.length ? ` (first @${fmt(rec.says[0].dt)})` : ''} rhythm=${rhythm(rec)}${rec.errors.length ? ` errors=${rec.errors.join(' | ').slice(0, 200)}` : ''}\n`);
    }
  }
  await host.shutdown();
  console.log('\n==== SUMMARY ====');
  console.log('task'.padEnd(22), 'run', 'verdict'.padEnd(16), 'time  ', 'tools', 'says', 'firstSay', 'rhythm');
  for (const r of results) console.log(r.task.padEnd(22), String(r.run).padEnd(3), verdict(r.rec).padEnd(16), fmt(r.rec.ms).padEnd(6), String(r.rec.tools.length).padEnd(5), String(r.rec.says.length).padEnd(4), (r.rec.says[0] ? fmt(r.rec.says[0].dt) : '-').padEnd(8), rhythm(r.rec));
  const byTask = {};
  for (const r of results) { byTask[r.task] ??= { ok: 0, clean: 0, n: 0 }; byTask[r.task].n++; if (okRun(r.rec)) byTask[r.task].ok++; if (okRun(r.rec) && !toolErrors(r.rec)) byTask[r.task].clean++; }
  console.log('\nper task (finished/total, clean=no tool errors):', Object.entries(byTask).map(([k, v]) => `${k} ${v.ok}/${v.n} (clean ${v.clean})`).join(', '));
  return results;
}

async function scenarioSteer() {
  const host = new Host();
  await host.init();
  console.log('scenario: prompt + 3 steers while running');
  const ends = [];
  const says = [];
  host.on(m => {
    if (m.type === 'companion_say') says.push(m.text);
    if (m.type === 'event' && ['tool_start', 'agent_end', 'turn_end'].includes(m.event.type)) console.log(`  [${fmt(Date.now() - t0)}]`, m.event.type, (m.event.summary ?? m.event.finalText ?? m.event.text ?? '').replace(/\s+/g, ' ').slice(0, 120));
    if (m.type === 'event' && m.event.type === 'agent_end') ends.push(m.event);
  });
  const t0 = Date.now();
  host.send({ type: 'prompt', id: 'a', text: '在工作目录依次创建 a1.txt、a2.txt、a3.txt 三个文件，每个文件用单独一次 bash 命令创建，内容写文件名，最后告诉我。', behavior: 'auto' });
  await host.waitFor(m => m.type === 'event' && m.event.type === 'tool_start', 30000);
  for (const [i, t] of ['另外再创建 b1.txt 内容写 B1', '还要创建 b2.txt 内容写 B2', '最后创建 b3.txt 内容写 B3'].entries()) {
    host.send({ type: 'prompt', id: `s${i}`, text: t, behavior: 'steer' });
    await new Promise(r => setTimeout(r, 300));
  }
  // Wait until idle for a while (steers may extend the run).
  await host.waitFor(m => m.type === 'event' && m.event.type === 'agent_end', 120000);
  await new Promise(r => setTimeout(r, 2000));
  const files = ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'].map(n => `${n}.txt`).filter(f => existsSync(join(ws, f)));
  console.log(`\nagent_end count=${ends.length}; files present: ${files.join(', ')}`);
  console.log(files.length === 6 ? 'STEER OK: all 6 files created' : `STEER FAIL: missing ${6 - files.length}`);
  await host.shutdown();
}

async function scenarioAbort() {
  const host = new Host();
  await host.init();
  console.log('scenario: abort mid-run → agent_end.aborted should be true');
  const t0 = Date.now();
  const p = host.waitFor(m => m.type === 'event' && m.event.type === 'agent_end', 60000);
  host.send({ type: 'prompt', id: 'a', text: '用 bash 执行 sleep 20，然后告诉我完成了。执行前先用 companion_say 说一句。', behavior: 'auto' });
  await host.waitFor(m => m.type === 'event' && m.event.type === 'tool_start' && m.event.name === 'bash', 30000);
  await new Promise(r => setTimeout(r, 1500));
  host.send({ type: 'abort' });
  const end = await p;
  console.log(`  [${fmt(Date.now() - t0)}] agent_end aborted=${end.event.aborted} finalText="${end.event.finalText.slice(0, 80)}"`);
  console.log(end.event.aborted ? 'ABORT OK' : 'ABORT FAIL: aborted flag not set');
  // Session must still be usable afterwards.
  const rec = await runPrompt(host, '回复“我还在”三个字即可，不要用工具。', { quiet: true });
  console.log(`  after abort: ended=${rec.ended} final="${rec.finalText.slice(0, 40)}"`);
  await host.shutdown();
}

const scenario = arg('scenario');
if (scenario === 'steer') await scenarioSteer();
else if (scenario === 'abort') await scenarioAbort();
else if (has('prompt')) await benchTasks([{ id: 'adhoc', prompt: arg('prompt') }]);
else {
  const all = shared.DEFAULT_CONFIG.quickTasks;
  const sel = arg('task', 'all');
  const tasks = sel === 'all' ? all : all.filter(t => sel.split(',').includes(t.id));
  if (!tasks.length) { console.error(`unknown task ${sel}; have: ${all.map(t => t.id).join(', ')}`); process.exit(1); }
  const results = await benchTasks(tasks);
  process.exit(results.every(r => okRun(r.rec)) ? 0 : 2);
}
