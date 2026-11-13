import type { ListingStore } from '../db/listing-store'
import type { Settings } from '../settings'
import { buildQuery, indexedOptionFor, type QueryOptions } from '../trade/query-builder'
import { abortError, tradeUrl, type SearchResult, type TradeClient } from '../trade/trade-client'
import { toListing } from '../trade/listing-mapper'
import type { ItemMod, Listing, RareItem, Valuation } from '../types'
import { weightsFor, type Weights } from './weights'
import { dpsCoverage, DPS_EPSILON, isAttackWeapon, modStatuses } from './mod-status'

export { isAttackWeapon, LOCAL_DAMAGE_STATS } from './mod-status'
import {
  cleanParityPrices,
  MIN_PARITY_PRICES,
  parityPriceFor,
  percentile,
  roundPrice
} from './price-strategy'

export interface DeepDeps {
  client: TradeClient
  store: ListingStore
  toExalted: (amount: number, currency: string) => number | null
  settings: Settings
  now: () => Date
  /** Budget di chiamate a `client.search` (i fetch non contano). Default 8. */
  maxSearches?: number
  /** Annullamento (pannello chiuso): l'analisi si ferma tra un passo e l'altro con AbortError. */
  signal?: AbortSignal
}

export const DEFAULT_MAX_SEARCHES = 8
/** Fattore dei valori dei mod nella query base. */
const VALUE_FACTOR = 0.8
/** Fattore del DPS nella query base. */
const DPS_FACTOR = 0.85
/** Fattore di mod e DPS nel primo passo di rilassamento. */
const RELAXED_FACTOR = 0.6
/** Risultati minimi della ricerca base prima di rilassare. */
const MIN_BASE_TOTAL = 5
/** Inserzioni scaricate dalla ricerca base e dalle ricerche secondarie. */
const BASE_FETCH = 20
const SIDE_FETCH = 10
/**
 * Il campione si prende fra i primi SAMPLE_CAP risultati (ordinati per prezzo crescente): id
 * equidistanti, così base e varianti confrontano lo stesso quantile e non le stesse posizioni.
 */
export const SAMPLE_CAP = 60
/** Peso minimo di una stat della classe per entrare nel gruppo not. */
const NOT_MIN_WEIGHT = 0.4
/** Stat massime nel gruppo not. */
const NOT_MAX_STATS = 12
/** Messaggio di "Dati insufficienti" dell'analisi approfondita (nessun verdetto, R26). */
export const DEEP_NO_DATA_MESSAGE = 'Non ho trovato oggetti simili in vendita'
/** Come sopra, quando gli oggetti simili ci sono ma sono meno di 3. */
export const DEEP_FEW_DATA_MESSAGE = 'Troppo pochi oggetti simili in vendita per una stima'

/** Avviso quando il rilassamento ha tolto affissi dalla ricerca finale. */
export const partialModsWarning = (used: number, total: number): string =>
  `Stima basata su ${used} ${used === 1 ? 'affisso' : 'affissi'} su ${total}: ` +
  'per gli altri non ci sono abbastanza oggetti simili'

export const openSlotsWarning = (priceExalted: number): string =>
  `Gli oggetti simili con uno slot libero si vendono intorno a ${roundPrice(priceExalted)} ex`

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

/** Ingredienti della query "alla pari" di un oggetto (R31). */
export interface ParityPlan {
  /** Mod dell'oggetto da cercare, per peso decrescente (con peso > 0; tutti se la classe non ha pesi). */
  mods: ItemMod[]
  /** Stat di valore della classe che l'oggetto non ha: gruppo not, mai rimosso. */
  exclude: string[]
  /** DPS dell'oggetto (armi d'attacco): sostituisce i mod di danno locali. */
  dps?: { pdps: number; edps: number }
  /** 0 sul lato (prefix/suffix) dove l'oggetto non ha slot liberi. */
  maxOpenPrefixes?: 0
  maxOpenSuffixes?: 0
  /** La classe ha una tabella pesi (senza: niente gruppo not, confidenza al massimo media). */
  hasWeights: boolean
}

