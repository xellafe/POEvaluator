import type { ListingStore } from '../db/listing-store'
import type { Settings } from '../settings'
import { buildQuery, type QueryOptions } from '../trade/query-builder'
import { tradeUrl, type SearchResult, type TradeClient } from '../trade/trade-client'
import { toListing } from '../trade/listing-mapper'
import type { ItemMod, Listing, RareItem, Valuation } from '../types'
import { weightsFor, type Weights } from './features'
import { percentile, priceFor, roundPrice } from './price-strategy'

export interface DeepDeps {
  client: TradeClient
  store: ListingStore
  toExalted: (amount: number, currency: string) => number | null
  settings: Settings
  now: () => Date
  /** Budget di chiamate a `client.search` (i fetch non contano). Default 8. */
  maxSearches?: number
}

export const DEFAULT_MAX_SEARCHES = 8
/** Fattore di rilassamento dei valori dei mod nelle query. */
const VALUE_FACTOR = 0.8
/** Risultati minimi della ricerca base prima di smettere di togliere mod. */
const MIN_BASE_TOTAL = 5
const BASE_FETCH = 20
const SIDE_FETCH = 10

export const openSlotsWarning = (medianExalted: number): string =>
  `Oggetti simili con slot liberi valgono di più (~${roundPrice(medianExalted)} ex)`

/**
 * Mod espliciti per peso decrescente (peso 0 se la stat non è in tabella); a parità il tier
 * migliore (numero più basso) prima, i mod senza tier in fondo. Ogni ItemMod è indipendente.
 */
export function sortModsByWeight(mods: ItemMod[], weights: Weights): ItemMod[] {
  const tier = (m: ItemMod): number => m.tier ?? Number.POSITIVE_INFINITY
  return [...mods].sort(
    (a, b) => (weights[b.statId] ?? 0) - (weights[a.statId] ?? 0) || tier(a) - tier(b)
  )
}

const median = (prices: number[]): number =>
  percentile(
    [...prices].sort((a, b) => a - b),
    0.5
  )

/**
 * Analisi approfondita con più ricerche trade (priorità user):
 * 1. ricerca base con tutti i mod (valori all'80%), togliendo il mod di peso minore finché
 *    total >= 5 o resta un mod;
 * 2. fetch dei primi 20 risultati, salvati nello store;
 * 3. contributo di ogni mod della query finale: mediana(base) - mediana(senza il mod);
 * 4. se l'oggetto non ha slot liberi, confronto con oggetti simili con uno slot libero.
 * Ogni ricerca conta nel budget `maxSearches`; gli errori del client vengono propagati
 * (le inserzioni già recuperate restano salvate).
 */
export async function deepAnalysis(
  item: RareItem,
  deps: DeepDeps,
  onProgress?: (done: number, total: number) => void
): Promise<Valuation> {
  const { client, store, settings } = deps
  const league = settings.league
  const maxSearches = Math.max(1, deps.maxSearches ?? DEFAULT_MAX_SEARCHES)
  const now = deps.now()
  const mods = sortModsByWeight(item.explicits, weightsFor(item.itemClass) ?? {})

  let searches = 0
  const budgetLeft = (): boolean => searches < maxSearches

  const search = async (opts: Omit<QueryOptions, 'valueFactor'>): Promise<SearchResult> => {
    const r = await client.search(
      league,
      buildQuery(item, { ...opts, valueFactor: VALUE_FACTOR }),
      'user'
    )
    searches++
    onProgress?.(searches, maxSearches)
    return r
  }

  /** Recupera i primi `n` risultati, li salva e restituisce i prezzi in exalted. */
  const fetchPrices = async (r: SearchResult, n: number): Promise<number[]> => {
    if (r.total === 0 || r.result.length === 0) return []
    const raw = await client.fetchListings(r.result.slice(0, n), r.id, 'user')
    const listings = raw
      .map((x) => toListing(x, league, deps.toExalted, now, item.itemClass))
      .filter((l): l is Listing => l !== null)
    if (listings.length > 0) store.upsert(listings)
    return listings.map((l) => l.priceExalted)
  }

  // 1. ricerca base con rilassamento
  let queryMods = mods
  let base = await search({ mods: queryMods })
  while (base.total < MIN_BASE_TOTAL && queryMods.length > 1 && budgetLeft()) {
    queryMods = queryMods.slice(0, -1)
    base = await search({ mods: queryMods })
  }

  // 2. prezzi base
  const basePrices = await fetchPrices(base, BASE_FETCH)
  const extraWarnings: string[] = []
  const contributions: NonNullable<Valuation['contributions']> = []

  if (basePrices.length >= 2) {
    const baseMedian = median(basePrices)

    // 3. contributi
    for (const m of queryMods) {
      if (!budgetLeft()) break
      const r = await search({ mods: queryMods.filter((x) => x !== m) })
      const prices = await fetchPrices(r, SIDE_FETCH)
      if (prices.length === 0) continue
      const delta = baseMedian - median(prices)
      contributions.push({
        statId: m.statId,
        text: m.text,
        deltaExalted: Math.sign(delta) * roundPrice(Math.abs(delta)) || 0
      })
    }

    // 4. penalità slot occupati: la stima resta sui comparabili base (stessi mod, slot occupati)
    const weakest = mods[mods.length - 1]
    if (item.openPrefixes + item.openSuffixes === 0 && weakest && budgetLeft()) {
      const r = await search(
        weakest.type === 'prefix'
          ? { mods: queryMods, minOpenPrefixes: 1 }
          : { mods: queryMods, minOpenSuffixes: 1 }
      )
      const prices = await fetchPrices(r, SIDE_FETCH)
      if (prices.length > 0) {
        const openMedian = median(prices)
        if (openMedian > baseMedian) extraWarnings.push(openSlotsWarning(openMedian))
      }
    }
  }

  const priced = priceFor(basePrices, settings.thresholds)
  onProgress?.(maxSearches, maxSearches)
  const result: Valuation = {
    ...priced,
    warnings: [...priced.warnings, ...extraWarnings],
    tradeUrl: tradeUrl(league, base.id)
  }
  if (contributions.length > 0) result.contributions = contributions
  return result
}
