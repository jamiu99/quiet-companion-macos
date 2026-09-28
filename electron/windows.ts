// One window: the companion stage — full-display, transparent, frameless, focusable. Everything (avatar, toolbar,
// embedded chat panel) lives in this single renderer.
//  layer 'float'   (default, "桌宠") — always on top of every app window (NSFloatingWindowLevel).
//  layer 'desktop' ("沉到桌面")      — just above the desktop icons, below every app window.
// Both layers are set with setAlwaysOnTop(true, level, relativeLevel) at runtime, so switching never recreates the
// window. Mouse events are ignored by default (click-through, mousemove forwarded); the renderer hit-tests the pointer
// against its `.interactive` regions and flips this via IPC.setInteractive → setIgnoreMouseEvents(!on, { forward: true }).
import { app, BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hardenRenderer, localDevOrigin } from './security/renderer';
import type { CompanionLayer } from '@shared/config';

export const devUrl = app.isPackaged ? undefined : localDevOrigin(process.env.VITE_DEV_SERVER_URL);
export const companionPageURL = devUrl ? `${devUrl}/companion/index.html` : pathToFileURL(join(__dirname, '../renderer/companion/index.html')).href;
const preload = join(__dirname, 'preload.cjs');
/** COMPANION_DEBUG_FILL=1 → the companion renderer paints a big translucent red block so the window level can be
 *  verified from a screenshot without a live avatar (see docs/PACKAGING.md). Off in normal runs. */
const debugFill = process.env.COMPANION_DEBUG_FILL === '1';
// CoreGraphics window levels observed with CGWindowListCopyWindowInfo on macOS 26 (see docs/PACKAGING.md):
//   墙纸 (wallpaper)            -2147483625  (kCGDesktopWindowLevel)
//   程序坞 "Wallpaper-" window  -2147483624  (Dock also draws a wallpaper window, +1)
//   访达 desktop icons          -2147483603  (kCGDesktopIconWindowLevel)
//   app windows                  0
// setAlwaysOnTop(flag, level, relativeLevel) → NSWindow.level = NSNormalWindowLevel(0) + relativeLevel, clamped by
// Electron to [kCGMinimumWindowLevel, kCGMaximumWindowLevel]. "沉到桌面" sits one above the desktop icons so the pet is
// never covered by icons and still receives clicks.
const DESKTOP_ICON_WINDOW_LEVEL = -2147483603;
export const COMPANION_DESKTOP_LEVEL = DESKTOP_ICON_WINDOW_LEVEL + 1;

function load(win: BrowserWindow) {
  const query: Record<string, string> = {};
  if (debugFill) query.debugFill = '1';
  if (process.env.COMPANION_VIDHIDE) query.vidhide = process.env.COMPANION_VIDHIDE;
  const qs = new URLSearchParams(query).toString();
  if (devUrl) return win.loadURL(`${devUrl}/companion/index.html${qs ? `?${qs}` : ''}`);
  return win.loadFile(join(__dirname, '../renderer', 'companion', 'index.html'), { query });
}

export function createCompanionWindow(layer: CompanionLayer): BrowserWindow {
  const { x, y, width, height } = screen.getPrimaryDisplay().bounds;
  const win = new BrowserWindow({
    x, y, width, height,
    transparent: true, frame: false, hasShadow: false, resizable: false, movable: false,
    skipTaskbar: true, focusable: true, show: false,
    // Without this AppKit pushes the window below the menu bar (y=38 on notch displays) and the bottom is cut off.
    enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', additionalArguments: ['--companion-window=companion'] },
  });
  hardenRenderer(win.webContents, companionPageURL);
  applyLayer(win, layer);
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false, skipTransformProcessType: true });
  void load(win);
  win.once('ready-to-show', () => { win.showInactive(); fitCompanionToPrimaryDisplay(win); });
  return win;
}

/** Set the NSWindow level for the chosen layer. Never call setAlwaysOnTop(false): it resets the level to 0. */
export function applyLayer(win: BrowserWindow, layer: CompanionLayer) {
  if (win.isDestroyed()) return;
  if (layer === 'float') win.setAlwaysOnTop(true, 'floating');
  else win.setAlwaysOnTop(true, 'normal', COMPANION_DESKTOP_LEVEL);
}

/** Click-through toggle driven by the renderer's hit-test (IPC.setInteractive). */
export function setInteractive(win: BrowserWindow, on: boolean) {
  if (win.isDestroyed()) return;
  win.setIgnoreMouseEvents(!on, { forward: true });
}

/** Re-cover the primary display (resolution / arrangement / dock changes). */
export function fitCompanionToPrimaryDisplay(win: BrowserWindow) {
  if (win.isDestroyed()) return;
  // COMPANION_DEBUG_BOUNDS=x,y,w,h: measurement-only override to see how much a full-screen transparent window costs.
  const dbg = process.env.COMPANION_DEBUG_BOUNDS?.split(',').map(Number);
  const b = dbg && dbg.length === 4 && dbg.every(Number.isFinite) ? { x: dbg[0], y: dbg[1], width: dbg[2], height: dbg[3] } : screen.getPrimaryDisplay().bounds;
  const cur = win.getBounds();
  if (cur.x === b.x && cur.y === b.y && cur.width === b.width && cur.height === b.height) return;
  win.setBounds(b);
}
