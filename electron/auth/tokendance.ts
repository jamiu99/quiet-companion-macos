import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TokenDanceAuthStatus } from '../../shared/auth';

import publication from '../../publication.json';
const ORIGIN = 'https://tokendance.space';
export const AUTH_APP_URL = publication.repositoryUrl;
export function validAppUrl(value: string): boolean {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && u.hostname.includes('.') && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname); } catch { return false; }
}
const MAX_RESPONSE = 16 * 1024;
const RECOVER = '如果已在网页确认或交换结果不明，请先检查本机设置，并到 TokenDance 删除不用的 Key，再重新授权；不要反复点击。';
interface Flow { verifier: string; state: string; nonce: string; server: Server; abort: AbortController; timer?: ReturnType<typeof setTimeout>; host?: string }
interface Options {
  openBrowser(url: string): Promise<unknown>;
  /** Must persist atomically BEFORE notifying consumers; throws without changing the old key on disk failure. */
  saveKey(key: string): void;
  fetch?: typeof fetch;
  appUrl?: string;
  lifetimeMs?: number; // Shortened only by offline tests.
}

/** Desktop Authorization Code + S256 PKCE. No logging of requests, responses, URLs or exception strings.
 * Single in-flight flow; fixed HTTPS origin; random loopback port; independent state; no automatic exchanges/retries.
 * Cancelling locally cannot revoke a key that the user has already created at the service. */
export class TokenDanceAuth {
  private flow?: Flow;
  private status: TokenDanceAuthStatus = { phase: 'idle', message: '在浏览器登录并确认授权，栖伴自动保存新 Key。' };
  constructor(private readonly options: Options) {}
  getStatus(): TokenDanceAuthStatus { return { ...this.status }; }
  get busy() { return Boolean(this.flow); }

