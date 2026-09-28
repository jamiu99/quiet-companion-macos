import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { DEFAULT_CONFIG, mergeConfig, toPublicConfig } from '../shared/config';
import { sanitizeConfigPatch } from '../shared/configValidation';
import { RENDERER_CSP } from '../shared/securityPolicy';
import { ConfigStore } from '../electron/config-store';
import { LocalAssetAccess, byteRange, serveLocalAsset } from '../electron/security/local-assets';
import { assertTrustedSender, hardenRenderer, localDevOrigin, secureServiceURL, trustedRendererURL } from '../electron/security/renderer';
import { redactPayload, redactSecrets, rememberSecrets } from '../electron/security/redact';
import { initLog, log } from '../electron/log';
const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'qc-security-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('config trust boundary', () => {
  it.each([
    '{"__proto__":{"polluted":true}}', '{"companion":{"__proto__":{"polluted":true}}}',
    '{"companion":{"anchor":{"constructor":{"prototype":{"polluted":true}}}}}',
    '{"agent":{"unexpectedSecret":"must-not-cross"}}',
  ])('rejects unknown / prototype keys at every depth: %s', json => {
    const patch = JSON.parse(json);
    expect(() => sanitizeConfigPatch(patch, true)).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const c = mergeConfig(DEFAULT_CONFIG, patch);
    expect(c).toEqual(DEFAULT_CONFIG);
    expect(JSON.stringify(toPublicConfig(c))).not.toContain('must-not-cross');
  });
  it.each([{ companion: { scale: NaN } }, { companion: { anchor: { x: Infinity } } }, { vidu: { maxMinutes: 0 } }, { vidu: { host: 'evil.example' } }, { agent: { extraTools: [7] } }, { quickTasks: [{ id: 'x', label: 'x', prompt: 4 }] }])('rejects malformed values atomically', patch => {
    expect(() => sanitizeConfigPatch(patch, true)).toThrow();
  });
  it('merges nested siblings, keeps optional fields, and masks both service keys', () => {
    const c = mergeConfig(DEFAULT_CONFIG, { companion: { anchor: { x: 0.1 }, framingGuard: false, docked: { side: 'left', y: 0.2 } }, vidu: { apiKey: 'private-vidu-value' }, agent: { apiKey: 'private-agent-value' } });
    expect(c.companion.anchor).toEqual({ x: 0.1, y: DEFAULT_CONFIG.companion.anchor.y });
    expect(c.companion.framingGuard).toBe(false);
    expect(mergeConfig(c, { companion: { docked: undefined } }).companion.docked).toBeUndefined();
    const pub = toPublicConfig(c);
    expect(pub.vidu.hasKey && pub.agent.hasKey).toBe(true);
    expect(JSON.stringify(pub)).not.toMatch(/private-vidu-value|private-agent-value|"apiKey":/);
  });
  it('preserves other characters when one on-disk record has an invalid field', () => {
    const c = mergeConfig(DEFAULT_CONFIG, { characters: [{ id: 'one', name: 'A', personality: '安静', unexpectedSecret: 'drop-me' }, { id: 'two', name: 'B', style: 'unknown' }, { id: '../escape', name: 'bad' }] });
    expect(c.characters?.map(c => c.name)).toEqual(['A', 'B']);
    expect(c.characters?.[1].style).toBe('anime');
    expect(JSON.stringify(toPublicConfig(c))).not.toContain('drop-me');
  });
  it('atomically writes private config and fixes existing file permissions', () => {
    const file = join(temp(), 'config.json'), store = new ConfigStore(file);
    chmodSync(file, 0o644); store.update({ companion: { scale: 0.7 } }); store.flush();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).companion.scale).toBe(0.7);
    expect(readdirSync(join(file, '..'))).toEqual(['config.json']);
  });
});

