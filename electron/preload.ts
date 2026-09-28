import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type CompanionApi } from '@shared/ipc';

const windowKind = (process.argv.find(a => a.startsWith('--companion-window='))?.split('=')[1] ?? 'companion') as 'companion' | 'bar';
const on = <T>(channel: string) => (cb: (v: T) => void) => {
  const listener = (_: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const api: CompanionApi = {
  getConfig: () => ipcRenderer.invoke(IPC.getConfig),
  beginTokenDanceAuth: () => ipcRenderer.invoke(IPC.beginTokenDanceAuth),
  getTokenDanceAuth: () => ipcRenderer.invoke(IPC.getTokenDanceAuth),
  cancelTokenDanceAuth: () => ipcRenderer.invoke(IPC.cancelTokenDanceAuth),
  setConfig: patch => ipcRenderer.invoke(IPC.setConfig, patch),
  getState: () => ipcRenderer.invoke(IPC.getState),
  sendText: text => ipcRenderer.invoke(IPC.sendText, text),
  runQuickTask: id => ipcRenderer.invoke(IPC.runQuickTask, id),
  abortAgent: () => ipcRenderer.invoke(IPC.abortAgent),
  resetAgent: () => ipcRenderer.invoke(IPC.resetAgent),
  clearSession: () => ipcRenderer.invoke(IPC.clearSession),
  restartAgent: () => ipcRenderer.invoke(IPC.restartAgent),
  connectAvatar: () => ipcRenderer.invoke(IPC.connectAvatar),
  disconnectAvatar: () => ipcRenderer.invoke(IPC.disconnectAvatar),
  interruptAvatar: () => ipcRenderer.invoke(IPC.interruptAvatar),
  mediaReady: liveId => ipcRenderer.invoke(IPC.mediaReady, liveId),
  mediaFailed: (liveId, reason) => ipcRenderer.invoke(IPC.mediaFailed, liveId, reason),
  pickImage: () => ipcRenderer.invoke(IPC.pickImage),
  pickVideo: () => ipcRenderer.invoke(IPC.pickVideo),
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  toggleBar: visible => ipcRenderer.invoke(IPC.toggleBar, visible),
  setLayer: layer => ipcRenderer.invoke(IPC.setLayer, layer),
  openExternal: url => ipcRenderer.invoke(IPC.openExternal, url),
  resizeBar: (width, height) => ipcRenderer.invoke(IPC.resizeBar, width, height),
  setInteractive: on => ipcRenderer.invoke(IPC.setInteractive, Boolean(on)),
  setSpeaking: on => ipcRenderer.invoke(IPC.setSpeaking, Boolean(on)),
  setWindowBounds: rect => ipcRenderer.invoke(IPC.setWindowBounds, rect),
  mediaLog: (tag, text) => ipcRenderer.invoke(IPC.mediaLog, tag, text),
  clearViduLog: () => ipcRenderer.invoke(IPC.clearViduLog),
  log: line => ipcRenderer.invoke(IPC.log, line),
  listCharacters: () => ipcRenderer.invoke(IPC.listCharacters),
  saveCharacter: c => ipcRenderer.invoke(IPC.saveCharacter, c),
  deleteCharacter: id => ipcRenderer.invoke(IPC.deleteCharacter, id),
  setActiveCharacter: id => ipcRenderer.invoke(IPC.setActiveCharacter, id),
  generatePortrait: id => ipcRenderer.invoke(IPC.generatePortrait, id),
  generateIdleVideo: id => ipcRenderer.invoke(IPC.generateIdleVideo, id),
  generateAssets: id => ipcRenderer.invoke(IPC.generateAssets, id),
  listVoices: () => ipcRenderer.invoke(IPC.listVoices),
  generateArt: id => ipcRenderer.invoke(IPC.generateArt, id),
  showContextMenu: () => ipcRenderer.invoke(IPC.showContextMenu),
  setDocked: dock => ipcRenderer.invoke(IPC.setDocked, dock),
  onOpenSettings: cb => { const l = () => cb(); ipcRenderer.on(IPC.openSettings, l); return () => ipcRenderer.removeListener(IPC.openSettings, l); },
  pickReferenceImage: id => ipcRenderer.invoke(IPC.pickReferenceImage, id),
  onCharacterJob: on(IPC.characterJob),
  onState: on(IPC.state),
  onRtc: on(IPC.rtc),
  onConfig: on(IPC.config),
  windowKind,
  assetUrl: path => `companion-asset://local/${encodeURIComponent(path)}`,
};
contextBridge.exposeInMainWorld('companion', api);
