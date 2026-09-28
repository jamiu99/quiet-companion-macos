import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { TokenDanceAuth, validAppUrl } from '../electron/auth/tokendance';

const APP_URL = 'https://example.org/quiet-companion';
const flows: TokenDanceAuth[] = [];
afterEach(() => flows.splice(0).forEach(f => f.cancel()));
function setup(options: Partial<ConstructorParameters<typeof TokenDanceAuth>[0]> = {}) {
  const opened: string[] = [], saved: string[] = [];
  const exchange = vi.fn(async () => Response.json({ key: 'fixture-new-private-key' }));
  const auth = new TokenDanceAuth({ openBrowser: async url => { opened.push(url); }, saveKey: key => { saved.push(key); }, fetch: exchange, appUrl: APP_URL, ...options });
  flows.push(auth);
  const callback = () => { const u = new URL(new URL(opened[0]).searchParams.get('callback_url')!); u.searchParams.set('code', 'one-time-fixture-code'); return u; };
  return { auth, opened, saved, exchange, callback };
}
// Real loopback socket, never global fetch / external network. TokenDance exchange is always injected.
function local(url: URL, options: { method?: string; headers?: Record<string, string>; path?: string } = {}) {
  if (url.hostname !== '127.0.0.1') throw new Error('Only loopback is allowed');
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: Number(url.port), path: options.path ?? `${url.pathname}${url.search}`, method: options.method ?? 'GET', headers: options.headers, agent: false }, res => {
      const data: Buffer[] = []; res.on('data', x => data.push(x)); res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(data).toString(), headers: res.headers }));
    });
    req.setTimeout(1500, () => req.destroy(new Error('loopback timeout'))); req.on('error', reject); req.end();
  });
}

