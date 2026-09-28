// Task 09: Q 版 art — prompt builder, chroma key / crop helpers, the seedream request, store paths and resolved fields.
import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({ nativeImage: {} })); // art.ts imports nativeImage for decode/encode only
const { bbox, chromaKey, greenShare, requestImage, squareCrop } = await import('../electron/characters/art');
import { buildArtPrompt } from '../electron/characters/prompts';
import { CharacterStore } from '../electron/characters/store';
import { ConfigStore } from '../electron/config-store';
import { CharacterJobs } from '../electron/characters/jobs';
import { DEFAULT_CONFIG, resolveActiveCharacter, type Character } from '../shared/config';

/** w×h image filled with `bg`, with a `fg` rectangle at (x,y,rw,rh). */
function synth(w: number, h: number, bg: [number, number, number], fg: [number, number, number], r: { x: number; y: number; w: number; h: number }) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, inside = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    const c = inside ? fg : bg; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

describe('buildArtPrompt', () => {
  const c = { name: '阿澈', appearance: '短发戴圆框眼镜穿深蓝卫衣的男生。' };
  it('asks for the same character in chibi form on pure green, bust vs waving full body', () => {
    const bust = buildArtPrompt('bust', c), hero = buildArtPrompt('hero', c);
    for (const p of [bust, hero]) { expect(p).toContain('Q 版'); expect(p).toContain('#00FF00'); expect(p).toContain('深灰色'); expect(p).toContain('短发戴圆框眼镜穿深蓝卫衣的男生）'); }
    expect(bust).toContain('胸像'); expect(bust).toContain('正面略侧'); expect(bust).not.toContain('挥手');
    expect(hero).toContain('全身'); expect(hero).toContain('挥手');
    expect(buildArtPrompt('bust', { appearance: '' })).not.toContain('（）');
  });
});

describe('chroma key + crop', () => {
  it('keys pure green, keeps the subject, crops to content with a margin', () => {
    const img = synth(100, 80, [0, 255, 0], [200, 120, 90], { x: 20, y: 10, w: 30, h: 40 });
    expect(greenShare(img)).toBeCloseTo(1 - (30 * 40) / (100 * 80), 3);
    chromaKey(img);
    const a = (x: number, y: number) => img.data[(y * 100 + x) * 4 + 3];
    expect(a(2, 2)).toBe(0); expect(a(35, 30)).toBe(255);
    // Edge pixels are eroded (blend with the transparent ring), interior stays opaque.
    expect(a(20, 10)).toBeLessThan(255);
    const b = bbox(img)!;
    expect(b.x).toBeGreaterThanOrEqual(20); expect(b.y).toBeGreaterThanOrEqual(10); expect(b.w).toBeLessThanOrEqual(30); expect(b.h).toBeLessThanOrEqual(40);
    const sq = squareCrop(img, 0.1);
    expect(sq.width).toBe(sq.height);
    expect(sq.width).toBe(Math.round(Math.max(b.w, b.h) * 1.2));
  });
  it('refuses an image that keys to nothing', () => {
    const img = synth(10, 10, [0, 255, 0], [0, 255, 0], { x: 0, y: 0, w: 0, h: 0 });
    expect(bbox(chromaKey(img))).toBeNull();
    expect(() => squareCrop(img)).toThrow('空');
  });
});

describe('requestImage', () => {
  it('posts prompt / size / image to the Ark endpoint and decodes b64', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }], usage: { total_tokens: 4096 } })));
    const r = await requestImage({ prompt: 'P', size: '1024x1024', image: 'data:image/png;base64,AA==', apiKey: 'sk', baseUrl: 'https://td.test/gateway/', fetcher });
    expect(r.image.equals(png)).toBe(true); expect(r.usage).toEqual({ total_tokens: 4096 });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://td.test/gateway/ark/v3/images/generations');
    expect(JSON.parse(String(init!.body))).toMatchObject({ model: 'seedream-5.0-pro', prompt: 'P', size: '1024x1024', image: 'data:image/png;base64,AA==', response_format: 'b64_json' });
    await expect(requestImage({ prompt: 'P', size: '1024x1024', apiKey: '', baseUrl: 'x' })).rejects.toThrow('API Key');
    const bad = vi.fn<typeof fetch>().mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(requestImage({ prompt: 'P', size: '1024x1024', apiKey: 'sk', baseUrl: 'x', fetcher: bad })).rejects.toThrow('HTTP 500');
  });
});

describe('store + resolve + jobs', () => {
  it('versioned art paths, setAsset records the field and prunes older versions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qc-art-'));
    const chars = new CharacterStore(new ConfigStore(join(dir, 'config.json')), join(dir, 'characters'));
    const c = chars.save({ name: 'A' });
    const p1 = chars.assetPath(c.id, 'bust', 1), p2 = chars.assetPath(c.id, 'bust', 2), h = chars.assetPath(c.id, 'hero', 3);
    expect(p1.endsWith('art-bust-1.png')).toBe(true); expect(h.endsWith('art-hero-3.png')).toBe(true);
    for (const p of [p1, p2, h]) writeFileSync(p, 'x');
    const u = chars.setAsset(c.id, 'bust', p2);
    expect(u.artBustPath).toBe(p2);
    expect(existsSync(p1)).toBe(false); expect(existsSync(h)).toBe(true);
    expect(chars.setAsset(c.id, 'hero', h).artHeroPath).toBe(h);
    expect(chars.save({ id: c.id, artBustPath: '' }).artBustPath).toBeUndefined();
  });
  it('resolveActiveCharacter exposes the art paths only for a character that has them', () => {
    const base: Character = { id: 'c1', name: 'A', personality: '', appearance: '', style: 'anime', voice: 'Tina', createdAt: 1, updatedAt: 1 };
    const cfg = { ...structuredClone(DEFAULT_CONFIG), characters: [{ ...base, artBustPath: '/b.png', artHeroPath: '/h.png' }], activeCharacterId: 'c1' };
    expect(resolveActiveCharacter(cfg)).toMatchObject({ artBustPath: '/b.png', artHeroPath: '/h.png' });
    expect(resolveActiveCharacter({ ...cfg, characters: [base] }).artBustPath).toBeUndefined();
    expect(resolveActiveCharacter(structuredClone(DEFAULT_CONFIG)).artHeroPath).toBeUndefined();
  });
  it('one art job per character at a time, with its own label', async () => {
    const jobs = new CharacterJobs();
    let done!: () => void;
    jobs.start('c1', 'art', () => new Promise<void>(r => { done = r; }));
    expect(() => jobs.start('c1', 'art', async () => {})).toThrow('Q 版形象正在生成中');
    jobs.start('c1', 'idle', async () => {}); // other kinds are independent
    done();
    await new Promise(r => setTimeout(r, 0));
    expect(jobs.get('c1', 'art')?.phase).toBe('done');
  });
});
