import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState, useCallback } from 'react';
import type { RtcPush } from '@shared/ipc';
import { resolveActiveCharacter } from '@shared/config';
import { useAppState, useConfig } from '../shared/useAppState';
import { loadRtcSdk, receiveVideo, type Receiver } from './rtc';
import { createGreenKey } from './greenKey';
import { FramingGuard } from './framingGuard';
import { MediaProgress } from './mediaHealth';
import { createFrameProbe } from './frameProbe';
import { IdleLayer } from './IdleLayer';
import { DEFAULT_ASPECT, Stage } from './Stage';
import { mockScenario } from '../shared/mock';
import { characterArt, uiAsset } from '../shared/ui-assets';

// Assembly only: media plumbing (RTC receive, green key) + the `.stage-body` container whose contents are the idle
// portrait (→ IdleLayer, task 06) and the live video / keyed canvas. Positioning, drag/scale/lock, toolbar, subtitle
// and the embedded chat panel live in Stage.tsx.

// Audio evidence for headless runs: AliRTC plays remote audio through WebAudio (the bound <video> is muted by the SDK
// on purpose), so track every AudioContext the SDK creates and report its state ('running' = audible).
const audioContexts: AudioContext[] = [];
for (const name of ['AudioContext', 'webkitAudioContext']) {
  const Orig = (window as any)[name];
  if (typeof Orig !== 'function') continue;
  (window as any)[name] = new Proxy(Orig, { construct(target, args, newTarget) { const ctx = Reflect.construct(target, args, newTarget); audioContexts.push(ctx); return ctx; } });
}

/** Diagnostic line: on-screen dev log + main.log via ui:log (so a headless run can read it). */
function useDiag() {
  const [log, setLog] = useState<string[]>([]);
  // Diagnostics: how often this component re-renders (a hot loop here re-creates the key / re-paints the panel).
  const renders = useRef(0); renders.current++;
  useEffect(() => { const t = setInterval(() => { void window.companion.log?.(`STAGE renders/5s=${renders.current}`); renders.current = 0; }, 5000); return () => clearInterval(t); }, []);
  const push = useCallback((s: string) => {
    // Only the dev overlay keeps log lines in React state; in production a state update per log line re-rendered
    // the whole stage several times a second (autokey / health probes) and cost ~10% CPU.
    if (import.meta.env.DEV) setLog(l => [...l.slice(-30), `${new Date().toLocaleTimeString()} ${s}`]);
    void window.companion.log?.(s).catch(() => { /* ignore */ });
  }, []);
  return [log, push] as const;
}

/** Every 5 s while live: decoded fps (stream health) and worst rAF gap (renderer main-thread health). */
function probeHealth(video: HTMLVideoElement, report: (s: string) => void) {
  let frames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, dropped = video.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0, last = performance.now(), worst = 0, stopped = false, raf = 0;
  const tick = (t: number) => { if (stopped) return; worst = Math.max(worst, t - last); last = t; raf = requestAnimationFrame(tick); };
  raf = requestAnimationFrame(tick);
  const timer = setInterval(() => {
    const q = video.getVideoPlaybackQuality?.(); const total = q?.totalVideoFrames ?? 0;
    const drop = q?.droppedVideoFrames ?? 0;
    const dFrames = Math.max(0, total - frames), dDrop = Math.max(0, drop - dropped);
    report(`HEALTH decodedFps=${(dFrames / 5).toFixed(1)} dropped=+${dDrop} worstRafGap=${worst.toFixed(0)}ms ready=${video.readyState} size=${video.videoWidth}x${video.videoHeight}`);
    frames = total; dropped = drop; worst = 0;
  }, 5000);
  return () => { stopped = true; cancelAnimationFrame(raf); clearInterval(timer); };
}

