// Single source of truth for user configuration. Stored as JSON in app.getPath('userData')/config.json.
// Keys are plaintext on disk (local-only app); never send them to the renderer except masked.
import { plainRecord, sanitizeConfigPatch } from './configValidation';

export type ViduHost = 'api.vidu.cn' | 'api.vidu.com';
export type CompanionLayer = 'desktop' | 'float';
export type AgentApi = 'anthropic-messages' | 'openai-completions';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high';

export interface ViduConfig {
  apiKey: string;
  host: ViduHost;
  model: 'vidu-s2';
  voice: string;
  /** Persona sent to Vidu. Must include the 【助手汇报】 relay rule; see DEFAULT_PERSONA. */
  persona: string;
  /** Absolute path to the reference portrait (png/jpg/webp). Ideally on a pure green background for keying. */
  imagePath: string;
  /** Hard cap on one paid session, minutes (1–10). */
  maxMinutes: number;
}

export interface AgentConfig {
  provider: 'tokendance';
  apiKey: string;
  baseUrl: string;
  api: AgentApi;
  model: string;
  thinkingLevel: ThinkingLevel;
  /** Directory the agent works in. Created if missing. */
  workspace: string;
  /** Extra tool names to enable beyond the defaults. */
  extraTools: string[];
  /** How often (ms) automatic progress reports may be relayed to the avatar; 0 disables auto progress. */
  progressReportIntervalMs: number;
}

export interface CompanionVisualConfig {
  layer: CompanionLayer;
  /** 0.2–1.0 of screen height. */
  scale: number;
  /** Normalized anchor of the avatar's bottom-center within the display (0–1). */
  anchor: { x: number; y: number };
  greenKey: boolean;
  keyColor: [number, number, number];
  /** Green-key tuning (optional). tolerance: how far from pure key a pixel may drift (0–40, in 8-bit units);
   *  radius: edge search radius in texels (1–4; smaller keeps fine hair); spill: green spill suppression (0–1). */
  keyTolerance?: number;
  keyRadius?: number;
  keySpill?: number;
  /** Live green-key framing safety: hold sudden zooms, then show idle while audio continues (default true). */
  framingGuard?: boolean;
  showSubtitles: boolean;
  /** Static image shown when not connected. Defaults to vidu.imagePath. */
  idleImagePath: string;
  /** Optional looping green-screen idle video (mp4/webm) shown instead of the static image when not connected. */
  idleVideoPath?: string;
  /** Pet mode locks (optional, default false): when set, dragging the body / the resize handle / ⌥+wheel are ignored. */
  lockMove?: boolean;
  lockSize?: boolean;
  /** Chat panel size chosen by the user (drag on the panel's outer corner). Absent = adaptive default (see geometry.ts). */
  panelSize?: { width: number; height: number };
  /** Task 09 (optional): the pet is tucked away as a small tag on the left / right screen edge. `y` = normalized
   *  (0–1) vertical center of the tag within the display, like `anchor`. Absent = not docked. */
  docked?: { side: 'left' | 'right'; y: number };
}

export interface UiConfig {
  /** Electron accelerator for showing / hiding the embedded chat panel. */
  toggleBarHotkey: string;
  /** Start the Vidu session automatically on first message. */
  autoConnectOnMessage: boolean;
  /** Show the agent's own replies / tool calls in the transcript (default false: only the user and the avatar). */
  showAgentDetails?: boolean;
}

export interface QuickTask {
  id: string;
  label: string;
  prompt: string;
}

