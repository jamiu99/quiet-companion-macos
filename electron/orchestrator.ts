// The heart of the app: routes user input to BOTH the avatar (Vidu S2, instant conversational reaction)
// and the agent (pi), and relays agent progress back to the avatar as 【助手汇报】 messages.
//
// Design (see docs/ARCHITECTURE.md §3):
//   user text ──► avatar.sendText(text)            (avatar reacts immediately with its own LLM)
//             └─► agent.prompt(text | steer)       (agent decides whether there is a task; if none it replies briefly)
//   agent companion_say tool ──► relay queue ──► avatar.sendText(RELAY_TAG + text)
//   tool_start / watchdog ──► auto progress line, throttled by progressReportIntervalMs
//   agent_end ──► if the agent did real work and its last word was not a companion_say, relay its final text
//   relay queue: rate-limited, explicit reports replace pending auto progress, dropped when avatar is not live.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import { AGENT_SKIP_MARKER, RELAY_TAG, TEXT_MODE_MARKER, TOKENDANCE_MODEL_PRESETS, resolveActiveCharacter, type AppConfig } from '@shared/config';
import { initialAgentState, initialAvatarState, type AgentToHost, type AppState, type TranscriptItem, type ViduRuntimeEvent, type AgentHostInit, type ViduLogItem } from '@shared/events';
import { ViduRuntime, type ViduRuntimeOptions } from './vidu/runtime';
import { AgentHostManager } from './agent/host-manager';
import { expandHome } from './config-store';

export interface OrchestratorOptions {
  /** Local capability checks must finish before any paid create request. */
  beforeConnect?: () => void;
  /** Test hooks for the Vidu runtime (fake fetcher / socket). */
  vidu?: Partial<Omit<ViduRuntimeOptions, 'emit' | 'log'>>;
  /** Optional re-encoder for the reference portrait (e.g. downscale large PNGs in main via nativeImage). Returns a data: URI. */
  encodeImage?: (path: string) => Promise<string | undefined>;
}

export interface OrchestratorEvents {
  state: [AppState];
  rtc: [Extract<ViduRuntimeEvent, { type: 'rtc-start' | 'rtc-stop' }>];
  log: [string];
}

const MAX_TRANSCRIPT = 200;
const MAX_VIDU_LOG = 150;
/** Wait after the first presented frame before cueing the greeting: the audio track is subscribed but still buffering
 *  right at first frame (measured 2026-09-22: first audible level ~2.5 s later), so an immediate cue lost its first half. */
export const GREETING_DELAY_MS = 1000;
/** Measured 2026-09-22 (4 sessions): in 2 of them Vidu re-published the stream 4.5–6 s after our first frame (<video>
 *  drops to 0x0 for ~2 s) and the greeting's first seconds of audio were lost; in the other 2 nothing happened. So:
 *  greet right away, and if a reset is seen within this window after the cue, interrupt and greet once more. */
export const GREETING_RESET_WINDOW_MS = 15000;
/** Minimum gap between two relayed lines so the avatar can finish one before the next arrives. */
export const MIN_RELAY_GAP_MS = 2500;
/** After the avatar's audio goes quiet, wait this long before the next relay (natural pause between sentences). */
export const SPEECH_SETTLE_MS = 700;
/** Fallback when no audio signal is available: estimated speaking time per character of her reply, plus a base. */
export const SPEECH_MS_PER_CHAR = 230, SPEECH_BASE_MS = 900;
/** Vidu S2: her transcript arrives ~0.7 s after our text, audible speech ~3.5 s after it (measured 2026-09-22). */
export const VIDU_TTS_LATENCY_MS = 3500;
/** Never hold a relay longer than this even if the speaking signal looks stuck. */
export const MAX_SPEECH_HOLD_MS = 25000;
/** Line she is cued to say after the first frame (she adapts it to her own voice). */
export const GREETING_CUE = '嗨，我来啦！现在能看到我、听到我了吧～想聊点什么，或者想让我帮你做点什么？';
const MAX_RELAY_CHARS = 160;
/** Max explicit reports waiting in the queue; older ones are dropped. */
const MAX_PENDING_EXPLICIT = 2;
/** Auto-restart agent-host after an unexpected exit: fixed delay, bounded consecutive attempts. */
export const AGENT_RESTART_DELAY_MS = 1000;
export const AGENT_MAX_RESTARTS = 3;

