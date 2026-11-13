import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type AnalyzingPayload,
  type PoeApi,
  type ProgressPayload,
  type ResultPayload,
  type StartedPayload
} from '../core/ipc'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

// API del renderer: solo IPC, niente rete (il trade passa dal main, che imposta lo User-Agent).
const poe: PoeApi = {
  onResult: (cb) => subscribe<ResultPayload>(IPC.result, cb),
  onProgress: (cb) => subscribe<ProgressPayload>(IPC.progress, cb),
  onStarted: (cb) => subscribe<StartedPayload>(IPC.started, cb),
  onAnalyzing: (cb) => subscribe<AnalyzingPayload>(IPC.analyzing, cb),
  onDismiss: (cb) => subscribe<void>(IPC.dismiss, () => cb()),
  requestDeep: () => ipcRenderer.send(IPC.deep),
  cancelDeep: () => ipcRenderer.send(IPC.cancel),
  requestContributions: () => ipcRenderer.invoke(IPC.contributions),
  setInteractive: (on) => ipcRenderer.send(IPC.interactive, on === true),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch) => ipcRenderer.invoke(IPC.setSettings, patch),
  getLeagues: () => ipcRenderer.invoke(IPC.leagues),
  onLeagues: (cb) => subscribe<string[]>(IPC.leaguesUpdated, cb)
}

// Preload sandboxed: espone solo `window.poe` (nessun ipcRenderer generico né `process`).
contextBridge.exposeInMainWorld('poe', poe)
