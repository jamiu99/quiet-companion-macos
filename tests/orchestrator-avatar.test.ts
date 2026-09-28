import { RELAY_TAG } from '@shared/config';
// Orchestrator-level session protection: one paid session at a time, error → idle fallback, queue cleanup.
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Orchestrator } from '../electron/orchestrator';
import type { ControlSocket } from '../electron/vidu/runtime';
import { DEFAULT_CONFIG, type AppConfig } from '../shared/config';

class Socket extends EventEmitter {
  readyState = 0; sent: any[] = [];
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  ping() {}
  open() { this.readyState = 1; this.emit('open'); }
  message(d: unknown) { this.emit('message', Buffer.from(JSON.stringify(d))); }
  ack() { this.message({ type: 2, payload: { conn_init_ack: { success: true } } }); }
}
const LIVE_ID = 'live-1';
const response = () => ({ live: { id: LIVE_ID, live_duration: 7200 }, rtc: { token: 't', user_id: 'viewer', token_expire_at: String(Math.floor(Date.now() / 1000) + 3600) } });

let orch: Orchestrator; let socket: Socket; let fetcher: Mock<typeof fetch>; let logs: string[];
const dir = mkdtempSync(join(tmpdir(), 'qc-avatar-'));
const image = join(dir, 'p.png'); writeFileSync(image, 'png');
const config: AppConfig = structuredClone(DEFAULT_CONFIG);
config.vidu.apiKey = 'vda_test'; config.vidu.imagePath = image; config.vidu.maxMinutes = 1; config.agent.apiKey = '';

beforeEach(() => {
  vi.useFakeTimers();
  socket = new Socket(); logs = [];
  fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(response())));
  orch = new Orchestrator(config, '/nonexistent/agent.mjs', dir, { vidu: { fetcher, connect: () => socket as ControlSocket } });
  orch.on('log', l => logs.push(l));
});
afterEach(() => { orch.disconnectAvatar(); vi.useRealTimers(); });

async function live() { await orch.connectAvatar(); socket.open(); socket.ack(); orch.mediaReady(LIVE_ID); }

describe('avatar session protection', () => {
  it('ignores a second connect while creating / live', async () => {
    const a = orch.connectAvatar(); const b = orch.connectAvatar();
    await Promise.all([a, b]);
    await orch.connectAvatar();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(logs.filter(l => l.includes('connectAvatar ignored'))).toHaveLength(2);
    socket.open(); socket.ack();
    expect(orch.state.avatar.phase).toBe('connecting');
    orch.mediaReady(LIVE_ID);
    expect(orch.state.avatar.phase).toBe('live');
    expect(orch.state.avatar.presented).toBe(true);
    await orch.connectAvatar();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns to idle (local portrait) after maxMinutes', async () => {
    await live();
    await vi.advanceTimersByTimeAsync(60000);
    expect(orch.state.avatar.phase).toBe('idle');
    expect(orch.state.avatar.presented).toBe(false);
    expect(socket.sent.at(-1).type).toBe(5);
  });

  it('network drop → error with message, then idle after the grace period; a new connect works', async () => {
    await live();
    socket.emit('close');
    expect(orch.state.avatar.phase).toBe('error');
    expect(orch.state.transcript.some(t => t.role === 'system' && t.text.includes('断开'))).toBe(true);
    await vi.advanceTimersByTimeAsync(8000);
    expect(orch.state.avatar.phase).toBe('idle');
    socket = new Socket();
    await orch.connectAvatar();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('server hangup (type 6) → error → idle', async () => {
    await live();
    socket.message({ type: 6, payload: { hangup: { hangup_reason: 'idle_timeout' } } });
    expect(orch.state.avatar.phase).toBe('error');
    expect(orch.state.avatar.message).toContain('idle_timeout');
    await vi.advanceTimersByTimeAsync(8000);
    expect(orch.state.avatar.phase).toBe('idle');
  });

  it('a reconnect during the error grace period cancels the idle fallback', async () => {
    await live();
    socket.emit('close');
    socket = new Socket();
    await orch.connectAvatar();
    await vi.advanceTimersByTimeAsync(8000);
    expect(orch.state.avatar.phase).toBe('warming');
  });

  it('connects with the active character\'s portrait, persona and voice (task 07), legacy fields otherwise', async () => {
    const portrait = join(dir, 'c1.png'); writeFileSync(portrait, 'png-c1');
    const withChar: AppConfig = { ...structuredClone(config), characters: [{ id: 'c1', name: '阿澈', personality: '冷静', appearance: '', style: 'anime', voice: 'Ethan', portraitPath: portrait, createdAt: 1, updatedAt: 1 }], activeCharacterId: 'c1' };
    orch.setConfig(withChar);
    await orch.connectAvatar();
    const body = JSON.parse(String(fetcher.mock.calls[0][1]!.body));
    expect(body.avatar.image_uri).toBe(`data:image/png;base64,${Buffer.from('png-c1').toString('base64')}`);
    expect(body.avatar.voice).toBe('Ethan');
    expect(body.avatar.persona).toContain('名字叫阿澈');
    expect(body.avatar.persona).toContain(RELAY_TAG);
    expect(logs.find(l => l.startsWith('connectAvatar:'))).toMatch(/character=阿澈#c1 image=.*c1\.png .*voice=Ethan persona="你是一位冷静的虚拟陪伴伙伴，名字叫阿澈/);
    orch.disconnectAvatar();
    // Active character without a portrait yet → clear error naming her, no paid request.
    orch.setConfig({ ...withChar, characters: [{ ...withChar.characters![0], portraitPath: undefined }] });
    await vi.advanceTimersByTimeAsync(0);
    await orch.connectAvatar();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(orch.state.avatar).toMatchObject({ phase: 'error', message: '请先为「阿澈」生成或选择形象' });
  });

  it('drops pending relays and user texts when the session ends', async () => {
    await live();
    (orch as any).relay('第一条', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent.some(m => m.type === 99)).toBe(true);
    (orch as any).relay('第二条', true); // rate-limited → queued
    orch.disconnectAvatar();
    await vi.advanceTimersByTimeAsync(10000);
    expect(socket.sent.filter(m => m.type === 99)).toHaveLength(1);
    expect(orch.state.avatar.phase).toBe('idle');
  });
});
