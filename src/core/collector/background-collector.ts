import type { ListingStore } from '../db/listing-store'
import type { Settings } from '../settings'
import { isTradePausedError, type TradeClient } from '../trade/trade-client'
import { toListing } from '../trade/listing-mapper'
import { buildQuery } from '../trade/query-builder'
import type { Listing, RareItem } from '../types'
import { DEFAULT_WEIGHTS } from '../valuation/features'
import { percentile } from '../valuation/price-strategy'
import { KNN_MIN_LISTINGS } from '../valuation/quick-evaluator'

const MIN_SEED_WEIGHT = 0.5
/** La raccolta lavora solo se ogni regola di search e fetch ha almeno il 60% del budget libero. */
export const MIN_RATIO = 0.6
/** Intervallo tra i tick della raccolta. */
export const COLLECT_INTERVAL_MS = 60_000
/**
 * Al massimo una ricerca della raccolta ogni 3 minuti, qualunque sia l'intervallo dei tick (R39:
 * con una ricerca al minuto il trade ha risposto 429 senza header anche senza analisi in corso).
 */
export const MIN_SEARCH_INTERVAL_MS = 3 * 60_000
/** Tolleranza sul controllo dei 60 s: il timer può arrivare qualche ms prima secondo Date.now(). */
export const SEARCH_INTERVAL_TOLERANCE_MS = 2_000
/** Pausa della raccolta oltre la fine di un blocco del trade (429 o restrizione). */
export const RESTRICTION_COOLDOWN_MS = 15 * 60_000
const FETCH_COUNT = 20
const ALL_AGES_DAYS = 3650
/** Classi richieste dalle valutazioni dell'utente tenute in lista (la più recente prima). */
export const MAX_REQUESTED_CLASSES = 5
/** Pausa della raccolta dopo la fine di un'analisi approfondita (il budget serve all'utente). */
export const DEEP_COOLDOWN_MS = 3 * 60_000
/** Nessuna raccolta nel primo minuto dopo l'avvio dell'app. */
export const STARTUP_DELAY_MS = 60_000

export interface Seed {
  itemClass: string
  statId: string
}

/** Tutte le coppie (classe, stat) con peso >= 0.5: classi in ordine di tabella, stat per peso decrescente. */
export function buildSeeds(): Seed[] {
  const seeds: Seed[] = []
  for (const [itemClass, weights] of Object.entries(DEFAULT_WEIGHTS)) {
    Object.entries(weights)
      .filter(([, w]) => w >= MIN_SEED_WEIGHT)
      .sort((a, b) => b[1] - a[1])
      .forEach(([statId]) => seeds.push({ itemClass, statId }))
  }
  return seeds
}

/**
 * Raccolta in background: a coda idle e budget ampio, una ricerca per tick, per dare dati al kNN
 * del valutatore rapido. Prima le classi richieste dalle valutazioni dell'utente (a turno sulle
 * loro stat seed, finché hanno 2 × KNN_MIN_LISTINGS inserzioni), poi il giro normale sui seed
 * (classe, stat). Ferma durante le analisi approfondite e nei 3 minuti successivi, e dopo un 429
 * o una restrizione del trade fino a 15 minuti oltre la fine del blocco. Al massimo una ricerca
 * ogni 60 s.
 */
