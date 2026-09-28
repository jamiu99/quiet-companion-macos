// IPC channel names and the API exposed to renderers via contextBridge (window.companion).
import type { AppConfig, Character, PublicConfig } from './config';
import type { AppState, CharacterJob, RtcCredentials, ViduRuntimeEvent } from './events';
import type { TokenDanceAuthStatus } from './auth';

export const IPC = {
  // renderer -> main (invoke)
  getConfig: 'config:get',
  beginTokenDanceAuth: 'auth:tokendance:start',
  getTokenDanceAuth: 'auth:tokendance:status',
  cancelTokenDanceAuth: 'auth:tokendance:cancel',
  setConfig: 'config:set',
  getState: 'state:get',
  sendText: 'chat:send',
  runQuickTask: 'chat:quick-task',
  abortAgent: 'agent:abort',
  resetAgent: 'agent:reset',
  /** Clear the transcript and start a fresh agent session. */
  clearSession: 'chat:clear',
  restartAgent: 'agent:restart',
  connectAvatar: 'avatar:connect',
  disconnectAvatar: 'avatar:disconnect',
  interruptAvatar: 'avatar:interrupt',
  mediaReady: 'avatar:media-ready',
  mediaFailed: 'avatar:media-failed',
  pickImage: 'dialog:pick-image',
  pickVideo: 'dialog:pick-video',
  pickFolder: 'dialog:pick-folder',
  toggleBar: 'ui:toggle-bar',
  setLayer: 'ui:set-layer',
  openExternal: 'ui:open-external',
  resizeBar: 'ui:resize-bar',
  /** renderer -> main: pointer is over an interactive region (body / handle / toolbar / panel) → stop click-through. */
  setInteractive: 'ui:set-interactive',
  /** renderer -> main: remote avatar audio is (not) audible right now (from AliRTC audioVolume). */
  setSpeaking: 'avatar:speaking',
  /** renderer -> main: shrink-wrap the companion window to this screen-space rect (DIP). */
  setWindowBounds: 'ui:set-window-bounds',
  mediaLog: 'avatar:media-log',
  clearViduLog: 'avatar:clear-log',
  /** renderer -> main: append a diagnostic line to main.log (companion window dev log). */
  log: 'ui:log',
  // characters (task 07)
  listCharacters: 'characters:list',
  saveCharacter: 'characters:save',
  deleteCharacter: 'characters:delete',
  setActiveCharacter: 'characters:set-active',
  generatePortrait: 'characters:generate-portrait',
  generateIdleVideo: 'characters:generate-idle',
  pickReferenceImage: 'characters:pick-reference',
  // main -> renderer (send)
  state: 'push:state',
  rtc: 'push:rtc',
  config: 'push:config',
  /** main -> renderer: one CharacterJob per change. */
  characterJob: 'push:character-job',
  generateAssets: 'characters:generate-assets',
  listVoices: 'vidu:list-voices',
  // task 09
  /** renderer -> main: Q 版半身 + 挥手图 for a character (job kind 'art'). */
  generateArt: 'characters:generate-art',
  /** renderer -> main: right-click on the pet body → native context menu at the cursor. */
  showContextMenu: 'ui:context-menu',
  /** renderer -> main: dock the pet as an edge tag (`config.companion.docked`) or restore it (null). */
  setDocked: 'ui:set-docked',
  /** main -> renderer: open the settings drawer (from the context menu / tray). */
  openSettings: 'push:open-settings',
} as const;

/** Event pushed to the companion renderer so it can join/leave the RTC channel. */
export type RtcPush = Extract<ViduRuntimeEvent, { type: 'rtc-start' | 'rtc-stop' }>;

