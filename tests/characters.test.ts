// Character model (task 07): persona template, active-character resolution with legacy fallback, first-run migration.
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_PERSONA, RELAY_TAG, buildPersona, mergeConfig, migrateCharacters, resolveActiveCharacter, type AppConfig, type Character } from '../shared/config';

const char = (over: Partial<Character> = {}): Character => ({
  id: 'c1', name: '阿澈', personality: '冷静、话少、偶尔毒舌', appearance: '短发戴圆框眼镜穿深蓝卫衣的男生', style: 'anime', voice: 'Ethan',
  portraitPath: '/tmp/c1/portrait.png', idleVideoPath: '/tmp/c1/idle.mp4', createdAt: 1, updatedAt: 1, ...over,
});
const legacy = (): AppConfig => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.vidu.imagePath = '/assets/xiaoqi-green.png'; c.companion.idleVideoPath = '/assets/xiaoqi-idle.mp4';
  return c;
};

describe('buildPersona', () => {
  it('keeps the relay rule and the faithful-relay paragraph for every character', () => {
    const p = buildPersona(char());
    expect(p).toContain(`「${RELAY_TAG}」`);
    expect(p).toContain('忠实表达');
    expect(p).toContain('名字叫阿澈');
    expect(p).toContain('冷静、话少、偶尔毒舌');
  });
  it('reproduces DEFAULT_PERSONA for the default character (so migration changes nothing)', () => {
    expect(buildPersona({ name: '小栖', personality: '温柔、自然、有分寸' })).toBe(DEFAULT_PERSONA);
    expect(DEFAULT_PERSONA).toContain(RELAY_TAG);
  });
  it('puts long personality descriptions in their own sentence and tolerates empty fields', () => {
    const p = buildPersona({ name: '', personality: '活泼开朗，喜欢开玩笑，说话带一点东北腔，但遇到正事会认真起来。' });
    expect(p).toContain('名字叫小栖');
    expect(p).toContain('你的性格：活泼开朗，喜欢开玩笑，说话带一点东北腔，但遇到正事会认真起来。');
    expect(p.startsWith('你是一位虚拟陪伴伙伴')).toBe(true);
  });
});

describe('resolveActiveCharacter', () => {
  it('falls back to the legacy vidu/companion fields when no character is active', () => {
    const r = resolveActiveCharacter(legacy());
    expect(r).toMatchObject({ name: '小栖', imagePath: '/assets/xiaoqi-green.png', idleVideoPath: '/assets/xiaoqi-idle.mp4', persona: DEFAULT_PERSONA, voice: 'Tina' });
    expect(r.character).toBeUndefined();
  });
  it('falls back when activeCharacterId points at a deleted character', () => {
    const c = { ...legacy(), characters: [char()], activeCharacterId: 'gone' };
    expect(resolveActiveCharacter(c).imagePath).toBe('/assets/xiaoqi-green.png');
  });
  it('uses the active character: files, voice and a generated persona', () => {
    const c = { ...legacy(), characters: [char()], activeCharacterId: 'c1' };
    const r = resolveActiveCharacter(c);
    expect(r).toMatchObject({ id: 'c1', name: '阿澈', imagePath: '/tmp/c1/portrait.png', idleVideoPath: '/tmp/c1/idle.mp4', voice: 'Ethan' });
    expect(r.persona).toBe(buildPersona(char()));
  });
  it('prefers personaOverride, and yields empty paths for a character without assets', () => {
    const c = { ...legacy(), characters: [char({ personaOverride: '自定义人设', portraitPath: undefined, idleVideoPath: undefined })], activeCharacterId: 'c1' };
    const r = resolveActiveCharacter(c);
    expect(r.persona).toBe('自定义人设');
    expect(r.imagePath).toBe(''); expect(r.idleVideoPath).toBe('');
  });
});

describe('migrateCharacters', () => {
  it('creates 小栖 from the legacy fields and makes her active; the resolved values are unchanged', () => {
    const before = legacy();
    const patch = migrateCharacters(before, 123, () => 'xq');
    expect(patch?.activeCharacterId).toBe('xq');
    expect(patch?.characters).toHaveLength(1);
    const xq = patch!.characters![0];
    expect(xq).toMatchObject({ id: 'xq', name: '小栖', portraitPath: '/assets/xiaoqi-green.png', idleVideoPath: '/assets/xiaoqi-idle.mp4', voice: 'Tina', createdAt: 123 });
    expect(xq.personaOverride).toBeUndefined(); // default persona is reproduced by the template
    const after = mergeConfig(before, patch!);
    expect(resolveActiveCharacter(after)).toMatchObject({ ...resolveActiveCharacter(before), id: 'xq', character: xq });
  });
  it('pins a customised persona as personaOverride', () => {
    const c = legacy(); c.vidu.persona = '你是小栖，说话像海盗。' + RELAY_TAG;
    const xq = migrateCharacters(c)!.characters![0];
    expect(xq.personaOverride).toBe(c.vidu.persona);
    expect(resolveActiveCharacter(mergeConfig(c, migrateCharacters(c)!)).persona).toBe(c.vidu.persona);
  });
  it('does nothing without a legacy portrait, and nothing when characters already exist with a valid active id', () => {
    expect(migrateCharacters(structuredClone(DEFAULT_CONFIG))).toBeUndefined();
    expect(migrateCharacters({ ...legacy(), characters: [char()], activeCharacterId: 'c1' })).toBeUndefined();
  });
  it('repairs a missing / stale activeCharacterId', () => {
    expect(migrateCharacters({ ...legacy(), characters: [char()] })?.activeCharacterId).toBe('c1');
    expect(migrateCharacters({ ...legacy(), characters: [char()], activeCharacterId: 'gone' })?.activeCharacterId).toBe('c1');
  });
});

describe('mergeConfig with characters', () => {
  it('stores characters / activeCharacterId even though DEFAULT_CONFIG has none, and keeps them across unrelated patches', () => {
    const a = mergeConfig(DEFAULT_CONFIG, { characters: [char()], activeCharacterId: 'c1' });
    expect(a.characters).toHaveLength(1); expect(a.activeCharacterId).toBe('c1');
    const b = mergeConfig(a, { companion: { scale: 0.5 } });
    expect(b.characters).toHaveLength(1); expect(b.activeCharacterId).toBe('c1'); expect(b.companion.scale).toBe(0.5);
    // Legacy fields are untouched.
    expect(b.vidu.imagePath).toBe(''); expect(b.vidu.persona).toBe(DEFAULT_PERSONA);
  });
});
