// Servizio di valutazione del main process. Non importa Electron: riceve le dipendenze (testabile in Vitest).
import type { ListingStore } from '../core/db/listing-store'
import type { EvalError, EvalResult } from '../core/ipc'
import { parseItemText } from '../core/parser/parse-item'
import { makeConverter, type CurrencyRates } from '../core/pricing/currency'
import type { Settings } from '../core/settings'
import type { TradeClient } from '../core/trade/trade-client'
import type { ParseResult } from '../core/types'
import { deepAnalysis } from '../core/valuation/deep-analysis'
import { quickEvaluate } from '../core/valuation/quick-evaluator'

export type { EvalResult }

type FailReason = Extract<ParseResult, { ok: false }>['reason']

const CANNOT = 'Impossibile valutare'
const UNSUPPORTED = 'Oggetto non supportato'

export const MESSAGES: Record<FailReason | 'tradeError', EvalError> = {
  empty: {
    title: CANNOT,
    message: 'Nessun oggetto trovato: tieni il mouse sopra un oggetto e riprova'
  },
  not_poe_item: { title: CANNOT, message: 'Il testo copiato non è un oggetto di PoE2' },
  not_advanced: {
    title: CANNOT,
    message: "Serve la descrizione avanzata: copia l'oggetto con Ctrl+Alt+C e riprova"
  },
  unidentified: { title: CANNOT, message: "L'oggetto non è identificato" },
  unsupported_rarity: { title: UNSUPPORTED, message: 'Per ora valuto solo gli oggetti rari' },
  unsupported_item: {
    title: UNSUPPORTED,
    message: 'Questo tipo di oggetto non è ancora supportato'
  },
  tradeError: {
    title: CANNOT,
    message: 'La ricerca sul trade non è riuscita: riprova tra poco'
  }
}

/** Timeout del download dei tassi da poe.ninja. */
export const RATES_TIMEOUT_MS = 20_000
/** Intervallo di aggiornamento dei tassi. */
export const RATES_REFRESH_MS = 30 * 60 * 1000

export interface EvaluatorDeps {
  client: TradeClient
  store: ListingStore
  settings: () => Settings
  /** Scarica i tassi della league corrente; `signal` viene abortito allo scadere del timeout. */
  fetchRates: (signal?: AbortSignal) => Promise<CurrencyRates>
  now: () => Date
  log?: (msg: string) => void
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export class EvaluatorService {
  private converter = makeConverter(null)
  private timer: ReturnType<typeof setInterval> | null = null
  private refreshing: Promise<void> | null = null
  /** Un refresh richiesto mentre un altro era in volo (es. cambio league): rifarlo subito dopo. */
  private rerun = false

  constructor(private readonly deps: EvaluatorDeps) {}

  /** Converte in exalted con i tassi correnti (letti a ogni chiamata: si aggiornano nel tempo). */
  readonly toExalted = (amount: number, currency: string): number | null =>
    this.converter(amount, currency)

  /** Carica i tassi salvati, avvia l'aggiornamento in background e lo ripete ogni 30 min. */
  async init(): Promise<void> {
    this.loadStoredRates()
    void this.refreshRates()
    if (!this.timer) {
      this.timer = setInterval(() => void this.refreshRates(), RATES_REFRESH_MS)
    }
  }

  /** Da chiamare quando cambia la league: tassi salvati della nuova league, poi aggiornamento. */
  async reloadRates(): Promise<void> {
    this.loadStoredRates()
    if (this.refreshing) {
      // il refresh in volo è per la league precedente (il suo risultato verrà scartato)
      this.rerun = true
      return this.refreshing
    }
    return this.refreshRates()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Scarica i tassi (max 20 s); in caso di errore tiene i precedenti. Non rigetta mai. */
  refreshRates(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.runRefreshes().finally(() => {
        this.refreshing = null
      })
    }
    return this.refreshing
  }

  private async runRefreshes(): Promise<void> {
    do {
      this.rerun = false
      await this.doRefresh()
    } while (this.rerun)
  }

  quick(text: string): EvalResult {
    const parsed = parseItemText(text)
    if (!parsed.ok) return { ok: false, ...MESSAGES[parsed.reason] }
    const valuation = quickEvaluate(
      parsed.item,
      this.deps.store,
      this.deps.settings(),
      this.deps.now()
    )
    return { ok: true, item: parsed.item, valuation }
  }

  async deep(text: string, onProgress: (done: number, total: number) => void): Promise<EvalResult> {
    const parsed = parseItemText(text)
    if (!parsed.ok) return { ok: false, ...MESSAGES[parsed.reason] }
    const { client, store, settings, now } = this.deps
    try {
      const valuation = await deepAnalysis(
        parsed.item,
        { client, store, toExalted: this.toExalted, settings: settings(), now },
        onProgress
      )
      return { ok: true, item: parsed.item, valuation }
    } catch (e) {
      this.deps.log?.(`analisi approfondita fallita: ${errMsg(e)}`)
      return { ok: false, ...MESSAGES.tradeError }
    }
  }

  /** Tassi salvati della league corrente; se non ce ne sono, nessun tasso (mai quelli di un'altra league). */
  private loadStoredRates(): void {
    this.converter = makeConverter(this.deps.store.latestRates(this.deps.settings().league))
  }

  private async doRefresh(): Promise<void> {
    const ac = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        ac.abort()
        reject(new Error(`timeout dopo ${RATES_TIMEOUT_MS / 1000} s`))
      }, RATES_TIMEOUT_MS)
    })
    try {
      const rates = await Promise.race([this.deps.fetchRates(ac.signal), expired])
      if (rates.league !== this.deps.settings().league) return // league cambiata nel frattempo
      this.deps.store.saveRates(rates)
      this.converter = makeConverter(rates)
      this.deps.log?.(`tassi aggiornati (${Object.keys(rates.exaltedPer).length} valute)`)
    } catch (e) {
      this.deps.log?.(`aggiornamento tassi fallito, tengo i precedenti: ${errMsg(e)}`)
    } finally {
      clearTimeout(timeout)
    }
  }
}
