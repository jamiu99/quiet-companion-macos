import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { realpathSync, statSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Electron file:// pages can fetch other local files even with sandbox + webSecurity. CSP 'self' is not enough. */
export function allowedRendererFile(url: string, expectedURL: string): boolean {
  try {
    const root = realpathSync(dirname(dirname(fileURLToPath(expectedURL))));
    const file = realpathSync(fileURLToPath(url));
    return file.startsWith(`${root}${sep}`) && statSync(file).isFile();
  } catch { return false; }
}

export function trustedRendererURL(url: string, expected: string): boolean {
  try {
    const actual = new URL(url), page = new URL(expected);
    actual.hash = ''; actual.search = ''; page.hash = ''; page.search = '';
    return actual.href === page.href;
  } catch { return false; }
}
export function assertTrustedSender(event: IpcMainInvokeEvent, contents: WebContents | undefined, expectedURL: string) {
  if (!contents || contents.isDestroyed() || event?.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame || !trustedRendererURL(event.senderFrame.url, expectedURL)) throw new Error('IPC 来源不受信任');
}
export function localDevOrigin(value: string | undefined): string | undefined {
  if (!value) return;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('开发服务器必须使用本机地址');
  return url.origin;
}
export function hardenRenderer(contents: WebContents, expectedURL: string, offlineBlocked?: (url: string) => void) {
  // Only packaged public renderer files may use file://. User media must go through companion-asset authorization.
  // Vite dev uses HTTP, so fileURLToPath(expectedURL) fails closed and all file:// requests are denied there.
  const urls = ['file://*/*', ...(offlineBlocked ? ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] : [])];
  contents.session.webRequest.onBeforeRequest({ urls }, (details, callback) => {
    if (!details.url.startsWith('file:')) { offlineBlocked?.(details.url); callback({ cancel: true }); return; }
    callback({ cancel: !allowedRendererFile(details.url, expectedURL) });
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => { if (!trustedRendererURL(url, expectedURL)) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!trustedRendererURL(url, expectedURL)) event.preventDefault(); });
  contents.on('will-attach-webview', event => event.preventDefault());
  // Current product receives remote RTC only: no camera, microphone, screen or notification permission is needed
  // in the renderer. macOS agent tools have separate, explicit OS permissions.
  contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
}
export function secureServiceURL(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('模型服务地址必须是 HTTPS（本机调试可用 HTTP），且不含账号密码');
  return url;
}
