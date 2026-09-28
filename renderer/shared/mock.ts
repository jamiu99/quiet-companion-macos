// Dev-only fake data so the pet stage + panel can be previewed / screenshotted without a running main process.
// Activated by `?mock=<scenario>` in the page URL; never active in production builds.
import type { AppState, CharacterJob, TranscriptItem } from '@shared/events';
import { DEFAULT_CONFIG, mergeConfig, toPublicConfig, type AppConfig, type Character, type PublicConfig } from '@shared/config';
import type { CompanionApi } from '@shared/ipc';

export type MockScenario = 'live' | 'idle' | 'running' | 'empty' | 'connecting' | 'error';
const SCENARIOS: MockScenario[] = ['live', 'idle', 'running', 'empty', 'connecting', 'error'];

export function mockScenario(): MockScenario | null {
  if (!import.meta.env.DEV) return null;
  const v = new URLSearchParams(location.search).get('mock');
  return v && (SCENARIOS as string[]).includes(v) ? (v as MockScenario) : null;
}

let idSeq = 0;
const now = Date.now();
const item = (role: TranscriptItem['role'], text: string, minutesAgo: number, ok?: boolean): TranscriptItem =>
  ({ id: `m${++idSeq}`, role, text, at: now - minutesAgo * 60_000, ok });

const CHAT: TranscriptItem[] = [
  item('system', '已开始新的 agent 会话', 9),
  item('user', '小栖，帮我把桌面上的截图整理一下', 8),
  item('companion', '好呀，我让助手去收拾一下，你先忙~', 7.9),
  item('tool', '▶ bash ls ~/Desktop | grep -i -E "screenshot|截屏"', 7.8),
  item('tool', '✓ bash 12 files', 7.6, true),
  item('tool', '▶ bash mkdir -p ~/Desktop/Screenshots && mv ~/Desktop/Screenshot*.png ~/Desktop/Screenshots/', 7.5),
  item('tool', '✓ bash moved 12 files', 7.4, true),
  item('agent', '已把 12 张截图移到 ~/Desktop/Screenshots，桌面清爽了。', 7.3),
  item('companion', '搞定啦，12 张截图都收进 Screenshots 文件夹了。', 7.2),
  item('user', '再帮我查下北京今天天气，顺便记到备忘录里', 3),
  item('companion', '收到，稍等一下。', 2.9),
  item('tool', '▶ bash curl -s "wttr.in/Beijing?format=3"', 2.8),
  item('tool', '✗ bash curl: (28) Connection timed out after 10001 milliseconds — 这是一次失败的工具调用，点开可以看到完整输出', 2.5, false),
  item('tool', '▶ bash curl -s "wttr.in/Beijing?format=3" --max-time 20', 2.4),
  item('tool', '✓ bash Beijing: ⛅️ +24°C', 2.2, true),
  item('tool', '▶ applescript tell application "Notes" to make new note …', 2.1),
];