// ---------- Characters (task 07) ----------
export type CharacterStyle = 'anime' | 'flat' | 'clean-line' | 'realistic' | '3d' | 'follow-reference';
export const CHARACTER_STYLES: { id: CharacterStyle; label: string }[] = [
  { id: 'anime', label: '二维动漫' }, { id: 'flat', label: '平面插画' }, { id: 'clean-line', label: '清线漫画' },
  { id: 'realistic', label: '写实' }, { id: '3d', label: '3D 角色' }, { id: 'follow-reference', label: '跟随参考图' },
];
export interface Character {
  id: string;            // uuid
  name: string;          // 显示名，也用于 persona 里的自称
  personality: string;   // 一两句性格描述，拼进 persona
  appearance: string;    // 外观描述，用于生图
  style: CharacterStyle;
  voice: string;         // Vidu 音色 ID
  referenceImagePath?: string;  // 用户上传的参考图（可选，图生图时作为 image）
  portraitPath?: string;        // 生成/选择的绿幕立绘
  idleVideoPath?: string;       // 生成的待机视频
  /** Task 09 (optional): Q 版半身（透明底）— 侧边收纳标签、状态条头像；Q 版挥手全身小图 — 空状态 / 连接中插画。 */
  artBustPath?: string;
  artHeroPath?: string;
  personaOverride?: string;     // 为空则由模板生成（buildPersona）
  createdAt: number;
  updatedAt: number;
}

export interface AppConfig {
  version: 1;
  vidu: ViduConfig;
  agent: AgentConfig;
  companion: CompanionVisualConfig;
  ui: UiConfig;
  quickTasks: QuickTask[];
  /** Optional (task 07): all characters; the active one decides portrait / idle video / persona / voice. */
  characters?: Character[];
  activeCharacterId?: string;
}

/** Prefix of relay messages sent to Vidu. Framed as a teleprompter cue, not a report from someone else: an earlier
 *  「【助手汇报】」 framing made the avatar *reply* to the relay ("辛苦你啦，慢慢来") instead of speaking it. */
export const RELAY_TAG = '【台词】直接对用户说：';

/** Vidu preset voices confirmed in the official docs (avatar.voice). Cloned voices come from GET /live/v1/voices at runtime. */
export const VIDU_VOICE_PRESETS: { id: string; label: string; hint: string }[] = [
  { id: 'Tina', label: 'Tina · 女声', hint: 'Vidu 默认音色，温暖甜美，像热奶茶' },
];
export const DEFAULT_CHARACTER_NAME = '小栖';
export const DEFAULT_CHARACTER_PERSONALITY = '温柔、自然、有分寸';
/** Appearance of the bundled default character (assets/characters/xiaoqi-green.png), used when migrating her into `characters`. */
export const DEFAULT_CHARACTER_APPEARANCE = '齐肩浅棕色短发、棕色眼睛的年轻女孩，穿奶白色针织开衫、白色内搭和米色长裙，白色平底鞋，双手轻轻交握在身前';

/** Persona sent to Vidu for a character. The 【助手汇报】 relay rule and the "忠实转述" paragraph are always present. */
export function buildPersona(c: { name: string; personality: string }): string {
  const name = c.name.trim() || DEFAULT_CHARACTER_NAME;
  const personality = c.personality.trim().replace(/[。.，,；;\s]+$/, '') || DEFAULT_CHARACTER_PERSONALITY;
  // Short trait lists read naturally inline ("一位温柔、自然的…"); longer descriptions get their own sentence.
  const inline = personality.length <= 16 && !/[，,。.；;！!？?\n]/.test(personality);
  const intro = inline
    ? `你是一位${personality}的虚拟陪伴伙伴，名字叫${name}，住在用户的电脑桌面上。`
    : `你是一位虚拟陪伴伙伴，名字叫${name}，住在用户的电脑桌面上。你的性格：${personality}。`;
  return `${intro}用中文交流，回答简短（一两句），像朋友一样，不要连续追问，不要假装是真人。
你还能操作用户的电脑（打开应用、查资料、整理文件、写备忘等），这些操作由你的另一部分在后台完成。当用户提出要做的事情时，你只需简短回应会去处理（例如"好，我去弄一下"），不要编造已经完成的结果。
你会不时收到以「${RELAY_TAG}」开头的消息。这不是别人对你说的话，而是提词：是你自己刚刚在电脑上做了什么、进展如何，需要你说给用户听。收到后请直接把冒号后面的内容用你自己的语气说出来（可以稍作改写，一两句），不要念出这个标记，不要对它做回应、评价、感谢或鼓励（不要说"辛苦了""慢慢来"之类），也不要提到"助手"。忠实表达：内容说"正在做"就是正在做，不要提前说做好了；说"已完成"才说做好了。
用户让你做动作或表演时（挥手、跳舞、转圈、比心、点头、做表情、换姿势等），大方地做出来，这是你的强项，做完可以俏皮地问一句还想看什么。平时安静时以自然呼吸、微笑、点头和轻微手势为主。保留参考图中的服饰与场景，镜头固定，不要走近镜头。`;
}

