// CharacterStore: CRUD on the config, asset directory lifecycle, guards, character.json recovery.
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../electron/config-store';
import { CharacterStore } from '../electron/characters/store';

let store: ConfigStore; let chars: CharacterStore; let dir: string;
let busy = new Set<string>(); let avatarActive = false;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qc-chars-'));
  store = new ConfigStore(join(dir, 'config.json'));
  busy = new Set(); avatarActive = false;
  chars = new CharacterStore(store, join(dir, 'characters'), { busy: id => busy.has(id), avatarActive: () => avatarActive });
});

afterEach(() => { store.flush(); rmSync(dir, { recursive: true, force: true }); });

describe('CharacterStore', () => {
  it('rejects traversal and symlinked character directories', () => {
    for (const id of ['../outside', '.', '..', '/tmp/outside', 'a/b', '']) expect(() => chars.dir(id)).toThrow('ID');
    const c = chars.save({ name: 'A' }); rmSync(chars.dir(c.id), { recursive: true }); symlinkSync(dir, join(chars.root, c.id));
    expect(() => chars.dir(c.id)).toThrow('符号链接');
    expect(() => chars.assetPath(c.id, 'portrait')).toThrow('符号链接');
  });

  it('does not delete a reference file in a sibling directory sharing the id prefix', () => {
    const c = chars.save({ name: 'A' }), outside = `${chars.dir(c.id)}-outside.png`;
    writeFileSync(outside, 'keep'); chars.save({ id: c.id, referenceImagePath: outside }); chars.save({ id: c.id, referenceImagePath: '' });
    expect(existsSync(outside)).toBe(true);
  });
  it('creates with defaults, makes the first character active, mirrors to character.json', () => {
    const c = chars.save({ name: '  阿澈 ', personality: '冷静', appearance: '短发眼镜', style: 'bogus' as never, voice: '' });
    expect(c).toMatchObject({ name: '阿澈', personality: '冷静', style: 'anime', voice: 'Tina' });
    expect(c.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.get().characters).toEqual([c]);
    expect(store.get().activeCharacterId).toBe(c.id);
    expect(JSON.parse(readFileSync(join(dir, 'characters', c.id, 'character.json'), 'utf8'))).toEqual(c);
    const second = chars.save({});
    expect(second.name).toBe('新角色 2');
    expect(store.get().activeCharacterId).toBe(c.id); // second one does not steal focus
  });

  it('updates only the given fields, bumps updatedAt, rejects unknown ids', () => {
    const c = chars.save({ name: 'A' });
    const u = chars.save({ id: c.id, appearance: '穿深蓝卫衣', updatedAt: 1, createdAt: 1 });
    expect(u.name).toBe('A'); expect(u.appearance).toBe('穿深蓝卫衣'); expect(u.createdAt).toBe(c.createdAt);
    expect(u.updatedAt).toBeGreaterThanOrEqual(c.updatedAt);
    expect(() => chars.save({ id: 'nope', name: 'x' })).toThrow('角色不存在');
  });

  it('copies the reference image into the character dir and removes it when cleared', () => {
    const c = chars.save({ name: 'A' });
    const src = join(dir, 'ref.jpg'); writeFileSync(src, 'jpg');
    const withRef = chars.setReferenceImage(c.id, src);
    expect(withRef.referenceImagePath).toBe(join(dir, 'characters', c.id, 'reference.jpg'));
    expect(existsSync(withRef.referenceImagePath!)).toBe(true);
    const png = join(dir, 'ref.png'); writeFileSync(png, 'png');
    chars.setReferenceImage(c.id, png);
    expect(existsSync(join(dir, 'characters', c.id, 'reference.jpg'))).toBe(false); // stale copy gone
    const cleared = chars.save({ id: c.id, referenceImagePath: '' });
    expect(cleared.referenceImagePath).toBeUndefined();
    expect(existsSync(join(dir, 'characters', c.id, 'reference.png'))).toBe(false);
    expect(() => chars.setReferenceImage(c.id, join(dir, 'x.gif'))).toThrow('png/jpg/webp');
  });

  it('switches active with guards: avatar session, generating character', () => {
    const a = chars.save({ name: 'A' }), b = chars.save({ name: 'B' });
    avatarActive = true;
    expect(() => chars.setActive(b.id)).toThrow('先挂断');
    avatarActive = false;
    busy.add(a.id);
    expect(() => chars.setActive(b.id)).toThrow('生成');
    busy.clear(); busy.add(b.id);
    expect(() => chars.setActive(b.id)).toThrow('生成');
    busy.clear();
    chars.setActive(b.id);
    expect(store.get().activeCharacterId).toBe(b.id);
    chars.setActive(b.id); // no-op
    expect(() => chars.setActive('nope')).toThrow('角色不存在');
  });

  it('removes the character and its directory; active falls to the first remaining one', () => {
    const a = chars.save({ name: 'A' }), b = chars.save({ name: 'B' });
    expect(existsSync(chars.dir(a.id))).toBe(true);
    busy.add(a.id);
    expect(() => chars.remove(a.id)).toThrow('生成');
    busy.clear();
    chars.remove(a.id);
    expect(existsSync(chars.dir(a.id))).toBe(false);
    expect(store.get().characters?.map(c => c.id)).toEqual([b.id]);
    expect(store.get().activeCharacterId).toBe(b.id);
    chars.remove(b.id);
    expect(store.get().activeCharacterId).toBe('');
  });

  it('recovers characters from character.json mirrors missing in the config', () => {
    const a = chars.save({ name: 'A' }); const b = chars.save({ name: 'B' });
    // Simulate an older build rewriting config.json without `characters`.
    const fresh = new ConfigStore(join(dir, 'config2.json'));
    const again = new CharacterStore(fresh, join(dir, 'characters'));
    expect(again.recover()).toBe(2);
    // Both were created within the same millisecond, so only the set is deterministic.
    expect(new Set(again.list().map(c => c.id))).toEqual(new Set([a.id, b.id]));
    expect(again.recover()).toBe(0);
  });
});
