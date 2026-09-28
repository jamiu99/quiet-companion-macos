// Orchestrator unit tests with ViduRuntime and AgentHostManager replaced by minimal fakes.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, RELAY_TAG, TEXT_MODE_MARKER, type AppConfig } from '@shared/config';
import type { AgentToHost, ViduRuntimeEvent } from '@shared/events';

// ---- fakes ----
class FakeVidu {
  isLive = false;
  isActive = false;
  sendText = vi.fn<(t: string) => void>();
  start = vi.fn(async () => {});
  stop = vi.fn();
  interrupt = vi.fn();
  mediaReady = vi.fn();
  mediaFailed = vi.fn();
  constructor(readonly opts: { emit: (e: ViduRuntimeEvent) => void }) { instances.vidu = this; }
}
class FakeAgent extends EventEmitter {
  running = true;
  start = vi.fn((_c: unknown) => { this.running = true; });
  send = vi.fn((_m: unknown) => {});
  stop = vi.fn(() => { this.running = false; });
  constructor(readonly entry: string) { super(); instances.agent = this; }
}
const instances: { vidu?: FakeVidu; agent?: FakeAgent } = {};
vi.mock('../electron/vidu/runtime', () => ({ ViduRuntime: FakeVidu }));
vi.mock('../electron/agent/host-manager', () => ({ AgentHostManager: FakeAgent }));

const { Orchestrator, MIN_RELAY_GAP_MS, SPEECH_SETTLE_MS, AGENT_RESTART_DELAY_MS, AGENT_MAX_RESTARTS } = await import('../electron/orchestrator');

const config = (): AppConfig => ({ ...structuredClone(DEFAULT_CONFIG), agent: { ...DEFAULT_CONFIG.agent, apiKey: 'sk-test', progressReportIntervalMs: 12000 } });