function mockAppState(s: MockScenario): AppState {
  const base: AppState = {
    avatar: { phase: 'idle', message: '未连接 · 显示本地形象', liveId: null, startedAt: null, deadline: null, presented: false },
    agent: { status: 'idle', model: 'tokendance/kimi-k2.7-code', activity: '', lastError: null, tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'companion_say', 'mac_open', 'applescript', 'mac_notify'] },
    transcript: CHAT,
    barVisible: true,
    viduLog: s === 'live' || s === 'running' ? ([
      ['out', 'create', 'POST /live/s_avatar/realtime host=api.vidu.cn model=vidu-s2 voice=Tina image≈1380KB persona=412字'],
      ['in', 'create_ok', 'live_id=999910255141855232 live_duration=7200s rtc_user=live-user-…-1855232 token_expire_at=1790071999'],
      ['out', 'conn_init', 'version=1'], ['in', 'conn_init_ack', 'success=true'],
      ['app', 'phase', 'connecting · 数字人正在创建中…'], ['app', 'rtc_start', '把 RTC 凭证交给渲染进程入会 user=live-user-…'],
      ['media', 'join', '已加入 RTC 频道，等待远端视频'], ['media', 'tracks', '远端轨道可用 audio=1 video=1'], ['media', 'subscribe', '已订阅远端视频 …-1855232 track=1'],
      ['in', 'avatar_text', '好的。'], ['app', 'drop', '首帧前的开场白不显示：「好的。」'],
      ['media', 'first_frame', '渲染进程收到首帧，会话进入 live'], ['out', 'interrupt', ''],
      ['app', 'cue', '首帧后 1s 发开场提词；若随后视频流被 Vidu 重推，恢复后再问候一次'],
      ['app', 'relay', '提词 → text_msg：嗨，我来啦！现在能看到我、听到我了吧～想聊点什么？'], ['out', 'text_msg', '【台词】直接对用户说：嗨，我来啦！…'],
      ['in', 'avatar_text', '能啊，画面声音都正常。想聊什么就直说，或者需要我帮你弄点啥？'], ['media', 'audio', '数字人开始出声'], ['media', 'audio', '数字人停止出声'],
    ] as const).map(([dir, tag, text], i) => ({ id: `v${i}`, at: Date.now() - (20 - i) * 1300, dir, tag, text })) : [],
    characterJobs: mockJobs(),
  };
  switch (s) {
    case 'live':
      return { ...base, avatar: { phase: 'live', message: '实时中', liveId: 'live_mock', startedAt: now - 90_000, deadline: now + 3.5 * 60_000, presented: true } };
    case 'running':
      return {
        ...base,
        avatar: { phase: 'live', message: '实时中', liveId: 'live_mock', startedAt: now - 90_000, deadline: now + 3.5 * 60_000, presented: true },
        agent: { ...base.agent, status: 'running', activity: 'applescript: tell application "Notes" to make new note with properties {name:"直播待办", body:"1. 整理截图 2. 查天气 3. 写周报"}' },
      };
    case 'connecting':
      return { ...base, avatar: { ...base.avatar, phase: 'warming', message: '正在预热数字人…' }, transcript: CHAT.slice(0, 3) };
    case 'error':
      return {
        ...base,
        avatar: { ...base.avatar, phase: 'error', message: 'Vidu 会话创建失败：401 Unauthorized' },
        agent: { ...base.agent, status: 'error', lastError: 'agent-host 退出（code 1）' },
        transcript: [...CHAT.slice(0, 3), item('system', 'Vidu 会话创建失败：401 Unauthorized', 1), item('system', 'agent 错误：agent-host 退出（code 1）', 0.5)],
      };
    case 'empty':
      return { ...base, agent: { ...base.agent, status: 'stopped', model: '' }, transcript: [] };
    default:
      // `?clear=1`: empty conversation (the panel shows the empty state with the character's Q 版 hero).
      return new URLSearchParams(location.search).get('clear') ? { ...base, transcript: [] } : base;
  }
}

// Task 07: three characters — the bundled 小栖 (active, with assets), one with a portrait only, one brand new.
const MOCK_CHARACTERS: Character[] = [
  { id: 'xiaoqi', name: '小栖', personality: '温柔、自然、有分寸', appearance: '齐肩浅棕色短发、棕色眼睛的年轻女孩，穿奶白色针织开衫、白色内搭和米色长裙', style: 'anime', voice: 'Tina', portraitPath: '/characters/xiaoqi-green.png', idleVideoPath: '/characters/xiaoqi-idle.mp4', artBustPath: '/ui/bust-xiaoqi.png', artHeroPath: '/ui/hero-empty.png', createdAt: now - 86400e3, updatedAt: now - 3600e3 },
  { id: 'ache', name: '阿澈', personality: '冷静、话少、偶尔毒舌，但很靠谱', appearance: '短发戴圆框眼镜穿深蓝卫衣的男生，清爽利落', style: 'clean-line', voice: 'Ethan', portraitPath: '/characters/xiaoqi-green.png', createdAt: now - 7200e3, updatedAt: now - 600e3 },
  { id: 'new', name: '新角色 3', personality: '', appearance: '', style: 'anime', voice: 'Tina', createdAt: now - 60e3, updatedAt: now - 60e3 },
];
/** `?job=portrait|idle` → a running generation job on the active character (progress UI in screenshots). */
function mockJobs(): CharacterJob[] {
  const kind = new URLSearchParams(location.search).get('job');
  if (kind !== 'portrait' && kind !== 'idle' && kind !== 'art') return [];
  return [{ characterId: 'xiaoqi', kind, phase: 'running', progress: kind === 'idle' ? 0.45 : kind === 'art' ? 0.52 : undefined, message: kind === 'idle' ? '生成中' : kind === 'art' ? '绘制 Q 版形象（挥手）12s' : '生成中（seedream-5.0-pro，约 30 秒）', startedAt: now - 20e3, updatedAt: now }];
}

