// Character CRUD on top of ConfigStore (AppConfig.characters / activeCharacterId) plus the per-character asset directory
// userData/characters/<id>/ { portrait.png, idle.mp4, reference.<ext>, character.json }.
// character.json mirrors the config entry so characters survive an older build rewriting config.json without the field
// (recover() re-imports any directory that is missing from the config at startup).
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, extname, join, resolve } from 'node:path';
import { sanitizeCharacterInput, validCharacterId } from '@shared/configValidation';
import { CHARACTER_STYLES, DEFAULT_CONFIG, type Character, type CharacterStyle } from '@shared/config';
import type { ConfigStore } from '../config-store';

export interface CharacterStoreOptions {
  /** True while a generation job for this character is running: it cannot be deleted or switched. */
  busy?: (id: string) => boolean;
  /** True while a Vidu session is creating / live / stopping: switching characters is refused (hang up first). */
  avatarActive?: () => boolean;
}
export type CharacterInput = Partial<Character> & { id?: string };
export type AssetKind = 'portrait' | 'idle' | 'bust' | 'hero';
const ASSET_FILES: Record<AssetKind, { prefix: string; ext: string; field: keyof Character }> = {
  portrait: { prefix: 'portrait-', ext: '.png', field: 'portraitPath' },
  idle: { prefix: 'idle-', ext: '.mp4', field: 'idleVideoPath' },
  bust: { prefix: 'art-bust-', ext: '.png', field: 'artBustPath' },
  hero: { prefix: 'art-hero-', ext: '.png', field: 'artHeroPath' },
};
const REFERENCE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export class CharacterStore {
  constructor(private readonly store: ConfigStore, readonly root: string, private readonly options: CharacterStoreOptions = {}) {}

  list(): Character[] { return this.store.get().characters ?? []; }
  get(id: string): Character | undefined { return this.list().find(c => c.id === id); }
  require(id: string): Character { const c = this.get(id); if (!c) throw new Error('角色不存在'); return c; }
  get activeId(): string { return this.store.get().activeCharacterId ?? ''; }
  dir(id: string): string {
    if (!validCharacterId(id)) throw new Error('角色 ID 无效');
    const dir = join(this.root, id);
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error('角色目录不能是符号链接');
    return dir;
  }
  isBusy(id: string) { return this.options.busy?.(id) ?? false; }

  /** Create (no id) or update. Only known fields are taken; timestamps are managed here. */
  save(input: CharacterInput): Character {
    const existing = input.id ? this.get(input.id) : undefined;
    if (input.id && !existing) throw new Error('角色不存在');
    const now = Date.now();
    const base: Character = existing ?? {
      id: randomUUID(), name: '', personality: '', appearance: '', style: 'anime', voice: DEFAULT_CONFIG.vidu.voice, createdAt: now, updatedAt: now,
    };
    this.dir(base.id); // Validate ownership before changing config or removing any old reference.
    const next: Character = { ...base, updatedAt: now };
    if (typeof input.name === 'string') next.name = input.name.trim().slice(0, 40);
    if (typeof input.personality === 'string') next.personality = input.personality.trim().slice(0, 2000);
    if (typeof input.appearance === 'string') next.appearance = input.appearance.trim().slice(0, 2000);
    if (typeof input.voice === 'string') next.voice = input.voice.trim().slice(0, 200) || DEFAULT_CONFIG.vidu.voice;
    if (typeof input.style === 'string') next.style = CHARACTER_STYLES.some(s => s.id === input.style) ? input.style as CharacterStyle : 'anime';
    if (typeof input.personaOverride === 'string') next.personaOverride = input.personaOverride.trim() || undefined;
    for (const k of ['portraitPath', 'idleVideoPath', 'artBustPath', 'artHeroPath'] as const) if (typeof input[k] === 'string') next[k] = input[k]!.trim() || undefined;
    if (typeof input.referenceImagePath === 'string') {
      // Clearing removes the copy we made inside the character directory (never a file the user picked elsewhere).
      if (!input.referenceImagePath && existing?.referenceImagePath && dirname(resolve(existing.referenceImagePath)) === resolve(this.dir(next.id))) rmSync(existing.referenceImagePath, { force: true });
      next.referenceImagePath = input.referenceImagePath.trim() || undefined;
    }
    if (!next.name) next.name = existing ? existing.name || '新角色' : `新角色${this.list().length ? ` ${this.list().length + 1}` : ''}`;
    const list = existing ? this.list().map(c => (c.id === next.id ? next : c)) : [...this.list(), next];
    const patch: Record<string, unknown> = { characters: list };
    // The first character ever created becomes active so the stage has something to show.
    if (!existing && !this.activeId) patch.activeCharacterId = next.id;
    this.store.update(patch);
    this.writeMirror(next);
    return next;
  }

  remove(id: string) {
    this.require(id);
    if (this.isBusy(id)) throw new Error('这个角色正在生成素材，请等完成后再删除');
    const rest = this.list().filter(c => c.id !== id);
    const patch: Record<string, unknown> = { characters: rest };
    if (this.activeId === id) {
      if (this.options.avatarActive?.()) throw new Error('数字人正在连接中，请先挂断再删除当前角色');
      patch.activeCharacterId = rest[0]?.id ?? '';
    }
    const dir = this.dir(id);
    this.store.update(patch);
    rmSync(dir, { recursive: true, force: true });
  }

  setActive(id: string) {
    this.require(id);
    if (id === this.activeId) return;
    if (this.options.avatarActive?.()) throw new Error('数字人正在连接中，请先挂断再切换角色');
    if (this.isBusy(id) || (this.activeId && this.isBusy(this.activeId))) throw new Error('角色正在生成素材，请等完成后再切换');
    this.store.update({ activeCharacterId: id });
  }

  /** Copy a user-picked image into the character directory as reference.<ext> and record it. */
  setReferenceImage(id: string, sourcePath: string): Character {
    this.require(id);
    const ext = extname(sourcePath).toLowerCase();
    if (!REFERENCE_EXT.has(ext)) throw new Error('参考图需为 png/jpg/webp');
    const dir = this.dir(id); mkdirSync(dir, { recursive: true });
    // Remove stale copies with another extension so the directory holds exactly one reference file.
    for (const f of readdirSync(dir)) if (f.startsWith('reference.') && f !== `reference${ext}`) rmSync(join(dir, f), { force: true });
    const dest = join(dir, `reference${ext}`);
    copyFileSync(sourcePath, dest);
    return this.save({ id, referenceImagePath: dest });
  }

  /** Path for a freshly generated asset. Versioned by timestamp so the renderer's <img>/<video> sees a new URL
   *  (task 09 Q 版 art: art-bust-<ts>.png / art-hero-<ts>.png). */
  assetPath(id: string, kind: AssetKind, now = Date.now()): string {
    this.require(id);
    const dir = this.dir(id); mkdirSync(dir, { recursive: true });
    return join(dir, `${ASSET_FILES[kind].prefix}${now}${ASSET_FILES[kind].ext}`);
  }
  /** Record a generated asset and delete older versions of the same kind in the character directory. */
  setAsset(id: string, kind: AssetKind, path: string): Character {
    const c = this.save({ id, [ASSET_FILES[kind].field]: path });
    const { prefix } = ASSET_FILES[kind];
    for (const f of readdirSync(this.dir(id))) { const full = join(this.dir(id), f); if (f.startsWith(prefix) && full !== path) rmSync(full, { force: true }); }
    return c;
  }

  /** Startup: re-import character.json mirrors whose id is missing from the config (see file header). */
  recover(): number {
    if (!existsSync(this.root)) return 0;
    const known = new Set(this.list().map(c => c.id));
    const found: Character[] = [];
    for (const name of readdirSync(this.root).sort()) {
      if (!validCharacterId(name) || lstatSync(join(this.root, name)).isSymbolicLink()) continue;
      const file = join(this.root, name, 'character.json');
      if (known.has(name) || !existsSync(file)) continue;
      try {
        const c = sanitizeCharacterInput(JSON.parse(readFileSync(file, 'utf8')));
        if (c.id === name && typeof c.name === 'string') found.push({ personality: '', appearance: '', style: 'anime', voice: DEFAULT_CONFIG.vidu.voice, createdAt: Date.now(), updatedAt: Date.now(), ...c } as Character);
      } catch { /* ignore a corrupt mirror */ }
    }
    if (!found.length) return 0;
    const list = [...this.list(), ...found].sort((a, b) => a.createdAt - b.createdAt);
    this.store.update({ characters: list });
    return found.length;
  }

  /** Write character.json for characters that do not have one yet (no config write). */
  mirrorAll() { for (const c of this.list()) if (!existsSync(join(this.dir(c.id), 'character.json'))) this.writeMirror(c); }

  private writeMirror(c: Character) {
    const dir = this.dir(c.id); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'character.json'), JSON.stringify(c, null, 2));
  }
}
