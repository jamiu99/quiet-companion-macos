// Runs inside a real, offline Electron renderer. Vitest alone cannot compile GLSL or verify texture alpha.
import { createGreenKey } from '../../renderer/companion/greenKey';
import { FramingGuard, measureForeground, type FramingDecision } from '../../renderer/companion/framingGuard';
import type { KeyColor } from '../../renderer/companion/keyColor';
import { createFrameProbe } from '../../renderer/companion/frameProbe';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createElement } from 'react';
import { IdleLayer } from '../../renderer/companion/IdleLayer';
import { authSettingsTest } from './auth-settings.browser';

const KEY: KeyColor = [6, 198, 62];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function raster(w = 128, h = 192) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
async function image(src: string, existing = new Image()) {
  await new Promise<void>((resolve, reject) => { existing.onload = () => resolve(); existing.onerror = () => reject(new Error('image decode failed')); existing.src = src; });
  return existing;
}
function fixture(scale = 1, gap = false) {
  const c = raster(), ctx = c.getContext('2d')!;
  ctx.fillStyle = `rgb(${KEY})`; ctx.fillRect(0, 0, c.width, c.height);
  ctx.save(); ctx.translate(64, 168); ctx.scale(scale, scale); ctx.translate(-64, -168);
  ctx.fillStyle = '#222'; ctx.fillRect(40, 24, 48, 144);
  // Deliberately much farther than keyRadius from any non-green outline: the historical shader made this transparent.
  ctx.fillStyle = 'rgb(183,198,178)'; ctx.fillRect(42, 26, 44, 140);
  ctx.fillStyle = 'rgb(232,189,163)'; ctx.fillRect(46, 28, 36, 28);
  if (gap) { ctx.fillStyle = `rgb(${KEY})`; ctx.fillRect(60, 110, 8, 16); }
  ctx.restore();
  return c;
}
function readPixels(c: HTMLCanvasElement) {
  const copy = raster(c.width, c.height), ctx = copy.getContext('2d')!;
  ctx.drawImage(c, 0, 0); return ctx.getImageData(0, 0, c.width, c.height).data;
}
function alphaAt(c: HTMLCanvasElement, x: number, y: number) { return readPixels(c)[(y * c.width + x) * 4 + 3]; }
function output(source: HTMLImageElement) {
  const c = raster(source.naturalWidth, source.naturalHeight);
  c.style.width = `${c.width}px`; c.style.height = `${c.height}px`; document.body.append(c); return c;
}