describe('local media file authorization', () => {
  const setup = () => {
    const dir = temp(), image = join(dir, 'portrait.png'), secret = join(dir, 'config.json');
    writeFileSync(image, '0123456789'); writeFileSync(secret, 'private-config');
    const access = new LocalAssetAccess();
    const c = mergeConfig(DEFAULT_CONFIG, { vidu: { imagePath: image } }); access.setConfigured(c);
    const request = (path: string, init?: RequestInit) => new Request(`companion-asset://local/${encodeURIComponent(path)}`, init);
    return { dir, image, secret, access, c, request };
  };
  it('serves only configured or explicitly picked media, never arbitrary files', async () => {
    const { dir, image, secret, access, request } = setup();
    expect(await (await serveLocalAsset(request(image), access)).text()).toBe('0123456789');
    expect((await serveLocalAsset(request(secret), access)).status).toBe(403);
    const other = join(dir, 'other.png'); writeFileSync(other, 'other');
    expect((await serveLocalAsset(request(other), access)).status).toBe(403);
    expect(() => access.assertAssignment(other, 'image')).toThrow();
    access.select(other); expect(() => access.assertAssignment(other, 'image')).not.toThrow();
    expect(() => access.assertAssignment(other, 'video')).toThrow();
    expect(await (await serveLocalAsset(request(other), access)).text()).toBe('other');
  });
  it('refuses symlinks to secrets and symlink redirection even after an unrelated config edit', async () => {
    const { dir, image, secret, access, c, request } = setup();
    const alias = join(dir, 'alias.png'); symlinkSync(secret, alias); access.select(alias);
    expect((await serveLocalAsset(request(alias), access)).status).toBe(403);
    unlinkSync(alias); symlinkSync(image, alias);
    const changed = mergeConfig(c, { companion: { idleImagePath: alias } }); access.setConfigured(changed);
    const other = join(dir, 'other.png'); writeFileSync(other, 'private-other-image');
    unlinkSync(alias); symlinkSync(other, alias); access.setConfigured(changed);
    expect((await serveLocalAsset(request(alias), access)).status).toBe(403);
  });
  it('supports HEAD, suffix / partial ranges, and rejects invalid ranges', async () => {
    const { image, access, request } = setup();
    const head = await serveLocalAsset(request(image, { method: 'HEAD' }), access);
    expect(head.headers.get('content-length')).toBe('10'); expect(await head.text()).toBe('');
    const partial = await serveLocalAsset(request(image, { headers: { range: 'bytes=-3', origin: 'null' } }), access);
    expect(partial.status).toBe(206); expect(partial.headers.get('content-range')).toBe('bytes 7-9/10'); expect(await partial.text()).toBe('789');
    const invalid = await serveLocalAsset(request(image, { headers: { range: 'bytes=99-' } }), access);
    expect(invalid.status).toBe(416); expect(invalid.headers.get('content-range')).toBe('bytes */10');
  });
  it('handles empty files, malformed URLs, methods and foreign origins without leaking paths', async () => {
    const { image, access, request } = setup(); writeFileSync(image, '');
    expect(await (await serveLocalAsset(request(image), access)).text()).toBe('');
    expect((await serveLocalAsset(new Request('companion-asset://local/%ZZ'), access)).status).toBe(400);
    expect((await serveLocalAsset(request(image, { method: 'POST' }), access)).status).toBe(405);
    expect((await serveLocalAsset(request(image, { headers: { origin: 'https://evil.example' } }), access)).status).toBe(403);
    const dev = await serveLocalAsset(request(image, { headers: { origin: 'http://127.0.0.1:5183' } }), access, 'http://127.0.0.1:5183');
    expect(dev.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5183');
  });
  it.each(['bytes=-0', 'bytes=5-2', 'bytes=9007199254740992-', 'bytes=0-1,4-5', 'garbage'])('rejects malformed range %s', range => expect(byteRange(range, 10)).toBeUndefined());
});

describe('renderer boundary', () => {
  const page = 'file:///application/renderer/companion/index.html';
  it('checks window, top-level frame, and exact document URL, not a prefix', () => {
    const frame = { url: `${page}?debugFill=1` }, contents = { mainFrame: frame, isDestroyed: () => false } as unknown as WebContents;
    const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    expect(() => assertTrustedSender(event, contents, page)).not.toThrow();
    expect(() => assertTrustedSender({ ...event, sender: {} } as IpcMainInvokeEvent, contents, page)).toThrow();
    expect(() => assertTrustedSender({ ...event, senderFrame: { ...frame } } as IpcMainInvokeEvent, contents, page)).toThrow();
    expect(trustedRendererURL(`${page}.evil`, page)).toBe(false);
    frame.url = 'https://evil.example'; expect(() => assertTrustedSender(event, contents, page)).toThrow();
  });
  it('allows only loopback dev servers and secure model URLs', () => {
    expect(localDevOrigin('http://127.0.0.1:5183/')).toBe('http://127.0.0.1:5183');
    for (const value of ['https://evil.example', 'file:///tmp/x', 'http://127.0.0.1.evil.example', 'http://user:pass@localhost']) expect(() => localDevOrigin(value)).toThrow();
    expect(secureServiceURL('https://api.example/gateway').origin).toBe('https://api.example');
    expect(() => secureServiceURL('http://api.example')).toThrow(); expect(() => secureServiceURL('https://user:pass@api.example')).toThrow();
  });
  it('denies popup / navigation / webview / renderer permissions', () => {
    const handlers = new Map<string, (...args: any[]) => void>();
    let popup: () => { action: string }, permission: (...args: any[]) => void;
    const contents = { setWindowOpenHandler: (fn: typeof popup) => { popup = fn; }, on: (name: string, fn: (...args: any[]) => void) => handlers.set(name, fn), session: { webRequest: { onBeforeRequest: vi.fn() }, setPermissionRequestHandler: (fn: typeof permission) => { permission = fn; }, setPermissionCheckHandler: vi.fn() } } as unknown as WebContents;
    hardenRenderer(contents, page); expect(popup!().action).toBe('deny');
    expect(contents.session.webRequest.onBeforeRequest).toHaveBeenCalledWith({ urls: ['file://*/*'] }, expect.any(Function));
    const event = { preventDefault: vi.fn() }; handlers.get('will-navigate')!(event, 'https://evil.example'); expect(event.preventDefault).toHaveBeenCalled();
    const callback = vi.fn(); permission!({}, 'media', callback); expect(callback).toHaveBeenCalledWith(false);
    expect(RENDERER_CSP).toContain("object-src 'none'"); expect(RENDERER_CSP).not.toContain("'unsafe-eval'");
  });
});

describe('diagnostic privacy', () => {
  it('redacts known keys, auth strings and images without mutating the source', () => {
    const key = 'private-fixture-key-123'; rememberSecrets(key);
    const data = { message: `bad ${key}`, nested: ['Bearer abcdefghijklmnopqrstuvwxyz'], image: 'data:image/png;base64,abcdef' };
    const safe = redactPayload(data);
    expect(JSON.stringify(safe)).not.toContain(key); expect(safe.image).toBe('[IMAGE]');
    expect(data.message).toContain(key); expect(redactSecrets('ordinary text')).toBe('ordinary text');
  });
  it('writes private, redacted and size-bounded rotating logs', () => {
    rememberSecrets('private-fixture-key-123');
    const dir = temp(), file = join(dir, 'main.log');
    writeFileSync(file, 'x'.repeat(5 * 1024 * 1024)); chmodSync(file, 0o644);
    initLog(file); log('private-fixture-key-123', 'x'.repeat(30000));
    expect(existsSync(`${file}.1`)).toBe(true); expect(statSync(`${file}.1`).mode & 0o777).toBe(0o600);
    expect(statSync(file).mode & 0o777).toBe(0o600); expect(statSync(file).size).toBeLessThan(17000);
    expect(readFileSync(file, 'utf8')).not.toContain('private-fixture-key-123');
  });
});
