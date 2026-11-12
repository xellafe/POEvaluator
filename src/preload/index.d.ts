import { ElectronAPI } from '@electron-toolkit/preload'
import type { PoeApi } from '../core/ipc'

declare global {
  interface Window {
    electron: ElectronAPI
    poe: PoeApi
  }
}