  async start(): Promise<TokenDanceAuthStatus> {
    if (this.flow) return this.getStatus();
    const appUrl = this.options.appUrl ?? AUTH_APP_URL;
    if (!validAppUrl(appUrl)) { this.status = { phase: 'error', message: '本构建尚未配置维护者的稳定应用主页，请先手动填写 Key；维护者请配置 publication.json。' }; return this.getStatus(); }
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
    const server = createServer({ maxHeaderSize: 8192 }, (req, res) => this.callback(flow, req, res));
    server.maxConnections = 8; server.maxHeadersCount = 20; server.headersTimeout = 5000; server.requestTimeout = 5000; server.keepAliveTimeout = 1000;
    server.on('clientError', (_error, socket) => socket.destroy());
    const flow: Flow = { verifier, state, nonce: randomBytes(16).toString('base64url'), server, abort: new AbortController() };
    this.flow = flow;
    this.status = { phase: 'starting', message: '正在准备安全授权…', expiresAt: Date.now() + (this.options.lifetimeMs ?? 600_000) };
    flow.timer = setTimeout(() => this.finish(flow, 'error', `授权已超时。${RECOVER}`), this.options.lifetimeMs ?? 600_000);
    flow.timer.unref();
    server.on('error', () => this.finish(flow, 'error', '无法监听本机回调端口，请重试或手动填写 Key。'));
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
      if (this.flow !== flow) { server.close(); return this.getStatus(); }
      const port = (server.address() as AddressInfo).port;
      flow.host = `127.0.0.1:${port}`;
      const callback = new URL(`http://${flow.host}/callback`); callback.searchParams.set('state', state);
      const auth = new URL('/auth', ORIGIN);
      auth.searchParams.set('callback_url', callback.href);
      auth.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
      auth.searchParams.set('code_challenge_method', 'S256');
      auth.searchParams.set('app_url', appUrl); auth.searchParams.set('key_name', '栖伴 macOS');
      this.status = { ...this.status, phase: 'waiting', message: '请在浏览器确认 Key 的名称、额度、有效期和 RPM，然后返回栖伴。' };
      let abortOpen: () => void = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => { abortOpen = () => reject(new Error()); flow.abort.signal.addEventListener('abort', abortOpen, { once: true }); });
      try { await Promise.race([this.options.openBrowser(auth.href), cancelled]); }
      finally { flow.abort.signal.removeEventListener('abort', abortOpen); }
    } catch { this.finish(flow, 'error', '未能打开授权页面或本机回调，请重试或手动填写 Key。'); }
    return this.getStatus();
  }

  cancel(): TokenDanceAuthStatus {
    if (this.flow) this.finish(this.flow, 'cancelled', `本地授权已取消。${RECOVER}`);
    return this.getStatus();
  }

  private finish(flow: Flow, phase: TokenDanceAuthStatus['phase'], message: string) {
    if (this.flow !== flow) return;
    this.flow = undefined; this.status = { phase, message };
    clearTimeout(flow.timer); flow.abort.abort(); flow.verifier = ''; flow.state = '';
    // Also close slow / keep-alive clients. A not-yet-listening server is closed by start() after listen completes.
    if (flow.server.listening) {
      flow.server.close();
      // Let the callback page flush before forcibly closing any slow clients.
      const force = setTimeout(() => flow.server.closeAllConnections(), 1000); force.unref();
    }
  }

  private callback(flow: Flow, req: IncomingMessage, res: ServerResponse) {
    const reply = (code: number, body = '请求无效') => {
      res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff', 'Connection': 'close',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${flow.nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
      res.end(body);
    };
    if (this.flow !== flow || req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== flow.host || req.method !== 'GET' ||
      (req.headers.origin && req.headers.origin !== ORIGIN) || !req.url?.startsWith('/') || req.url.startsWith('//') || req.url.length > 4096) { reply(400); return; }
    let url: URL;
    try { url = new URL(req.url, `http://${flow.host}`); } catch { reply(400); return; }
    if (url.pathname === '/complete') { reply(200, '<meta charset="utf-8"><title>栖伴授权</title><p>请返回栖伴查看授权结果。</p>'); return; }
    if (url.pathname !== '/callback') { reply(404); return; }
    const states = url.searchParams.getAll('state'), state = states[0] ?? '';
    if (states.length !== 1 || Buffer.byteLength(state) !== Buffer.byteLength(flow.state) || !timingSafeEqual(Buffer.from(state), Buffer.from(flow.state))) { reply(400); return; }
    if (this.status.phase !== 'waiting') { reply(409); return; }
    const codes = url.searchParams.getAll('code'), code = codes[0] ?? '';
    if (codes.length !== 1 || !code || code.length > 2048 || /[\x00-\x20\x7f]/.test(code)) { reply(400); return; }
    this.status = { ...this.status, phase: 'exchanging', message: '正在交换并保存 Key，请勿重复授权…' };
    // Remove the short-lived code from this browser history entry. This page has no external assets / analytics.
    reply(200, `<meta charset="utf-8"><title>栖伴授权</title><script nonce="${flow.nonce}">history.replaceState(null,'','/complete')</script><p>已收到授权结果，请返回栖伴查看保存状态。可以关闭此页面。</p>`);
    void this.exchange(flow, code);
  }

  private async exchange(flow: Flow, code: string) {
    try {
      const response = await (this.options.fetch ?? fetch)(`${ORIGIN}/portal/api/v1/auth/keys`, {
        method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ code, code_verifier: flow.verifier, code_challenge_method: 'S256' }),
        signal: AbortSignal.any([flow.abort.signal, AbortSignal.timeout(20_000)]),
      });
      if (this.flow !== flow) { await response.body?.cancel(); return; }
      if (!response.ok) {
        await response.body?.cancel();
        this.finish(flow, 'error', response.status === 403 ? '授权码无效、已过期、已使用或 PKCE 不匹配，请重新授权。' : `授权交换失败（HTTP ${response.status}）。${RECOVER}`);
        return;
      }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) throw new Error();
      const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_RESPONSE) throw new Error(); chunks.push(value); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const key = payload && typeof payload === 'object' && 'key' in payload ? payload.key : undefined;
      if (typeof key !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(key)) throw new Error();
      if (this.flow !== flow) return; // A late response after cancellation must never replace an existing credential.
      this.options.saveKey(key);
      this.finish(flow, 'success', '授权成功，Key 已保存到本机受保护配置；未触发模型调用或数字人连接。');
    } catch { this.finish(flow, 'error', `未能完成交换或保存。${RECOVER}`); }
  }
}
