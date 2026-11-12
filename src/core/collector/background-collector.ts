import type { ListingStore } from '../db/listing-store'
import type { Settings } from '../settings'
import type { TradeClient } from '../trade/trade-client'
import { toListing } from '../trade/listing-mapper'
import { buildQuery } from '../trade/query-builder'
import type { Listing, RareItem } from '../types'
import { DEFAULT_WEIGHTS } from '../valuation/features'
import { percentile } from '../valuation/price-strategy'

const MIN_SEED_WEIGHT = 0.5
const MIN_RATIO = 0.5
const FETCH_COUNT = 20
const ALL_AGES_DAYS = 3650

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
 * Raccolta in background: a coda idle e budget ampio, una ricerca per tick su un seed
 * (classe, stat) a round robin, per dare dati al kNN del valutatore rapido.
 */
export class BackgroundCollector {
  private readonly seeds = buildSeeds()
  private cursor = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private readonly deps: {
      client: TradeClient
      store: ListingStore
      toExalted: (amount: number, currency: string) => number | null
      settings: () => Settings
      now: () => Date
      log?: (msg: string) => void
    }
  ) {}

  async tick(): Promise<'collected' | 'skipped'> {
    const { client, settings, toExalted } = this.deps
    try {
      const s = settings()
      if (
        !s.backgroundCollection ||
        !client.isIdle() ||
        // restrizione del trade attiva: niente raccolta finché non scade (Review Focus 2)
        client.blockedForMs() > 0 ||
        client.remainingRatio() < MIN_RATIO ||
        // senza tassi tutte le inserzioni verrebbero scartate: budget sprecato
        toExalted(1, 'exalted') === null ||
        this.seeds.length === 0
      ) {
        return 'skipped'
      }
      const seed = this.seeds[this.cursor]
      this.cursor = (this.cursor + 1) % this.seeds.length
      await this.collect(seed, s.league)
      return 'collected'
    } catch (e) {
      this.deps.log?.(
        `raccolta in background fallita: ${e instanceof Error ? e.message : String(e)}`
      )
      return 'skipped'
    }
  }

  start(intervalMs = 20000): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (this.running) return
      this.running = true
      void this.tick().finally(() => {
        this.running = false
      })
    }, intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
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
    const query = buildQuery(item, { mods: item.explicits, valueFactor: 1 })
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
