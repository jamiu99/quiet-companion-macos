// Vidu S2 realtime session: HTTP create -> WS control signalling; media goes over AliRTC in the renderer.
// Ported from the previous prototype (known-good against api.vidu.cn). Message types:
//  1 conn_init  2 conn_init_ack  5 hangup(client)  6 hangup(server)  7 interrupt  9 user transcript  10 avatar text  99 text_msg
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type { ViduConfig } from '@shared/config';
import type { AvatarState, RtcCredentials, ViduRuntimeEvent } from '@shared/events';
import { makeCreatePayload, normalizeKey, validateViduConfig } from './config';

export interface ControlSocket {
  readyState: number;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate(): void;
  ping(): void;
}
export interface ViduRuntimeOptions {
  emit: (event: ViduRuntimeEvent) => void;
  /** Optional diagnostic logger (timings, message types); never receives secrets. */
  log?: (line: string) => void;
  fetcher?: typeof fetch;
  createTimeoutMs?: number;
  /** ms to wait for conn_init_ack after socket open. */
  warmupTimeoutMs?: number;
  /** ms to wait for the renderer to report a presented frame after ack. */
  firstFrameTimeoutMs?: number;
  connect?: (url: string, token: string) => ControlSocket;
}
interface LiveSession {
  id: string; connId: string; seq: number; cancelled: boolean; ready: boolean; creating: boolean;
  socket?: ControlSocket; timers: ReturnType<typeof setTimeout>[]; heartbeat?: ReturnType<typeof setInterval>;
}
type State = Omit<AvatarState, 'presented'>;
const SIGNAL_NAMES: Record<number, string> = { 1: 'conn_init', 2: 'conn_init_ack', 5: 'hangup', 6: 'force_hangup', 7: 'interrupt', 9: 'user_transcript', 10: 'avatar_text', 99: 'text_msg' };
const initial = (): State => ({ phase: 'idle', message: '未连接 · 显示本地形象', liveId: null, startedAt: null, deadline: null });

export class ViduRuntime {
  snapshot: State = initial();
  private current?: LiveSession;
  private closing = new Set<ControlSocket>();
  private readonly fetcher: typeof fetch;
  private readonly connect: NonNullable<ViduRuntimeOptions['connect']>;
  private readonly createTimeoutMs: number;
  private readonly warmupTimeoutMs: number;
  private readonly firstFrameTimeoutMs: number;

  constructor(private readonly options: ViduRuntimeOptions) {
    this.createTimeoutMs = options.createTimeoutMs ?? 90000; // official sample waits 60s; creation with a ~1–2 MB portrait can take longer
    this.warmupTimeoutMs = options.warmupTimeoutMs ?? 60000;
    this.firstFrameTimeoutMs = options.firstFrameTimeoutMs ?? 40000;
    this.fetcher = options.fetcher ?? fetch;
    this.connect = options.connect ?? ((url, token) => new WebSocket(url, {
      headers: { Authorization: `Token ${token}` }, handshakeTimeout: 15000, maxPayload: 1024 * 1024,
    }));
  }

  get phase() { return this.snapshot.phase; }
  get isLive() { return this.snapshot.phase === 'live' && this.current?.ready === true && this.current.socket?.readyState === 1; }
  get isActive() { return Boolean(this.current); }

