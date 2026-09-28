import type { ViduConfig } from '@shared/config';

export function normalizeKey(value: string): string {
  const token = (value ?? '').trim().replace(/^Token\s+/, '');
  if (!/^vda_[A-Za-z0-9_-]+$/.test(token)) throw new Error('Vidu API Key 需要以 vda_ 开头');
  return token;
}

export function validateViduConfig(c: ViduConfig): ViduConfig {
  if (c.host !== 'api.vidu.cn' && c.host !== 'api.vidu.com') throw new Error('Vidu host 只能是 api.vidu.cn 或 api.vidu.com');
  if (c.model !== 'vidu-s2') throw new Error('仅支持 vidu-s2');
  if (!c.persona?.trim() || c.persona.length > 50000) throw new Error('人设需要 1–50000 字');
  if (!c.voice?.trim() || c.voice.length > 200) throw new Error('音色 ID 无效');
  if (!Number.isInteger(c.maxMinutes) || c.maxMinutes < 1 || c.maxMinutes > 10) throw new Error('单次会话上限需为 1–10 分钟');
  return c;
}

/** A best-effort generation constraint, not a substitute for the renderer's framing guard.
 *  Applied at request time so existing character overrides also receive it without rewriting saved personas. */
export const REALTIME_FRAMING_RULE = '桌宠画面约束：始终保持参考图的全身构图、人物大小和站立位置，头顶与脚底留白不变。所有动作在原地完成；镜头固定，不推近、不拉远、不变焦，不切换为半身或面部特写，不走近镜头。保持原有服饰颜色，皮肤和衣物不要染上绿色；背景保持均匀纯绿色，不增加阴影、道具或文字。';

/** Body of POST https://{host}/live/s_avatar/realtime */
export function makeCreatePayload(config: ViduConfig, imageUri: string) {
  return {
    model: config.model,
    call_mode: 'video',
    avatar: {
      image_uri: imageUri,
      persona: config.persona.length + REALTIME_FRAMING_RULE.length + 1 <= 50000 ? `${config.persona}\n${REALTIME_FRAMING_RULE}` : config.persona,
      voice: config.voice, persona_enhance: false,
      // Vidu speaks its default opening line right after conn_init_ack — seconds before our RTC media is up, so the
      // user only heard the tail. Ask her to wait; the app cues a greeting once the first frame is presented.
      greeting_instruction: '会话刚开始时请保持微笑安静等待，不要说话、不要打招呼，等收到第一条消息再回应。',
    },
    audio: { enable_transcription: true },
    enable_recording: false,
    // Server-side guard, measured 2026-09-22: Vidu hangs up (type 6, idle_timeout) exactly this many seconds after
    // conn_init_ack when the client publishes no audio, regardless of text messages. Keep it above our local cap
    // (maxMinutes) so the local timer ends the session first, but the server still ends it if the app dies.
    idle_timeout_seconds: config.maxMinutes * 60 + 60,
  };
}
