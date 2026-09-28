import { Tray, Menu, nativeImage, app } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { CompanionLayer } from '@shared/config';

export interface TrayActions {
  toggleBar(): void;
  connectAvatar(): void;
  disconnectAvatar(): void;
  setLayer(layer: CompanionLayer): void;
  getLayer(): CompanionLayer;
  avatarLive(): boolean;
  /** Task 09: tuck the pet away as an edge tag / bring her back. */
  toggleDocked?(): void;
  isDocked?(): boolean;
  /** Current accelerator for showing / hiding the chat panel (shown in the menu). */
  getToggleBarHotkey(): string;
  openLogs(): void;
  openWorkspace(): void;
  openConfig(): void;
}

// Template icon (black silhouette, transparent). Dev: assets/; packaged: vite copies assets/ into dist/renderer/.
// nativeImage.createFromPath picks up trayTemplate@2x.png automatically when it sits next to trayTemplate.png.
function trayIcon(): Electron.NativeImage {
  const candidates = [join(__dirname, '..', '..', 'assets', 'trayTemplate.png'), join(__dirname, '..', 'renderer', 'trayTemplate.png')];
  const file = candidates.find(existsSync);
  const icon = file ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
  icon.setTemplateImage(true);
  return icon;
}

export type CompanionTray = Tray & { rebuild(): void };
export function createTray(actions: TrayActions): CompanionTray {
  const tray = new Tray(trayIcon());
  tray.setToolTip('栖伴');
  const rebuild = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏对话面板', accelerator: actions.getToggleBarHotkey() || undefined, click: () => actions.toggleBar() },
    ...(actions.toggleDocked ? [{ label: actions.isDocked?.() ? '从侧边唤出' : '收到侧边', click: () => { actions.toggleDocked!(); rebuild(); } }] : []),
    { type: 'separator' },
    actions.avatarLive()
      ? { label: '结束数字人连接', click: () => { actions.disconnectAvatar(); rebuild(); } }
      : { label: '连接数字人', click: () => { actions.connectAvatar(); rebuild(); } },
    { type: 'separator' },
    { label: '数字人图层', submenu: [
      { label: '置顶（桌宠）', type: 'radio', checked: actions.getLayer() === 'float', click: () => actions.setLayer('float') },
      { label: '沉到桌面', type: 'radio', checked: actions.getLayer() === 'desktop', click: () => actions.setLayer('desktop') },
    ] },
    { type: 'separator' },
    { label: '打开工作目录', click: () => actions.openWorkspace() },
    { label: '打开日志目录', click: () => actions.openLogs() },
    { label: '打开配置文件', click: () => actions.openConfig() },
    { type: 'separator' },
    { label: `退出栖伴 ${app.getVersion()}`, click: () => { (app as any).isQuitting = true; app.quit(); } },
  ]));
  rebuild();
  tray.on('click', () => actions.toggleBar());
  return Object.assign(tray, { rebuild });
}