  async start(input: ViduConfig, imageUri: string): Promise<void> {
    if (this.current || this.closing.size) throw new Error('已有会话正在运行或结束，请稍候');
    const config = validateViduConfig(input);
    const token = normalizeKey(config.apiKey);
    const s: LiveSession = { id: '', connId: randomUUID(), seq: 0, cancelled: false, ready: false, creating: true, timers: [] };
    this.current = s;
    this.update({ ...initial(), phase: 'creating', message: '数字人正在创建中…' });
    const controller = new AbortController();
    const createTimer = setTimeout(() => controller.abort(new DOMException('Create deadline', 'TimeoutError')), this.createTimeoutMs);
    const t0 = Date.now();
    const log = (line: string) => this.options.log?.(`vidu +${((Date.now() - t0) / 1000).toFixed(1)}s ${line}`);
    try {
      log(`create POST host=${config.host} body≈${Math.round(imageUri.length / 1024)}KB`);
      this.plog('out', 'create', `POST /live/s_avatar/realtime host=${config.host} model=${config.model} voice=${config.voice} image≈${Math.round(imageUri.length / 1024)}KB persona=${config.persona.length}字`);
      const response = await this.fetcher(`https://${config.host}/live/s_avatar/realtime`, {
        method: 'POST', headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(makeCreatePayload(config, imageUri)), signal: controller.signal,
      });
      log(`create response ${response.status}`);
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as Record<string, any>;
        const safe = (value: unknown) => typeof value === 'string' || typeof value === 'number'
          ? String(value).replaceAll(token, '[REDACTED]').replace(/vda_[A-Za-z0-9_-]+/g, '[REDACTED]').replace(/data:image\/[^\s"']+/g, '[IMAGE]').replace(/[\r\n\t]/g, ' ').slice(0, 350) : '';
        const parts = [safe(detail.code ?? detail.error?.code), safe(detail.message ?? detail.error?.message ?? detail.reason), safe(detail.trace_id)];
        this.plog('in', 'create_error', `HTTP ${response.status} ${parts.filter(Boolean).join(' · ')}`);
        throw new Error(`Vidu HTTP ${response.status}：${parts.filter(Boolean).join(' · ') || '请求被拒绝'}；请检查 S2 权限、余额、参考图和密钥地区。`);
      }
      const data = await response.json().catch(error => {
        if (controller.signal.aborted) throw error;
        throw new Error('Vidu 响应不是有效 JSON，远端创建结果未确认，请勿连续重试');
      }) as { live?: { id?: string; live_duration?: number }; rtc?: RtcCredentials };
      if (typeof data.live?.id !== 'string' || !data.live.id) throw new Error('Vidu 响应缺少 live.id');
      s.id = data.live.id;
      this.plog('in', 'create_ok', `live_id=${s.id} live_duration=${data.live?.live_duration ?? '-'}s rtc_user=${data.rtc?.user_id ?? '-'} token_expire_at=${data.rtc?.token_expire_at ?? '-'}`);
      log(`live.id=${s.id} live_duration=${data.live?.live_duration ?? '-'} rtc.user=${data.rtc?.user_id ?? '-'} remote=${(data.rtc as any)?.remote_user_id ?? '-'}`);
      const query = new URLSearchParams({ live_id: s.id, conn_id: s.connId });
      s.socket = this.connect(`wss://${config.host}/live/ws/live/connect?${query}`, token);
      s.socket.on('error', (e: unknown) => { log(`ws error ${(e as Error)?.message?.replace(/vda_[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 200) ?? ''}`); this.fail(s, 'Vidu 控制连接失败，请检查网络和密钥地区'); });
      s.socket.on('close', (code: unknown) => { log(`ws close code=${String(code)}`); this.fail(s, 'Vidu 连接已断开；不会自动重建付费会话'); });
      s.creating = false;
      if (s.cancelled) { this.finish(s, '已取消连接'); return; }
      const rtc = data.rtc;
      if (!rtc || typeof rtc.token !== 'string' || !rtc.token || typeof rtc.user_id !== 'string' || !rtc.user_id) throw new Error('Vidu 响应缺少 RTC 凭证');
      const expiresIn = Number(rtc.token_expire_at) * 1000 - Date.now();
      if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('RTC 凭证已过期或有效期无效');
      const cap = Math.min(config.maxMinutes * 60000, Number(data.live?.live_duration || 7200) * 1000, expiresIn);
      if (!Number.isFinite(cap) || cap <= 0) throw new Error('Vidu 会话时长无效');
      this.update({ ...initial(), phase: 'warming', liveId: s.id, message: '数字人正在创建中…' });
      this.later(s, this.warmupTimeoutMs, () => { if (!s.ready) this.fail(s, '数字人准备超时，已结束连接，请手动重试'); });
      s.socket.on('open', () => {
        if (!this.isCurrent(s)) return;
        log('ws open → conn_init');
        this.signal(s, 1, { conn_init: { version: 1 } });
        s.heartbeat = setInterval(() => { if (s.socket?.readyState === 1) s.socket.ping(); }, 5000);
      });
      s.socket.on('message', raw => {
        if (!this.isCurrent(s)) return;
        let message: any;
        try { message = JSON.parse(String(raw)); } catch { return; }
        if (!message || typeof message !== 'object') return;
        if (message.type !== 9 && message.type !== 10) log(`ws message type=${message.type} ${JSON.stringify(message.payload ?? {}).slice(0, 200)}`);
        {
          const t = message.type as number, pl = message.payload ?? {};
          const text = t === 9 || t === 10 ? String(pl.text_msg?.content ?? '') : t === 2 ? `success=${pl.conn_init_ack?.success} ${pl.conn_init_ack?.error_code ?? ''}`.trim() : t === 6 ? String(pl.hangup?.hangup_reason ?? '') : JSON.stringify(pl).slice(0, 200);
          this.plog('in', SIGNAL_NAMES[t] ?? `type${t}`, text);
        }
        const ack = message.payload?.conn_init_ack;
        if (message.type === 2 && ack && !s.ready) {
          if (ack.success === true) {
            s.ready = true;
            const now = Date.now();
            this.update({ ...this.snapshot, phase: 'connecting', startedAt: now, deadline: now + cap, message: '数字人正在创建中…' });
            this.later(s, cap, () => this.finish(s, '已达到单次会话时长上限，已挂断'));
            this.later(s, this.firstFrameTimeoutMs, () => { if (this.snapshot.phase === 'connecting') this.fail(s, '未收到数字人画面，已挂断；请检查 RTC 网络'); });
            this.options.emit({ type: 'rtc-start', liveId: s.id, rtc });
          } else if (ack.error_code === 'NOT_READY') {
            this.later(s, 3000, () => { if (!s.ready) this.signal(s, 1, { conn_init: { version: 1 } }); });
          } else this.fail(s, '数字人初始化失败，请检查模型权限并手动重试');
        }
        if (message.type === 6) {
          const rawReason = message.payload?.hangup?.hangup_reason;
          const reason = typeof rawReason === 'string' && /^[a-z_]{1,80}$/.test(rawReason) ? rawReason : 'unknown';
          this.fail(s, `Vidu 已结束会话：${reason}`);
        }
        const text = message.payload?.text_msg?.content;
        if ((message.type === 9 || message.type === 10) && typeof text === 'string' && text.trim()) {
          this.options.emit({ type: 'transcript', role: message.type === 9 ? 'user' : 'companion', text: text.slice(0, 4000) });
        }
      });
    } catch (error) {
      s.creating = false;
      if (s.cancelled) this.finish(s, s.id ? '已取消连接' : '已停止本地等待；远端创建结果未确认');
      else {
        const safe = error instanceof Error && /^(Vidu HTTP|Vidu 响应|Vidu 会话|RTC 凭证)/.test(error.message);
        const cause = error instanceof Error ? (error as Error & { cause?: { code?: unknown } }).cause?.code : undefined;
        const code = typeof cause === 'string' ? cause : 'CREATE_NETWORK';
        this.fail(s, safe ? (error as Error).message : controller.signal.aborted
          ? `创建等待超过 ${Math.round(this.createTimeoutMs / 1000)} 秒；远端结果未确认，请勿连续重试。`
          : `创建请求中断（${code}）；不会自动重试。`);
      }
    } finally { clearTimeout(createTimer); }
  }

  stop(reason = '已结束连接'): void {
    const s = this.current;
    if (!s) return;
    if (s.creating) { s.cancelled = true; this.update({ ...this.snapshot, phase: 'stopping', message: '正在取消创建…' }); }
    else this.finish(s, reason);
  }
  /** Renderer reported a real presented video frame. */
  mediaReady(liveId: string): void {
    if (this.current?.id === liveId && this.current.ready && this.snapshot.phase === 'connecting') this.update({ ...this.snapshot, phase: 'live', message: '实时陪伴中' });
  }
  mediaFailed(liveId: string, reason: string): void {
    if (this.current?.id === liveId) this.fail(this.current, `RTC 播放失败（${reason.slice(0, 120)}），已挂断`);
  }
  /** Send a user-side text message; the avatar's own LLM answers it. */
  sendText(text: string): void {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('文本需为 1–2000 字');
    const s = this.requireLive();
    this.signal(s, 99, { text_msg: { msg_id: randomUUID(), content: text.trim(), timestamp: Date.now() } });
  }
  /** Interrupt the avatar's current speech. */
  interrupt(): void { this.signal(this.requireLive(), 7, {}); }

  private requireLive(): LiveSession {
    if (!this.isLive) throw new Error('数字人尚未就绪');
    return this.current!;
  }
  private update(state: State) { this.snapshot = state; this.options.emit({ type: 'state', state }); }
  private isCurrent(s: LiveSession) { return this.current === s && !s.cancelled; }
  private later(s: LiveSession, ms: number, callback: () => void) { s.timers.push(setTimeout(() => { if (this.isCurrent(s)) callback(); }, ms)); }
  private signal(s: LiveSession, type: number, payload: object) {
    if (s.socket?.readyState !== 1) { this.plog('out', SIGNAL_NAMES[type] ?? `type${type}`, `未发送（socket 未就绪）`); return; }
    s.socket.send(JSON.stringify({ type, live_id: s.id, conn_id: s.connId, seq_id: ++s.seq, payload }));
    const p = payload as any;
    const text = type === 99 ? String(p.text_msg?.content ?? '') : type === 5 ? String(p.hangup?.hangup_reason ?? '') : type === 1 ? `version=${p.conn_init?.version}` : '';
    this.plog('out', SIGNAL_NAMES[type] ?? `type${type}`, text);
  }
  /** Protocol log line for the in-app Vidu log (never includes the key or the image). */
  private plog(dir: 'out' | 'in', tag: string, text: string) { this.options.emit({ type: 'log', dir, tag, text: text.slice(0, 600) }); }
  private fail(s: LiveSession, message: string) { if (this.current === s) this.finish(s, message, true); }
  private finish(s: LiveSession, message: string, error = false) {
    if (this.current !== s) return;
    this.current = undefined;
    s.cancelled = true;
    s.timers.forEach(clearTimeout);
    clearInterval(s.heartbeat);
    if (s.socket && s.socket.readyState !== 3) {
      const socket = s.socket;
      this.closing.add(socket);
      const timeout = setTimeout(() => socket.terminate(), 5000);
      timeout.unref?.();
      socket.once('close', () => { clearTimeout(timeout); this.closing.delete(socket); });
      const close = () => {
        try { this.signal(s, 5, { hangup: { hangup_reason: 'user_end' } }); }
        catch { this.options.log?.('vidu hangup write failed; remote stop unconfirmed'); }
        try { socket.close(); } catch { socket.terminate(); }
      };
      if (socket.readyState === 0) socket.once('open', close);
      else if (socket.readyState === 1) close();
      // CLOSING (2) still needs the termination deadline; do not create a second paid session until close arrives.
    }
    this.options.emit({ type: 'rtc-stop', liveId: s.id });
    this.update({ ...initial(), phase: error ? 'error' : 'idle', message });
  }
}
