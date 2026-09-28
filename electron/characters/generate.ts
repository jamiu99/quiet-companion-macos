// Portrait generation: TokenDance Ark Image Generations (synchronous), seedream-5.0-pro, b64 response.
// No Electron imports so it can be unit-tested; the caller resizes / re-encodes the returned image.
import type { Character } from '@shared/config';
import type { CharacterJob } from '@shared/events';
import { buildPortraitPrompt } from './prompts';

export const PORTRAIT_MODEL = 'seedream-5.0-pro';
export const PORTRAIT_SIZE = '1440x2560';
export type Progress = (patch: Pick<CharacterJob, 'phase'> & Partial<Pick<CharacterJob, 'progress' | 'message'>>) => void;

export interface GeneratePortraitOptions {
  character: Pick<Character, 'appearance' | 'style'>;
  apiKey: string;
  /** TokenDance gateway root, e.g. https://tokendance.space/gateway */
  baseUrl: string;
  /** data:image/...;base64,… of the user's reference image → image-to-image. */
  referenceDataUri?: string;
  onProgress?: Progress;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}
export interface PortraitResult { image: Buffer; mime: string; prompt: string; usage?: unknown }

export function portraitRequestBody(o: Pick<GeneratePortraitOptions, 'character' | 'referenceDataUri'>) {
  const prompt = buildPortraitPrompt(o.character, Boolean(o.referenceDataUri));
  return { model: PORTRAIT_MODEL, prompt, size: PORTRAIT_SIZE, response_format: 'b64_json', watermark: false, ...(o.referenceDataUri ? { image: o.referenceDataUri } : {}) };
}

function sniffMime(b: Buffer): string {
  if (b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

export async function generatePortrait(o: GeneratePortraitOptions): Promise<PortraitResult> {
  if (!o.apiKey) throw new Error('未配置 TokenDance API Key');
  if (!o.character.appearance.trim()) throw new Error('请先填写外观描述');
  const fetcher = o.fetcher ?? fetch;
  const body = portraitRequestBody(o);
  o.onProgress?.({ phase: 'submitted', message: '已提交给 seedream-5.0-pro' });
  const started = Date.now();
  // Synchronous API: the request only returns once the image is done (~20–60 s); tick a message meanwhile.
  const tick = setInterval(() => o.onProgress?.({ phase: 'running', message: `生成中 ${Math.round((Date.now() - started) / 1000)}s` }), 1000);
  let res: Response;
  try {
    res = await fetcher(`${o.baseUrl.replace(/\/$/, '')}/ark/v3/images/generations`, {
      method: 'POST', headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(o.timeoutMs ?? 180_000),
    });
  } catch (e) { throw new Error(`生图请求失败：${(e as Error).message}`); }
  finally { clearInterval(tick); }
  const text = await res.text();
  if (!res.ok) throw new Error(`TokenDance 生图 HTTP ${res.status}：${text.slice(0, 300)}`);
  let json: any; try { json = JSON.parse(text); } catch { throw new Error('生图响应不是 JSON'); }
  const b64: unknown = json?.data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || !b64) throw new Error(`生图响应里没有图片：${text.slice(0, 300)}`);
  const image = Buffer.from(b64, 'base64');
  const mime = sniffMime(image);
  if (mime === 'application/octet-stream') throw new Error('生图结果不是 png/jpg/webp');
  o.onProgress?.({ phase: 'downloading', message: '处理图片' });
  return { image, mime, prompt: body.prompt, usage: json.usage };
}