function make(live = true) {
  const o = new Orchestrator(config(), '/dev/null/agent.mjs', '/tmp/agent-dir');
  const vidu = instances.vidu!, agent = instances.agent!;
  vidu.isLive = live; vidu.isActive = live;
  o.state.avatar = { ...o.state.avatar, phase: live ? 'live' : 'idle', presented: live };
  const msg = (m: AgentToHost) => agent.emit('message', m);
  const ev = (event: Extract<AgentToHost, { type: 'event' }>['event']) => msg({ type: 'event', event });
  const relayed = () => vidu.sendText.mock.calls.map(c => c[0]).filter(t => t.startsWith(RELAY_TAG)).map(t => t.slice(RELAY_TAG.length));
  return { o, vidu, agent, msg, ev, relayed };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-22T10:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('fan-out', () => {
  it('rejects missing local RTC capability before a paid start, including automatic connection', async () => {
    const c = config(); c.vidu.apiKey = 'fixture-vidu'; c.ui.autoConnectOnMessage = true;
    const check = vi.fn(() => { throw new Error('RTC_SDK_MISSING'); });
    const o = new Orchestrator(c, '/dev/null/agent.mjs', '/tmp/agent-dir', { beforeConnect: check });
    await o.connectAvatar(); await o.sendUserText('hello');
    expect(check).toHaveBeenCalledTimes(2); expect(instances.vidu!.start).not.toHaveBeenCalled();
    expect(o.state.avatar.message).toContain('RTC_SDK_MISSING');
    expect(instances.agent!.send).toHaveBeenCalledWith(expect.objectContaining({ text: `hello ${TEXT_MODE_MARKER}` }));
  });
  it('sends user text to both the avatar and the agent (prompt when idle, steer when running)', async () => {
    const { o, vidu, agent, ev } = make();
    await o.sendUserText('帮我查天气');
    expect(vidu.sendText).toHaveBeenCalledWith('帮我查天气');
    expect(agent.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt', text: '帮我查天气', behavior: 'auto' }));
    ev({ type: 'agent_start', promptId: 'p1' });
    await o.sendUserText('顺便开个备忘录');
    expect(agent.send).toHaveBeenLastCalledWith(expect.objectContaining({ text: '顺便开个备忘录', behavior: 'steer' }));
    expect(o.state.transcript.filter(t => t.role === 'user')).toHaveLength(2);
  });

  it('starts the agent first if it is not running', async () => {
    const { o, agent } = make();
    agent.running = false;
    await o.sendUserText('hi');
    expect(agent.start).toHaveBeenCalledTimes(1);
    expect(agent.start.mock.calls[0][0]).toMatchObject({ model: DEFAULT_CONFIG.agent.model, vision: true });
  });
});

describe('relay queue', () => {
  it('throttles relays to one per MIN_RELAY_GAP_MS', () => {
    const { o, vidu, msg, relayed } = make();
    o.setAvatarSpeaking(false); // audio signal available → no text-length estimate, plain min gap applies
    msg({ type: 'companion_say', text: '我去看看' });
    msg({ type: 'companion_say', text: '快好了' });
    vi.advanceTimersByTime(0);
    expect(relayed()).toEqual(['我去看看']);
    vi.advanceTimersByTime(MIN_RELAY_GAP_MS - 1);
    expect(vidu.sendText).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(relayed()).toEqual(['我去看看', '快好了']);
  });

  it('explicit report arriving together with auto progress wins (no duplicate)', () => {
    const { o, ev, msg, relayed } = make();
    o.setAvatarSpeaking(false);
    ev({ type: 'agent_start', promptId: 'p' });
    vi.advanceTimersByTime(12000);
    // Same tick: tool_start (auto line becomes eligible) then companion_say → only the explicit line is spoken.
    ev({ type: 'tool_start', toolCallId: '1', name: 'bash', summary: 'curl wttr.in' });
    msg({ type: 'companion_say', text: '天气查到了，晴' });
    vi.advanceTimersByTime(1);
    expect(relayed()).toEqual(['天气查到了，晴']);
    // Two explicit lines queue up and go out one per gap; a tool_start in between adds nothing.
    msg({ type: 'companion_say', text: 'A' });
    msg({ type: 'companion_say', text: 'B' });
    vi.advanceTimersByTime(MIN_RELAY_GAP_MS);
    ev({ type: 'tool_start', toolCallId: '2', name: 'bash', summary: 'x' });
    vi.advanceTimersByTime(MIN_RELAY_GAP_MS);
    expect(relayed()).toEqual(['天气查到了，晴', 'A', 'B']);
  });

  it('auto progress: silent until the interval elapses, then one line naming the current tool, no duplicates', () => {
    const { ev, relayed } = make();
    ev({ type: 'agent_start', promptId: 'p' });
    vi.advanceTimersByTime(6000);
    ev({ type: 'tool_start', toolCallId: '1', name: 'bash', summary: 'curl wttr.in' });
    vi.advanceTimersByTime(5000);
    expect(relayed()).toEqual([]); // 11 s < interval
    vi.advanceTimersByTime(1001);
    ev({ type: 'tool_start', toolCallId: '2', name: 'mac_notify', summary: '天气' });
    vi.advanceTimersByTime(1);
    // Task 09: the watchdog line (fired at exactly one interval) names the running step in speakable words — no
    // command text — and the phrasing rotates (progressLine); the tool_start a millisecond later adds nothing.
    expect(relayed()).toEqual(['还在查资料，等它一下']);
    vi.advanceTimersByTime(11000);
    expect(relayed()).toHaveLength(1);
  });

  it('does not auto-report within the first interval (short tasks only speak the result)', () => {
    const { ev, relayed } = make();
    ev({ type: 'agent_start', promptId: 'p' });
    vi.advanceTimersByTime(3000);
    ev({ type: 'tool_start', toolCallId: '1', name: 'bash', summary: 'ls' });
    vi.advanceTimersByTime(1000);
    ev({ type: 'agent_end', promptId: 'p', finalText: '桌面有 3 个文件', aborted: false });
    vi.advanceTimersByTime(MIN_RELAY_GAP_MS);
    expect(relayed()).toEqual(['桌面有 3 个文件']);
  });

  it('watchdog speaks during a long silent tool call', () => {
    const { ev, relayed } = make();
    ev({ type: 'agent_start', promptId: 'p' });
    ev({ type: 'tool_start', toolCallId: '1', name: 'bash', summary: 'sleep 30' });
    vi.advanceTimersByTime(11999);
    expect(relayed()).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(relayed()).toEqual(['还在跑命令，等它一下']);
    vi.advanceTimersByTime(12000);
    // Second watchdog line uses the next template so she does not repeat herself.
    expect(relayed()).toEqual(['还在跑命令，等它一下', '还在等它反应，我盯着呢']);
    ev({ type: 'agent_end', promptId: 'p', finalText: '好了', aborted: false });
    vi.advanceTimersByTime(60000);
    expect(relayed()).toEqual(['还在跑命令，等它一下', '还在等它反应，我盯着呢', '好了']);
  });

  it('does not relay when the avatar is not live; the line becomes her text reply instead', () => {
    const { o, vidu, msg } = make(false);
    msg({ type: 'companion_say', text: '我来啦' });
    vi.advanceTimersByTime(MIN_RELAY_GAP_MS * 2);
    expect(vidu.sendText).not.toHaveBeenCalled();
    const last = o.state.transcript.at(-1)!;
    expect(last.role).toBe('companion'); expect(last.text).toBe('我来啦');
  });
});

describe('agent_end fallback', () => {
  const run = (o: ReturnType<typeof make>, steps: Array<'tool' | 'say'>, finalText: string, aborted = false) => {
    o.ev({ type: 'agent_start', promptId: 'p' });
    steps.forEach((s, i) => s === 'tool' ? o.ev({ type: 'tool_start', toolCallId: String(i), name: 'bash', summary: 'x' }) : o.msg({ type: 'companion_say', text: `say${i}` }));
    o.ev({ type: 'agent_end', promptId: 'p', finalText, aborted });
    vi.advanceTimersByTime(MIN_RELAY_GAP_MS * 6);
  };
  it('relays the final text when tools ran and nothing was said', () => { const o = make(); run(o, ['tool', 'tool'], '完成'); expect(o.relayed()).toEqual(['完成']); });
  it('relays the final text when the last say was followed by more work', () => { const o = make(); run(o, ['say', 'tool', 'tool'], '完成'); expect(o.relayed()).toEqual(['say0', '完成']); });
  it('does not relay the final text when the run closed with a companion_say; unsent progress collapses into the result', () => {
    const o = make(); run(o, ['say', 'tool', 'say'], '完成');
    // The whole run finished before say0 was ever spoken → only the result line is heard.
    expect(o.relayed()).toEqual(['say2']);
  });
  it('keeps an already-spoken progress line and then says the result', () => {
    const o = make();
    o.ev({ type: 'agent_start', promptId: 'p' });
    o.msg({ type: 'companion_say', text: 'say0' });
    vi.advanceTimersByTime(1); // say0 goes out
    o.ev({ type: 'tool_start', toolCallId: '1', name: 'bash', summary: 'x' });
    o.msg({ type: 'companion_say', text: 'say2' });
    o.ev({ type: 'agent_end', promptId: 'p', finalText: '完成', aborted: false });
    vi.advanceTimersByTime(MIN_RELAY_GAP_MS * 6);
    expect(o.relayed()).toEqual(['say0', 'say2']);
  });
  it('does not relay pure chit-chat (no tools)', () => { const o = make(); run(o, [], '你好呀'); expect(o.relayed()).toEqual([]); });
  it('does not relay after abort', () => { const o = make(); run(o, ['tool'], '被中断了', true); expect(o.relayed()).toEqual([]); expect(o.o.state.agent.status).toBe('idle'); });
});

describe('relay waits for the avatar to finish speaking', () => {
  it('holds the next relay while remote audio is audible, releases SPEECH_SETTLE_MS after silence', () => {
    const { o, msg, relayed } = make();
    msg({ type: 'companion_say', text: '第一句' });
    vi.advanceTimersByTime(1);
    expect(relayed()).toEqual(['第一句']);
    o.setAvatarSpeaking(true);
    msg({ type: 'companion_say', text: '第二句' });
    vi.advanceTimersByTime(MIN_RELAY_GAP_MS * 4); // she is still talking → nothing new
    expect(relayed()).toEqual(['第一句']);
    o.setAvatarSpeaking(false);
    vi.advanceTimersByTime(SPEECH_SETTLE_MS - 1);
    expect(relayed()).toEqual(['第一句']);
    vi.advanceTimersByTime(2);
    expect(relayed()).toEqual(['第一句', '第二句']);
  });
  it('without an audio signal, estimates her speaking time from the transcript length', () => {
    const { o, msg, relayed } = make();
    const vidu = instances.vidu!;
    msg({ type: 'companion_say', text: '第一句' });
    vi.advanceTimersByTime(1);
    // Her 20-char reply arrives → TTS latency 3.5s + 0.9s + 20×0.23s ≈ 9s busy, far longer than the plain min gap.
    vidu.opts.emit({ type: 'transcript', role: 'companion', text: '好哒我这就去帮你把这个文件夹建起来哦' });
    msg({ type: 'companion_say', text: '第二句' });
    vi.advanceTimersByTime(MIN_RELAY_GAP_MS + 100);
    expect(relayed()).toEqual(['第一句']);
    vi.advanceTimersByTime(4000);
    expect(relayed()).toEqual(['第一句']);
    vi.advanceTimersByTime(3000);
    expect(relayed()).toEqual(['第一句', '第二句']);
    void o;
  });
});

describe('agent-host auto restart', () => {
  it('restarts once after an unexpected exit, with a delay', () => {
    const { o, agent } = make();
    agent.emit('exit', 1, null, false);
    expect(o.state.agent.status).toBe('starting');
    expect(agent.start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(AGENT_RESTART_DELAY_MS);
    expect(agent.start).toHaveBeenCalledTimes(1);
    agent.emit('message', { type: 'ready', model: 'tokendance/x', tools: [] } satisfies AgentToHost);
    expect(o.state.agent.status).toBe('idle');
  });
  it('gives up after AGENT_MAX_RESTARTS consecutive failures', () => {
    const { o, agent } = make();
    for (let i = 0; i < AGENT_MAX_RESTARTS; i++) { agent.emit('exit', 1, null, false); vi.advanceTimersByTime(AGENT_RESTART_DELAY_MS); }
    expect(agent.start).toHaveBeenCalledTimes(AGENT_MAX_RESTARTS);
    agent.emit('exit', 1, null, false);
    vi.advanceTimersByTime(AGENT_RESTART_DELAY_MS * 5);
    expect(agent.start).toHaveBeenCalledTimes(AGENT_MAX_RESTARTS);
    expect(o.state.agent.status).toBe('stopped');
    expect(o.state.agent.lastError).toContain('已停止自动重启');
  });
  it('does not restart after an expected stop', () => {
    const { o, agent } = make();
    o.stopAgent();
    agent.emit('exit', 0, null, true);
    vi.advanceTimersByTime(AGENT_RESTART_DELAY_MS * 2);
    expect(agent.start).not.toHaveBeenCalled();
    expect(o.state.agent.status).toBe('stopped');
  });
});

describe('config changes', () => {
  it('restarts agent-host when agent config changes while running', () => {
    const { o, agent } = make();
    const c = config(); c.agent.model = 'glm-5.3-flashx';
    o.setConfig(c);
    expect(agent.start).toHaveBeenCalledTimes(1);
    expect(agent.start.mock.calls[0][0]).toMatchObject({ model: 'glm-5.3-flashx', vision: true });
    o.setConfig(c);
    expect(agent.start).toHaveBeenCalledTimes(1);
  });
});

describe('auto-progress wording (task 09)', () => {
  it('describeTool never reads out commands or paths; progressLine rotates and resets per run', async () => {
    const { describeTool, progressLine, STEP_LINES, WAIT_LINES } = await import('../electron/orchestrator');
    expect(describeTool('bash', 'curl -s -m 15 https://github.com/trending -o /tmp/t.html')).toBe('查资料');
    expect(describeTool('bash', 'mkdir -p ~/Desktop/Screenshots && mv ~/Desktop/Screenshot*.png ~/Desktop/Screenshots/')).toBe('整理文件');
    expect(describeTool('bash', 'ls ~/Desktop')).toBe('跑命令');
    expect(describeTool('mac_open', 'Safari')).toBe('打开Safari');
    expect(describeTool('mac_open', 'https://github.com/trending')).toBe('打开网页');
    expect(describeTool('mac_open', '/Users/me/Desktop/report.md')).toBe('打开东西');
    expect(describeTool('applescript', 'tell application "Notes" …')).toBe('操作应用');
    const steps = STEP_LINES.map((_, i) => progressLine('step', i, '查资料'));
    expect(new Set(steps).size).toBe(STEP_LINES.length);
    for (const l of steps) { expect(l.length).toBeLessThanOrEqual(40); expect(l).not.toMatch(/正在执行命令/); }
    const waits = WAIT_LINES.map((_, i) => progressLine('wait', i, '查资料'));
    expect(new Set(waits).size).toBe(WAIT_LINES.length);
    expect(progressLine('wait', 0)).toBe('还在处理，稍等一下');
    expect(progressLine('step', STEP_LINES.length, '翻文件')).toBe(progressLine('step', 0, '翻文件'));
  });
  it('a new run starts the rotation over', () => {
    const { ev, relayed } = make();
    ev({ type: 'agent_start', promptId: 'p1' });
    vi.advanceTimersByTime(12001);
    ev({ type: 'tool_start', toolCallId: '1', name: 'bash', summary: 'ls' });
    vi.advanceTimersByTime(1);
    ev({ type: 'agent_end', promptId: 'p1', finalText: '', aborted: false });
    vi.advanceTimersByTime(MIN_RELAY_GAP_MS + 1);
    ev({ type: 'agent_start', promptId: 'p2' });
    vi.advanceTimersByTime(12001);
    ev({ type: 'tool_start', toolCallId: '2', name: 'bash', summary: 'ls' });
    vi.advanceTimersByTime(1);
    // Both runs: the watchdog fires first (seq 0 → the same template), i.e. the rotation restarted with the run.
    expect(relayed()).toEqual(['还在处理，稍等一下', '还在处理，稍等一下']);
  });
});
