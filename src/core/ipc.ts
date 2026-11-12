// Contratto IPC main <-> renderer (tipi condivisi; nessun import di Electron).
import type { Settings } from './settings'
import type { RareItem, Valuation } from './types'

/** Errore mostrato all'utente: titolo breve e spiegazione. */
export interface EvalError {
  title: string
  message: string
}

export type EvalResult =
  { ok: true; item: RareItem; valuation: Valuation } | ({ ok: false } & EvalError)

export type ValuationKind = 'quick' | 'deep'

/** Punto in pixel CSS relativo alla finestra overlay. */
export interface Point {
  x: number
  y: number
}

export type ResultPayload = {
  kind: ValuationKind
  /** Exalted per 1 divine con i tassi correnti; null se i tassi non sono ancora disponibili. */
  exaltedPerDivine: number | null
  /** Risposta "Analisi già in corso": non riguarda l'analisi mostrata nel pannello. */
  busy?: true
} & EvalResult

export interface ProgressPayload {
  done: number
  total: number
}

/** Richiesta accettata (hotkey o click sul badge): il renderer mostra il caricamento vicino al cursore. */
export interface StartedPayload {
  kind: ValuationKind
  /** Posizione del cursore nell'overlay; null se non è nota (overlay non agganciato). */
  anchor: Point | null
}

/** Analisi approfondita partita su un oggetto valido: dati per il pannello "in corso". */
export interface AnalyzingPayload {
  item: RareItem
  /** Stima rapida già calcolata, mostrata durante l'analisi. */
  quick: Valuation
  exaltedPerDivine: number | null
  /** Ricerche massime dell'analisi (per la barra di avanzamento). */
  totalSearches: number
}

/** Impostazioni parziali: hotkeys e thresholds si possono passare anche solo in parte. */
export type SettingsPatch = Partial<Omit<Settings, 'hotkeys' | 'thresholds'>> & {
  hotkeys?: Partial<Settings['hotkeys']>
  thresholds?: Partial<Settings['thresholds']>
}

export const IPC = {
  result: 'valuation:result',
  progress: 'valuation:progress',
  started: 'valuation:started',
  analyzing: 'valuation:analyzing',
  deep: 'valuation:deep',
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  /** renderer -> main: league PoE2 disponibili sul trade */
  leagues: 'settings:leagues',
  /** main -> overlay: chiudi badge e pannello (Esc in gioco) */
  dismiss: 'overlay:dismiss',
  /** overlay -> main: il mouse è sopra un elemento cliccabile (badge o pannello) */
  interactive: 'overlay:interactive'
} as const

/** API esposta al renderer come `window.poe`. Le funzioni `on*` restituiscono l'unsubscribe. */
export interface PoeApi {
  onResult(cb: (r: ResultPayload) => void): () => void
  onProgress(cb: (p: ProgressPayload) => void): () => void
  onStarted(cb: (p: StartedPayload) => void): () => void
  onAnalyzing(cb: (p: AnalyzingPayload) => void): () => void
  onDismiss(cb: () => void): () => void
  requestDeep(): void
  /** true: l'overlay riceve i click; false: torna trasparente ai click (passano al gioco). */
  setInteractive(on: boolean): void
  getSettings(): Promise<Settings>
  setSettings(patch: SettingsPatch): Promise<Settings>
  /** League PoE2 attive sul trade; lista vuota se non è stato possibile scaricarle. */
  getLeagues(): Promise<string[]>
}