function mockAppConfig(s: MockScenario): AppConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  if (s !== 'empty') {
    c.vidu.apiKey = 'vda_mock0123456789abcdef';
    c.vidu.imagePath = '/characters/xiaoqi-green.png'; // served by vite publicDir (assets/)
    c.agent.apiKey = 'sk-mock0123456789abcdef';
    c.agent.workspace = '/Users/demo/CompanionWorkspace';
    c.characters = structuredClone(MOCK_CHARACTERS);
    c.activeCharacterId = new URLSearchParams(location.search).get('active') ?? 'xiaoqi';
    // Task 09: `?docked=left|right` starts tucked away as an edge tag; `?art=<url prefix>` gives 阿澈 real generated
    // pictures (<prefix>-bust.png / -hero.png, e.g. /@fs/<repo>/docs/screenshots/characters-ache) and his portrait.
    const q = new URLSearchParams(location.search);
    const dock = q.get('docked');
    if (dock === 'left' || dock === 'right') c.companion.docked = { side: dock, y: 0.42 };
    const art = q.get('art');
    const ache = c.characters.find(x => x.id === 'ache');
    if (art && ache) { ache.artBustPath = `${art}-bust.png`; ache.artHeroPath = `${art}-hero.png`; ache.portraitPath = art.replace(/[^/]*$/, 'characters-portrait.png'); }
  }
  return c;
}

