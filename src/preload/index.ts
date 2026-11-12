import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
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
  setInteractive: (on) => ipcRenderer.send(IPC.interactive, on === true),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch) => ipcRenderer.invoke(IPC.setSettings, patch)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('poe', poe)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.poe = poe
}
