// Idle-loop video via TokenDance Seedance Generations (async: submit → poll → download), extracted from
// scripts/gen-idle-video.mjs so the main process can run it. No Electron imports; fetcher is injectable for tests.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { CharacterJob } from '@shared/events';

export const IDLE_MODEL = 'seedance-2.0-fast';
export const IDLE_DURATION_S = 8;
export const IDLE_RESOLUTION = '720p';
/** Typical wall time of an 8 s seedance-2.0-fast job (docs/ASSETS.md: 130–190 s); drives the estimated progress bar. */
export const IDLE_EXPECTED_MS = 170_000;

export interface SeedanceOptions {
  apiKey: string;
  baseUrl: string;
  fetcher?: typeof fetch;
}
export interface SubmitOptions extends SeedanceOptions {
  imagePath: string;
  prompt: string;
  model?: string;
  duration?: number;
  resolution?: string;
  /** Same image as last frame → seamless loop (default true). */
  lastFrame?: boolean;
}
export interface TaskStatus { id?: string; status: string; content?: { video_url?: string }; usage?: unknown; error?: unknown }

export function imageDataUrl(path: string): string {
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extname(path).toLowerCase()];
  if (!mime) throw new Error(`立绘需为 png/jpg/webp：${path}`);
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
}
const tasksUrl = (baseUrl: string) => `${baseUrl.replace(/\/$/, '')}/ark/v3/generations/tasks`;

async function api(o: SeedanceOptions, url: string, init: RequestInit = {}): Promise<any> {
  const res = await (o.fetcher ?? fetch)(url, { ...init, headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) }, signal: init.signal ?? AbortSignal.timeout(60_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.replace(/^https?:\/\/[^/]+/, '')}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export function seedanceRequestBody(o: Omit<SubmitOptions, keyof SeedanceOptions | 'imagePath'> & { image: string }) {
  const content: unknown[] = [
    { type: 'text', text: o.prompt },
    { type: 'image_url', image_url: { url: o.image }, role: 'first_frame' },
  ];
  if (o.lastFrame ?? true) content.push({ type: 'image_url', image_url: { url: o.image }, role: 'last_frame' });
  return { model: o.model ?? IDLE_MODEL, content, resolution: o.resolution ?? IDLE_RESOLUTION, ratio: 'adaptive', duration: o.duration ?? IDLE_DURATION_S, generate_audio: false };
}

/** Submit the job; resolves with the task id. */
export async function submitIdleVideo(o: SubmitOptions): Promise<string> {
  const body = seedanceRequestBody({ ...o, image: imageDataUrl(o.imagePath) });
  const r = await api(o, tasksUrl(o.baseUrl), { method: 'POST', body: JSON.stringify(body) });
  if (!r?.id) throw new Error(`提交成功但没有任务 ID：${JSON.stringify(r).slice(0, 300)}`);
  return String(r.id);
}

export interface PollOptions extends SeedanceOptions {
  intervalMs?: number; timeoutMs?: number;
  onStatus?: (s: TaskStatus, elapsedMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}
export async function pollTask(id: string, o: PollOptions): Promise<TaskStatus> {
  const start = Date.now(), interval = o.intervalMs ?? 5_000, timeout = o.timeoutMs ?? 20 * 60_000;
  const sleep = o.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  for (;;) {
    const r: TaskStatus = await api(o, `${tasksUrl(o.baseUrl)}/${id}`).catch(e => ({ status: 'transient', error: String(e.message) }));
    o.onStatus?.(r, Date.now() - start);
    if (r.status === 'succeeded') return r;
    if (r.status === 'failed' || r.status === 'cancelled' || r.status === 'expired') throw new Error(`任务 ${r.status}：${JSON.stringify(r.error ?? '').slice(0, 300)}`);
    if (Date.now() - start > timeout) throw new Error(`任务 ${id} 超时（最后状态 ${r.status}）`);
    await sleep(interval);
  }
}

export async function downloadVideo(url: string, fetcher: typeof fetch = fetch): Promise<Buffer> {
  const res = await fetcher(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`下载视频 HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Map a Seedance task status onto the UI job phase with an elapsed-time progress estimate. */
export function statusToJob(s: TaskStatus, elapsedMs: number): Pick<CharacterJob, 'phase'> & Partial<Pick<CharacterJob, 'progress' | 'message'>> {
  if (s.status === 'queued') return { phase: 'queued', message: '排队中', progress: 0.02 };
  if (s.status === 'succeeded') return { phase: 'downloading', message: '下载视频', progress: 0.97 };
  const progress = Math.min(0.95, 0.05 + 0.9 * (elapsedMs / IDLE_EXPECTED_MS));
  return { phase: 'running', message: `生成中（seedance-2.0-fast，约 3 分钟）`, progress };
}
