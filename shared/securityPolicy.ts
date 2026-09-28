// Production renderer only. Vite's development HMR needs a different policy and is loopback-only.
// AliRTC uses local/blob workers and WebAssembly; remote script/eval/frames are deliberately not allowed.
export const RENDERER_CSP = [
  "default-src 'none'", "script-src 'self' blob: 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: companion-asset:", "media-src 'self' blob: companion-asset:",
  "font-src 'self' data:", "connect-src 'self' https: wss: blob: companion-asset:",
  "worker-src 'self' blob:", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');
