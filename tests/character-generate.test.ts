// Prompt builders, portrait request/response handling, seedance submit/poll mapping, job registry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIdlePrompt, buildPortraitPrompt } from '../electron/characters/prompts';
import { generatePortrait, portraitRequestBody } from '../electron/characters/generate';
import { pollTask, seedanceRequestBody, statusToJob, submitIdleVideo } from '../electron/characters/seedance';
import { CharacterJobs } from '../electron/characters/jobs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const ch = { appearance: '短发戴圆框眼镜穿深蓝卫衣的男生。', style: 'clean-line' as const, name: '阿澈' };

describe('prompts', () => {
  it('portrait prompt keeps the green-screen constraints and style clause', () => {
    const p = buildPortraitPrompt(ch, false);
    expect(p.startsWith('一位短发戴圆框眼镜穿深蓝卫衣的男生，全身竖构图')).toBe(true);
    expect(p).toContain('#00FF00'); expect(p).toContain('9:16'); expect(p).toContain('二维清线漫画');
    expect(p).not.toContain('参考图');
    expect(buildPortraitPrompt(ch, true)).toContain('保留参考图的人物特征、发型、服装');
    expect(buildPortraitPrompt({ ...ch, style: 'follow-reference' }, false)).toContain('画风按外观描述自然选择');
    expect(buildPortraitPrompt({ ...ch, style: 'follow-reference' }, true)).toContain('严格沿用参考图的画风');
  });
  it('idle prompt names the character and asks for a seamless loop', () => {
    expect(buildIdlePrompt(ch)).toMatch(/^画面中的人物（阿澈）保持原样安静站立/);
    expect(buildIdlePrompt(ch)).toContain('无缝循环');
    expect(buildIdlePrompt(ch)).toContain('与第一帧完全一致');
    expect(buildIdlePrompt({ name: 'x', appearance: '穿白色开衫的女孩' })).toContain('人物外观：穿白色开衫的女孩');
  });
});

describe('generatePortrait', () => {
  it('posts the Ark request (image only with a reference) and decodes b64 png', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }], usage: { generated_images: 1 } })));
    const phases: string[] = [];
    const r = await generatePortrait({ character: ch, apiKey: 'sk', baseUrl: 'https://td.test/gateway/', fetcher, onProgress: p => phases.push(p.phase) });
    expect(r.image.equals(PNG)).toBe(true); expect(r.mime).toBe('image/png'); expect(r.usage).toEqual({ generated_images: 1 });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://td.test/gateway/ark/v3/images/generations');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk');
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ model: 'seedream-5.0-pro', size: '1440x2560', response_format: 'b64_json', watermark: false });
    expect(body.image).toBeUndefined();
    expect(phases).toEqual(['submitted', 'downloading']);
    expect(portraitRequestBody({ character: ch, referenceDataUri: 'data:image/png;base64,AA==' }).image).toBe('data:image/png;base64,AA==');
  });
  it('surfaces HTTP errors and empty responses, refuses without appearance / key', async () => {
    const bad = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":"quota"}', { status: 402 }));
    await expect(generatePortrait({ character: ch, apiKey: 'sk', baseUrl: 'https://td.test', fetcher: bad })).rejects.toThrow('HTTP 402');
    const empty = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"data":[]}'));
    await expect(generatePortrait({ character: ch, apiKey: 'sk', baseUrl: 'https://td.test', fetcher: empty })).rejects.toThrow('没有图片');
    await expect(generatePortrait({ character: { ...ch, appearance: ' ' }, apiKey: 'sk', baseUrl: 'x' })).rejects.toThrow('外观');
    await expect(generatePortrait({ character: ch, apiKey: '', baseUrl: 'x' })).rejects.toThrow('API Key');
  });
});

describe('seedance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qc-seedance-'));
  const portrait = join(dir, 'p.png'); writeFileSync(portrait, PNG);
  it('submits first+last frame from the portrait and returns the task id', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 'cgt-1' })));
    const id = await submitIdleVideo({ apiKey: 'sk', baseUrl: 'https://td.test/gateway', fetcher, imagePath: portrait, prompt: 'P' });
    expect(id).toBe('cgt-1');
    const body = JSON.parse(String(fetcher.mock.calls[0][1]!.body));
    expect(fetcher.mock.calls[0][0]).toBe('https://td.test/gateway/ark/v3/generations/tasks');
    expect(body).toMatchObject({ model: 'seedance-2.0-fast', resolution: '720p', ratio: 'adaptive', duration: 8, generate_audio: false });
    expect(body.content.map((c: any) => c.role ?? c.type)).toEqual(['text', 'first_frame', 'last_frame']);
    expect(body.content[1].image_url.url.startsWith('data:image/png;base64,')).toBe(true);
    expect(seedanceRequestBody({ image: 'i', prompt: 'p', lastFrame: false }).content).toHaveLength(2);
  });
  it('polls until succeeded, tolerating transient errors, and maps statuses to job phases', async () => {
    const responses = [new Response('oops', { status: 502 }), new Response(JSON.stringify({ status: 'queued' })), new Response(JSON.stringify({ status: 'running' })), new Response(JSON.stringify({ status: 'succeeded', content: { video_url: 'https://v/x.mp4' } }))];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => responses.shift()!);
    const seen: string[] = [];
    const r = await pollTask('cgt-1', { apiKey: 'sk', baseUrl: 'https://td.test', fetcher, sleep: async () => {}, onStatus: s => seen.push(s.status) });
    expect(r.content?.video_url).toBe('https://v/x.mp4');
    expect(seen).toEqual(['transient', 'queued', 'running', 'succeeded']);
    expect(statusToJob({ status: 'queued' }, 0)).toMatchObject({ phase: 'queued' });
    expect(statusToJob({ status: 'running' }, 85_000).progress).toBeCloseTo(0.5, 1);
    expect(statusToJob({ status: 'running' }, 10 * 60_000).progress).toBe(0.95);
    expect(statusToJob({ status: 'succeeded' }, 1).phase).toBe('downloading');
    const failed = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: 'failed', error: { message: 'nsfw' } })));
    await expect(pollTask('cgt-2', { apiKey: 'sk', baseUrl: 'https://td.test', fetcher: failed, sleep: async () => {} })).rejects.toThrow('任务 failed');
  });
});

describe('CharacterJobs', () => {
  beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
  it('tracks one job per character+kind, reports progress, ends in done / failed', async () => {
    const jobs = new CharacterJobs();
    const events: string[] = [];
    jobs.on('job', j => events.push(`${j.kind}:${j.phase}${j.progress != null ? `@${j.progress}` : ''}`));
    let finish!: () => void;
    jobs.start('c1', 'portrait', report => new Promise<void>(r => { report({ phase: 'running', progress: 0.5 }); finish = r; }));
    expect(jobs.busy('c1')).toBe(true);
    expect(() => jobs.start('c1', 'portrait', async () => {})).toThrow('正在生成中');
    jobs.start('c1', 'idle', async () => { throw new Error('boom'); });
    await vi.advanceTimersByTimeAsync(0);
    expect(jobs.get('c1', 'idle')).toMatchObject({ phase: 'failed', error: 'boom' });
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(jobs.get('c1', 'portrait')).toMatchObject({ phase: 'done', progress: 1 });
    expect(jobs.busy('c1')).toBe(false);
    expect(events).toEqual(['portrait:submitted', 'portrait:running@0.5', 'idle:submitted', 'idle:failed', 'portrait:done@1']);
    // A finished job can be restarted.
    jobs.start('c1', 'idle', async () => {});
    expect(jobs.list()).toHaveLength(2);
  });
});
