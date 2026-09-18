/**
 * Preload bridge (§54).
 *
 * Runs in an isolated context with access to a restricted `electron` module and exposes
 * exactly the functions in `DesktopBridge` on `window.aido`. The renderer never sees
 * `ipcRenderer`, never sees Node, and cannot invoke an arbitrary channel.
 *
 * Built to CommonJS by `scripts/build-desktop.mjs`: sandboxed preload scripts are not
 * ES modules.
 */
import { IPC_CHANNELS, type DesktopBridge, type DesktopPlatformInfo, type UpdateCheckResponse } from './ipc-contract.js';

// Sandboxed preload scripts cannot use ESM, so `require` is the only way to reach
// Electron here. The import is a static, audited one: no dynamic require, no Node API.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron') as {
  contextBridge: { exposeInMainWorld(key: string, api: unknown): void };
  ipcRenderer: { invoke(channel: string, ...args: unknown[]): Promise<unknown> };
};

const bridge: DesktopBridge = {
  getPlatformInfo: () => ipcRenderer.invoke(IPC_CHANNELS.platformInfo) as Promise<DesktopPlatformInfo>,
  openExternal: (request) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, request) as Promise<{ opened: boolean; reason?: string }>,
  showInFileManager: (request) => ipcRenderer.invoke(IPC_CHANNELS.showInFileManager, request) as Promise<{ revealed: boolean; reason?: string }>,
  notifyTest: (request) => ipcRenderer.invoke(IPC_CHANNELS.notifyTest, request) as Promise<{ delivered: boolean; reason?: string }>,
  checkUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.checkUpdates) as Promise<UpdateCheckResponse>,
  setBadge: (request) => ipcRenderer.invoke(IPC_CHANNELS.setBadge, request) as Promise<void>,
  windowControl: (request) => ipcRenderer.invoke(IPC_CHANNELS.windowControl, request) as Promise<void>,
};

contextBridge.exposeInMainWorld('aido', bridge);