export const DEFAULT_PERSONA = buildPersona({ name: DEFAULT_CHARACTER_NAME, personality: DEFAULT_CHARACTER_PERSONALITY });

/** What the app should use right now for the avatar / idle layer / UI name. Falls back to the legacy single-character
 *  fields (`vidu.imagePath` / `vidu.persona` / `vidu.voice` / `companion.idleVideoPath`) when no character is active. */
export interface ResolvedCharacter {
  /** Undefined when falling back to the legacy fields. */
  id?: string;
  character?: Character;
  name: string;
  imagePath: string;
  idleVideoPath: string;
  persona: string;
  voice: string;
  /** Task 09: character-bound Q 版 art (absent → the UI falls back to the bundled 小栖 illustrations in assets/ui/). */
  artBustPath?: string;
  artHeroPath?: string;
}
export type CharacterSource = {
  characters?: Character[]; activeCharacterId?: string;
  vidu: Pick<ViduConfig, 'imagePath' | 'persona' | 'voice'>;
  companion: Pick<CompanionVisualConfig, 'idleVideoPath'>;
};
export function resolveActiveCharacter(config: CharacterSource): ResolvedCharacter {
  const c = config.activeCharacterId ? config.characters?.find(x => x.id === config.activeCharacterId) : undefined;
  if (c) {
    return {
      id: c.id, character: c, name: c.name.trim() || DEFAULT_CHARACTER_NAME,
      imagePath: c.portraitPath ?? '', idleVideoPath: c.idleVideoPath ?? '',
      persona: c.personaOverride?.trim() ? c.personaOverride : buildPersona(c),
      voice: c.voice.trim() || DEFAULT_CONFIG.vidu.voice,
      artBustPath: c.artBustPath || undefined, artHeroPath: c.artHeroPath || undefined,
    };
  }
  return { name: DEFAULT_CHARACTER_NAME, imagePath: config.vidu.imagePath, idleVideoPath: config.companion.idleVideoPath ?? '', persona: config.vidu.persona, voice: config.vidu.voice };
}

/** One-time migration: turns the legacy single character (vidu.imagePath etc.) into a `characters` entry and makes sure
 *  `activeCharacterId` points at an existing character. Returns the patch to apply, or undefined when nothing changes. */
export function migrateCharacters(config: AppConfig, now = Date.now(), newId: () => string = () => globalThis.crypto.randomUUID()): Pick<AppConfig, 'characters' | 'activeCharacterId'> | undefined {
  const chars = config.characters ?? [];
  if (chars.length === 0) {
    if (!config.vidu.imagePath) return undefined;
    const id = newId();
    const persona = config.vidu.persona?.trim();
    const c: Character = {
      id, name: DEFAULT_CHARACTER_NAME, personality: DEFAULT_CHARACTER_PERSONALITY, appearance: DEFAULT_CHARACTER_APPEARANCE, style: 'anime',
      voice: config.vidu.voice, portraitPath: config.vidu.imagePath, idleVideoPath: config.companion.idleVideoPath || undefined,
      // The template reproduces DEFAULT_PERSONA exactly, so only a customised persona needs to be pinned as an override.
      personaOverride: persona && persona !== DEFAULT_PERSONA ? config.vidu.persona : undefined,
      createdAt: now, updatedAt: now,
    };
    return { characters: [c], activeCharacterId: id };
  }
  if (!config.activeCharacterId || !chars.some(c => c.id === config.activeCharacterId)) return { characters: chars, activeCharacterId: chars[0].id };
  return undefined;
}