export class BackgroundCollector {
  private readonly seeds = buildSeeds()
  private cursor = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private startTimer: ReturnType<typeof setTimeout> | null = null
  private running = false
  /** Classi con pochi dati valutate di recente, la più recente prima. */
  private requested: string[] = []
  /** Turno tra le classi richieste e prossimo seed di ciascuna. */
  private requestedTurn = 0
  private readonly requestedCursor = new Map<string, number>()
  /** Ricerche fatte per ogni classe richiesta: oltre un limite la classe esce (mercato povero). */
  private readonly requestedSearches = new Map<string, number>()
  /** Analisi approfondite in corso (una annullata può chiudersi dopo l'inizio della successiva). */
  private deepsRunning = 0
  private lastDeepEnd = Number.NEGATIVE_INFINITY
  /** Istante dell'ultima ricerca della raccolta (ms). */
  private lastSearchAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly deps: {
      client: TradeClient
      store: ListingStore
      toExalted: (amount: number, currency: string) => number | null
      settings: () => Settings
      now: () => Date
      log?: (msg: string) => void
      /** Distanza minima tra due ricerche (default MIN_SEARCH_INTERVAL_MS; i test usano 0). */
      minSearchIntervalMs?: number
    }
  ) {}

  /**
   * Una valutazione (rapida o approfondita) ha riguardato `itemClass`: se nella league corrente
   * ha meno di KNN_MIN_LISTINGS inserzioni va in testa alle classi richieste.
   */
  noteValuation(itemClass: string): void {
    try {
      if (!this.seeds.some((s) => s.itemClass === itemClass)) return
      const count = this.deps.store.countByClass(this.deps.settings().league)[itemClass] ?? 0
      if (count >= KNN_MIN_LISTINGS) return
      this.requested = [itemClass, ...this.requested.filter((c) => c !== itemClass)].slice(
        0,
        MAX_REQUESTED_CLASSES
      )
      this.requestedTurn = 0 // si riparte dalla più recente
      this.requestedSearches.delete(itemClass) // una nuova richiesta riapre il budget
    } catch (e) {
      this.deps.log?.(`classe richiesta non registrata: ${e instanceof Error ? e.message : e}`)
    }
  }

  /** Inizio di un'analisi approfondita: la raccolta si ferma. */
  deepStarted(): void {
    this.deepsRunning++
  }

  /** Fine (o annullamento) di un'analisi approfondita: la raccolta riprende dopo 3 minuti. */
  deepEnded(): void {
    this.deepsRunning = Math.max(0, this.deepsRunning - 1)
    this.lastDeepEnd = this.deps.now().getTime()
  }

  private pausedForDeep(): boolean {
    return this.deepsRunning > 0 || this.deps.now().getTime() - this.lastDeepEnd < DEEP_COOLDOWN_MS
  }

  /** Due giri completi sulle stat seed della classe: se non bastano, il mercato è troppo povero. */
  private maxRequestedSearches(itemClass: string): number {
    return 2 * this.seeds.filter((s) => s.itemClass === itemClass).length
  }

  /** Prossimo seed: prima le classi richieste ancora sotto 2 × KNN_MIN_LISTINGS, poi il giro normale. */
  private nextSeed(league: string): Seed {
    if (this.requested.length > 0) {
      const counts = this.deps.store.countByClass(league)
      this.requested = this.requested.filter(
        (c) =>
          (counts[c] ?? 0) < 2 * KNN_MIN_LISTINGS &&
          (this.requestedSearches.get(c) ?? 0) < this.maxRequestedSearches(c)
      )
    }
    if (this.requested.length > 0) {
      const itemClass = this.requested[this.requestedTurn % this.requested.length]
      this.requestedTurn++
      const own = this.seeds.filter((s) => s.itemClass === itemClass)
      const i = this.requestedCursor.get(itemClass) ?? 0
      this.requestedCursor.set(itemClass, (i + 1) % own.length)
      this.requestedSearches.set(itemClass, (this.requestedSearches.get(itemClass) ?? 0) + 1)
      return own[i % own.length]
    }
    const seed = this.seeds[this.cursor]
    this.cursor = (this.cursor + 1) % this.seeds.length
    return seed
  }

  async tick(): Promise<'collected' | 'skipped'> {
    const { client, settings, toExalted } = this.deps
    try {
      const t = this.deps.now().getTime()
      const minInterval = this.deps.minSearchIntervalMs ?? MIN_SEARCH_INTERVAL_MS
      const s = settings()
      if (
        !s.backgroundCollection ||
        this.pausedForDeep() ||
        !client.isIdle() ||
        // restrizione del trade attiva: niente raccolta finché non scade (Review Focus 2)
        client.blockedForMs() > 0 ||
        // dopo un 429 o una restrizione: 15 minuti di margine oltre la fine del blocco
        client.blockEndedAgoMs() < RESTRICTION_COOLDOWN_MS ||
        t - this.lastSearchAt < Math.max(0, minInterval - SEARCH_INTERVAL_TOLERANCE_MS) ||
        client.remainingRatio() < MIN_RATIO ||
        // senza tassi tutte le inserzioni verrebbero scartate: budget sprecato
        toExalted(1, 'exalted') === null ||
        this.seeds.length === 0
      ) {
        return 'skipped'
      }
      // istante letto all'inizio del tick: il tempo di nextSeed (SQLite) non sposta la cadenza
      this.lastSearchAt = t
      await this.collect(this.nextSeed(s.league), s.league)
      return 'collected'
    } catch (e) {
      // trade bloccato durante il giro (429 o restrizione): giro saltato, la pausa fa il resto
      if (isTradePausedError(e)) return 'skipped'
      this.deps.log?.(
        `raccolta in background fallita: ${e instanceof Error ? e.message : String(e)}`
      )
      return 'skipped'
    }
  }

  /** Un tick ogni `intervalMs`, a partire da `startupDelayMs` dopo la chiamata (avvio dell'app). */
  start(intervalMs = COLLECT_INTERVAL_MS, startupDelayMs = STARTUP_DELAY_MS): void {
    if (this.timer || this.startTimer) return
    const loop = (): void => {
      this.startTimer = null
      this.timer = setInterval(() => {
        if (this.running) return
        this.running = true
        void this.tick().finally(() => {
          this.running = false
        })
      }, intervalMs)
    }
    if (startupDelayMs > 0) this.startTimer = setTimeout(loop, startupDelayMs)
    else loop()
  }

  stop(): void {
    if (this.startTimer) clearTimeout(this.startTimer)
    if (this.timer) clearInterval(this.timer)
    this.startTimer = null
    this.timer = null
  }

  /** floor(0.5 · 95° percentile di |valore|) della stat tra i listing locali della classe; 0 se nessun dato. */
  private seedBound(seed: Seed, league: string): number {
    const { store, now } = this.deps
    const values: number[] = []
    for (const l of store.comparables({
      league,
      itemClass: seed.itemClass,
      maxAgeDays: ALL_AGES_DAYS,
      now: now()
    })) {
      for (const m of l.mods) if (m.statId === seed.statId) values.push(Math.abs(m.value))
    }
    if (values.length === 0) return 0
    values.sort((a, b) => a - b)
    return Math.floor(0.5 * percentile(values, 0.95))
  }

  private async collect(seed: Seed, league: string): Promise<void> {
    const { client, store, toExalted, now } = this.deps
    const item: RareItem = {
      raw: '',
      itemClass: seed.itemClass,
      baseType: '',
      name: '',
      itemLevel: 0,
      quality: 0,
      corrupted: false,
      explicits: [
        {
          statId: seed.statId,
          text: '',
          values: [],
          tradeValue: this.seedBound(seed, league),
          type: 'prefix'
        }
      ],
      implicits: [],
      openPrefixes: 0,
      openSuffixes: 0
    }
    // inserzioni più recenti prima: a ogni giro dati nuovi, non sempre le più economiche (R28)
    const query = buildQuery(item, { mods: item.explicits, valueFactor: 1, sort: 'indexed' })
    const res = await client.search(league, query, 'background')
    if (res.total === 0 || res.result.length === 0) return
    const raws = await client.fetchListings(res.result.slice(0, FETCH_COUNT), res.id, 'background')
    const t = now()
    const listings = raws
      .map((r) => toListing(r, league, toExalted, t, seed.itemClass))
      .filter((l): l is Listing => l !== null)
    store.upsert(listings)
  }
}