interface RelayItem { text: string; explicit: boolean }

/** After a session ends with an error, fall back to the plain idle state (local portrait) once the message has been seen. */
const ERROR_TO_IDLE_MS = 8000;

export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  readonly state: AppState = { avatar: initialAvatarState(), agent: initialAgentState(), transcript: [], barVisible: true };
  readonly vidu: ViduRuntime;
  readonly agent: AgentHostManager;
  private config: AppConfig;
  private relayQueue: RelayItem[] = [];
  private relayTimer?: ReturnType<typeof setTimeout>;
  private lastRelayAt = 0;
  /** Avatar speech tracking: real signal from the renderer (RTC audio level) plus a text-length estimate fallback. */
  private avatarSpeaking = false;
  /** Vidu speaks its opening line right after conn_init_ack, seconds before our RTC audio/video is up: the user only
   *  hears the tail. Remember that it happened so we can cut it and greet again once the first frame is presented. */
  private spokeBeforeLive = false;
  private greeted = false;
  private greetingSentAt = 0;
  private regreeted = false;
  private speechEndedAt = 0;
  private speechBusyUntil = 0; // estimate from her transcript when no audio signal has been seen
  private hasAudioSignal = false;
  private speakHoldStartedAt = 0;
  // Per-run bookkeeping for the reporting rhythm.
  private reportedThisRun = false;
  private autoProgressSeq = 0; // rotates the auto-progress phrasing (task 09)
  private toolsThisRun = 0;
  private toolsSinceLastSay = 0;
  private lastProgressAt = 0; // last time anything was queued for the avatar during this run
  private progressWatchdog?: ReturnType<typeof setTimeout>;
  private pendingUserText: string[] = []; // texts to send to the avatar once live (autoConnectOnMessage)
  private agentTextBuffer = '';
  private restartAttempts = 0;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private connecting = false;
  private errorResetTimer?: ReturnType<typeof setTimeout>;

  constructor(config: AppConfig, agentEntry: string, private readonly agentDir: string, private readonly options: OrchestratorOptions = {}) {
    super();
    this.config = config;
    this.vidu = new ViduRuntime({ ...options.vidu, emit: e => this.onVidu(e), log: line => this.emit('log', line) });
    this.agent = new AgentHostManager(agentEntry);
    this.agent.on('message', m => this.onAgent(m));
    this.agent.on('stderr', s => this.emit('log', `[agent-host] ${s.trimEnd()}`));
    this.agent.on('exit', (code, signal, expected) => this.onAgentExit(code, signal, expected));
  }

  setConfig(config: AppConfig) {
    const agentChanged = JSON.stringify(config.agent) !== JSON.stringify(this.config.agent);
    this.config = config;
    if (agentChanged && this.agent.running) this.startAgent();
  }

  // ---------- agent ----------
  startAgent() {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined; }
    const a = this.config.agent;
    if (!a.apiKey) { this.state.agent = { ...initialAgentState(), status: 'error', lastError: '未配置 TokenDance API Key' }; this.push(); return; }
    const init: AgentHostInit = {
      apiKey: a.apiKey, baseUrl: a.baseUrl, api: a.api, model: a.model, thinkingLevel: a.thinkingLevel,
      workspace: expandHome(a.workspace), extraTools: a.extraTools, agentDir: this.agentDir,
      vision: TOKENDANCE_MODEL_PRESETS.find(p => p.id === a.model)?.vision ?? false,
      systemPromptExtra: `当前时间：${new Date().toLocaleString('zh-CN')}。`,
    };
    this.state.agent = { ...initialAgentState(), status: 'starting', model: a.model };
    this.push();
    try { this.agent.start(init); } catch (e) { this.state.agent = { ...this.state.agent, status: 'error', lastError: String((e as Error).message) }; this.push(); }
  }
  abortAgent() { if (this.agent.running) this.agent.send({ type: 'abort' }); }
  resetAgent() { if (this.agent.running) this.agent.send({ type: 'reset' }); this.addTranscript('system', '已开始新的 agent 会话'); }
  /** Clear the visible conversation and start a fresh agent session (the avatar session, if any, keeps running). */
  clearViduLog() { this.state.viduLog = []; this.push(); }
  clearSession() {
    if (this.agent.running) this.agent.send({ type: 'reset' });
    this.state.transcript = [];
    this.relayQueue = []; this.pendingUserText = [];
    this.push();
  }
  stopAgent() {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined; }
    this.restartAttempts = 0;
    this.agent.stop();
  }

  private onAgentExit(code: number | null, signal: NodeJS.Signals | null, expected: boolean) {
    this.clearProgressWatchdog();
    const clean = code === 0 || (code === null && !signal);
    if (expected || (clean && this.state.agent.status === 'stopped')) {
      this.state.agent = { ...this.state.agent, status: 'stopped', activity: '', lastError: null };
      this.push();
      return;
    }
    const reason = `agent-host 退出（${code ?? signal}）`;
    if (this.restartAttempts < AGENT_MAX_RESTARTS) {
      this.restartAttempts += 1;
      this.state.agent = { ...this.state.agent, status: 'starting', activity: `重启中（${this.restartAttempts}/${AGENT_MAX_RESTARTS}）`, lastError: reason };
      this.addTranscript('system', `${reason}，${AGENT_RESTART_DELAY_MS / 1000} 秒后自动重启`);
      this.emit('log', `agent-host exited unexpectedly (${code ?? signal}); restart ${this.restartAttempts}/${AGENT_MAX_RESTARTS}`);
      this.restartTimer = setTimeout(() => { this.restartTimer = undefined; this.startAgent(); }, AGENT_RESTART_DELAY_MS);
      this.restartTimer.unref?.();
    } else {
      this.state.agent = { ...this.state.agent, status: 'stopped', activity: '', lastError: `${reason}，连续失败 ${AGENT_MAX_RESTARTS} 次，已停止自动重启` };
      this.addTranscript('system', this.state.agent.lastError!);
    }
    this.push();
  }

  // ---------- user input ----------
  async sendUserText(text: string) {
    const t = text.trim();
    if (!t) return;
    this.addTranscript('user', t);
    // 1) avatar: immediate reaction
    if (this.vidu.isLive) { try { this.vidu.sendText(t); this.expectSpeech(); } catch (e) { this.emit('log', `avatar send failed: ${(e as Error).message}`); } }
    else if (this.config.ui.autoConnectOnMessage && !this.vidu.isActive && this.config.vidu.apiKey) { this.pendingUserText.push(t); void this.connectAvatar(); }
    else if (this.vidu.isActive) this.pendingUserText.push(t);
    // 2) agent
    if (!this.agent.running) this.startAgent();
    const running = this.state.agent.status === 'running';
    // Not live → the avatar cannot answer aloud, so the agent answers chit-chat in text (shown as her message).
    const willBeLive = this.vidu.isLive || this.vidu.isActive || this.connecting;
    const promptText = willBeLive ? t : `${t} ${TEXT_MODE_MARKER}`;
    try { this.agent.send({ type: 'prompt', id: randomUUID(), text: promptText, behavior: running ? 'steer' : 'auto' }); }
    catch (e) { this.addTranscript('system', `agent 不可用：${(e as Error).message}`); }
  }
  async runQuickTask(id: string) {
    const task = this.config.quickTasks.find(q => q.id === id);
    if (!task) throw new Error('未知任务');
    await this.sendUserText(task.prompt);
  }

  // ---------- avatar ----------
  /** Idempotent: a second call while a session is being created / running / stopping is ignored (never two paid sessions). */
  async connectAvatar() {
    if (this.vidu.isActive || this.connecting) { this.emit('log', `connectAvatar ignored: phase=${this.vidu.phase}`); return; }
    this.connecting = true;
    try {
      this.options.beforeConnect?.();
      // Portrait / persona / voice come from the active character (task 07); legacy vidu.* fields are the fallback.
      const active = resolveActiveCharacter(this.config);
      const imagePath = expandHome(active.imagePath);
      if (!imagePath || !existsSync(imagePath)) { this.setAvatarError(active.character ? `请先为「${active.name}」生成或选择形象` : '请先在设置里选择数字人参考图'); return; }
      const mime = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' }[extname(imagePath).toLowerCase()];
      if (!mime) { this.setAvatarError('参考图需为 png/jpg/webp'); return; }
      const imageUri = (await this.options.encodeImage?.(imagePath).catch(e => { this.emit('log', `encodeImage failed: ${(e as Error).message}`); return undefined; }))
        ?? `data:image/${mime};base64,${readFileSync(imagePath).toString('base64')}`;
      this.emit('log', `connectAvatar: character=${active.name}${active.id ? `#${active.id.slice(0, 8)}` : '(legacy)'} image=${imagePath} (${Math.round(imageUri.length / 1024)} KB b64) voice=${active.voice} persona="${active.persona.slice(0, 40).replace(/\n/g, ' ')}…"`);
      await this.vidu.start({ ...this.config.vidu, persona: active.persona, voice: active.voice }, imageUri);
    } catch (e) {
      this.setAvatarError(`连接失败：${(e as Error).message}`);
    } finally { this.connecting = false; }
  }
  disconnectAvatar() { this.pendingUserText = []; this.relayQueue = []; this.vidu.stop('已手动结束连接'); }
  private setAvatarError(message: string) {
    this.pendingUserText = []; // Failed preflight/create must not replay old messages on a later connection.
    this.state.avatar = { ...initialAvatarState(), phase: 'error', message };
    this.addTranscript('system', message);
    this.scheduleErrorReset();
    this.push();
  }
  /** error → idle after a short while so the stage shows the plain local portrait again (message stays in the transcript). */
  private scheduleErrorReset() {
    clearTimeout(this.errorResetTimer);
    this.errorResetTimer = setTimeout(() => {
      this.errorResetTimer = undefined;
      if (this.state.avatar.phase === 'error' && !this.vidu.isActive) { this.state.avatar = initialAvatarState(); this.push(); }
    }, ERROR_TO_IDLE_MS);
  }
  interruptAvatar() { if (this.vidu.isLive) this.vidu.interrupt(); }
  mediaReady(liveId: string) {
    this.vidu.mediaReady(liveId);
    if (this.vidu.isLive) {
      this.state.avatar = { ...this.state.avatar, presented: true };
      const pending = this.pendingUserText.splice(0);
      this.viduLog('media', 'first_frame', '渲染进程收到首帧，会话进入 live');
      if (this.spokeBeforeLive) {
        // Cut the half-heard opening line; greet again once the audio path has had time to settle.
        this.spokeBeforeLive = false;
        try { this.vidu.interrupt(); } catch { /* not fatal */ }
      }
      if (!pending.length && !this.greeted) {
        this.greeted = true;
        this.viduLog('app', 'cue', `首帧后 ${GREETING_DELAY_MS / 1000}s 发开场提词；若随后视频流被 Vidu 重推，恢复后再问候一次`);
        setTimeout(() => { if (this.vidu.isLive) { this.greetingSentAt = Date.now(); this.relay(GREETING_CUE, true); } }, GREETING_DELAY_MS);
      }
      for (const t of pending) { try { this.vidu.sendText(t); } catch { /* ignore */ } }
      this.push();
    }
  }
  mediaFailed(liveId: string, reason: string) { this.viduLog('media', 'failed', reason); this.vidu.mediaFailed(liveId, reason); }
  /** Renderer-side media milestone (join / subscribe / stall / stats) for the Vidu log. */
  mediaLog(tag: string, text: string) {
    this.viduLog('media', tag, text);
    // Vidu re-published the stream right after our greeting: its audio start was lost → greet again once video is back.
    if (tag === 'recovered' && this.greetingSentAt && !this.regreeted && Date.now() - this.greetingSentAt < GREETING_RESET_WINDOW_MS && this.vidu.isLive) {
      this.regreeted = true;
      this.viduLog('app', 'cue', '视频流刚被重推，开场白可能只听到一半：打断并再问候一次');
      try { this.vidu.interrupt(); } catch { /* ignore */ }
      setTimeout(() => { if (this.vidu.isLive) { this.relayQueue = []; this.relay(GREETING_CUE, true); } }, 800);
    }
  }
  /** Renderer reports the avatar's remote audio becoming audible / silent. Relays wait while she speaks. */
  setAvatarSpeaking(on: boolean) {
    this.hasAudioSignal = true;
    if (this.avatarSpeaking === on) return;
    this.avatarSpeaking = on;
    if (!on) { this.speechEndedAt = Date.now(); this.speechBusyUntil = 0; }
    this.emit('log', `avatar speaking=${on}`);
    this.viduLog('media', 'audio', on ? '数字人开始出声' : '数字人停止出声');
    if (!on) { if (this.relayTimer) { clearTimeout(this.relayTimer); this.relayTimer = undefined; } this.flushRelay(); }
  }

  setBarVisible(v: boolean) { this.state.barVisible = v; this.push(); }
  /** Show a system line in the bar transcript (e.g. hotkey registration failure). */
  notify(text: string) { this.addTranscript('system', text); }

  // ---------- internals ----------
  private onVidu(e: ViduRuntimeEvent) {
    switch (e.type) {
      case 'state': {
        const presented = e.state.phase === 'live' ? this.state.avatar.presented : false;
        this.state.avatar = { ...e.state, presented };
        this.emit('log', `avatar ${e.state.phase}: ${e.state.message}${e.state.liveId ? ` live=${e.state.liveId}` : ''}`);
        this.viduLog('app', 'phase', `${e.state.phase} · ${e.state.message}`);
        if (e.state.phase === 'error') { this.addTranscript('system', e.state.message); this.scheduleErrorReset(); }
        else if (e.state.phase === 'idle' && this.state.transcript.length) this.addTranscript('system', e.state.message);
        if (e.state.phase === 'idle' || e.state.phase === 'error') {
          // Session over (cap reached / network / server hangup / manual): drop anything waiting for the avatar.
          this.pendingUserText = []; this.relayQueue = [];
          if (this.relayTimer) { clearTimeout(this.relayTimer); this.relayTimer = undefined; }
          this.avatarSpeaking = false; this.speechBusyUntil = 0; this.hasAudioSignal = false; this.speakHoldStartedAt = 0; this.spokeBeforeLive = false; this.greeted = false; this.greetingSentAt = 0; this.regreeted = false;
        } else clearTimeout(this.errorResetTimer);
        this.push(); break;
      }
      case 'log': this.viduLog(e.dir, e.tag, e.text); break;
      case 'rtc-start': this.viduLog('app', 'rtc_start', `把 RTC 凭证交给渲染进程入会 user=${e.rtc.user_id}`); this.emit('rtc', e); break;
      case 'rtc-stop': this.viduLog('app', 'rtc_stop', '离开 RTC 频道'); this.emit('rtc', e); break;
      case 'transcript':
        this.emit('log', `transcript ${e.role}: ${e.text.slice(0, 500)}`);
        // Vidu echoes user transcripts (type 9) including our relay messages; hide relays from the log.
        if (e.role === 'user' && e.text.startsWith(RELAY_TAG)) break;
        if (e.role === 'user') break; // we already logged what the user typed
        // Before the first presented frame the user cannot hear her yet (measured: greeting transcript at +3.4s, audible
        // audio at +9.4s) — do not show what was never heard; mediaReady() will interrupt and re-greet.
        if (!this.state.avatar.presented) { this.spokeBeforeLive = true; this.viduLog('app', 'drop', `首帧前的开场白不显示：「${e.text.slice(0, 60)}」`); break; }
        // Her reply text arrives around when she starts speaking: without an audio signal, estimate how long it takes.
        if (!this.hasAudioSignal) this.speechBusyUntil = Math.max(this.speechBusyUntil, Date.now() + VIDU_TTS_LATENCY_MS + SPEECH_BASE_MS + e.text.length * SPEECH_MS_PER_CHAR);
        this.addTranscript('companion', e.text); break;
    }
  }

  private onAgent(m: AgentToHost) {
    switch (m.type) {
      case 'ready': this.restartAttempts = 0; this.state.agent = { ...this.state.agent, status: 'idle', model: m.model, tools: m.tools, lastError: null, activity: '' }; this.push(); break;
      case 'status': this.state.agent = { ...this.state.agent, status: m.status, activity: m.activity ?? '' }; this.push(); break;
      case 'log': this.emit('log', `[agent-host:${m.level}] ${m.message}`); break;
      case 'fatal': this.state.agent = { ...this.state.agent, status: 'error', lastError: m.message }; this.addTranscript('system', `agent 错误：${m.message}`); this.push(); break;
      case 'companion_say':
        this.reportedThisRun = true; this.toolsSinceLastSay = 0;
        this.addTranscript('agent', `🗣 ${m.text}`);
        this.relay(m.text, true);
        break;
      case 'event': {
        const ev = m.event;
        switch (ev.type) {
          case 'agent_start':
            this.reportedThisRun = false; this.toolsThisRun = 0; this.toolsSinceLastSay = 0; this.agentTextBuffer = ''; this.autoProgressSeq = 0;
            this.lastProgressAt = Date.now(); this.armProgressWatchdog();
            this.state.agent = { ...this.state.agent, status: 'running', activity: '思考中…' }; this.push(); break;
          case 'text_delta': this.agentTextBuffer += ev.delta; break;
          case 'tool_start': {
            this.state.agent = { ...this.state.agent, activity: `${ev.name}: ${ev.summary}`.slice(0, 120) };
            this.addTranscript('tool', `▶ ${ev.name} ${ev.summary}`.slice(0, 300));
            if (ev.name !== 'companion_say') {
              this.toolsThisRun += 1; this.toolsSinceLastSay += 1;
              this.maybeAutoProgress(describeTool(ev.name, ev.summary));
            }
            break;
          }
          case 'tool_end': this.addTranscript('tool', `${ev.ok ? '✓' : '✗'} ${ev.name} ${ev.summary}`.slice(0, 300), ev.ok); break;
          case 'turn_end': { const t = ev.text.trim(); if (t && !isSkip(t)) this.addTranscript('agent', t); this.agentTextBuffer = ''; break; }
          case 'agent_end': {
            this.clearProgressWatchdog();
            this.state.agent = { ...this.state.agent, status: 'idle', activity: '' };
            // Stale "正在…" lines are pointless once the run is over.
            this.relayQueue = this.relayQueue.filter(i => i.explicit);
            // A fast run may have several unsent companion_say lines queued while she was still talking: the last one
            // (the result) supersedes the earlier progress lines, so only that one is kept.
            if (this.relayQueue.length > 1) { this.emit('log', `relay collapse: dropping ${this.relayQueue.length - 1} stale progress line(s)`); this.relayQueue = this.relayQueue.slice(-1); }
            // Fallback: relay the final answer when the agent did real work and did not close with a companion_say.
            // Pure chit-chat (no tools) is not relayed: the avatar already answered the user itself.
            const needsFallback = !ev.aborted && this.toolsThisRun > 0 && (!this.reportedThisRun || this.toolsSinceLastSay > 0);
            if (needsFallback && ev.finalText.trim() && !isSkip(ev.finalText)) this.relay(ev.finalText, true);
            // Text mode (avatar not live): a plain chat answer is her reply; with tools the relay() above already showed it.
            else if (!this.vidu.isLive && !ev.aborted && this.toolsThisRun === 0 && ev.finalText.trim() && !isSkip(ev.finalText)) this.addTranscript('companion', ev.finalText.trim().slice(0, 400));
            this.push(); break;
          }
          case 'error': this.state.agent = { ...this.state.agent, lastError: ev.message }; this.addTranscript('system', `agent：${ev.message}`); this.push(); break;
        }
      }
    }
  }

  // ---------- reporting rhythm ----------
  private get progressGap() { return this.config.agent.progressReportIntervalMs; }

  /** Called on every real tool start: relay a short progress line if nothing has been said for a while. `step` is the
   *  speakable description of the tool that just started (see describeTool); the wording rotates so a long task does
   *  not sound like a log ("正在执行命令 xxx" every time). */
  private maybeAutoProgress(step: string) {
    const gap = this.progressGap;
    if (!gap || Date.now() - this.lastProgressAt < gap) return;
    this.relay(progressLine('step', this.autoProgressSeq++, step), false);
  }

  /** A long-running single tool call produces no tool_start events; the watchdog still speaks every `gap` ms. */
  private armProgressWatchdog() {
    this.clearProgressWatchdog();
    const gap = this.progressGap;
    if (!gap) return;
    // Fire `gap` ms after the last thing we queued for the avatar, not after the last check.
    const wait = Math.max(1, this.lastProgressAt + gap - Date.now());
    this.progressWatchdog = setTimeout(() => {
      this.progressWatchdog = undefined;
      if (this.state.agent.status !== 'running') return;
      if (Date.now() - this.lastProgressAt >= gap) {
        const m = /^([a-z_]+): (.*)$/.exec(this.state.agent.activity);
        this.relay(progressLine('wait', this.autoProgressSeq++, m ? describeTool(m[1], m[2]) : undefined), false);
      }
      this.armProgressWatchdog();
    }, wait);
    this.progressWatchdog.unref?.();
  }
  private clearProgressWatchdog() { if (this.progressWatchdog) { clearTimeout(this.progressWatchdog); this.progressWatchdog = undefined; } }

  /** Queue text for the avatar to relay. Explicit reports (companion_say / final answer) replace pending auto progress. */
  private relay(text: string, explicit: boolean) {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, MAX_RELAY_CHARS);
    if (!clean) return;
    this.lastProgressAt = Date.now();
    // Not live: nothing to say it aloud, so it becomes her text reply in the panel.
    if (!this.vidu.isLive) { this.addTranscript('companion', clean); return; }
    if (explicit) {
      const kept = this.relayQueue.filter(i => i.explicit).slice(-(MAX_PENDING_EXPLICIT - 1));
      this.relayQueue = [...kept, { text: clean, explicit: true }];
    } else {
      if (this.relayQueue.length) return; // never stack auto progress behind anything
      this.relayQueue.push({ text: clean, explicit: false });
    }
    this.flushRelay();
  }
  private expectSpeech() {
    // She is about to answer: until the audio signal says otherwise, treat the next ~2.5 s as busy.
    if (!this.hasAudioSignal) this.speechBusyUntil = Math.max(this.speechBusyUntil, Date.now() + VIDU_TTS_LATENCY_MS + 1500);
  }
  /** ms until the avatar can take the next relay: 0 when free. Combines audio signal, transcript estimate and min gap. */
  private relayWait(): number {
    const now = Date.now();
    const gap = this.lastRelayAt + MIN_RELAY_GAP_MS - now;
    const settle = this.speechEndedAt + SPEECH_SETTLE_MS - now;
    const estimate = this.speechBusyUntil - now;
    let wait = Math.max(0, gap, settle, estimate);
    if (this.avatarSpeaking) {
      if (!this.speakHoldStartedAt) this.speakHoldStartedAt = now;
      // Poll while she talks; give up holding if the signal looks stuck.
      wait = now - this.speakHoldStartedAt > MAX_SPEECH_HOLD_MS ? 0 : Math.max(wait, 300);
    } else this.speakHoldStartedAt = 0;
    return wait;
  }
  private flushRelay() {
    if (this.relayTimer || !this.relayQueue.length) return;
    const wait = this.relayWait();
    this.relayTimer = setTimeout(() => {
      this.relayTimer = undefined;
      if (!this.vidu.isLive) { this.relayQueue = []; return; }
      if (this.relayWait() > 0) { this.flushRelay(); return; } // still talking: re-check
      const next = this.relayQueue.shift();
      if (!next) return;
      try {
        this.viduLog('app', 'relay', `提词 → text_msg：${next.text}`);
        this.vidu.sendText(`${RELAY_TAG}${next.text}`); this.lastRelayAt = Date.now(); this.speakHoldStartedAt = 0;
        this.expectSpeech();
        this.emit('log', `relay → avatar: ${next.text}`);
      } catch (e) { this.emit('log', `relay failed: ${(e as Error).message}`); }
      this.flushRelay();
    }, wait);
  }

  /** Append to the Vidu-side log (control signalling, media milestones, orchestrator decisions). */
  viduLog(dir: ViduLogItem['dir'], tag: string, text: string) {
    const list = this.state.viduLog ?? (this.state.viduLog = []);
    list.push({ id: randomUUID(), at: Date.now(), dir, tag, text: text.slice(0, 600) });
    if (list.length > MAX_VIDU_LOG) list.splice(0, list.length - MAX_VIDU_LOG);
    this.push();
  }
  private addTranscript(role: TranscriptItem['role'], text: string, ok?: boolean) {
    this.state.transcript.push({ id: randomUUID(), role, text, at: Date.now(), ok });
    if (this.state.transcript.length > MAX_TRANSCRIPT) this.state.transcript.splice(0, this.state.transcript.length - MAX_TRANSCRIPT);
    this.push();
  }
  // Coalesce: many code paths push in the same tick (transcript + log + phase). One IPC per animation-frame-ish slice
  // keeps the renderer from re-rendering the whole stage several times per event.
  private pushTimer?: ReturnType<typeof setTimeout>;
  private push() {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => { this.pushTimer = undefined; this.emit('state', this.state); }, 16);
    this.pushTimer.unref?.();
  }
  /** Synchronous emit for the rare paths that need the renderer to see the state before the next tick (tests). */
  flushState() { if (this.pushTimer) { clearTimeout(this.pushTimer); this.pushTimer = undefined; } this.emit('state', this.state); }
}