export interface CompanionApi {
  getConfig(): Promise<PublicConfig>;
  /** Optional desktop S256 PKCE authorization. Results contain status only, never key/code/verifier/URL. */
  beginTokenDanceAuth?(): Promise<TokenDanceAuthStatus>;
  getTokenDanceAuth?(): Promise<TokenDanceAuthStatus>;
  cancelTokenDanceAuth?(): Promise<TokenDanceAuthStatus>;
  /** Partial deep patch. Passing apiKey fields is allowed here (renderer -> main only). */
  setConfig(patch: Record<string, unknown>): Promise<PublicConfig>;
  getState(): Promise<AppState>;
  sendText(text: string): Promise<void>;
  runQuickTask(id: string): Promise<void>;
  abortAgent(): Promise<void>;
  resetAgent(): Promise<void>;
  /** Optional: clear the conversation (transcript + new agent session). */
  clearSession?(): Promise<void>;
  restartAgent(): Promise<void>;
  connectAvatar(): Promise<void>;
  disconnectAvatar(): Promise<void>;
  interruptAvatar(): Promise<void>;
  mediaReady(liveId: string): Promise<void>;
  mediaFailed(liveId: string, reason: string): Promise<void>;
  pickImage(): Promise<string | null>;
  /** Optional (added by task 06): file picker filtered to mp4/webm/mov for the idle video. */
  pickVideo?(): Promise<string | null>;
  pickFolder(): Promise<string | null>;
  /** Show / hide the embedded chat panel (name kept from the old bar window; semantics = panel visibility). */
  toggleBar(visible?: boolean): Promise<void>;
  setLayer(layer: AppConfig['companion']['layer']): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** Legacy (bar window removed): kept for contract stability, no-op in main. */
  resizeBar(width: number, height: number): Promise<void>;
  /** Pet mode hit-test: `on` = pointer is over an interactive region → main calls setIgnoreMouseEvents(!on, { forward: true }). */
  setInteractive(on: boolean): Promise<void>;
  /** Optional: report whether the avatar is currently speaking (remote audio level above threshold). */
  setSpeaking?(on: boolean): Promise<void>;
  /** Optional: ask main to resize/move the companion window (screen coordinates, DIP). */
  setWindowBounds?(rect: { x: number; y: number; width: number; height: number }): Promise<void>;
  /** Optional: renderer media milestone for the Vidu log (join / subscribe / stall / stats). */
  mediaLog?(tag: string, text: string): Promise<void>;
  clearViduLog?(): Promise<void>;
  /** Optional: append a renderer diagnostic line to main.log (prefixed with the window kind). */
  log?(line: string): Promise<void>;
  // ---- characters (task 07, all optional) ----
  listCharacters?(): Promise<Character[]>;
  /** Create (no id) or update (with id). Setting `referenceImagePath: ''` removes the copied reference file. */
  saveCharacter?(c: Partial<Character> & { id?: string }): Promise<Character>;
  /** Removes the character and its asset directory. Rejects while one of its generation jobs is running. */
  deleteCharacter?(id: string): Promise<void>;
  /** Rejects while an avatar session is active (hang up first) or the character is generating. */
  setActiveCharacter?(id: string): Promise<void>;
  /** Start a TokenDance job; resolves once the job is accepted, progress arrives via onCharacterJob / AppState.characterJobs. */
  generatePortrait?(id: string): Promise<void>;
  generateIdleVideo?(id: string): Promise<void>;
  /** File picker; the chosen image is copied into the character's directory. */
  pickReferenceImage?(id: string): Promise<string | null>;
  onCharacterJob?(cb: (job: CharacterJob) => void): () => void;
  /** One-shot: portrait then idle video for a character (progress via the two job kinds). */
  generateAssets?(id: string): Promise<void>;
  /** Cloned voice ids registered on the Vidu account (presets are in shared/config VIDU_VOICE_PRESETS). */
  listVoices?(): Promise<string[]>;
  // ---- task 09 (all optional) ----
  /** Q 版半身 + 挥手图 from the character's portrait (≈0.6 元); progress via job kind 'art'. */
  generateArt?(id: string): Promise<void>;
  /** Native context menu for the pet (收到侧边 / 锁定 / 面板 / 连接 / 设置 / 退出), popped up at the cursor. */
  showContextMenu?(): Promise<void>;
  /** Dock the pet as a small tag on a screen edge, or restore it with null. Persisted in config.companion.docked. */
  setDocked?(dock: { side: 'left' | 'right'; y: number } | null): Promise<void>;
  onOpenSettings?(cb: () => void): () => void;
  onState(cb: (state: AppState) => void): () => void;
  onRtc(cb: (event: RtcPush) => void): () => void;
  onConfig(cb: (config: PublicConfig) => void): () => void;
  /** Which window this renderer is: 'companion' or 'bar'. */
  readonly windowKind: 'companion' | 'bar';
  /** file:// URL safe helper for local images (main converts a path to a companion-asset:// URL). */
  assetUrl(path: string): string;
}

declare global {
  interface Window { companion: CompanionApi; AliRtcEngine?: any }
}
export type { RtcCredentials };
