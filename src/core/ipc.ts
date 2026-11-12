// Contratto IPC main <-> renderer (tipi condivisi; nessun import di Electron).
import type { Settings } from './settings'
import type { RareItem, Valuation } from './types'

export type EvalResult =
  { ok: true; item: RareItem; valuation: Valuation } | { ok: false; message: string }

export type ValuationKind = 'quick' | 'deep'
export type ResultPayload = { kind: ValuationKind } & EvalResult
export interface ProgressPayload {
  done: number
  total: number
}

/** Impostazioni parziali: hotkeys e thresholds si possono passare anche solo in parte. */
export type SettingsPatch = Partial<Omit<Settings, 'hotkeys' | 'thresholds'>> & {
  hotkeys?: Partial<Settings['hotkeys']>
  thresholds?: Partial<Settings['thresholds']>
}

export const IPC = {
  result: 'valuation:result',
  progress: 'valuation:progress',
  deep: 'valuation:deep',
  getSettings: 'settings:get',
  setSettings: 'settings:set'
} as const

/** API esposta al renderer come `window.poe`. Le funzioni `on*` restituiscono l'unsubscribe. */
export interface PoeApi {
  onResult(cb: (r: ResultPayload) => void): () => void
  onProgress(cb: (p: ProgressPayload) => void): () => void
  requestDeep(): void
  getSettings(): Promise<Settings>
  setSettings(patch: SettingsPatch): Promise<Settings>
}