export async function run(input: { portrait: string; video: string; times: number[]; customVideo: boolean }) {
  const tests: { name: string; ok: boolean; error?: string }[] = [];
  const artifacts: { name: string; png: string }[] = [];
  const frames: Record<string, unknown>[] = [];
  const test = async (name: string, fn: () => unknown | Promise<unknown>) => {
    try { await fn(); tests.push({ name, ok: true }); }
    catch (e) { tests.push({ name, ok: false, error: String((e as Error).message) }); }
  };
  const save = (name: string, raw: CanvasImageSource, keyed: HTMLCanvasElement) => {
    const c = raster(keyed.width, keyed.height), ctx = c.getContext('2d')!;
    ctx.drawImage(raw, 0, 0, c.width, c.height); artifacts.push({ name: `${name}-raw`, png: c.toDataURL() });
    artifacts.push({ name: `${name}-keyed`, png: keyed.toDataURL() });
    const rgba = readPixels(keyed), mask = ctx.createImageData(c.width, c.height);
    for (let i = 0; i < rgba.length; i += 4) { mask.data[i] = mask.data[i + 1] = mask.data[i + 2] = rgba[i + 3]; mask.data[i + 3] = 255; }
    ctx.putImageData(mask, 0, 0); artifacts.push({ name: `${name}-alpha`, png: c.toDataURL() });
    for (let y = 0; y < c.height; y += 16) for (let x = 0; x < c.width; x += 16) { ctx.fillStyle = ((x + y) / 16) % 2 ? '#999' : '#eee'; ctx.fillRect(x, y, 16, 16); }
    ctx.drawImage(keyed, 0, 0); artifacts.push({ name: `${name}-checker`, png: c.toDataURL() });
  };

  for (const scale of [1, 1.8]) await test(`WebGL preserves large tinted interiors at scale ${scale}`, async () => {
    const raw = fixture(scale), img = await image(raw.toDataURL()), c = output(img);
    const errors: Error[] = [];
    const key = createGreenKey(img, c, { key: KEY, autoKey: false, onError: e => errors.push(e) });
    try {
      save(`tinted-${scale}`, raw, c);
      check(!errors.length, errors[0]?.message);
      check(alphaAt(c, 64, 100) >= 250, `shirt alpha=${alphaAt(c, 64, 100)}, expected opaque`);
      check(alphaAt(c, 8, 100) === 0, 'background not transparent');
    } finally { key.stop(); c.remove(); }
  });

  await test('topology preserves an uncertain shirt without making border-connected shadows opaque', async () => {
    const raw = fixture(), ctx = raw.getContext('2d')!;
    ctx.fillStyle = 'rgb(100,176,100)'; ctx.fillRect(42, 57, 44, 109);
    // A dark print is a nearby solid sample, but is NOT proof that the neighboring cloth is a translucent edge.
    ctx.fillStyle = '#222'; ctx.fillRect(62, 70, 2, 30);
    ctx.fillStyle = 'rgb(3,100,30)'; ctx.fillRect(0, 10, 20, 160);
    ctx.fillStyle = `rgb(${KEY})`; ctx.fillRect(60, 110, 8, 16);
    ctx.fillStyle = `rgb(${KEY.map((v, i) => (v + [100, 176, 100][i]) / 2)})`; ctx.fillRect(59, 110, 1, 16);
    const img = await image(raw.toDataURL()), c = output(img), key = createGreenKey(img, c, { key: KEY, autoKey: false });
    try {
      save('protected-shirt', raw, c);
      check(alphaAt(c, 64, 90) >= 250, `uncertain shirt interior was punched through: ${alphaAt(c, 64, 90)}`);
      check(alphaAt(c, 10, 80) < 240, 'background shadow incorrectly protected as opaque foreground');
      check(alphaAt(c, 64, 118) === 0, 'true enclosed green gap was filled');
      check(alphaAt(c, 59, 118) > 0 && alphaAt(c, 59, 118) < 240, 'internal gap lost its fractional-alpha edge');
    } finally { key.stop(); c.remove(); }
  });

  await test('portrait reference blocks a first-frame close-up before it is ever shown', async () => {
    const reference = await image(fixture().toDataURL()), guard = new FramingGuard(), probe = createFrameProbe();
    guard.setReference(probe.measure(reference, reference.naturalWidth, reference.naturalHeight, KEY).geometry);
    const img = await image(fixture(1.8).toDataURL()), c = output(img);
    let ready = false, decision: FramingDecision | undefined;
    const key = createGreenKey(img, c, { key: KEY, autoKey: false, frameGuard: guard, onReady: () => { ready = true; }, onGuard: d => { decision = d; } });
    try { check(!ready && decision?.reason === 'zoom' && decision.fallback, 'first close-up became a healthy baseline'); check(alphaAt(c, 64, 100) === 0, 'rejected first texture visible'); }
    finally { key.stop(); c.remove(); }
  });

  await test('large central matte collapse holds the good texture rather than exposing another body', async () => {
    const img = await image(fixture().toDataURL()), c = output(img);
    let decision: FramingDecision | undefined;
    const key = createGreenKey(img, c, { key: KEY, autoKey: false, frameGuard: new FramingGuard(), onGuard: d => { decision = d; } });
    try {
      const bad = fixture(), ctx = bad.getContext('2d')!; ctx.fillStyle = `rgb(${KEY})`; ctx.fillRect(48, 60, 32, 70);
      await image(bad.toDataURL(), img); key.update({});
      check(decision?.reason === 'matte-hole' && !decision.accept, `central collapse accepted: ${decision?.reason}`);
      check(alphaAt(c, 64, 90) >= 250, 'good body was overwritten by the hollow frame');
      await sleep(380); key.update({}); check(decision?.fallback, 'persistent collapse did not fall back');
    } finally { key.stop(); c.remove(); }
  });

  await test('standby becomes non-painting immediately and never falls back to raw green on key failure', async () => {
    const previous = window.companion;
    window.companion = { assetUrl: (s: string) => s } as typeof window.companion;
    const host = document.createElement('div'); host.style.cssText = 'position:relative;width:128px;height:192px'; document.body.append(host);
    const root = createRoot(host), src = fixture().toDataURL(), props = { imagePath: src, keyParams: { key: KEY }, active: true };
    const render = (active: boolean, greenKey = true) => flushSync(() => root.render(createElement(IdleLayer, { ...props, active, greenKey })));
    try {
      render(true); await sleep(150);
      check(host.querySelector('[data-keyed="1"]'), 'standby never produced a keyed frame');
      render(false);
      check(getComputedStyle(host.firstElementChild!).display === 'none', 'standby can still paint through a transparent live body during handoff');
      render(true); await sleep(100);
      const c = host.querySelector('canvas')!, ext = c.getContext('webgl')!.getExtension('WEBGL_lose_context');
      check(ext, 'context loss unavailable'); ext.loseContext(); await sleep(100);
      check(host.querySelector('[role="status"]'), 'key failure missing graceful state');
      check(getComputedStyle(host.querySelector('img')!).opacity === '0', 'raw green image leaked after key failure');
      render(true, false); await sleep(50);
      check(getComputedStyle(host.querySelector('img')!).opacity === '1', 'explicitly disabled key must still support raw mode');
    } finally { flushSync(() => root.unmount()); host.remove(); window.companion = previous; }
  });

  await test('WebGL removes true green gaps inside the silhouette (no blanket hole-fill)', async () => {
    const raw = fixture(1, true), img = await image(raw.toDataURL()), c = output(img);
    const key = createGreenKey(img, c, { key: KEY, autoKey: false });
    try { save('enclosed-gap', raw, c); check(alphaAt(c, 64, 118) === 0, 'real arm gap filled'); check(alphaAt(c, 55, 118) > 250, 'nearby clothing erased'); }
    finally { key.stop(); c.remove(); }
  });

  await test('WebGL keeps a fractional alpha edge and removes the codec border', async () => {
    const raw = fixture(), ctx = raw.getContext('2d')!;
    ctx.fillStyle = `rgb(${KEY.map(v => (v + 34) / 2).join(',')})`; ctx.fillRect(39, 24, 1, 144);
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, 2, 192);
    const img = await image(raw.toDataURL()), c = output(img), key = createGreenKey(img, c, { key: KEY, autoKey: false });
    try { const a = alphaAt(c, 39, 80); check(a > 100 && a < 160, `edge alpha=${a}`); check(alphaAt(c, 1, 80) === 0, 'codec border visible'); }
    finally { key.stop(); c.remove(); }
  });

  await test('WebGL auto-key ignores corners covered by tinted clothes', async () => {
    const raw = fixture(), ctx = raw.getContext('2d')!;
    ctx.fillStyle = 'rgb(183,198,178)'; ctx.fillRect(0, 0, 30, 30); ctx.fillRect(100, 0, 28, 30);
    const img = await image(raw.toDataURL()), c = output(img), key = createGreenKey(img, c, { key: [0, 255, 0] });
    try { check(key.key.every((v, i) => Math.abs(v - KEY[i]) <= 2), `wrong key ${key.key}`); check(alphaAt(c, 64, 100) >= 250, 'clothing lost after auto-key'); }
    finally { key.stop(); c.remove(); }
  });

  await test('WebGL framing gate retains the last texture, falls back, then recovers', async () => {
    const img = await image(fixture().toDataURL()), c = output(img);
    let decision: FramingDecision | undefined;
    const key = createGreenKey(img, c, { key: KEY, autoKey: false, frameGuard: new FramingGuard(), onGuard: d => { decision = d; } });
    try {
      await image(fixture(1.8).toDataURL(), img); key.update({});
      check(decision?.reason === 'zoom' && !decision.accept, 'zoom frame accepted');
      check(alphaAt(c, 30, 100) === 0, 'rejected enlarged texture was uploaded');
      check(alphaAt(c, 64, 100) >= 250, 'last good texture was not retained');
      await sleep(380); key.update({}); check(decision?.fallback, 'persistent zoom did not request idle');
      await image(fixture().toDataURL(), img); key.update({}); check(decision?.fallback, 'recovery flickered immediately');
      await sleep(430); key.update({}); check(decision?.accept && !decision.fallback, 'stable picture failed to recover');
    } finally { key.stop(); c.remove(); }
  });

  await test('single black RTC frame followed by decoder freeze still enters fallback', async () => {
    const raw = fixture(), stream = raw.captureStream(0), track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    const v = document.createElement('video'), c = raster();
    c.style.width = '128px'; c.style.height = '192px'; v.muted = true; v.playsInline = true; v.srcObject = stream; document.body.append(v, c);
    let key: ReturnType<typeof createGreenKey> | undefined;
    try {
      await Promise.race([v.play(), sleep(4000).then(() => { throw new Error('capture stream play timeout'); })]);
      track.requestFrame(); await sleep(200);
      let decision: FramingDecision | undefined;
      key = createGreenKey(v, c, { key: KEY, autoKey: false, frameGuard: new FramingGuard(), onGuard: d => { decision = d; } });
      await sleep(100); check(decision?.accept, 'valid first frame missing');
      const ctx = raw.getContext('2d')!; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, raw.width, raw.height); track.requestFrame();
      await sleep(800);
      check(Boolean(decision?.fallback && decision.reason === 'flood'), 'a single black frame must reach fallback without more decoder progress');
      ctx.drawImage(fixture(), 0, 0); track.requestFrame(); await sleep(600);
      check(Boolean(decision?.fallback && decision.reason === 'recovering'), 'one good frame frozen on screen must not count as continuous recovery');
      // captureStream only emits after canvas paint; requestFrame alone on an unchanged canvas is not a new frame.
      ctx.fillStyle = 'rgb(7,198,62)'; ctx.fillRect(10, 10, 1, 1); track.requestFrame(); await sleep(250);
      check(decision?.accept && !decision.fallback, `fresh good frames should recover (${decision?.reason})`);
    } finally { key?.stop(); stream.getTracks().forEach(t => t.stop()); v.srcObject = null; v.remove(); c.remove(); }
  });

  await test('WebGL canvas can stop / restart repeatedly without losing its context', async () => {
    const img = await image(fixture().toDataURL()), c = output(img);
    try {
      for (let i = 0; i < 5; i++) {
        const key = createGreenKey(img, c, { key: KEY, autoKey: false });
        check(alphaAt(c, 64, 100) >= 250, `canvas reuse failed on cycle ${i}`); key.stop(); key.stop();
      }
    } finally { c.remove(); }
  });

  await test('WebGL context loss is reported for presentation fallback', async () => {
    const img = await image(fixture().toDataURL()), c = output(img), errors: Error[] = [];
    const key = createGreenKey(img, c, { key: KEY, onError: e => errors.push(e) });
    try {
      const ext = c.getContext('webgl')!.getExtension('WEBGL_lose_context'); check(ext, 'missing test extension');
      ext.loseContext(); await sleep(100);
      check(errors.some(e => e.message === 'WEBGL_CONTEXT_LOST'), 'context loss not reported');
    } finally { key.stop(); c.remove(); }
  });

  for (const stage of ['sampling', 'upload'] as const) await test(`WebGL ${stage} failure is reported once instead of silently going transparent`, async () => {
    const img = await image(fixture().toDataURL()), c = output(img), errors: Error[] = [];
    const read = CanvasRenderingContext2D.prototype.getImageData, upload = WebGLRenderingContext.prototype.texImage2D;
    let key: ReturnType<typeof createGreenKey> | undefined;
    try {
      const fail = () => { throw new DOMException('test tainted source', 'SecurityError'); };
      if (stage === 'sampling') CanvasRenderingContext2D.prototype.getImageData = fail;
      else WebGLRenderingContext.prototype.texImage2D = fail;
      key = createGreenKey(img, c, { key: KEY, autoKey: stage === 'sampling', onError: e => errors.push(e) });
      key.update({});
      check(errors.length === 1 && errors[0].name === 'SecurityError', `expected one ${stage} error, got ${errors.length}`);
    } finally {
      CanvasRenderingContext2D.prototype.getImageData = read; WebGLRenderingContext.prototype.texImage2D = upload;
      key?.stop(); c.remove();
    }
  });

  const replayGuard = new FramingGuard();
  const inspect = async (name: string, raw: HTMLCanvasElement, time?: number) => {
    const img = await image(raw.toDataURL()), c = output(img), errors: Error[] = [];
    const key = createGreenKey(img, c, { key: [0, 255, 0], onError: e => errors.push(e) });
    try {
      save(name, raw, c);
      const pixels = readPixels(c);
      let opaque = 0, transparent = 0;
      for (let i = 3; i < pixels.length; i += 4) { if (pixels[i] > 240) opaque++; if (pixels[i] < 10) transparent++; }
      const geometry = measureForeground(readPixels(raw), raw.width, raw.height, key.key);
      const frame = { name, size: [c.width, c.height], key: key.key, opaque: opaque / (c.width * c.height), transparent: transparent / (c.width * c.height), geometry, framing: time === undefined ? undefined : replayGuard.inspect(geometry, time * 1000) };
      frames.push(frame);
      check(!errors.length, errors[0]?.message);
      if (!input.customVideo || time === undefined) { check(frame.opaque > 0.1 && frame.opaque < 0.6, `unexpected foreground coverage ${frame.opaque}`); check(frame.transparent > 0.35, 'background not removed'); }
    } finally { key.stop(); c.remove(); }
  };
  await test('bundled portrait decodes and keys on the real shader', async () => {
    const img = await image(input.portrait), raw = raster(img.naturalWidth, img.naturalHeight);
    raw.getContext('2d')!.drawImage(img, 0, 0); await inspect('portrait', raw);
  });
  await test('local video replay: decode / seek / key / export raw+alpha+checker', async () => {
    const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; document.body.append(v);
    try {
      await new Promise<void>((resolve, reject) => { v.onloadeddata = () => resolve(); v.onerror = () => reject(new Error(`video load failed ${v.error?.code}`)); v.src = input.video; });
      // Exercise the actual HTMLVideoElement upload / rAF decoder-counter path as well as deterministic still-frame
      // comparisons below. A requested parameter redraw must work even while this video is paused.
      await test('video texture upload and paused-video parameter redraw use the production loop', async () => {
        const c = raster(); c.style.width = '200px'; c.style.height = `${200 * v.videoHeight / v.videoWidth}px`; document.body.append(c);
        const errors: Error[] = [];
        const gl = c.getContext('webgl', { premultipliedAlpha: false, alpha: true })!;
        const upload = gl.texImage2D, draw = CanvasRenderingContext2D.prototype.drawImage;
        const probed = new Set<VideoFrame>(), committed: VideoFrame[] = [];
        let uploads = 0, key: ReturnType<typeof createGreenKey> | undefined;
        CanvasRenderingContext2D.prototype.drawImage = function (...args: unknown[]) {
          if (args[0] instanceof VideoFrame) probed.add(args[0]);
          Reflect.apply(draw, this, args);
        };
        gl.texImage2D = (...args: unknown[]) => {
          uploads++;
          const frame = args.at(-1);
          if (frame instanceof VideoFrame) { check(probed.has(frame), 'uploaded a different frame from the CPU probe'); committed.push(frame); }
          Reflect.apply(upload, gl, args);
        };
        try {
          key = createGreenKey(v, c, { key: [0, 255, 0], frameGuard: new FramingGuard(), onError: e => errors.push(e) });
          for (let i = 0; i < 2; i++) {
            key.update({ spill: i });
            const drawn = await new Promise<boolean>(resolve => requestAnimationFrame(() => {
              const pixels = readPixels(c);
              resolve(pixels.some((v, p) => p % 4 === 3 && v > 240));
            }));
            check(drawn, `paused-video draw ${i} has no foreground`);
          }
          check(!errors.length, errors[0]?.message);
          check(committed.length > 0 && committed.every(f => f.codedWidth === 0), 'video snapshots were missing or not closed');
          const before = uploads; await sleep(80);
          check(uploads === before, `paused decoder re-uploaded ${uploads - before} unchanged frames`);
        } finally { CanvasRenderingContext2D.prototype.drawImage = draw; gl.texImage2D = upload; key?.stop(); c.remove(); }
      });
      const raw = raster(v.videoWidth, v.videoHeight);
      for (const t of input.times) {
        check(t < v.duration, `sample ${t}s exceeds duration ${v.duration}s`);
        if (Math.abs(v.currentTime - t) > 0.0001) await new Promise<void>(resolve => { v.onseeked = () => resolve(); v.currentTime = t; });
        raw.getContext('2d')!.drawImage(v, 0, 0); await inspect(`video-${t}`, raw, t);
      }
    } finally { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); }
  });
  await test('real settings DOM: consent-only OAuth, cancellation and explicit secret input save', authSettingsTest);
  return { tests, artifacts, frames };
}