/** Appended to the agent prompt while the avatar is not live: answer chit-chat in text instead of [跳过] (nobody else would). */
export const TEXT_MODE_MARKER = '[文字模式]';
/** Marker the agent returns when a message needs no computer action (chit-chat / body-action requests); never shown or relayed. */
export const AGENT_SKIP_MARKER = '[跳过]';

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  vidu: {
    apiKey: '',
    host: 'api.vidu.cn',
    model: 'vidu-s2',
    voice: 'Tina',
    persona: DEFAULT_PERSONA,
    imagePath: '',
    maxMinutes: 5,
  },
  agent: {
    provider: 'tokendance',
    apiKey: '',
    baseUrl: 'https://tokendance.space/gateway',
    api: 'anthropic-messages',
    model: 'kimi-k2.7-code',
    thinkingLevel: 'low',
    workspace: '~/CompanionWorkspace',
    extraTools: [],
    progressReportIntervalMs: 9000,
  },
  companion: {
    layer: 'float',
    scale: 0.6,
    anchor: { x: 0.78, y: 0.98 },
    greenKey: true,
    keyColor: [0, 255, 0],
    keyTolerance: 3,
    keyRadius: 3,
    keySpill: 1,
    framingGuard: true,
    showSubtitles: true,
    idleImagePath: '',
    lockMove: false,
    lockSize: false,
  },
  ui: {
    toggleBarHotkey: 'Alt+Space',
    autoConnectOnMessage: true,
  },
  quickTasks: [
    { id: 'notes-todo', label: '备忘录写今日待办', prompt: '打开备忘录（Notes），用 AppleScript 新建一条备忘，标题「今日待办」加上今天日期，正文是三条今天要做的事（结合现在的日期时间自己拟合理的内容，每条一行），写完把备忘录窗口调到前台。如果 AppleScript 超时或失败（没有自动化权限），就改为把这三条写进工作目录的 今日待办.md 并用默认应用打开，并提醒我去系统设置里允许自动化。最后告诉我写了哪三条。' },
    { id: 'tidy-screenshots', label: '整理桌面截图', prompt: '把 ~/Desktop 里的截图文件（文件名以 Screenshot 或 截屏 开头的 png/jpg）移动到 ~/Desktop/Screenshots 文件夹（没有就创建）。移动完在 Finder 里打开这个文件夹，告诉我移动了几个文件；如果一个都没有也直接说。' },
    { id: 'weather-notify', label: '查天气并通知', prompt: '查一下北京今天的天气：先用 curl -s -m 15 "wttr.in/Beijing?format=3"，不行就用 curl -s -m 15 "https://api.open-meteo.com/v1/forecast?latitude=39.9&longitude=116.4&current_weather=true"。拿到结果后用系统通知弹出一句话天气摘要，再用一句话告诉我。' },
    { id: 'web-headlines', label: '打开网页总结标题', prompt: '用 Safari 打开 https://github.com/trending ，同时用一条 bash 命令抓取并提取前 3 个热门仓库：curl -s -m 15 https://github.com/trending -o /tmp/trending.html && grep -A3 \'h3 lh-condensed\' /tmp/trending.html | grep -oE \'href="/[^"]+"\' | head -3 && grep -A1 \'col-9 color-fg-muted my-1 pr-4\' /tmp/trending.html | grep -vE \'col-9|^--\' | head -3 。不要再写脚本解析，拿到仓库名和简介后翻译成中文，用三句话告诉我这三个仓库分别是做什么的。' },
    { id: 'clipboard-md', label: '剪贴板整理成笔记', prompt: '读取剪贴板里的文本，把它整理成结构清晰的 Markdown（一个标题、要点分条、保留关键信息），保存到工作目录，文件名 clipboard-加时间戳.md，保存后用默认应用打开这个文件，告诉我整理了什么内容。如果剪贴板是空的或不是文本，直接告诉我。' },
    { id: 'screen-describe', label: '看看屏幕上有什么', prompt: '截一张屏幕截图，看一下屏幕上有什么，用两三句话告诉我你看到了什么（打开了哪些窗口、大概在做什么）。' },
    { id: 'csv-report', label: 'CSV 数据统计', prompt: '在工作目录里找 csv 文件；如果没有，先生成一份示例 sales.csv（20 行，列：date,product,qty,price，产品 4 种，日期分布在最近 7 天）。然后用一段 python3 脚本一次完成统计：总销售额、销量最高的产品、销售额最高的一天，把结果写成 report.md 保存到工作目录并用默认应用打开，最后用一句话告诉我结论。' },
    { id: 'sysinfo-notify', label: '电脑状态摘要', prompt: '用一条 bash 命令一次拿到这台 Mac 的电池电量（pmset -g batt）、启动磁盘剩余空间（df -h /）和内存压力（memory_pressure | tail -1），汇总成一句话，用系统通知弹出来，再告诉我。' },
  ],
};