export /** The agent answers `[跳过]` when the avatar alone should respond (chit-chat, dance/wave requests). */
function isSkip(text: string): boolean { const t = text.trim(); return t === AGENT_SKIP_MARKER || t.startsWith(AGENT_SKIP_MARKER) && t.length <= AGENT_SKIP_MARKER.length + 12; }

/** Speakable description of a tool call for auto progress: what she is doing, never the raw command / path (she reads
 *  these lines aloud). App / URL names from mac_open are kept when short. */
export function describeTool(name: string, summary: string): string {
  const s = summary.trim().replace(/\s+/g, ' ');
  switch (name) {
    case 'bash': return /\bcurl\b|wget|https?:\/\//.test(s) ? '查资料' : /\bmv\b|\bcp\b|mkdir|\brm\b/.test(s) ? '整理文件' : /python|node|awk|sed|sort|wc/.test(s) ? '算数据' : '跑命令';
    case 'read': case 'grep': case 'find': case 'ls': return '翻文件';
    case 'write': case 'edit': return '写东西';
    case 'mac_open': return s && s.length <= 16 && !/[\/:]/.test(s) ? `打开${s}` : /^https?:\/\//.test(s) ? '打开网页' : '打开东西';
    case 'applescript': return '操作应用';
    case 'mac_screenshot': return '看屏幕';
    case 'mac_clipboard': return '看剪贴板';
    case 'mac_notify': return '发通知';
    default: return '处理';
  }
}

