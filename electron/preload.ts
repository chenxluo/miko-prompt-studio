/**
 * Preload script — runs in an isolated context with access to Node.js APIs.
 * Exposes a minimal, typed API to the renderer via contextBridge.
 */

import { contextBridge, ipcRenderer } from 'electron';

const api = {
  openFile: (options?: Electron.OpenDialogOptions) =>
    ipcRenderer.invoke('dialog:openFile', options ?? {}),
  openDirectory: (options?: Electron.OpenDialogOptions) =>
    ipcRenderer.invoke('dialog:openDirectory', options ?? {}),
  saveFile: (options?: Electron.SaveDialogOptions) =>
    ipcRenderer.invoke('dialog:saveFile', options ?? {}),
};

contextBridge.exposeInMainWorld('electronAPI', api);

export type ElectronAPI = typeof api;
