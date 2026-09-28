// Runtime state and event contracts shared by electron main, renderer, and agent-host.

// ---------- Vidu avatar session ----------
export type AvatarPhase = 'idle' | 'creating' | 'warming' | 'connecting' | 'live' | 'stopping' | 'error';
export interface AvatarState {
  phase: AvatarPhase;
  message: string;
  liveId: string | null;
  startedAt: number | null;
  deadline: number | null;
  /** True once the renderer reported a real presented video frame. */
  presented: boolean;
}
export interface RtcCredentials {
  token: string;
  user_id: string;
  token_expire_at?: number | string;
  remote_user_id?: string;
  [k: string]: unknown;
}
/** Emitted by the Vidu runtime (main process). */
export type ViduRuntimeEvent =
  | { type: 'state'; state: Omit<AvatarState, 'presented'> }
  | { type: 'rtc-start'; liveId: string; rtc: RtcCredentials }
  | { type: 'rtc-stop'; liveId: string }
  | { type: 'transcript'; role: 'user' | 'companion'; text: string }
  /** Structured protocol log (what we sent / what Vidu sent), for the in-app Vidu log. */
  | { type: 'log'; dir: 'out' | 'in'; tag: string; text: string };

// ---------- Agent ----------
export type AgentStatus = 'stopped' | 'starting' | 'idle' | 'running' | 'error';
export interface AgentState {
  status: AgentStatus;
  model: string;
  /** Short human-readable line for the UI, e.g. "正在运行 bash: ls ~/Desktop". */
  activity: string;
  lastError: string | null;
  /** Names of tools currently enabled. */
  tools: string[];
}

/** Simplified, UI-facing agent events (derived from pi session events inside agent-host). */
export type AgentEvent =
  | { type: 'agent_start'; promptId: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_start'; toolCallId: string; name: string; summary: string }
  | { type: 'tool_end'; toolCallId: string; name: string; ok: boolean; summary: string }
  | { type: 'turn_end'; text: string }
  | { type: 'agent_end'; promptId: string; finalText: string; aborted: boolean }
  | { type: 'error'; message: string };

// ---------- Agent-host stdio protocol (JSON lines, one object per line) ----------
export interface AgentHostInit {
  apiKey: string;
  baseUrl: string;
  api: 'anthropic-messages' | 'openai-completions';
  model: string;
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high';
  workspace: string;
  extraTools: string[];
  /** Extra system prompt text appended by the host (e.g. current time, quick task hints). */
  systemPromptExtra?: string;
  /** Where agent-host keeps its own pi agentDir (models.json/auth.json/sessions). */
  agentDir: string;
  /** Optional: the model accepts image input (lets mac_screenshot hand the picture to the model). */
  vision?: boolean;
}
export type HostToAgent =
  | { type: 'init'; config: AgentHostInit }
  | { type: 'prompt'; id: string; text: string; behavior: 'auto' | 'steer' | 'followUp' }
  | { type: 'abort' }
  | { type: 'reset' }
  | { type: 'shutdown' };
export type AgentToHost =
  | { type: 'ready'; model: string; tools: string[] }
  | { type: 'event'; event: AgentEvent }
  /** The companion_say tool was called: relay to the avatar. */
  | { type: 'companion_say'; text: string; mood?: string; action?: string }
  | { type: 'status'; status: AgentStatus; activity?: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'fatal'; message: string };

// ---------- Transcript shown in the bar / subtitles ----------
export type TranscriptRole = 'user' | 'companion' | 'agent' | 'system' | 'tool';
export interface TranscriptItem {
  id: string;
  role: TranscriptRole;
  text: string;
  at: number;
  /** For tool items: whether it ended ok. */
  ok?: boolean;
}

// ---------- Character asset generation (task 07) ----------
/** 'art' (task 09) = the two Q 版 pictures (bust + waving hero) drawn from the portrait in one job. */
export type CharacterJobKind = 'portrait' | 'idle' | 'art';
export type CharacterJobPhase = 'submitted' | 'queued' | 'running' | 'downloading' | 'done' | 'failed';
/** Progress of one TokenDance generation job; pushed on every change (push:character-job) and mirrored in AppState. */
export interface CharacterJob {
  characterId: string;
  kind: CharacterJobKind;
  phase: CharacterJobPhase;
  /** 0–1 when the backend reports it (Seedance polling); absent for indeterminate phases. */
  progress?: number;
  /** Short Chinese status line for the UI. */
  message?: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
}

// ---------- Whole-app state broadcast to renderers ----------
/** One line of the Vidu-side log shown in settings → 「Vidu 日志」: control signalling both ways plus media milestones. */
export type ViduLogDir = 'out' | 'in' | 'media' | 'app';
export interface ViduLogItem {
  id: string;
  at: number;
  /** out = we → Vidu (HTTP/WS), in = Vidu → us, media = RTC/video/audio in the renderer, app = orchestrator decisions. */
  dir: ViduLogDir;
  /** Short tag, e.g. create / conn_init / ack / text / cue / transcript / interrupt / hangup / join / first_frame / stall. */
  tag: string;
  text: string;
}

export interface AppState {
  avatar: AvatarState;
  agent: AgentState;
  transcript: TranscriptItem[];
  barVisible: boolean;
  /** Optional (task 07): generation jobs in flight plus the most recent finished/failed one per character+kind. */
  characterJobs?: CharacterJob[];
  /** Optional: last ~300 Vidu-side log lines (control + media), newest last. */
  viduLog?: ViduLogItem[];
}

export const initialAvatarState = (): AvatarState => ({ phase: 'idle', message: '未连接 · 显示本地形象', liveId: null, startedAt: null, deadline: null, presented: false });
export const initialAgentState = (): AgentState => ({ status: 'stopped', model: '', activity: '', lastError: null, tools: [] });