/**
 * Query alla pari: i mod utili dell'oggetto, nessuna stat di valore che l'oggetto non ha (not),
 * gli stessi slot pieni e, per le armi d'attacco, il DPS al posto dei mod di danno locali.
 */
export function parityPlan(item: RareItem): ParityPlan {
  const weights = weightsFor(item.itemClass)
  const coveredByDps = dpsCoverage(item)

  const candidates = item.explicits.filter((m) => !coveredByDps(m.statId))
  const mods = weights
    ? sortModsByWeight(
        candidates.filter((m) => (weights[m.statId] ?? 0) > 0),
        weights
      )
    : candidates

  const owned = new Set(item.explicits.map((m) => m.statId))
  const exclude = weights
    ? Object.entries(weights)
        .filter(([id, w]) => w >= NOT_MIN_WEIGHT && !owned.has(id) && !coveredByDps(id))
        .sort((a, b) => b[1] - a[1])
        .slice(0, NOT_MAX_STATS)
        .map(([id]) => id)
    : []

  const plan: ParityPlan = { mods, exclude, hasWeights: weights !== undefined }
  if (isAttackWeapon(item.itemClass) && item.weapon) {
    plan.dps = { pdps: item.weapon.pdps, edps: item.weapon.edps }
  }
  if (item.openPrefixes === 0) plan.maxOpenPrefixes = 0
  if (item.openSuffixes === 0) plan.maxOpenSuffixes = 0
  return plan
}

/** Variante di una ricerca rispetto alla query base del piano. */
export interface ParityStep {
  /** Mod da cercare (default: tutti quelli del piano). */
  mods?: ItemMod[]
  /** Fattore dei valori dei mod (default 0.8). */
  valueFactor?: number
  /** Fattore del DPS (default 0.85). */
  dpsFactor?: number
  /** Stat aggiunte al gruppo not (ricerche dei contributi). */
  extraExclude?: string[]
  /** Lato con uno slot libero in più (controllo degli slot liberi). */
  openSlotSide?: 'prefix' | 'suffix'
}

/** Opzioni di buildQuery per la query alla pari (base o variante). */
export function parityQueryOptions(
  plan: ParityPlan,
  settings: Settings,
  step: ParityStep = {}
): QueryOptions {
  const dpsFactor = step.dpsFactor ?? DPS_FACTOR
  const opts: QueryOptions = {
    mods: step.mods ?? plan.mods,
    valueFactor: step.valueFactor ?? VALUE_FACTOR,
    exclude: [...plan.exclude, ...(step.extraExclude ?? [])],
    indexed: indexedOptionFor(settings.maxListingAgeDays),
    collapse: true
  }
  if (plan.dps) {
    // stesso criterio di dpsCoverage: un danno sotto DPS_EPSILON non ha filtro; se c'è, il
    // filtro vale almeno 1 (floor(1.1 × 0.85) = 0 non filtrerebbe nulla)
    const min = (v: number): number =>
      v >= DPS_EPSILON ? Math.max(1, Math.floor(v * dpsFactor)) : 0
    opts.dps = { pdps: min(plan.dps.pdps), edps: min(plan.dps.edps) }
  }
  if (step.openSlotSide === 'prefix') opts.minOpenPrefixes = 1
  else if (plan.maxOpenPrefixes !== undefined) opts.maxOpenPrefixes = plan.maxOpenPrefixes
  if (step.openSlotSide === 'suffix') opts.minOpenSuffixes = 1
  else if (plan.maxOpenSuffixes !== undefined) opts.maxOpenSuffixes = plan.maxOpenSuffixes
  return opts
}

/** Query trade alla pari (base o variante) per l'oggetto. */
export function parityQuery(
  item: RareItem,
  plan: ParityPlan,
  settings: Settings,
  step: ParityStep = {}
): object {
  return buildQuery(item, parityQueryOptions(plan, settings, step))
}

