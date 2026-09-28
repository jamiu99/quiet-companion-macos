import { RELAY_TAG } from '@shared/config';
// Vidu S2 runtime state machine with a fake fetcher / control socket (no paid session is ever created here).
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ViduRuntime, type ControlSocket } from '../electron/vidu/runtime';
import { DEFAULT_CONFIG, type ViduConfig } from '../shared/config';
import type { ViduRuntimeEvent } from '../shared/events';

class Socket extends EventEmitter {
  readyState = 0;
  sent: any[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  ping() {}
  open() { this.readyState = 1; this.emit('open'); }
  message(data: unknown) { this.emit('message', Buffer.from(JSON.stringify(data))); }
  ack(success = true, error_code = '') { this.message({ type: 2, payload: { conn_init_ack: { success, error_code } } }); }
}
const LIVE_ID = '995200676634042368';
const response = () => ({
  live: { id: LIVE_ID, live_duration: 7200 },
  rtc: { token: 'temporary-rtc', user_id: 'viewer', token_expire_at: String(Math.floor(Date.now() / 1000) + 3600) },
});
const config: ViduConfig = { ...DEFAULT_CONFIG.vidu, apiKey: 'vda_demo123', maxMinutes: 3 };
const IMAGE = 'data:image/png;base64,aGVsbG8=';

let runtime: ViduRuntime;
let socket: Socket;
let events: ViduRuntimeEvent[];
let fetcher: Mock<typeof fetch>;
let connect: Mock<(url: string, token: string) => ControlSocket>;
const phases = () => events.filter(e => e.type === 'state').map(e => (e as any).state.phase);

beforeEach(() => {
  vi.useFakeTimers();
  events = [];
  socket = new Socket();
  fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response())));
  connect = vi.fn(() => socket as ControlSocket);
  runtime = new ViduRuntime({ emit: e => events.push(e), fetcher, connect });
});
afterEach(() => { runtime.stop(); vi.useRealTimers(); });

async function ready() { await runtime.start(config, IMAGE); socket.open(); socket.ack(); }

