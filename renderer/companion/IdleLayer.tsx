import { useEffect, useRef, useState, type CSSProperties, memo } from 'react';
import { createGreenKey, type GreenKeyOptions } from './greenKey';

// Exactly one body is visible: standby does NOT crossfade underneath a transparent live matte. Inactive standby
// is display:none immediately, then its decoder / keyer stop. A requested key never falls back to raw green pixels.
export type IdleKeyParams = Pick<GreenKeyOptions, 'key' | 'tolerance' | 'radius' | 'spill'>;
export interface IdleLayerProps {
  imagePath: string;
  videoPath?: string;
  keyParams: IdleKeyParams;
  active: boolean;
  greenKey?: boolean;
  onLog?(line: string): void;
  onSize?(width: number, height: number): void;
}
const hidden: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', opacity: 0, pointerEvents: 'none' };
// Keep the decoder active while keying; this is the same source, never a second avatar pose.
const hiddenVideo: CSSProperties = { ...hidden, opacity: 0.01 };
const shown: CSSProperties = { ...hidden, opacity: 1 };

function IdleLayerImpl({ imagePath, videoPath, keyParams, active, greenKey = true, onLog, onSize }: IdleLayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null), imgRef = useRef<HTMLImageElement>(null), canvasRef = useRef<HTMLCanvasElement>(null);
  const keyRef = useRef<ReturnType<typeof createGreenKey> | undefined>(undefined);
  const [videoFailed, setVideoFailed] = useState(false), [keyed, setKeyed] = useState(false), [keyFailed, setKeyFailed] = useState(false);
  const [size, setSize] = useState<[number, number]>([9, 16]);
  const useVideo = Boolean(videoPath) && !videoFailed;
  const log = (s: string) => onLog?.(`IDLE ${s}`);
  useEffect(() => { setVideoFailed(false); }, [videoPath]);
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !useVideo) return;
    if (active) void v.play().catch(e => log(`play failed ${(e as Error).message}`));
    else v.pause();
  }, [active, useVideo, videoPath]);

  const keyColor = keyParams.key.join(',');
  useEffect(() => {
    keyRef.current?.stop(); keyRef.current = undefined; setKeyed(false); setKeyFailed(false);
    if (!active || !greenKey) return;
    const source = useVideo ? videoRef.current : imgRef.current, canvas = canvasRef.current;
    if (!source || !canvas) return;
    const failed = (e: Error) => {
      log(`key failed ${e.name}: ${e.message}`); setKeyed(false); setKeyFailed(true);
      if (useVideo) setVideoFailed(true); // Try the portrait, NOT the unkeyed failed video.
    };
    try {
      keyRef.current = createGreenKey(source, canvas, { ...keyParams, onReady: () => setKeyed(true), onKey: k => log(`autokey=${k.join(',')}`), onStat: l => log(`stat ${l}`), onError: failed });
      log(`key on source=${useVideo ? 'video' : 'image'} key=${keyColor}`);
    } catch (e) { failed(e instanceof Error ? e : new Error(String(e))); }
    return () => { keyRef.current?.stop(); keyRef.current = undefined; setKeyed(false); };
  }, [active, greenKey, useVideo, videoPath, imagePath, keyColor]);
  useEffect(() => { keyRef.current?.update({ tolerance: keyParams.tolerance, radius: keyParams.radius, spill: keyParams.spill }); }, [keyParams.tolerance, keyParams.radius, keyParams.spill]);

  const root: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', aspectRatio: `${size[0]} / ${size[1]}`, display: active ? 'block' : 'none', pointerEvents: 'none' };
  return (
    <div style={root} data-idle-layer={useVideo ? 'video' : 'image'} data-keyed={keyed ? '1' : '0'}>
      {useVideo && <video ref={videoRef} src={window.companion.assetUrl(videoPath!)} crossOrigin="anonymous" loop muted playsInline preload="auto"
        style={!greenKey ? shown : hiddenVideo}
        onLoadedMetadata={e => { const v = e.currentTarget; setSize([v.videoWidth, v.videoHeight]); onSize?.(v.videoWidth, v.videoHeight); log(`video ${v.videoWidth}x${v.videoHeight} dur=${v.duration.toFixed(1)}s`); }}
        onError={() => { log('video failed, falling back to portrait'); setVideoFailed(true); }} />}
      {!useVideo && imagePath && <img ref={imgRef} src={window.companion.assetUrl(imagePath)} crossOrigin="anonymous" alt="" style={!greenKey ? shown : hidden}
        onLoad={e => { const i = e.currentTarget; setSize([i.naturalWidth, i.naturalHeight]); onSize?.(i.naturalWidth, i.naturalHeight); log(`image ${i.naturalWidth}x${i.naturalHeight}`); }}
        onError={() => { setKeyFailed(true); log('portrait failed'); }} />}
      <canvas ref={canvasRef} style={{ ...shown, opacity: keyed ? 1 : 0, zIndex: 1 }} />
      {greenKey && keyFailed && <span role="status" style={{ position: 'absolute', top: '50%', width: '100%', textAlign: 'center' }}>本地形象暂不可用</span>}
    </div>
  );
}
export const IdleLayer = memo(IdleLayerImpl, (a, b) =>
  a.imagePath === b.imagePath && a.videoPath === b.videoPath && a.active === b.active && a.greenKey === b.greenKey
  && a.keyParams.key.join(',') === b.keyParams.key.join(',') && a.keyParams.tolerance === b.keyParams.tolerance
  && a.keyParams.radius === b.keyParams.radius && a.keyParams.spill === b.keyParams.spill && a.onLog === b.onLog && a.onSize === b.onSize);