/**
 * `n` elementi equidistanti fra i primi `min(items.length, cap)`, primo e ultimo inclusi; con al
 * massimo `n` elementi li prende tutti. Sugli id del trade (ordinati per prezzo crescente) dà un
 * campione dello stesso quantile qualunque sia il numero di risultati.
 */
export function spreadSample<T>(items: readonly T[], n: number, cap = SAMPLE_CAP): T[] {
  if (n <= 0) return []
  if (n === 1) return items.slice(0, 1)
  const m = Math.min(items.length, cap)
  if (m <= n) return items.slice(0, m)
  return Array.from({ length: n }, (_, i) => items[Math.round((i * (m - 1)) / (n - 1))])
}

/**
 * 10° percentile (lo stesso punto del mercato del prezzo consigliato, R32) di un campione di
 * SIDE_FETCH prezzi equidistanti, dopo la pulizia; null se ne restano meno di 3. Il campione
 * base (20 prezzi) si riduce a 10 equidistanti, così base e ricerche secondarie hanno la stessa
 * granularità.
 */
function sampleP10(prices: number[]): number | null {
  const sample = spreadSample(
    [...prices].sort((a, b) => a - b),
    SIDE_FETCH,
    Number.POSITIVE_INFINITY
  )
  const clean = cleanParityPrices(sample)
  return clean.length >= MIN_PARITY_PRICES ? percentile(clean, 0.1) : null
}

/**
 * Analisi approfondita con il confronto "alla pari" (R31, priorità user):
 * 1. ricerca base (parityPlan): mod utili ×0.8, DPS ×0.85, gruppo not, slot pieni, indexed,
 *    collapse; se total < 5: mod e DPS a ×0.6, poi via il mod di peso minore finché ne resta
 *    uno (il gruppo not e i vincoli sugli slot restano sempre);
 * 2. fetch di 20 risultati equidistanti fra i primi 60 (spreadSample), salvati nello store;
 *    prezzo consigliato al 10° percentile del campione (R32), verdetto dal prezzo
 *    (parityPriceFor); con meno di 3 prezzi nessun verdetto (R26);
 * 3. contributo di ogni mod della query finale: p10(base) - p10(senza il mod e con la sua stat
 *    nel not), su campioni equidistanti di 10 prezzi; nascosto se uno dei due ha meno di 3 prezzi;
 * 4. se il lato del mod più debole non ha slot liberi, confronto con oggetti alla pari che hanno
 *    uno slot libero su quel lato al posto di quel mod.
 * Ogni ricerca conta nel budget `maxSearches` (priorità 1 > 3 > 4); gli errori del client
 * vengono propagati (le inserzioni già recuperate restano salvate). Con `deps.signal` annullato
 * rigetta con AbortError al passo successivo, senza altri `onProgress`.
 */