describe('Vidu session lifecycle', () => {
  it('creates the session, signals conn_init, hands RTC credentials to the media view only after the ack', async () => {
    await runtime.start(config, IMAGE);
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.vidu.cn/live/s_avatar/realtime');
    expect(new Headers(request?.headers).get('Authorization')).toBe('Token vda_demo123');
    const body = JSON.parse(String(request?.body));
    expect(body.model).toBe('vidu-s2');
    expect(body.avatar.image_uri).toBe(IMAGE);
    expect(body.avatar.persona).toContain(RELAY_TAG);
    expect(connect.mock.calls[0][0]).toContain(`live_id=${LIVE_ID}`);
    expect(runtime.snapshot.phase).toBe('warming');
    expect(events.some(e => e.type === 'rtc-start')).toBe(false);
    socket.open();
    expect(socket.sent[0]).toMatchObject({ type: 1, seq_id: 1, live_id: LIVE_ID, payload: { conn_init: { version: 1 } } });
    socket.ack();
    expect(runtime.snapshot.phase).toBe('connecting');
    expect(runtime.isLive).toBe(false);
    expect(events.find(e => e.type === 'rtc-start')).toMatchObject({ liveId: LIVE_ID, rtc: { token: 'temporary-rtc', user_id: 'viewer' } });
    expect(JSON.stringify(events.filter(e => e.type === 'state'))).not.toContain('temporary-rtc');
    runtime.mediaReady(LIVE_ID);
    expect(runtime.snapshot.phase).toBe('live');
    expect(runtime.isLive).toBe(true);
    expect(phases()).toEqual(['creating', 'warming', 'connecting', 'live']);
  });

  it('sends text / interrupt only when live and hangs up cleanly on stop', async () => {
    expect(() => runtime.sendText('hello')).toThrow();
    await ready();
    expect(() => runtime.sendText('hello')).toThrow();
    runtime.mediaReady(LIVE_ID);
    runtime.sendText('你好'); runtime.interrupt();
    expect(socket.sent.at(-2)).toMatchObject({ type: 99, payload: { text_msg: { content: '你好' } } });
    expect(socket.sent.at(-1).type).toBe(7);
    for (const value of ['', ' ', 'x'.repeat(2001)]) expect(() => runtime.sendText(value)).toThrow();
    runtime.stop('已结束');
    expect(socket.sent.at(-1)).toMatchObject({ type: 5, payload: { hangup: { hangup_reason: 'user_end' } } });
    expect(runtime.snapshot.phase).toBe('idle');
    expect(runtime.isActive).toBe(false);
    expect(events.at(-2)).toMatchObject({ type: 'rtc-stop', liveId: LIVE_ID });
  });

  it('waits for control socket closure before allowing another paid create', async () => {
    await ready(); runtime.mediaReady(LIVE_ID);
    socket.close = () => { socket.readyState = 2; };
    socket.terminate = () => { socket.readyState = 3; socket.emit('close', 1006); };
    runtime.stop();
    expect(runtime.snapshot.phase).toBe('idle');
    await expect(runtime.start(config, IMAGE)).rejects.toThrow('正在运行或结束');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5001);
    await runtime.start(config, IMAGE); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('still tears down media when the hangup write throws', async () => {
    await ready(); runtime.mediaReady(LIVE_ID);
    socket.send = () => { throw new Error('socket write failed'); };
    expect(() => runtime.stop()).not.toThrow();
    expect(runtime.snapshot.phase).toBe('idle'); expect(socket.readyState).toBe(3);
    expect(events.some(e => e.type === 'rtc-stop')).toBe(true);
  });

  it('refuses a second start while a session exists (no double billing)', async () => {
    await ready();
    await expect(runtime.start(config, IMAGE)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('retries NOT_READY on the same socket and ignores duplicate success acks', async () => {
    await runtime.start(config, IMAGE); socket.open(); socket.ack(false, 'NOT_READY');
    await vi.advanceTimersByTimeAsync(3000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(socket.sent.map(e => e.type)).toEqual([1, 1]);
    expect(socket.sent[1].seq_id).toBe(2);
    socket.ack(); socket.ack();
    expect(events.filter(e => e.type === 'rtc-start')).toHaveLength(1);
  });

  it('times out warmup without reconnecting or leaving a billable session', async () => {
    await runtime.start(config, IMAGE); socket.open();
    await vi.advanceTimersByTimeAsync(60001);
    expect(runtime.snapshot.phase).toBe('error');
    expect(socket.sent.at(-1).type).toBe(5);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('ends a ready session if no video frame arrives', async () => {
    await ready();
    await vi.advanceTimersByTimeAsync(40001);
    expect(runtime.snapshot.phase).toBe('error');
    expect(runtime.snapshot.message).toContain('画面');
    expect(socket.sent.at(-1).type).toBe(5);
    expect(events.some(e => e.type === 'rtc-stop')).toBe(true);
  });

  it('enforces maxMinutes from control readiness and returns to idle', async () => {
    await ready(); runtime.mediaReady(LIVE_ID);
    await vi.advanceTimersByTimeAsync(3 * 60000 - 1);
    expect(runtime.snapshot.phase).toBe('live');
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.snapshot.phase).toBe('idle');
    expect(runtime.snapshot.message).toContain('时长');
    expect(socket.sent.at(-1).type).toBe(5);
  });

  it('honors shorter server limits and rejects expired RTC credentials', async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...response(), live: { id: 's', live_duration: 10 } })));
    await ready(); runtime.mediaReady('s');
    await vi.advanceTimersByTimeAsync(10000);
    expect(runtime.snapshot.phase).toBe('idle');
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...response(), rtc: { token: 't', user_id: 'u', token_expire_at: '1' } })));
    await runtime.start(config, IMAGE);
    expect(runtime.snapshot.phase).toBe('error');
    expect(runtime.isActive).toBe(false);
  });

  it.each(['close', 'error'])('cleans media and reports an error on socket %s (network drop)', async kind => {
    await ready(); runtime.mediaReady(LIVE_ID);
    socket.emit(kind, new Error('private upstream message'));
    expect(runtime.snapshot.phase).toBe('error');
    expect(runtime.snapshot.message).not.toContain('private');
    expect(events.some(e => e.type === 'rtc-stop')).toBe(true);
    expect(runtime.isActive).toBe(false);
  });

  it('handles explicit init failures, malformed and unrelated messages', async () => {
    await runtime.start(config, IMAGE); socket.open();
    socket.emit('message', Buffer.from('not JSON')); socket.message({ type: 123 });
    expect(runtime.snapshot.phase).toBe('warming');
    socket.ack(false, 'LIVE_CONN_INIT_FAILED');
    expect(runtime.snapshot.phase).toBe('error');
  });

  it('surfaces server hangup (type 6) reasons without reconnecting', async () => {
    await ready(); runtime.mediaReady(LIVE_ID);
    socket.message({ type: 6, payload: { hangup: { hangup_reason: 'credit_insufficient' } } });
    expect(runtime.snapshot.phase).toBe('error');
    expect(runtime.snapshot.message).toContain('credit_insufficient');
    expect(connect).toHaveBeenCalledTimes(1);
    socket.message({ type: 6, payload: { hangup: { hangup_reason: '<script>' } } });
    expect(runtime.snapshot.message).not.toContain('<script>');
  });

  it('forwards user (type 9) and avatar (type 10) transcripts', async () => {
    await ready();
    socket.message({ type: 9, payload: { text_msg: { content: '你好呀' } } });
    socket.message({ type: 10, payload: { text_msg: { content: '嗨，我在呢' } } });
    socket.message({ type: 10, payload: { text_msg: { content: '   ' } } });
    expect(events.filter(e => e.type === 'transcript')).toEqual([
      { type: 'transcript', role: 'user', text: '你好呀' },
      { type: 'transcript', role: 'companion', text: '嗨，我在呢' },
    ]);
  });

  it('does not let stale events, ready callbacks or media errors affect a later session', async () => {
    await ready(); runtime.stop();
    socket.ack(); runtime.mediaReady('stale'); runtime.mediaFailed('stale', 'bad');
    expect(runtime.snapshot.phase).toBe('idle');
    runtime.mediaReady(LIVE_ID);
    expect(runtime.snapshot.phase).toBe('idle');
  });

  it('fails safely for HTTP, invalid-response and network errors', async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'vda_demo123 private' }), { status: 401 }));
    await runtime.start(config, IMAGE);
    expect(runtime.snapshot.phase).toBe('error');
    expect(runtime.snapshot.message).toContain('401');
    expect(runtime.snapshot.message).not.toContain('vda_demo123');
    expect(connect).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(new Response('{}'));
    await runtime.start(config, IMAGE);
    expect(runtime.snapshot.phase).toBe('error');
    expect(runtime.snapshot.message).toContain('live.id');
    fetcher.mockRejectedValueOnce(Object.assign(new TypeError('private URL vda_demo123'), { cause: { code: 'ECONNRESET' } }));
    await runtime.start(config, IMAGE);
    expect(runtime.snapshot.message).toContain('ECONNRESET');
    expect(runtime.snapshot.message).not.toContain('private');
    fetcher.mockResolvedValueOnce(new Response('not-json-private'));
    await runtime.start(config, IMAGE);
    expect(runtime.snapshot.message).toContain('响应不是有效 JSON');
    expect(runtime.snapshot.message).not.toContain('not-json-private');
    expect(runtime.isActive).toBe(false);
  });

  it('surfaces safe upstream business errors without disclosing the key or image', async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'MODEL_NOT_ENABLED', message: 'S2 is not enabled for vda_demo123', trace_id: 'trace-abc' }), { status: 403 }));
    await runtime.start(config, IMAGE);
    expect(runtime.snapshot.message).toContain('MODEL_NOT_ENABLED');
    expect(runtime.snapshot.message).toContain('trace-abc');
    expect(runtime.snapshot.message).not.toContain('vda_demo123');
  });

  it('reports a local create timeout as an uncertain result and leaves no timers', async () => {
    fetcher.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason));
    }));
    const pending = runtime.start(config, IMAGE);
    await vi.advanceTimersByTimeAsync(90001);
    await pending;
    expect(runtime.snapshot.phase).toBe('error');
    expect(runtime.snapshot.message).toContain('远端结果未确认');
    expect(connect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops a pending create, then hangs up its late result without initializing generation', async () => {
    let resolve!: (response: Response) => void;
    fetcher.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const creating = runtime.start(config, IMAGE);
    runtime.stop();
    expect(runtime.snapshot.phase).toBe('stopping');
    await expect(runtime.start(config, IMAGE)).rejects.toThrow();
    resolve(new Response(JSON.stringify(response())));
    await creating;
    socket.open();
    expect(socket.sent.map(s => s.type)).toEqual([5]);
    expect(runtime.snapshot.phase).toBe('idle');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('bounds cleanup of sockets that never open', async () => {
    await runtime.start(config, IMAGE); runtime.stop();
    await vi.advanceTimersByTimeAsync(5001);
    expect(socket.readyState).toBe(3);
  });

  it('turns a renderer media failure into an error and a hangup', async () => {
    await ready(); runtime.mediaReady(LIVE_ID);
    runtime.mediaFailed(LIVE_ID, 'RTC_BYE');
    expect(runtime.snapshot.phase).toBe('error');
    expect(runtime.snapshot.message).toContain('RTC_BYE');
    expect(socket.sent.at(-1).type).toBe(5);
  });

  it('rejects invalid configuration before any network call', async () => {
    await runtime.start({ ...config, apiKey: 'nope' }, IMAGE).catch(() => {});
    await runtime.start({ ...config, maxMinutes: 0 }, IMAGE).catch(() => {});
    expect(fetcher).not.toHaveBeenCalled();
  });
});
