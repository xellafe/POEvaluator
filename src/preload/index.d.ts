import type { PoeApi } from '../core/ipc'

declare global {
  interface Window {
    poe: PoeApi
  }
}
