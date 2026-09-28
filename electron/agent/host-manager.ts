// Spawns agent-host as a child process (Electron binary in Node mode, so no system Node is required)
// and speaks the JSON-lines protocol from shared/events.ts.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import type { AgentHostInit, AgentToHost, HostToAgent } from '@shared/events';

export interface AgentHostEvents {
  message: [AgentToHost];
  /** `expected` is true when we asked the child to stop (stop()/restart); false means it died on its own. */
  exit: [code: number | null, signal: NodeJS.Signals | null, expected: boolean];
  stderr: [string];
}

export class AgentHostManager extends EventEmitter<AgentHostEvents> {
  private child?: ChildProcess;
  private initConfig?: AgentHostInit;
  private stopping = new WeakSet<ChildProcess>();
  constructor(private readonly entry: string, private readonly execPath: string = process.execPath) { super(); }

  get running() { return Boolean(this.child && this.child.exitCode === null && !this.child.killed); }

  start(config: AgentHostInit) {
    this.stop();
    this.initConfig = config;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_OFFLINE: '1', NO_COLOR: '1' };
    // The agent receives its own key over private stdio; do not also hand service credentials to spawned shells.
    delete (env as NodeJS.ProcessEnv).VIDU_API_KEY; delete (env as NodeJS.ProcessEnv).TOKENDANCE_API_KEY;
    const child = spawn(this.execPath, [this.entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: config.workspace,
    });
    this.child = child;
    const rl = createInterface({ input: child.stdout! });
    rl.on('line', line => {
      if (!line.trim()) return;
      try { this.emit('message', JSON.parse(line) as AgentToHost); }
      catch { this.emit('stderr', `[agent-host non-json] ${line.slice(0, 500)}`); }
    });
    child.stderr!.on('data', (d: Buffer) => this.emit('stderr', d.toString()));
    child.on('exit', (code, signal) => { if (this.child === child) this.child = undefined; this.emit('exit', code, signal, this.stopping.has(child)); });
    this.send({ type: 'init', config });
  }

  send(message: HostToAgent) {
    if (!this.child?.stdin?.writable) throw new Error('agent-host 未运行');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  restart() { if (this.initConfig) this.start(this.initConfig); }

  stop() {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.stopping.add(child);
    try { child.stdin?.write(JSON.stringify({ type: 'shutdown' } satisfies HostToAgent) + '\n'); } catch { /* ignore */ }
    const t = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000);
    t.unref();
    child.once('exit', () => clearTimeout(t));
  }
}