export async function deepAnalysis(
  item: RareItem,
  deps: DeepDeps,
  onProgress?: (done: number, total: number) => void
): Promise<Valuation> {
  const { client, store, settings, signal } = deps
  const checkAborted = (): void => {
    if (signal?.aborted) throw abortError()
  }
  checkAborted()
  const league = settings.league
  const maxSearches = Math.max(1, deps.maxSearches ?? DEFAULT_MAX_SEARCHES)
  const now = deps.now()
  const plan = parityPlan(item)

  let searches = 0
  const budgetLeft = (): boolean => searches < maxSearches

  const search = async (step: ParityStep): Promise<SearchResult> => {
    const r = await client.search(league, parityQuery(item, plan, settings, step), 'user', signal)
    checkAborted()
    searches++
    onProgress?.(searches, maxSearches)
    return r
  }

  /** Recupera `n` risultati equidistanti, li salva e restituisce i prezzi in exalted. */
  const fetchPrices = async (r: SearchResult, n: number): Promise<number[]> => {
    if (r.total === 0 || r.result.length === 0) return []
    const raw = await client.fetchListings(spreadSample(r.result, n), r.id, 'user', signal)
    const listings = raw
      .map((x) => toListing(x, league, deps.toExalted, now, item.itemClass))
      .filter((l): l is Listing => l !== null)
    if (listings.length > 0) store.upsert(listings)
    checkAborted()
    return listings.map((l) => l.priceExalted)
  }

  // 1. ricerca base con rilassamento (il gruppo not e gli slot non cambiano mai)
  let queryMods = plan.mods
  let valueFactor = VALUE_FACTOR
  let dpsFactor = DPS_FACTOR
  const current = (): ParityStep => ({ mods: queryMods, valueFactor, dpsFactor })
  let base = await search(current())
  if (base.total < MIN_BASE_TOTAL && (queryMods.length > 0 || plan.dps) && budgetLeft()) {
    valueFactor = RELAXED_FACTOR
    dpsFactor = RELAXED_FACTOR
    base = await search(current())
  }
  while (base.total < MIN_BASE_TOTAL && queryMods.length > 1 && budgetLeft()) {
    queryMods = queryMods.slice(0, -1)
    base = await search(current())
  }
  const modsRemoved = queryMods.length < plan.mods.length

  // 2. prezzi base
  const basePrices = await fetchPrices(base, BASE_FETCH)
  const priced = parityPriceFor(basePrices, settings.thresholds, {
    fullMatch: !modsRemoved && plan.exclude.length > 0
  })
  const result: Valuation = {
    ...priced,
    warnings: [...priced.warnings],
    tradeUrl: tradeUrl(league, base.id),
    searches
  }
  // stato degli affissi (R34): quelli tolti dal rilassamento sono "relaxed"
  const kept = new Set(queryMods.map((m) => m.statId))
  const removed = new Set(plan.mods.filter((m) => !kept.has(m.statId)).map((m) => m.statId))
  result.mods = modStatuses(item, removed)
  if (priced.verdict === null) {
    // meno di 3 prezzi: nessun verdetto, solo la spiegazione
    result.warnings = [priced.comparablesCount === 0 ? DEEP_NO_DATA_MESSAGE : DEEP_FEW_DATA_MESSAGE]
    return result
  }

  const baseP10 = sampleP10(basePrices)
  const deltas = new Map<string, number>()
  if (baseP10 !== null) {
    // 3. contributi: oggetti alla pari senza quell'affisso
    for (const m of queryMods) {
      if (!budgetLeft()) break
      const r = await search({
        ...current(),
        mods: queryMods.filter((x) => x !== m),
        extraExclude: [m.statId]
      })
      const p10 = sampleP10(await fetchPrices(r, SIDE_FETCH))
      if (p10 === null) continue
      const delta = baseP10 - p10
      deltas.set(m.statId, Math.sign(delta) * roundPrice(Math.abs(delta)) || 0)
    }

    // 4. slot occupati: la stima resta sugli oggetti alla pari (stessi slot pieni)
    const weakest = sortModsByWeight(item.explicits, weightsFor(item.itemClass) ?? {}).at(-1)
    const side = weakest?.type === 'prefix' || weakest?.type === 'suffix' ? weakest.type : null
    const sideFull = side === 'prefix' ? item.openPrefixes === 0 : item.openSuffixes === 0
    if (weakest && side && sideFull && budgetLeft()) {
      // il mod più debole esce dai mod (non va nel not): oggetti alla pari con uno slot libero al
      // suo posto; tenerlo renderebbe la ricerca impossibile se il lato è tutto nella query
      const r = await search({
        ...current(),
        mods: queryMods.filter((m) => m !== weakest),
        openSlotSide: side
      })
      const openP10 = sampleP10(await fetchPrices(r, SIDE_FETCH))
      if (openP10 !== null && openP10 > baseP10) result.warnings.push(openSlotsWarning(openP10))
    }
  }
  result.searches = searches

  if (modsRemoved) {
    // stima su una parte degli affissi: non è la stima dell'oggetto intero (I3)
    result.warnings.push(partialModsWarning(queryMods.length, plan.mods.length))
  }
  for (const m of result.mods) {
    const d = deltas.get(m.statId)
    if (d !== undefined && m.status === 'used') m.deltaExalted = d
  }
  return result
}