/** Install a fake `window.companion` (only when the real preload is absent) and return the scenario's data. */
export function installMock(s: MockScenario) {
  let config = mockAppConfig(s);
  let state = mockAppState(s);
  const stateSubs = new Set<(st: AppState) => void>();
  const configSubs = new Set<(c: PublicConfig) => void>();
  const pushState = () => stateSubs.forEach(cb => cb(state));
  const log = (name: string, ...args: unknown[]) => console.info(`[mock] companion.${name}`, ...args);
  const noop = (name: string) => async (...args: unknown[]) => { log(name, ...args); };
  const api: CompanionApi = {
    getConfig: async () => toPublicConfig(config),
    setConfig: async patch => { config = mergeConfig(config, patch); const pub = toPublicConfig(config); configSubs.forEach(cb => cb(pub)); return pub; },
    getState: async () => state,
    sendText: async text => {
      log('sendText', text);
      state = { ...state, transcript: [...state.transcript, item('user', text, 0)] };
      pushState();
    },
    runQuickTask: noop('runQuickTask'), abortAgent: noop('abortAgent'), resetAgent: noop('resetAgent'), clearSession: async () => { state = { ...state, transcript: [] }; pushState(); }, restartAgent: noop('restartAgent'),
    connectAvatar: noop('connectAvatar'), disconnectAvatar: noop('disconnectAvatar'), interruptAvatar: noop('interruptAvatar'),
    mediaReady: noop('mediaReady'), mediaFailed: noop('mediaFailed'),
    pickImage: async () => '/Users/demo/Pictures/picked.png', pickVideo: async () => '/Users/demo/Movies/idle.mp4', pickFolder: async () => '/Users/demo/Work',
    toggleBar: async visible => { log('toggleBar', visible); state = { ...state, barVisible: visible ?? !state.barVisible }; pushState(); },
    setLayer: noop('setLayer'), openExternal: noop('openExternal'), resizeBar: noop('resizeBar'), setInteractive: noop('setInteractive'), setSpeaking: noop('setSpeaking'), mediaLog: noop('mediaLog'), clearViduLog: async () => { state = { ...state, viduLog: [] }; pushState(); }, setWindowBounds: noop('setWindowBounds'),
    // characters (task 07): in-memory CRUD + a fake job that walks through the phases in ~4 s.
    listCharacters: async () => config.characters ?? [],
    saveCharacter: async c => {
      const list = config.characters ?? [];
      const existing = c.id ? list.find(x => x.id === c.id) : undefined;
      const next: Character = { ...(existing ?? { id: `c${Date.now().toString(36)}`, name: '', personality: '', appearance: '', style: 'anime', voice: 'Tina', createdAt: Date.now(), updatedAt: Date.now() }), ...c, updatedAt: Date.now() } as Character;
      if (!next.name) next.name = existing ? existing.name : `新角色 ${list.length + 1}`;
      if (c.referenceImagePath === '') delete next.referenceImagePath;
      config = { ...config, characters: existing ? list.map(x => (x.id === next.id ? next : x)) : [...list, next] };
      const pub = toPublicConfig(config); configSubs.forEach(cb => cb(pub));
      return next;
    },
    deleteCharacter: async id => { config = { ...config, characters: (config.characters ?? []).filter(x => x.id !== id) }; if (config.activeCharacterId === id) config.activeCharacterId = config.characters?.[0]?.id ?? ''; const pub = toPublicConfig(config); configSubs.forEach(cb => cb(pub)); },
    setActiveCharacter: async id => { if (state.avatar.phase !== 'idle' && state.avatar.phase !== 'error') throw new Error('数字人正在连接中，请先挂断再切换角色'); config = { ...config, activeCharacterId: id }; const pub = toPublicConfig(config); configSubs.forEach(cb => cb(pub)); },
    pickReferenceImage: async id => { await api.saveCharacter!({ id, referenceImagePath: '/characters/xiaoqi-green.png' }); return '/characters/xiaoqi-green.png'; },
    generatePortrait: async id => fakeJob(id, 'portrait'),
    generateIdleVideo: async id => fakeJob(id, 'idle'),
    generateAssets: async id => { fakeJob(id, 'portrait'); setTimeout(() => { fakeJob(id, 'idle'); fakeJob(id, 'art'); }, 4200); },
    generateArt: async id => fakeJob(id, 'art'),
    showContextMenu: noop('showContextMenu'),
    setDocked: async dock => { log('setDocked', dock); config = { ...config, companion: { ...config.companion, docked: dock ?? undefined } }; const pub = toPublicConfig(config); configSubs.forEach(cb => cb(pub)); },
    onOpenSettings: () => () => {},
    listVoices: async () => ['my_cloned_voice'],
    onCharacterJob: () => () => {},
    onState: cb => { stateSubs.add(cb); return () => stateSubs.delete(cb); },
    onRtc: () => () => {},
    onConfig: cb => { configSubs.add(cb); return () => configSubs.delete(cb); },
    windowKind: 'companion',
    assetUrl: p => p,
  };
  const fakeJob = (id: string, kind: CharacterJob['kind']) => {
    const put = (j: Partial<CharacterJob>) => {
      const job: CharacterJob = { characterId: id, kind, phase: 'submitted', startedAt: Date.now(), updatedAt: Date.now(), ...j };
      state = { ...state, characterJobs: [...(state.characterJobs ?? []).filter(x => !(x.characterId === id && x.kind === kind)), job] };
      pushState();
    };
    put({ phase: 'submitted', message: '已提交' });
    setTimeout(() => put({ phase: 'running', message: '生成中', progress: kind === 'idle' ? 0.2 : undefined }), 800);
    setTimeout(() => put({ phase: 'running', message: '生成中', progress: kind === 'idle' ? 0.7 : undefined }), 2000);
    setTimeout(() => put({ phase: 'downloading', message: '下载中' }), 3200);
    setTimeout(() => {
      put({ phase: 'done', message: '完成' });
      void api.saveCharacter!({ id, ...(kind === 'portrait' ? { portraitPath: '/characters/xiaoqi-green.png' } : kind === 'idle' ? { idleVideoPath: '/characters/xiaoqi-idle.mp4' } : { artBustPath: '/ui/bust-xiaoqi.png', artHeroPath: '/ui/hero-empty.png' }) });
    }, 4000);
  };
  if (!window.companion) window.companion = api;
  // `?bg=1` paints a wallpaper-ish backdrop so the glass effect is visible in screenshots.
  if (new URLSearchParams(location.search).get('bg')) {
    document.documentElement.style.background =
      'radial-gradient(circle at 20% 20%, #5b3fd6 0, transparent 45%), radial-gradient(circle at 80% 30%, #e0507a 0, transparent 40%), radial-gradient(circle at 60% 85%, #1e88e5 0, transparent 45%), linear-gradient(160deg, #10131f, #2a1d3d 60%, #0d2a3a)';
  }
}