/** Auto-progress phrasing (task 09): colloquial first-person lines that rotate with `seq` (reset per run).
 *  'step' = a new tool just started (fresh activity); 'wait' = the watchdog fired while one tool keeps running. */
export const STEP_LINES: ((step: string) => string)[] = [
  step => `我在${step}，稍等一下`,
  () => '这一步在跑，稍等我一下',
  step => `${step}中，快了快了`,
  () => '找到了一些，我再看看',
  () => '我还在弄，马上',
  step => `继续${step}，别急`,
  () => '嗯，这里稍微慢一点，我继续',
  step => `好，接着${step}`,
];
export const WAIT_LINES: ((step?: string) => string)[] = [
  step => step ? `还在${step}，等它一下` : '还在处理，稍等一下',
  () => '还在等它反应，我盯着呢',
  step => step ? `${step}有点慢，我再等等` : '这一步有点慢，我再等等',
  () => '快了快了，别急',
  () => '它还没回我，我继续等',
  step => step ? `还在${step}，马上` : '我还在弄，马上',
];
export function progressLine(kind: 'step' | 'wait', seq: number, step?: string): string {
  if (kind === 'step') return STEP_LINES[seq % STEP_LINES.length](step || '处理');
  return WAIT_LINES[seq % WAIT_LINES.length](step);
}
