// AliRTC receiver: joins the channel from Vidu's credentials, binds the avatar's remote video to a <video>,
// reports the first *presented* frame. Ported from the previous prototype (AliRTC Web SDK 7.1.9, in assets/vendor).
import type { RtcCredentials } from '@shared/events';

let sdkPromise: Promise<void> | undefined;
export function loadRtcSdk(): Promise<void> {
  if (window.AliRtcEngine) return Promise.resolve();
  sdkPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    // vite publicDir (assets/) lands at the renderer root: dist/renderer/vendor/ (prod, file://) or /vendor/ (dev server).
    // The page lives one level down (companion/index.html), so resolve relative to the parent directory.
    script.src = new URL('../vendor/aliyun-rtc-sdk.js', location.href).toString();
    const timeout = setTimeout(() => { script.remove(); reject(new Error('RTC SDK 加载超时')); }, 15000);
    script.onload = () => { clearTimeout(timeout); resolve(); };
    script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error('RTC SDK 加载失败')); };
    document.head.append(script);
  }).catch(e => { sdkPromise = undefined; throw e; });
  return sdkPromise;
}
function bounded<T>(value: Promise<T> | T, ms = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([Promise.resolve(value), new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('SDK operation timed out')), ms); })]).finally(() => clearTimeout(timer));
}
const avatarUser = (id: string) => /^live-(bot|video-push)-/.test(id);
const MIN_REAL_FRAME_PX = 64;

export interface Receiver {
  stop(): Promise<void>;
  play(): void;
  /** Re-attach the remote video to the <video> element (recovery after a stall); no-op before the first subscription. */
  rebind(): void;
}
export interface ReceiveOptions {
  log(step: string, msg: string): void;
  /** Called once when a real video frame has been presented. */
  frame(): void;
  failed(stage: string): void;
  /** Remote avatar audio became audible / fell silent (debounced). */
  speaking?(on: boolean): void;
  /** Media milestone for the in-app Vidu log (join / subscribe / stats). */
  media?(tag: string, text: string): void;
  /** Autoplay blocked: a user gesture is needed (unlikely in Electron with autoplay policy disabled). */
  gesture(): void;
  active(): boolean;
}