describe('TokenDance desktop S256 authorization', () => {
  it('has no browser / listener side effect when publisher attribution is unset', async () => {
    const f = setup({ appUrl: '' }); expect(await f.auth.start()).toMatchObject({ phase: 'error' }); expect(f.auth.busy).toBe(false); expect(f.opened).toHaveLength(0); expect(f.exchange).not.toHaveBeenCalled();
  });
  it.each(['', 'http://example.org', 'https://localhost', 'https://127.0.0.1', 'https://u:p@example.org', 'https://example.org/?token=x', 'https://example.org/#x'])('rejects non-public / credential-bearing attribution: %s', value => expect(validAppUrl(value)).toBe(false));
  it('pins origin + stable attribution, verifies PKCE and exposes no credentials in status/callback', async () => {
    const f = setup(); await f.auth.start();
    const authUrl = new URL(f.opened[0]), cb = f.callback();
    expect(authUrl.origin).toBe('https://tokendance.space'); expect(authUrl.pathname).toBe('/auth');
    expect(authUrl.searchParams.get('app_url')).toBe(APP_URL);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(cb.hostname).toBe('127.0.0.1'); expect(Number(cb.port)).toBeGreaterThan(0); expect(cb.searchParams.get('state')!.length).toBeGreaterThanOrEqual(43);
    const response = await local(cb);
    expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer'); expect(response.body).toContain('history.replaceState');
    await vi.waitFor(() => expect(f.auth.getStatus().phase).toBe('success'));
    const [endpoint, init] = f.exchange.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe('https://tokendance.space/portal/api/v1/auth/keys'); expect(init.redirect).toBe('error');
    const payload = JSON.parse(String(init.body));
    expect(payload.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(createHash('sha256').update(payload.code_verifier).digest('base64url')).toBe(authUrl.searchParams.get('code_challenge'));
    expect(payload.code).toBe('one-time-fixture-code'); expect(payload.code_challenge_method).toBe('S256');
    expect(f.saved).toEqual(['fixture-new-private-key']);
    const exposed = JSON.stringify(f.auth.getStatus()) + response.body + f.opened.join('');
    expect(exposed).not.toContain(payload.code_verifier); expect(exposed).not.toContain(payload.code); expect(exposed).not.toContain(f.saved[0]);
    await expect(local(cb)).rejects.toThrow();
  });
  it('deduplicates starts and never exchanges the callback twice', async () => {
    let resolve!: (r: Response) => void;
    const f = setup({ fetch: vi.fn(() => new Promise<Response>(r => { resolve = r; })) });
    await Promise.all([f.auth.start(), f.auth.start()]); expect(f.opened).toHaveLength(1);
    expect((await local(f.callback())).status).toBe(200);
    expect((await local(f.callback())).status).toBe(409);
    resolve(Response.json({ key: 'fixture-single-key' }));
    await vi.waitFor(() => expect(f.auth.getStatus().phase).toBe('success'));
    expect(f.saved).toEqual(['fixture-single-key']);
  });
  it.each(['state', 'duplicate-state', 'duplicate-code', 'no-code', 'path', 'host', 'origin', 'method', 'absolute-url', 'oversize'])('rejects %s without consuming the flow', async kind => {
    const f = setup(); await f.auth.start(); const cb = f.callback();
    const options: Parameters<typeof local>[1] = {};
    if (kind === 'state') cb.searchParams.set('state', 'x'.repeat(43));
    if (kind === 'duplicate-state') cb.searchParams.append('state', cb.searchParams.get('state')!);
    if (kind === 'duplicate-code') cb.searchParams.append('code', 'second');
    if (kind === 'no-code') cb.searchParams.delete('code');
    if (kind === 'path') cb.pathname = '/not-callback';
    if (kind === 'host') options.headers = { Host: 'evil.example' };
    if (kind === 'origin') options.headers = { Origin: 'https://evil.example' };
    if (kind === 'method') options.method = 'POST';
    if (kind === 'absolute-url') options.path = cb.href;
    if (kind === 'oversize') cb.searchParams.set('code', 'x'.repeat(5000));
    expect((await local(cb, options)).status).toBeGreaterThanOrEqual(400);
    expect(f.exchange).not.toHaveBeenCalled(); expect(f.auth.getStatus().phase).toBe('waiting');
  });
  it('cancels exchange and ignores a late result even after starting a fresh flow', async () => {
    let resolve!: (r: Response) => void; let signal: AbortSignal | undefined;
    const f = setup({ fetch: async (_url, init) => { signal = init?.signal ?? undefined; return new Promise(r => { resolve = r; }); } });
    await f.auth.start(); await local(f.callback()); f.auth.cancel(); expect(signal?.aborted).toBe(true);
    const first = new URL(f.opened[0]).searchParams.get('code_challenge');
    await f.auth.start(); expect(new URL(f.opened[1]).searchParams.get('code_challenge')).not.toBe(first);
    resolve(Response.json({ key: 'fixture-stale-key' })); await new Promise(r => setTimeout(r, 20));
    expect(f.saved).toEqual([]); expect(f.auth.getStatus().phase).toBe('waiting');
  });
  it('expires and closes the listener', async () => {
    const f = setup({ lifetimeMs: 60 }); await f.auth.start(); const cb = f.callback();
    await vi.waitFor(() => expect(f.auth.getStatus().phase).toBe('error'));
    await expect(local(cb)).rejects.toThrow(); expect(f.exchange).not.toHaveBeenCalled();
  });
  it('does not leave a listener when cancelled while binding', async () => {
    const f = setup(); const pending = f.auth.start(); f.auth.cancel(); await pending;
    expect(f.opened).toEqual([]); expect(f.auth.busy).toBe(false);
  });
  it('cancellation releases start even if the OS browser-open promise never resolves', async () => {
    const f = setup({ openBrowser: () => new Promise(() => {}) });
    const pending = f.auth.start();
    await vi.waitFor(() => expect(f.auth.getStatus().phase).toBe('waiting'));
    f.auth.cancel(); await pending; expect(f.auth.busy).toBe(false);
  });
  it('sanitizes browser errors and releases the flow', async () => {
    const f = setup({ openBrowser: async () => { throw new Error('fixture-private-browser-error'); } });
    await f.auth.start(); expect(f.auth.getStatus().phase).toBe('error'); expect(JSON.stringify(f.auth.getStatus())).not.toContain('fixture-private'); expect(f.auth.busy).toBe(false);
  });
  it.each(['403', '400', 'redirect', 'network', 'malformed', 'large', 'save'])('fails closed on %s without retry or returning raw errors', async kind => {
    const exchange = vi.fn(async () => {
      if (kind === 'network') throw new Error('fixture-private-network-error');
      if (kind === '403' || kind === '400') return new Response('fixture-private-response', { status: Number(kind) });
      if (kind === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://evil.example' } });
      if (kind === 'malformed') return Response.json({ key: 'bad\nheader' });
      if (kind === 'large') return Response.json({ key: 'x'.repeat(17000) });
      return Response.json({ key: 'fixture-private-key' });
    });
    const f = setup({ fetch: exchange, ...(kind === 'save' ? { saveKey: () => { throw new Error('fixture-private-disk-error'); } } : {}) });
    await f.auth.start(); await local(f.callback());
    await vi.waitFor(() => expect(f.auth.getStatus().phase).toBe('error'));
    expect(exchange).toHaveBeenCalledTimes(1); expect(f.saved).toEqual([]);
    expect(JSON.stringify(f.auth.getStatus())).not.toContain('fixture-private');
  });
});
