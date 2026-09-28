import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { RENDERER_CSP } from './shared/securityPolicy';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// One renderer entry: the companion stage (full-screen transparent pet window with the embedded chat panel).
export default defineConfig({
  root: r('./renderer'),
  base: './',
  plugins: [react(), { name: 'production-csp', apply: 'build', transformIndexHtml: { order: 'post', handler: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: RENDERER_CSP }, injectTo: 'head-prepend' }] } }],
  resolve: { alias: { '@shared': r('./shared') } },
  publicDir: r('./assets'),
  build: {
    outDir: r('./dist/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        companion: r('./renderer/companion/index.html'),
      },
    },
  },
  server: { host: '127.0.0.1', port: 5183, strictPort: true },
});
