import { constants, realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import type { AppConfig } from '@shared/config';
import { expandHome } from '../config-store';

export const ASSET_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
export type MediaKind = 'image' | 'video';
const kind = (path: string): MediaKind | undefined => { const mime = ASSET_MIME[extname(path).toLowerCase()]; return mime?.startsWith('image/') ? 'image' : mime?.startsWith('video/') ? 'video' : undefined; };
const canonical = (path: string) => { try { return realpathSync(expandHome(path)); } catch { return undefined; } };
export function configuredMedia(config: AppConfig): string[] {
  return [config.vidu.imagePath, config.companion.idleImagePath, config.companion.idleVideoPath,
    ...(config.characters ?? []).flatMap(c => [c.portraitPath, c.idleVideoPath, c.referenceImagePath, c.artBustPath, c.artHeroPath])].filter((p): p is string => typeof p === 'string' && Boolean(p));
}

/** Exact, canonical files only, never the entire userData directory. Selection grants live for this app session.
 *  A symlink redirected after approval is not silently re-authorized. */
export class LocalAssetAccess {
  private configured = new Map<string, string>();
  private selected = new Map<string, string>();
  private register(map: Map<string, string>, path: string) {
    const actual = canonical(path);
    if (actual && kind(path) && kind(actual) === kind(path)) map.set(expandHome(path), actual);
  }
  setConfigured(config: AppConfig) {
    const next = new Map<string, string>();
    for (const path of configuredMedia(config)) {
      const name = expandHome(path), approved = this.configured.get(name);
      if (approved) next.set(name, approved); // An unrelated setting update must not bless a redirected symlink.
      else this.register(next, path);
    }
    this.configured = next;
  }
  select(path: string) { this.register(this.selected, path); }
  resolve(path: string): string | undefined {
    if (!isAbsolute(path) || path.includes('\0') || !kind(path)) return;
    const approved = this.selected.get(path) ?? this.configured.get(path);
    if (approved && canonical(path) === approved) return approved;
  }
  assertAssignment(path: unknown, expected: MediaKind) {
    if (path === '' || path === undefined) return;
    if (typeof path !== 'string' || kind(path) !== expected || !this.resolve(expandHome(path))) throw new Error('素材必须先通过文件选择器授权');
  }
}

/** Only one byte range is supported. Reject malformed / unsafe integer / unsatisfiable ranges. */
export function byteRange(value: string | null, size: number): { start: number; end: number; partial: boolean } | undefined {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m || (!m[1] && !m[2]) || size === 0) return;
  const a = Number(m[1]), b = Number(m[2]);
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return;
  const start = m[1] ? a : Math.max(0, size - b);
  const end = m[1] && m[2] ? Math.min(b, size - 1) : size - 1;
  if (start > end || start >= size) return;
  return { start, end, partial: true };
}

/** Serves approved image/video files with CORS + Range, but never config.json, .env, arbitrary paths or directories. */
export async function serveLocalAsset(req: Request, access: LocalAssetAccess, devOrigin?: string): Promise<Response> {
  const origin = req.headers.get('origin');
  const headers: Record<string, string> = { 'Access-Control-Allow-Origin': origin === devOrigin ? origin : 'null', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
  if (origin && origin !== 'null' && origin !== devOrigin) return new Response('forbidden', { status: 403, headers });
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
  let path: string;
  try {
    const url = new URL(req.url);
    if (url.protocol !== 'companion-asset:' || url.hostname !== 'local' || url.username || url.password || url.port || url.search) throw new Error('url');
    path = decodeURIComponent(url.pathname.slice(1));
    if (!isAbsolute(path) || path.includes('\0')) throw new Error('path');
  } catch { return new Response('bad request', { status: 400, headers }); }
  const actual = access.resolve(path);
  if (!actual) return new Response('forbidden', { status: 403, headers });
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile()) { await file.close(); return new Response('forbidden', { status: 403, headers }); }
    const range = byteRange(req.headers.get('range'), stat.size);
    if (!range) { await file.close(); return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${stat.size}` } }); }
    const { start, end, partial } = range;
    headers['Content-Type'] = ASSET_MIME[extname(actual).toLowerCase()];
    headers['Content-Length'] = String(end - start + 1);
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    if (req.method === 'HEAD' || stat.size === 0) { await file.close(); return new Response(null, { status: partial ? 206 : 200, headers }); }
    const stream = file.createReadStream({ start, end, autoClose: true });
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: partial ? 206 : 200, headers });
  } catch { await file?.close().catch(() => {}); return new Response('not found', { status: 404, headers }); }
}