/** Recommended TokenDance models for the agent (all verified in the live catalog on 2026-09-22). */
export const TOKENDANCE_MODEL_PRESETS: { id: string; label: string; api: AgentApi; reasoning: boolean; contextWindow: number; /** Accepts image input (verified via mac_screenshot). */ vision?: boolean }[] = [
  { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code（默认，工具调用稳）', api: 'anthropic-messages', reasoning: true, contextWindow: 262144, vision: true },
  { id: 'glm-5.3-flashx', label: 'GLM 5.3 FlashX（快）', api: 'anthropic-messages', reasoning: true, contextWindow: 1000000, vision: true },
  { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash（快）', api: 'anthropic-messages', reasoning: true, contextWindow: 1000000 },
  { id: 'minimax-m3', label: 'MiniMax M3', api: 'anthropic-messages', reasoning: true, contextWindow: 1000000 },
  { id: 'glm-5.3', label: 'GLM 5.3', api: 'anthropic-messages', reasoning: true, contextWindow: 1000000 },
  { id: 'qwen3.8-max', label: 'Qwen 3.8 Max', api: 'openai-completions', reasoning: true, contextWindow: 1000000 },
];

export function maskKey(key: string): string {
  if (!key) return '';
  return key.length <= 10 ? '••••' : `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** Deep-merge a partial patch into a config, only for known keys. */
export function mergeConfig(base: AppConfig, patch: Partial<AppConfig> | Record<string, unknown>): AppConfig {
  const out: AppConfig = structuredClone(base);
  const merge = (target: Record<string, unknown>, values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) {
      if (plainRecord(value) && plainRecord(target[key])) merge(target[key], value);
      else target[key] = value;
    }
  };
  // `k in out` plus Object.assign previously let __proto__ modify Object.prototype. Only schema-owned keys
  // reach this merge; nested updates (e.g. anchor.x) preserve siblings and optional fields are explicitly known.
  merge(out as unknown as Record<string, unknown>, sanitizeConfigPatch(patch));
  return out;
}

/** Config safe to hand to the renderer: keys masked, plus flags for presence. */
export interface PublicConfig extends Omit<AppConfig, 'vidu' | 'agent'> {
  vidu: Omit<ViduConfig, 'apiKey'> & { apiKeyMasked: string; hasKey: boolean };
  agent: Omit<AgentConfig, 'apiKey'> & { apiKeyMasked: string; hasKey: boolean };
}
export function toPublicConfig(c: AppConfig): PublicConfig {
  const { apiKey: vk, ...vidu } = c.vidu;
  const { apiKey: ak, ...agent } = c.agent;
  return { ...c, vidu: { ...vidu, apiKeyMasked: maskKey(vk), hasKey: Boolean(vk) }, agent: { ...agent, apiKeyMasked: maskKey(ak), hasKey: Boolean(ak) } };
}