/** Watches decoded-frame progress after the first frame; see the stall fallback comment in Stage. Returns a disposer. */
function watchStalls(video: HTMLVideoElement, h: { log(s: string): void; stalled(on: boolean): void; recover(): void; giveUp(): void }) {
  const SOFT_MS = 3000, RECOVER_MS = 6000, GIVE_UP_MS = 20000, TICK_MS = 500;
  const progress = new MediaProgress(Date.now());
  let stalled = false, recovered = false, stopped = false, inReset = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const q = video.getVideoPlaybackQuality?.();
    // Stream re-publish by Vidu: the element loses its dimensions / data for ~2 s, then comes back. Report both edges
    // (the orchestrator uses 'recovered' to repeat a greeting whose audio start was lost in the switch).
    const resetNow = video.videoWidth < 64 || video.videoHeight < 64 || video.readyState === 0;
    if (resetNow && !inReset) { inReset = true; h.log(`RESET stream re-published (${video.videoWidth}x${video.videoHeight})`); void window.companion.mediaLog?.('reset', `视频流重置（${video.videoWidth}x${video.videoHeight}）`); }
    else if (!resetNow && inReset && video.readyState >= 3) { inReset = false; h.log('RESET recovered'); void window.companion.mediaLog?.('recovered', '视频流恢复'); }
    // A paid soak reproduced readyState=4 with a frozen black frame. Only decoder progress is evidence of recovery;
    // tolerate normal bursty delivery through the 3s grace period, not by treating buffered data as ongoing progress.
    const { advanced, ageMs: dur } = progress.observe({ width: video.videoWidth, height: video.videoHeight, readyState: video.readyState, decodedFrames: q?.totalVideoFrames, currentTime: video.currentTime }, Date.now());
    if (advanced) {
      if (stalled) { stalled = false; recovered = false; h.log(`STALL recovered`); void window.companion.mediaLog?.('stall', '视频恢复'); h.stalled(false); }
      return;
    }
    if (!stalled && dur >= SOFT_MS) { stalled = true; h.log(`STALL ${dur}ms ready=${video.readyState} size=${video.videoWidth}x${video.videoHeight} → idle fallback`); void window.companion.mediaLog?.('stall', `视频断流 ${Math.round(dur / 1000)}s（ready=${video.readyState}），暂用待机画面`); h.stalled(true); }
    if (stalled && !recovered && dur >= RECOVER_MS) { recovered = true; h.log(`STALL ${dur}ms → rebind remote view`); h.recover(); }
    if (stalled && dur >= GIVE_UP_MS) { stopped = true; clearInterval(timer); h.log(`STALL ${dur}ms → give up`); h.giveUp(); }
  }, TICK_MS);
  return () => { stopped = true; clearInterval(timer); };
}

/** Counts presented frames per second for `seconds` and reports each second (evidence that video is really playing). */
function probeFrames(video: HTMLVideoElement, seconds: number, report: (line: string) => void) {
  let frames = 0, sec = 0, ticket: number | undefined, stopped = false;
  let decoded = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
  const tick = () => { frames++; if (!stopped) ticket = video.requestVideoFrameCallback(tick); };
  ticket = video.requestVideoFrameCallback(tick);
  const timer = setInterval(() => {
    sec++;
    // presented = rVFC callbacks (0 while the <video> is hidden behind the keyed canvas); decoded = frames the decoder produced.
    const q = video.getVideoPlaybackQuality?.(); const dec = (q?.totalVideoFrames ?? 0) - decoded; decoded = q?.totalVideoFrames ?? 0;
    const audioEls = [...document.querySelectorAll('audio')].map(a => `${a.paused ? 'paused' : 'playing'}/${a.muted ? 'muted' : 'unmuted'}/vol=${a.volume}/src=${a.srcObject ? 'stream' : 'none'}`).join(',') || 'none';
    report(`FRAMES sec=${sec} presented=${frames} decoded=${dec} dropped=${q?.droppedVideoFrames ?? '-'} size=${video.videoWidth}x${video.videoHeight} paused=${video.paused} ready=${video.readyState} videoMuted=${video.muted} audioEls=${audioEls} audioCtx=${audioContexts.map(c => `${c.state}@${c.sampleRate}`).join(',') || 'none'}`);
    frames = 0;
    if (sec >= seconds) { stopped = true; clearInterval(timer); if (ticket !== undefined) video.cancelVideoFrameCallback?.(ticket); }
  }, 1000);
  return () => { stopped = true; clearInterval(timer); if (ticket !== undefined) video.cancelVideoFrameCallback?.(ticket); };
}