export async function receiveVideo(video: HTMLVideoElement, rtc: RtcCredentials, { log, frame, failed, gesture, speaking, media, active: isActive }: ReceiveOptions): Promise<Receiver | undefined> {
  await loadRtcSdk();
  let stopped = false, stopping: Promise<void> | undefined;
  const active = () => !stopped && isActive();
  const SDK = window.AliRtcEngine;
  if (!SDK || !(await bounded(SDK.isSupported(), 8000)).support) throw new Error('SDK_SUPPORT');
  if (!active()) return;
  const engine = SDK.getInstance();
  let joined = false, presented = false, bound = false, reported = false, ticket: number | undefined, view = '', uid = '';
  const audioUsers = new Set<string>();
  const ready = () => { if (active() && joined && bound && presented && !reported) { reported = true; frame(); } };
  const attemptPlay = () => video.play().catch((error: any) => {
    if (!active()) return;
    if (error?.name === 'NotAllowedError') gesture();
    else if (error?.name !== 'AbortError' && error?.code !== 20) failed('HTML_PLAY_FAILED');
  });
  const subscribe = (user: string, next: number, track: number) => {
    if (!active()) return;
    log('SUBSCRIBE', `state=${next} track=${track} user=${user}`);
    if (next !== 3 || (rtc.remote_user_id ? user !== rtc.remote_user_id : !avatarUser(user))) return;
    const identity = `${user}:${track}`;
    if (view === identity) return;
    view = identity; uid = user; presented = false; bound = false;
    media?.('subscribe', `已订阅远端视频 ${user.slice(-14)} track=${track}`);
    if (ticket !== undefined) video.cancelVideoFrameCallback?.(ticket);
    try {
      engine.setRemoteViewConfig(video, user, track); bound = true;
      // Vidu's stream starts with a 2x2 placeholder frame; wait for a real-sized frame before reporting FIRST_FRAME.
      const onFrame = () => {
        if (!active() || view !== identity) return;
        if (video.videoWidth >= MIN_REAL_FRAME_PX && video.videoHeight >= MIN_REAL_FRAME_PX) { presented = true; ready(); }
        else ticket = video.requestVideoFrameCallback(onFrame);
      };
      ticket = video.requestVideoFrameCallback(onFrame);
      void attemptPlay();
    } catch { failed('BIND_VIEW'); }
  };
  engine.on('videoSubscribeStateChanged', (u: string, _o: number, n: number) => subscribe(u, n, 1));
  engine.on('screenShareSubscribeStateChanged', (u: string, _o: number, n: number) => subscribe(u, n, 2));
  engine.on('remoteUserOnLineNotify', (u: string) => { if (active()) log('REMOTE', `online ${u}`); });
  engine.on('remoteUserOffLineNotify', (u: string, reason: unknown) => { if (active()) log('REMOTE', `offline ${u} reason=${String(reason)}`); });
  engine.on('audioSubscribeStateChanged', (u: string, o: number, n: number) => { if (active()) log('AUDIO_SUB', `state=${o}->${n} user=${u}`); });
  engine.on('remoteTrackAvailableNotify', (u: string, audio: unknown, video: unknown) => { if (active()) { log('TRACKS', `user=${u} audio=${String(audio)} video=${String(video)}`); if (avatarUser(u)) media?.('tracks', `远端轨道可用 audio=${String(audio)} video=${String(video)}`); } });
  // Audio evidence for headless runs: per-second remote volume for a few seconds after join (0 = silence).
  let volumeSamples = 0;
  // Speaking detector: audible → immediately on; silent for SILENCE_HOLD_MS → off (audioVolume arrives ~every 250–1000 ms).
  const SPEAK_THRESHOLD = 3, SILENCE_HOLD_MS = 600;
  let speakingNow = false, silenceTimer: ReturnType<typeof setTimeout> | undefined;
  const setSpeaking = (on: boolean) => { if (speakingNow === on) return; speakingNow = on; speaking?.(on); };
  engine.on('audioVolume', (list: { userId: string; volume: number }[]) => {
    if (!active() || !Array.isArray(list)) return;
    const remote = list.filter(v => v.userId);
    const audible = remote.some(v => avatarUser(v.userId) && v.volume > SPEAK_THRESHOLD);
    if (audible) { if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = undefined; } setSpeaking(true); }
    else if (speakingNow && !silenceTimer) silenceTimer = setTimeout(() => { silenceTimer = undefined; setSpeaking(false); }, SILENCE_HOLD_MS);
    if (volumeSamples < 12 || remote.some(v => v.volume > 0 && volumeSamples % 5 === 0)) log('AUDIO_LEVEL', remote.map(v => `${v.userId}=${v.volume}`).join(' ') || 'no-remote');
    volumeSamples++;
  });
  engine.on('networkQuality', (u: string, up: unknown, down: unknown) => { if (active()) log('NET_QUALITY', `user=${u || 'local'} up=${String(up)} down=${String(down)}`); });
  engine.on('connectionStatusChange', (status: unknown, reason: unknown) => { if (active()) log('RTC_CONN', `status=${String(status)} reason=${String(reason)}`); });
  // Note: this SDK build exposes no remote-stats API on the public engine (checked 2026-09-22: only connectState /
  // backToUnpublishStatus / onLocalDeviceStatusChange), so network loss cannot be measured here. Stream health comes from
  // the <video> element (HEALTH lines in main.tsx: decoded fps, dropped frames, readyState).
  engine.on('remoteAudioAutoPlayFail', (u: string) => { if (active()) { audioUsers.add(u); gesture(); } });
  engine.on('remoteVideoAutoPlayFail', () => { if (active()) gesture(); });
  engine.on('bye', () => { if (active()) failed('RTC_BYE'); });
  engine.on('authInfoExpired', () => { if (active()) failed('RTC_AUTH'); });
  const stop = () => stopping ??= (async () => {
    stopped = true;
    if (silenceTimer) clearTimeout(silenceTimer);
    setSpeaking(false);
    if (ticket !== undefined) video.cancelVideoFrameCallback?.(ticket);
    video.pause(); video.srcObject = null;
    for (const method of ['stopAudioCapture', 'leaveChannel', 'destroy']) { try { await bounded(engine[method]?.(), 2000); } catch { /* keep going */ } }
  })();
  try {
    for (const [method, value] of [
      ['setChannelProfile', 'communication'], ['setAudioOnlyMode', false],
      ['setDefaultSubscribeAllRemoteAudioStreams', true], ['setDefaultSubscribeAllRemoteVideoStreams', true],
      ['publishLocalVideoStream', false], ['publishLocalAudioStream', false],
    ] as const) {
      if (!active()) { await stop(); return; }
      await bounded(engine[method](value), 8000);
    }
    if (engine.setRemoteDefaultVideoStreamType) await bounded(engine.setRemoteDefaultVideoStreamType(SDK.AliRtcVideoStreamType?.AliRtcVideoStreamTypeHigh ?? 1), 8000);
    if (!active()) { await stop(); return; }
    log('RTC_JOIN', 'joining (no local publish)');
    await bounded(engine.joinChannel(rtc.token, rtc.user_id));
    if (!active()) { await stop(); return; }
    joined = true; log('RTC_JOIN', 'joined; waiting for first frame'); media?.('join', '已加入 RTC 频道，等待远端视频'); ready();
    try { engine.enableAudioVolumeIndication?.(1000); } catch { /* optional */ }

    const rebind = () => {
      if (!active() || !view) return;
      const [user, trackStr] = view.split(':'); const track = Number(trackStr) || 1;
      log('REBIND', `user=${user} track=${track}`);
      try { engine.setRemoteViewConfig(video, user, track); void attemptPlay(); } catch (e) { log('REBIND', `failed ${(e as Error)?.message ?? e}`); }
    };
    return { stop, rebind, play() { if (!active()) return; void attemptPlay(); for (const u of new Set([...audioUsers, uid].filter(Boolean))) { try { void Promise.resolve(engine.resumeRemoteAudioStream?.(u)).catch(() => gesture()); } catch { gesture(); } } } };
  } catch (error) { await stop(); throw error; }
}
