// WebGL green-screen key shared by portraits, idle loops and RTC. See docs/MEDIA_PIPELINE.md.
import { KEY_BACKGROUND, KEY_FOREGROUND, type KeyColor } from './keyColor';
import { type ForegroundGeometry, type FramingDecision, type FramingGuard } from './framingGuard';
import { createFrameProbe } from './frameProbe';

const VERT = `attribute vec2 a_pos;varying vec2 v_uv;void main(){v_uv=vec2(a_pos.x*.5+.5,.5-a_pos.y*.5);gl_Position=vec4(a_pos,0.,1.);}`;
const FRAG = `precision highp float;
uniform sampler2D u_video;uniform sampler2D u_protection;uniform vec3 u_key;uniform vec2 u_texel;
uniform float u_radius;uniform float u_tolerance;uniform float u_spill;uniform float u_edge;
varying vec2 v_uv;
float excess(vec3 c){return max(0.,c.g-max(c.r,c.b));}
float strength(vec3 c){
 float screen=max(1./255.,excess(u_key));
 return min(excess(c)/screen,(excess(c)/max(1./255.,c.g))/(screen/max(1./255.,u_key.g)));
}
bool solid(vec3 c){return excess(c)<=u_tolerance/255.||strength(c)<=${KEY_FOREGROUND.toFixed(2)};}
vec3 despill(vec3 c){c.g-=u_spill*excess(c);return c;}
void main(){
 vec2 e=u_texel*u_edge;
 if(v_uv.x<e.x||v_uv.y<e.y||v_uv.x>1.-e.x||v_uv.y>1.-e.y){gl_FragColor=vec4(0.);return;}
 vec4 c=texture2D(u_video,v_uv);
 // Slight green tint on skin / clothes is foreground, regardless of its size or distance from an outline.
 if(solid(c.rgb)){gl_FragColor=vec4(despill(c.rgb),c.a);return;}
 float s=strength(c.rgb);
 if(s>=${KEY_BACKGROUND.toFixed(2)}){gl_FragColor=vec4(0.);return;}
 vec3 f=vec3(0.);float best=u_radius+1.;bool nearScreen=false;
 for(int y=-4;y<=4;y++)for(int x=-4;x<=4;x++){
  float d=abs(float(x))+abs(float(y));
  if(d>0.&&d<=max(1.,u_radius)){vec3 n=texture2D(u_video,v_uv+vec2(float(x),float(y))*u_texel).rgb;
   if(strength(n)>=${KEY_BACKGROUND.toFixed(2)})nearScreen=true;
   if(d<=u_radius&&d<best&&solid(n)){f=n;best=d;}}
 }
 // No neighbor is NOT evidence of background (the old branch punched large holes in tinted clothes).
 float a=1.-smoothstep(${KEY_FOREGROUND.toFixed(2)},${KEY_BACKGROUND.toFixed(2)},s);
 // Only uncertain tint enclosed by foreground is protected; true green gaps already returned above.
 vec2 maskUV=clamp((v_uv-e)/(vec2(1.)-2.*e),vec2(0.),vec2(1.));
 bool protectedInterior=texture2D(u_protection,maskUV).r>.5&&!nearScreen;
 vec3 color=despill(c.rgb);
 if(protectedInterior)a=1.;
 else if(best<=u_radius){
  float screen=excess(u_key);
  a=clamp((screen-excess(c.rgb))/max(1./255.,screen-excess(f)),0.,1.);
  color=despill(clamp((c.rgb-(1.-a)*u_key)/max(a,.02),0.,1.));
 }
 if(a<.02){gl_FragColor=vec4(0.);return;}
 gl_FragColor=vec4(color,a*c.a);
}`;

export interface GreenKeyOptions {
  key: KeyColor;
  radius?: number;
  tolerance?: number;
  spill?: number;
  /** Texels dropped along the encoded frame border. */
  edge?: number;
  /** Consensus of uniform green patches; retain the last key if corners are covered. */
  autoKey?: boolean;
  /** Live-only safety gate, owned by the session so docking / parameter edits do not reset its baseline. */
  frameGuard?: FramingGuard;
  onGuard?(decision: FramingDecision): void;
  onKey?(key: KeyColor): void;
  /** First successfully drawn, accepted texture; constructing the keyer is not proof of a visible frame. */
  onReady?(): void;
  /** Every 5 s: render/upload counters, source size, key and framing metrics (no image / credentials). */
  onStat?(line: string): void;
  onError?(error: Error): void;
}
export const GREEN_KEY_DEFAULTS = { radius: 3, tolerance: 3, spill: 1, edge: 3, autoKey: true };
export type GreenKeySource = HTMLVideoElement | HTMLImageElement;
const isVideo = (s: GreenKeySource): s is HTMLVideoElement => s instanceof HTMLVideoElement;
const sourceSize = (s: GreenKeySource): [number, number] => isVideo(s) ? [s.videoWidth, s.videoHeight] : [s.naturalWidth, s.naturalHeight];
const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(typeof v === 'number' && !Number.isFinite(v)))) as Partial<T>;

