// Runtime allowlist for persisted / IPC config. TypeScript types alone do not protect a privileged process.
type Predicate = (value: unknown) => boolean;
type Schema = { [key: string]: Predicate | Schema };
export const plainRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const text = (max: number): Predicate => v => typeof v === 'string' && v.length <= max && !v.includes('\0');
const number = (min: number, max: number): Predicate => v => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const choice = (...values: unknown[]): Predicate => v => values.includes(v);
const boolean: Predicate = v => typeof v === 'boolean';
const optional = (test: Predicate): Predicate => v => v === undefined || test(v);
const strings = (maxItems: number, maxLength: number): Predicate => v => Array.isArray(v) && v.length <= maxItems && v.every(text(maxLength));
export const validCharacterId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
const mediaPath = text(4096);
const character: Schema = {
  id: validCharacterId, name: text(40), personality: text(2000), appearance: text(2000),
  style: choice('anime', 'flat', 'clean-line', 'realistic', '3d', 'follow-reference'), voice: text(200),
  portraitPath: optional(mediaPath), idleVideoPath: optional(mediaPath), referenceImagePath: optional(mediaPath),
  artBustPath: optional(mediaPath), artHeroPath: optional(mediaPath), personaOverride: optional(text(50000)),
  createdAt: number(0, Number.MAX_SAFE_INTEGER), updatedAt: number(0, Number.MAX_SAFE_INTEGER),
};
const schema: Schema = {
  vidu: { apiKey: text(8192), host: choice('api.vidu.cn', 'api.vidu.com'), model: choice('vidu-s2'), voice: text(200), persona: text(50000), imagePath: mediaPath, maxMinutes: v => number(1, 10)(v) && Number.isInteger(v) },
  agent: { provider: choice('tokendance'), apiKey: text(8192), baseUrl: text(2048), api: choice('anthropic-messages', 'openai-completions'), model: text(200), thinkingLevel: choice('off', 'minimal', 'low', 'medium', 'high'), workspace: mediaPath, extraTools: strings(64, 100), progressReportIntervalMs: number(0, 60000) },
  companion: {
    layer: choice('desktop', 'float'), scale: number(0.2, 1), anchor: { x: number(-1, 2), y: number(-1, 2) },
    greenKey: boolean, keyColor: v => Array.isArray(v) && v.length === 3 && v.every(number(0, 255)),
    keyTolerance: optional(number(0, 40)), keyRadius: optional(number(1, 4)), keySpill: optional(number(0, 1)), framingGuard: optional(boolean),
    showSubtitles: boolean, idleImagePath: mediaPath, idleVideoPath: optional(mediaPath), lockMove: optional(boolean), lockSize: optional(boolean),
    panelSize: { width: number(64, 10000), height: number(64, 10000) },
    docked: v => v === undefined || v === null || plainRecord(v) && Object.keys(v).every(k => k === 'side' || k === 'y') && choice('left', 'right')(v.side) && number(0, 1)(v.y),
  },
  ui: { toggleBarHotkey: text(200), autoConnectOnMessage: boolean, showAgentDetails: optional(boolean) },
  quickTasks: v => Array.isArray(v) && v.length <= 100 && v.every(q => plainRecord(q) && Object.keys(q).every(k => ['id', 'label', 'prompt'].includes(k)) && text(100)(q.id) && text(100)(q.label) && text(2000)(q.prompt)),
  activeCharacterId: optional(v => v === '' || validCharacterId(v)),
  characters: v => Array.isArray(v) && v.every(c => {
    if (!plainRecord(c)) return false;
    try { sanitize(c, character, true); } catch { return false; }
    return ['id', 'name', 'personality', 'appearance', 'style', 'voice', 'createdAt', 'updatedAt'].every(k => Object.hasOwn(c, k));
  }),
};
function sanitize(value: unknown, rules: Schema, strict: boolean, path = 'config'): Record<string, unknown> {
  if (!plainRecord(value)) { if (strict) throw new Error(`${path} 必须是对象`); return {}; }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!Object.hasOwn(rules, key)) { if (strict) throw new Error(`${path}.${key} 不允许修改`); continue; }
    const rule = rules[key];
    if (typeof rule !== 'function') {
      if (v === undefined) continue;
      const child = sanitize(v, rule, strict, `${path}.${key}`);
      if (Object.keys(child).length) out[key] = child;
    } else if (rule(v)) out[key] = structuredClone(v);
    else if (strict) throw new Error(`${path}.${key} 值无效`);
  }
  return out;
}
/** Tolerant on disk (drop invalid / unknown fields), strict for untrusted IPC (reject the entire patch). */
export function sanitizeConfigPatch(value: unknown, strict = false) {
  if (strict || !plainRecord(value) || !Array.isArray(value.characters)) return sanitize(value, schema, strict);
  // A damaged field in ONE persisted character must not silently erase the whole collection on the next save.
  const { characters, ...rest } = value;
  const out = sanitize(rest, schema, false);
  out.characters = characters.flatMap(c => {
    if (!plainRecord(c) || !validCharacterId(c.id)) return [];
    return [{ name: '新角色', personality: '', appearance: '', style: 'anime', voice: 'Tina', createdAt: 0, updatedAt: 0, ...sanitize(c, character, false) }];
  });
  return out;
}
export function sanitizeCharacterInput(value: unknown) { return sanitize(value, character, true, 'character'); }
