// Calcolo periodico dei pesi appresi dall'archivio (R40). Non importa Electron (testabile in Vitest).
import type { ListingStore } from '../core/db/listing-store'
import { learnAllClasses } from '../core/valuation/learned-weights'
import { DEFAULT_WEIGHTS, type Weights } from '../core/valuation/weights'

/** Intervallo di ricalcolo dei pesi appresi. */
export const LEARN_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface LearnedWeightsDeps {
  store: Pick<ListingStore, 'listingsOfLeague'>
  league: () => string
  /** Installa i pesi per classe (setLearnedWeights); null = solo tabella. */
  install: (map: Record<string, Weights> | null) => void
  /** Scrive il report JSON (userData/learned-weights.json). */
  writeReport: (json: string) => void
  now: () => Date
  log: (msg: string) => void
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Pesi appresi della league corrente: al primo giro dopo start(), poi ogni 6 ore e al cambio di
 * league. Il calcolo è sincrono (pochi ms su qualche migliaio di inserzioni): parte da un timer,
 * fuori dal gestore delle richieste, e il tempo impiegato finisce nel log.
 */
export class LearnedWeightsJob {
  private interval: ReturnType<typeof setInterval> | null = null
  private pending: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: LearnedWeightsDeps) {}

  start(): void {
    this.schedule()
    if (!this.interval) this.interval = setInterval(() => this.run(), LEARN_INTERVAL_MS)
  }

  /** I pesi della league precedente non valgono più: tolti subito, poi ricalcolo. */
  leagueChanged(): void {
    this.deps.install(null)
    this.schedule()
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval)
    if (this.pending) clearTimeout(this.pending)
    this.interval = null
    this.pending = null
  }

  /** Calcola e installa; un errore lascia installati i pesi precedenti. */
  run(): void {
    const { store, league, install, writeReport, now, log } = this.deps
    const lg = league()
    const t0 = performance.now()
    let classes: ReturnType<typeof learnAllClasses>
    try {
      classes = learnAllClasses(store.listingsOfLeague(lg), DEFAULT_WEIGHTS)
    } catch (e) {
      log(`pesi appresi non calcolati: ${errMsg(e)}`)
      return
    }
    const ms = Math.round(performance.now() - t0)
    install(Object.fromEntries(Object.entries(classes).map(([c, r]) => [c, r.weights])))
    const counts = Object.fromEntries(Object.entries(classes).map(([c, r]) => [c, r.listings]))
    log(`pesi appresi: ${JSON.stringify(counts)} (${ms} ms)`)
    try {
      writeReport(
        JSON.stringify({ league: lg, computedAt: now().toISOString(), ms, classes }, null, 2)
      )
    } catch (e) {
      log(`report dei pesi appresi non scritto: ${errMsg(e)}`)
    }
  }

  private schedule(): void {
    if (this.pending) clearTimeout(this.pending)
    this.pending = setTimeout(() => {
      this.pending = null
      this.run()
    }, 0)
  }
}