/** Videos: rAF + decoder counter (hidden videos may not fire rVFC). Images: load / resize / update only. */
export function createGreenKey(source: GreenKeySource, canvas: HTMLCanvasElement, opts: GreenKeyOptions) {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: false, alpha: true });
  if (!gl || gl.isContextLost()) throw new Error('WEBGL_UNAVAILABLE');
  const shaders: WebGLShader[] = [];
  const prog = gl.createProgram()!;
  try {
    for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]] as const) {
      const s = gl.createShader(type)!; shaders.push(s); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      gl.attachShader(prog, s);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'shader link');
  } catch (e) { gl.deleteProgram(prog); throw e; }
  finally { shaders.forEach(s => gl.deleteShader(s)); }
  gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'a_pos'); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  const uniforms = new Map<string, WebGLUniformLocation | null>();
  const u = (n: string) => { if (!uniforms.has(n)) uniforms.set(n, gl.getUniformLocation(prog, n)); return uniforms.get(n)!; };
  gl.uniform1i(u('u_video'), 0); gl.uniform1i(u('u_protection'), 1);
  gl.activeTexture(gl.TEXTURE1);
  const protectionTexture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, protectionTexture);
  for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  gl.activeTexture(gl.TEXTURE0);
  let readyReported = false;
  let settings = { ...GREEN_KEY_DEFAULTS, ...defined(opts), key: opts.key };
  let key: KeyColor = [...settings.key], sampled = false, lastKeyLog = -1e9;
  const video = isVideo(source);
  let stopped = false, failed = false, frames = 0, hasTexture = false, dirty = true;
  let geometry: ForegroundGeometry | undefined, decision: FramingDecision | undefined;
  const reportGuard = (next: FramingDecision) => {
    if (!decision || decision.accept !== next.accept || decision.fallback !== next.fallback || decision.reason !== next.reason) settings.onGuard?.(next);
    decision = next;
  };
  let renders = 0, uploads = 0, statFrames = video ? source.getVideoPlaybackQuality?.().totalVideoFrames ?? 0 : 0;
  const display: [number, number] = [0, 0];
  const probe = createFrameProbe();
  const fail = (e: unknown) => { if (!failed && !stopped) { failed = true; settings.onError?.(e instanceof Error ? e : new Error(String(e))); } };
  const lost = (e: Event) => { e.preventDefault(); fail(new Error('WEBGL_CONTEXT_LOST')); };
  canvas.addEventListener('webglcontextlost', lost);
  const draw = () => { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); };

  const render = (): boolean => {
    if (stopped || failed) return false;
    renders++;
    const [w, h] = sourceSize(source);
    // Ignore both network resets and Vidu's 2x2 placeholders, including mid-session re-publishes.
    if (!w || !h || (video && (w < 64 || h < 64 || source.readyState < 2))) return false;
    let snapshot: VideoFrame | undefined;
    try {
      // Pin one decoded frame for sampling AND upload: the RTC decoder may advance between canvas operations.
      const frame = video && typeof VideoFrame !== 'undefined' ? (snapshot = new VideoFrame(source)) : source;
      if (snapshot && (snapshot.displayWidth !== w || snapshot.displayHeight !== h)) return false;
      let nextKey = key;
      if (settings.autoKey && (!video || frames++ % 15 === 0)) {
        const bg = probe.background(frame, w, h);
        if (bg) nextKey = !sampled ? bg : key.map((v, ch) => v + Math.max(-4, Math.min(4, (bg[ch] - v) * 0.2))) as KeyColor;
      }
      const matte = probe.measure(frame, w, h, nextKey, settings.tolerance, settings.edge);
      geometry = matte.geometry;
      if (settings.frameGuard) {
        const next = settings.frameGuard.inspect(geometry, performance.now());
        reportGuard(next);
        // Do not upload, resize, or recalibrate from a rejected frame. Re-draw the retained texture instead.
        if (!next.accept) { if (hasTexture) draw(); return false; }
      }
      if (nextKey !== key) {
        key = nextKey; sampled = true;
        const now = performance.now();
        if (now - lastKeyLog > 2000) { lastKeyLog = now; settings.onKey?.(key.map(Math.round) as KeyColor); }
      }
      // At most displayed device pixels; small pets should not key a full-resolution frame.
      const cw = display[0] ? Math.min(w, Math.max(64, Math.round(display[0]))) : w;
      const ch = Math.min(h, Math.max(1, Math.round(cw * h / w)));
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; gl.viewport(0, 0, cw, ch); }
      // Commit both textures only AFTER the guard accepts. A rejected matte must not corrupt the held good frame.
      gl.activeTexture(gl.TEXTURE1); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, matte.width, matte.height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, matte.protection);
      gl.activeTexture(gl.TEXTURE0); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      uploads++; hasTexture = true;
      gl.uniform3f(u('u_key'), key[0] / 255, key[1] / 255, key[2] / 255);
      gl.uniform2f(u('u_texel'), 1 / w, 1 / h);
      gl.uniform1f(u('u_radius'), settings.radius); gl.uniform1f(u('u_tolerance'), settings.tolerance); gl.uniform1f(u('u_spill'), settings.spill); gl.uniform1f(u('u_edge'), settings.edge);
      draw();
      if (!readyReported) { readyReported = true; settings.onReady?.(); }
      return true;
    } catch (e) { fail(e); return false; }
    finally { snapshot?.close(); }
  };
  const measure = () => {
    const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (display[0] === r.width * dpr && display[1] === r.height * dpr) return;
    display[0] = r.width * dpr; display[1] = r.height * dpr; dirty = true;
    if (!video) render();
  };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : undefined;
  // Initial measurement must not draw an image twice.
  const rect = canvas.getBoundingClientRect(); display[0] = rect.width * (window.devicePixelRatio || 1); display[1] = rect.height * (window.devicePixelRatio || 1);
  ro?.observe(canvas);
  const statTimer = setInterval(() => {
    const q = video ? source.getVideoPlaybackQuality?.() : undefined, total = q?.totalVideoFrames ?? 0;
    settings.onStat?.(`renders=${renders} uploads=${uploads} decoded=${total - statFrames} dropped=${q?.droppedVideoFrames ?? '-'} source=${sourceSize(source).join('x')} canvas=${canvas.width}x${canvas.height} key=${key.map(Math.round).join(',')}${geometry ? ` fg=${geometry.area.toFixed(3)} bbox=${geometry.width.toFixed(3)}x${geometry.height.toFixed(3)} areaRatio=${decision?.areaRatio.toFixed(2)} center=${geometry.centerCoverage?.toFixed(3)} guard=${decision?.reason}` : ''}`);
    renders = 0; uploads = 0; statFrames = total;
  }, 5000);
  let ticket: number | undefined, lastTime = -1, lastFrames = -1;
  const loop = () => {
    if (stopped) return;
    const v = source as HTMLVideoElement, q = v.getVideoPlaybackQuality?.();
    const count = q?.totalVideoFrames ?? -1;
    const fresh = q ? count !== lastFrames : Math.abs(v.currentTime - lastTime) >= 1 / 30;
    if (fresh || dirty) { lastFrames = count; lastTime = v.currentTime; dirty = false; render(); }
    // A single bad frame followed by a frozen decoder must still reach the time-based fallback. Re-evaluate only
    // rejected geometry (no upload / readback); a stale GOOD frame must never count toward recovery.
    else if (settings.frameGuard && geometry && decision && !decision.accept && decision.reason !== 'recovering') reportGuard(settings.frameGuard.inspect(geometry, performance.now()));
    ticket = requestAnimationFrame(loop);
  };
  const drawImage = () => { render(); };
  if (video) ticket = requestAnimationFrame(loop);
  else { if (source.complete && source.naturalWidth) drawImage(); source.addEventListener('load', drawImage); }
  return {
    get settings() { return settings; },
    get key() { return key; },
    get isStatic() { return !video; },
    update(next: Partial<GreenKeyOptions>) {
      settings = { ...settings, ...defined(next) };
      if (next.key && !settings.autoKey) key = [...next.key];
      dirty = true; if (!video) drawImage();
    },
    stop() {
      if (stopped) return;
      stopped = true; ro?.disconnect(); clearInterval(statTimer);
      if (ticket !== undefined) cancelAnimationFrame(ticket);
      source.removeEventListener('load', drawImage); canvas.removeEventListener('webglcontextlost', lost);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.deleteTexture(tex); gl.deleteTexture(protectionTexture); gl.deleteBuffer(buf); gl.deleteProgram(prog);
      // Do not lose the context: the same canvas is reused on reconnect / undock.
    },
  };
}
