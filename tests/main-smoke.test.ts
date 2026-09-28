// Smoke test for the built main bundle: load it with a stubbed `electron` and make sure every IPC handler registers
// (a self-recursive `handle()` wrapper once shipped and left the renderer with no IPC at all).
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import type { EventEmitter } from 'node:events';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IPC } from '../shared/ipc';
import { get as httpGet } from 'node:http';

const bundle = join(__dirname, '..', 'dist', 'electron', 'main.cjs');

describe('dist/electron/main.cjs', () => {
  it.skipIf(!existsSync(bundle))('registers every IPC channel exactly once without throwing', async () => {
    const temp = mkdtempSync(join(os.tmpdir(), 'companion-main-smoke-'));
    const env = { ...process.env };
    const events = ['uncaughtException', 'unhandledRejection'] as const;
    const emitter: EventEmitter = process;
    const listeners = events.map(event => emitter.listeners(event));
    for (const k of Object.keys(process.env)) if (/^(COMPANION_|VIDU_|TOKENDANCE_)/.test(k)) delete process.env[k];
    process.env.COMPANION_SMOKE_NO_AGENT = '1';
    process.env.COMPANION_AUTH_APP_URL = 'https://example.org/quiet-companion';
    vi.useFakeTimers();
    const registered = new Map<string, number>();
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const paths: Record<string, string> = { home: join(temp, 'home'), appData: join(temp, 'appData'), userData: join(temp, 'userData') };
    const readyCallbacks: Array<() => unknown> = [];
    const frame = { url: '' }, pushed: unknown[] = [];
    const webContents = { mainFrame: frame, isDestroyed: () => false, setWindowOpenHandler: () => {}, on: () => {}, session: { webRequest: { onBeforeRequest: () => {} }, setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} }, send: (...args: unknown[]) => { pushed.push(args); }, capturePage: async () => ({ toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 1, height: 1 }) }) };
    const sender = { sender: webContents, senderFrame: frame };
    const stubWindow = () => ({
      loadURL: (url: string) => { frame.url = url; return Promise.resolve(); }, loadFile: (path: string) => { frame.url = pathToFileURL(path).href; return Promise.resolve(); }, on: () => {}, once: (_: string, cb: () => void) => { if (_ === 'ready-to-show') cb(); }, show: () => {}, showInactive: () => {}, hide: () => {},
      isDestroyed: () => false, isVisible: () => true, getBounds: () => ({ x: 0, y: 0, width: 1470, height: 956 }), setBounds: () => {}, setAlwaysOnTop: () => {}, setIgnoreMouseEvents: () => {},
      setVisibleOnAllWorkspaces: () => {}, focus: () => {}, blur: () => {}, destroy: () => {}, isAlwaysOnTop: () => true, isFocusable: () => true,
      webContents,
    });
    const electron = {
      app: { requestSingleInstanceLock: () => true, exit: (code: number) => { throw new Error(`TEST_EXIT_${code}`); }, getPath: (name: string) => paths[name] ?? join(temp, name), setPath: (name: string, path: string) => { paths[name] = path; }, whenReady: () => ({ then: (cb: () => unknown) => { readyCallbacks.push(cb); return Promise.resolve(); } }), on: () => {}, quit: () => {}, dock: { hide: () => {} }, getVersion: () => '0.0.0', isQuitting: false, isPackaged: false },
      BrowserWindow: function () { return stubWindow(); },
      ipcMain: { handle: (ch: string, fn: (...args: unknown[]) => unknown) => { handlers.set(ch, fn); registered.set(ch, (registered.get(ch) ?? 0) + 1); } },
      protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
      screen: { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1470, height: 956 }, workArea: { x: 0, y: 0, width: 1470, height: 900 } }), on: () => {}, getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1470, height: 956 } }) },
      globalShortcut: { register: () => true, unregister: () => {}, unregisterAll: () => {}, isRegistered: () => false },
      Tray: function () { return { setToolTip: () => {}, setContextMenu: () => {}, on: () => {}, setImage: () => {} }; },
      Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
      nativeImage: { createFromPath: () => ({ isEmpty: () => true, setTemplateImage: () => {}, resize: () => ({}), getSize: () => ({ width: 0, height: 0 }) }), createFromBuffer: () => ({ isEmpty: () => true, setTemplateImage: () => {} }), createEmpty: () => ({ setTemplateImage: () => {} }) },
      Notification: function () { return { show: () => {} }; },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: vi.fn(async () => ({ response: 0 })) },
      shell: { openExternal: vi.fn(async (_url: string) => {}), openPath: async () => '', showItemInFolder: () => {} },
      net: { fetch: async () => new Response('') },
    };
    // Anything the bundle touches that the stub lacks becomes a harmless no-op function / object.
    const permissive = <T extends object>(o: T): T => new Proxy(o, { get: (t, k) => (k in t ? (t as any)[k] : (k === 'then' ? undefined : permissive(function () { return permissive({}); } as any))) });
    for (const k of Object.keys(electron) as (keyof typeof electron)[]) (electron as any)[k] = typeof electron[k] === 'function' ? electron[k] : permissive(electron[k] as object);
    const req = createRequire(bundle);
    const Module = req('node:module') as { _load: (...a: unknown[]) => unknown };
    const original = Module._load;
    // Isolate disk, home expansion, credentials and child processes. Loading main must not seed real .env keys or
    // honor inherited COMPANION_AUTOCONNECT / generation hooks in an otherwise offline test.
    const spawn = vi.fn(() => { throw new Error('child process forbidden in main smoke test'); });
    Module._load = function (this: unknown, request: string, ...rest: unknown[]) {
      if (request === 'electron') return electron;
      if (request === 'node:fs') return { ...fs, existsSync: (path: string) => /^\.env(?:\.|$)/.test(basename(String(path))) ? false : existsSync(path) };
      if (request === 'node:os') return { ...os, homedir: () => paths.home };
      if (request === 'node:child_process') return { spawn };
      return original.call(this, request, ...rest);
    } as typeof Module._load;
    try {
      delete req.cache[bundle];
      req(bundle);
      for (const cb of readyCallbacks) await cb();
      const config = await handlers.get(IPC.getConfig)?.(sender) as { vidu: { hasKey: boolean }; agent: { hasKey: boolean } };
      expect(config.vidu.hasKey).toBe(false); expect(config.agent.hasKey).toBe(false);
      expect(await handlers.get(IPC.getTokenDanceAuth)?.(sender)).toMatchObject({ phase: 'idle' });
      await expect(handlers.get(IPC.beginTokenDanceAuth)?.({ sender: {}, senderFrame: frame })).rejects.toThrow('IPC 来源');
      expect(await handlers.get(IPC.beginTokenDanceAuth)?.(sender)).toMatchObject({ phase: 'cancelled' });
      expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1);
      expect(electron.shell.openExternal).not.toHaveBeenCalled();
      await expect(handlers.get(IPC.getConfig)?.({ sender: {}, senderFrame: frame })).rejects.toThrow('IPC 来源');
      await expect(handlers.get(IPC.getConfig)?.({ sender: webContents, senderFrame: { url: frame.url } })).rejects.toThrow('IPC 来源');
      await expect(handlers.get(IPC.setConfig)?.(sender, { characters: [] })).rejects.toThrow('角色修改');
      await expect(handlers.get(IPC.setConfig)?.(sender, { vidu: { imagePath: '/etc/passwd' } })).rejects.toThrow('素材必须');
      await expect(handlers.get(IPC.setConfig)?.(sender, JSON.parse('{"__proto__":{"polluted":true}}'))).rejects.toThrow('不允许修改');
      // Exercise the built main's complete successful save boundary: browser and service are mocked, callback is real loopback.
      await handlers.get(IPC.setConfig)?.(sender, { agent: { apiKey: 'fixture-main-old-key', baseUrl: 'https://fixture.invalid/gateway' } });
      electron.dialog.showMessageBox.mockResolvedValue({ response: 1 });
      const exchange = vi.fn(async () => Response.json({ key: 'fixture-main-new-key' })); vi.stubGlobal('fetch', exchange);
      expect(await handlers.get(IPC.beginTokenDanceAuth)?.(sender)).toMatchObject({ phase: 'waiting' });
      const browser = new URL(electron.shell.openExternal.mock.calls.at(-1)![0]);
      const callback = new URL(browser.searchParams.get('callback_url')!);
      expect(callback.hostname).toBe('127.0.0.1'); expect(callback.protocol).toBe('http:');
      callback.searchParams.set('code', 'fixture-main-code');
      const httpStatus = await new Promise<number | undefined>((resolve, reject) => { httpGet(callback, { agent: false }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); }).once('error', reject); });
      expect(httpStatus).toBe(200);
      expect(await handlers.get(IPC.getTokenDanceAuth)?.(sender)).toMatchObject({ phase: 'success' });
      expect(exchange).toHaveBeenCalledTimes(1);
      const saved = JSON.parse(fs.readFileSync(join(paths.userData, 'config.json'), 'utf8'));
      expect(saved.agent.apiKey).toBe('fixture-main-new-key'); expect(saved.agent.baseUrl).toBe('https://tokendance.space/gateway');
      expect(JSON.stringify(pushed)).not.toContain('fixture-main-new-key');
      expect(JSON.stringify(await handlers.get(IPC.getConfig)?.(sender))).not.toContain('fixture-main-new-key');
      // A deliberate manual edit cancels the next flow rather than being overwritten by it.
      await handlers.get(IPC.beginTokenDanceAuth)?.(sender);
      await handlers.get(IPC.setConfig)?.(sender, { agent: { apiKey: 'fixture-main-manual-key' } });
      expect(await handlers.get(IPC.getTokenDanceAuth)?.(sender)).toMatchObject({ phase: 'cancelled' });
      expect(exchange).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
      // A second process must exit before constructing runtimes or registering more handlers.
      electron.app.requestSingleInstanceLock = () => false;
      delete req.cache[bundle];
      expect(() => req(bundle)).toThrow('TEST_EXIT_0');
      expect([...registered.values()].every(count => count === 1)).toBe(true);
    } finally {
      await handlers.get(IPC.cancelTokenDanceAuth)?.(sender);
      vi.unstubAllGlobals();
      Module._load = original; delete req.cache[bundle];
      vi.clearAllTimers(); vi.useRealTimers();
      for (const [i, event] of events.entries()) for (const listener of emitter.listeners(event)) if (!listeners[i].includes(listener)) emitter.removeListener(event, listener as (...args: unknown[]) => void);
      for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
      Object.assign(process.env, env);
      rmSync(temp, { recursive: true, force: true });
    }
    const expected = Object.values(IPC).filter(ch => !ch.startsWith('push:'));
    const missing = expected.filter(ch => !registered.has(ch));
    const dupes = [...registered].filter(([, n]) => n > 1).map(([ch]) => ch);
    expect(missing).toEqual([]);
    expect(dupes).toEqual([]);
  });
});