function App() {
  const state = useAppState();
  const [config, setConfig] = useConfig();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const receiverRef = useRef<Promise<Receiver | undefined> | undefined>(undefined);
  const keyRef = useRef<ReturnType<typeof createGreenKey> | undefined>(undefined);
  const probeRef = useRef<(() => void) | undefined>(undefined);
  const [live, setLive] = useState(false);
  // Network-stall fallback: the RTC stream can stop delivering frames (or reset to 0x0) for a few seconds while the
  // session and audio stay alive. <1.2s: nothing. Then the keyed canvas keeps the last frame; ≥3s: fade the idle loop
  // in over the live layer; 6s: re-attach the remote view once; 20s: give up (mediaFailed → hang up).
  const [stalled, setStalled] = useState(false);
  const stallRef = useRef<() => void>(undefined);
  const [keyed, setKeyed] = useState(false);
  const [keyFailed, setKeyFailed] = useState(false);
  const [framingFallback, setFramingFallback] = useState(false);
  const framingGuardRef = useRef(new FramingGuard());
  // Body aspect (w/h) reported by whichever media is showing; Stage sizes the container from it.
  const [idleAspect, setIdleAspect] = useState(DEFAULT_ASPECT);
  const onIdleSize = useCallback((w: number, h: number) => { if (w && h) setIdleAspect(w / h); }, []);
  const [videoAspect, setVideoAspect] = useState(DEFAULT_ASPECT);
  const [log, push] = useDiag();

  // Preload the RTC SDK and report support for this origin (file:// in production) before any paid session starts.
  useEffect(() => {
    push(`STAGE href=${location.href.slice(0, 80)} secure=${window.isSecureContext} ua=${navigator.userAgent.match(/Electron\/[\d.]+/)?.[0] ?? '-'}`);
    loadRtcSdk().then(async () => {
      const SDK = window.AliRtcEngine;
      const r = await Promise.resolve(SDK?.isSupported?.()).catch((e: Error) => ({ support: false, error: e?.message }));
      push(`SDK_SUPPORT ${JSON.stringify(r).slice(0, 300)} version=${SDK?.getSdkVersion?.() ?? SDK?.version ?? '-'}`);
    }).catch(e => push(`SDK_LOAD_FAILED ${(e as Error).message}`));
  }, []);

  useEffect(() => window.companion.onRtc((e: RtcPush) => {
    const video = videoRef.current!;
    const teardown = () => {
      probeRef.current?.(); probeRef.current = undefined;
      stallRef.current?.(); stallRef.current = undefined; setStalled(false);
      keyRef.current?.stop(); keyRef.current = undefined; setKeyed(false); setLive(false); setKeyFailed(false);
      framingGuardRef.current.reset(); setFramingFallback(false);
      const r = receiverRef.current; receiverRef.current = undefined; void r?.then(x => x?.stop());
    };
    if (e.type === 'rtc-stop') { push(`RTC_STOP ${e.liveId}`); teardown(); return; }
    teardown();
    push(`RTC_START live=${e.liveId} user=${e.rtc.user_id} remote=${e.rtc.remote_user_id ?? '-'} href=${location.protocol}//${location.host} secure=${window.isSecureContext}`);
    let current = true;
    const p: Promise<Receiver | undefined> = receiveVideo(video, e.rtc, {
      log: (a, b) => push(`${a} ${b}`),
      active: () => current && receiverRef.current === p,
      failed: stage => { push(`FAILED ${stage}`); void window.companion.mediaFailed(e.liveId, stage); },
      gesture: () => push('AUTOPLAY_BLOCKED (NotAllowedError)'),
      speaking: on => { push(`SPEAKING ${on}`); void window.companion.setSpeaking?.(on); },
      media: (tag, text) => void window.companion.mediaLog?.(tag, text),
      frame: () => {
        push(`FIRST_FRAME size=${video.videoWidth}x${video.videoHeight} paused=${video.paused} ready=${video.readyState} muted=${video.muted}`);
        if (video.videoWidth && video.videoHeight) setVideoAspect(video.videoWidth / video.videoHeight);
        setLive(true);
        probeRef.current?.();
        const stopFrames = probeFrames(video, 8, push); const stopHealth = probeHealth(video, push);
        probeRef.current = () => { stopFrames(); stopHealth(); };
        stallRef.current?.();
        stallRef.current = watchStalls(video, {
          log: push,
          stalled: on => setStalled(on),
          recover: () => void p.then(r => r?.rebind()),
          giveUp: () => { push('FAILED VIDEO_STALLED'); void window.companion.mediaFailed(e.liveId, 'VIDEO_STALLED_20S'); },
        });
        void window.companion.mediaReady(e.liveId);
      },
    }).catch(err => { push(`RTC_ERROR ${err?.message ?? err}`); void window.companion.mediaFailed(e.liveId, String(err?.message ?? err)); return undefined; });
    receiverRef.current = p;
    return () => { current = false; };
  }), []);

  // Start/stop the green key when live state or config changes; tune parameters live.
  const c = config?.companion;
  const keyParams = { key: c?.keyColor ?? [0, 255, 0] as [number, number, number], tolerance: c?.keyTolerance, radius: c?.keyRadius, spill: c?.keySpill };
  // Docked (task 09): nothing is on screen, so the key loop and the idle loop pause; the live <video> keeps playing (audio).
  const docked = Boolean(c?.docked);
  useEffect(() => {
    setKeyed(false); setKeyFailed(false); setFramingFallback(false);
    if (!live || !c?.greenKey || docked) { keyRef.current?.stop(); keyRef.current = undefined; setKeyed(false); return; }
    try {
      keyRef.current = createGreenKey(videoRef.current!, canvasRef.current!, {
        ...keyParams, frameGuard: c.framingGuard !== false ? framingGuardRef.current : undefined,
        onReady: () => setKeyed(true),
        onKey: k => push(`GREENKEY autokey=${k.join(',')}`),
        onStat: line => push(`GREENKEY stat ${line}`),
        onError: e => { setKeyFailed(true); push(`GREENKEY_FAILED ${e.name}: ${e.message}`); },
        onGuard: d => {
          setFramingFallback(d.fallback);
          const line = `reason=${d.reason} accept=${d.accept} fallback=${d.fallback} areaRatio=${d.areaRatio.toFixed(2)}`;
          push(`FRAMING ${line}`);
          void window.companion.mediaLog?.('framing', line);
        },
      });
      push(`GREENKEY on key=${keyParams.key.join(',')} tol=${keyRef.current.settings.tolerance} radius=${keyRef.current.settings.radius} spill=${keyRef.current.settings.spill} edge=${keyRef.current.settings.edge} autoKey=${keyRef.current.settings.autoKey}`);
    } catch (e) { push(`GREENKEY_FAILED ${(e as Error).message}`); setKeyed(false); setKeyFailed(true); }
    return () => { keyRef.current?.stop(); keyRef.current = undefined; setKeyed(false); };
  }, [live, c?.greenKey, c?.framingGuard, docked, keyParams.key.join(',')]);
  useEffect(() => {
    if (!keyRef.current) return;
    keyRef.current.update({ tolerance: keyParams.tolerance, radius: keyParams.radius, spill: keyParams.spill });
    push(`GREENKEY update tol=${keyRef.current.settings.tolerance} radius=${keyRef.current.settings.radius} spill=${keyRef.current.settings.spill}`);
  }, [keyParams.tolerance, keyParams.radius, keyParams.spill]);

  // Active character (task 07) decides the idle portrait / loop; legacy fields are the fallback (see resolveActiveCharacter).
  const active = config ? resolveActiveCharacter(config) : undefined;
  useEffect(() => {
    // Calibrate while idle; a portrait edited during a live session must not change that session's reference.
    if (live) return;
    const guard = framingGuardRef.current; guard.setReference(undefined);
    if (!active?.imagePath) return;
    let cancelled = false;
    const image = new Image(); image.crossOrigin = 'anonymous';
    image.onload = () => {
      if (cancelled) return;
      try {
        const probe = createFrameProbe(), w = image.naturalWidth, h = image.naturalHeight;
        const key = probe.background(image, w, h) ?? keyParams.key;
        const { geometry } = probe.measure(image, w, h, key, keyParams.tolerance);
        guard.setReference(geometry);
        push(`FRAMING reference fg=${geometry.area.toFixed(3)} bbox=${geometry.width.toFixed(3)}x${geometry.height.toFixed(3)} center=${geometry.centerCoverage?.toFixed(3)}`);
      } catch { push('FRAMING reference unavailable; using first plausible live frame'); }
    };
    image.onerror = () => { if (!cancelled) push('FRAMING reference load failed; using first plausible live frame'); };
    image.src = window.companion.assetUrl(active.imagePath);
    return () => { cancelled = true; image.onload = null; image.onerror = null; };
  }, [live, active?.imagePath, keyParams.key.join(','), keyParams.tolerance]);
  const idle = active?.character ? active.imagePath : (c?.idleImagePath || active?.imagePath || '');
  const idleVideo = active?.idleVideoPath || undefined;
  const showKeyed = live && Boolean(c?.greenKey) && keyed && !keyFailed;
  const visualFallback = live && (stalled || Boolean(c?.greenKey) && (framingFallback || keyFailed || !keyed));
  // A failed key should show the local fallback, never an opaque green rectangle.
  const showVideo = live && !c?.greenKey;
  // COMPANION_DEBUG_FILL=1 (main → ?debugFill=1): paint a large translucent red block to verify window level from a screenshot.
  const debugFill = new URLSearchParams(location.search).get('debugFill') === '1';
  const showDiag = import.meta.env.DEV && !mockScenario();

  return (
    <div className="stage-root">
      {debugFill && (
        <div style={{ position: 'absolute', left: '10vw', top: '10vh', width: '80vw', height: '80vh', background: 'rgba(255,0,0,.55)', border: '12px solid #ff0', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 64, fontFamily: 'system-ui', fontWeight: 700 }}>
          COMPANION DEBUG FILL · {config?.companion.layer}
        </div>
      )}
      {state && config && (
        <Stage config={config} state={state} setConfig={setConfig} live={live} visualFallback={visualFallback} aspect={live ? videoAspect : idleAspect}>
          {/* Body container: Stage owns its position/size (fills the body box); the contents below are the media layers
              (the idle <img> becomes <IdleLayer/> in task 06). Children are sized 100%/100% by stage.css. */}
          <div className="stage-body">
            {idle && <IdleLayer imagePath={idle} videoPath={idleVideo} keyParams={keyParams} active={(!live || visualFallback) && !docked} greenKey={c?.greenKey ?? true} onLog={push} onSize={onIdleSize} />}
            {!idle && !live && active && config && <div className="stage-placeholder"><img src={active.artHeroPath ? characterArt(config).hero : uiAsset('hero-placeholder.png')} alt="" draggable={false} /><b>{active.name}</b><span>尚未生成形象</span></div>}
            {/* Hidden behind the keyed canvas with opacity 0.01, not 0: Chromium treats an opacity-0 video as invisible and
                delivers its frames lazily in batches (~5 fps measured), which made the keyed avatar stutter. */}
            <video ref={videoRef} autoPlay playsInline muted={false} style={{ position: 'absolute', inset: 0, opacity: showVideo && !visualFallback ? 1 : 0.01 }} />
            <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, display: showKeyed && !visualFallback ? 'block' : 'none' }} />
          </div>
        </Stage>
      )}
      {showDiag && <pre className="stage-diag">{log.join('\n')}</pre>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
