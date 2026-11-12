import type { ListingStore } from '../db/listing-store'
import type { Settings } from '../settings'
import { buildQuery, indexedOptionFor, type QueryOptions } from '../trade/query-builder'
import { abortError, tradeUrl, type SearchResult, type TradeClient } from '../trade/trade-client'
import { toListing } from '../trade/listing-mapper'
import type { ItemMod, Listing, RareItem, Valuation } from '../types'
import { weightsFor, type Weights } from './features'
import {
  cleanPrices,
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
const BASE_FETCH = 20
const SIDE_FETCH = 10
/** Peso minimo di una stat della classe per entrare nel gruppo not. */
const NOT_MIN_WEIGHT = 0.4
/** Stat massime nel gruppo not. */
const NOT_MAX_STATS = 10
/**
 * Tipo di vendita: solo inserzioni con prezzo. Opzione presente in GET /api/trade2/data/filters
 * (2026-11-12) ma non ancora provata in una ricerca reale: se il trade la rifiuta, togliere qui.
 */
const SALE_TYPE = 'priced_with_info'

/**
 * Stat di danno locali delle armi (data/en/stats.ndjson, id interni `local_*`): nelle armi
 * d'attacco il loro effetto è già nel DPS, quindi la query usa `pdps`/`edps` al posto loro.
 */
export const LOCAL_DAMAGE_STATS: readonly string[] = [
  'explicit.stat_1509134228', // #% increased Physical Damage (local_physical_damage_+%)
  'explicit.stat_1940865751', // Adds # to # Physical Damage (local_minimum_added_physical_damage)
  'explicit.stat_709508406', // Adds # to # Fire Damage (local_minimum_added_fire_damage)
  'explicit.stat_1037193709', // Adds # to # Cold Damage (local_minimum_added_cold_damage)
  'explicit.stat_3336890334', // Adds # to # Lightning Damage (local_minimum_added_lightning_damage)
  'explicit.stat_210067635' // #% increased Attack Speed (local_attack_speed_+%)
]
const LOCAL_DAMAGE = new Set(LOCAL_DAMAGE_STATS)

/** Armi senza danno d'attacco (incantatori): nessun filtro DPS. */
const CASTER_WEAPONS = new Set(['weapon.wand', 'weapon.staff', 'weapon.sceptre'])

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

/** Categorie `weapon.*` con danno d'attacco (tutte tranne bacchette, bastoni e scettri). */
export function isAttackWeapon(itemClass: string): boolean {
  return itemClass.startsWith('weapon.') && !CASTER_WEAPONS.has(itemClass)
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
  maxOpenPrefixes?: number
  maxOpenSuffixes?: number
  /** La classe ha una tabella pesi (senza: niente gruppo not, confidenza al massimo media). */
  hasWeights: boolean
}

/**
 * Query alla pari: i mod utili dell'oggetto, nessuna stat di valore che l'oggetto non ha (not),
 * gli stessi slot pieni e, per le armi d'attacco, il DPS al posto dei mod di danno locali.
 */
export function parityPlan(item: RareItem): ParityPlan {
  const weights = weightsFor(item.itemClass)
  const dpsActive = isAttackWeapon(item.itemClass) && item.weapon !== undefined
  const coveredByDps = (statId: string): boolean => dpsActive && LOCAL_DAMAGE.has(statId)

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
  if (dpsActive && item.weapon) plan.dps = { pdps: item.weapon.pdps, edps: item.weapon.edps }
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
    collapse: true,
    saleType: SALE_TYPE
  }
  if (plan.dps) {
    opts.dps = {
      pdps: Math.floor(plan.dps.pdps * dpsFactor),
      edps: Math.floor(plan.dps.edps * dpsFactor)
    }
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
 * 25° percentile dei primi 10 prezzi (i più economici: le ricerche sono per prezzo crescente)
 * dopo la pulizia; null se ne restano meno di 3. Stesso campione per base e ricerche secondarie.
 */
function sampleP25(prices: number[]): number | null {
  const clean = cleanPrices([...prices].sort((a, b) => a - b).slice(0, SIDE_FETCH))
  return clean.length >= MIN_PARITY_PRICES ? percentile(clean, 0.25) : null
}

/**
 * Analisi approfondita con il confronto "alla pari" (R31, priorità user):
 * 1. ricerca base (parityPlan): mod utili ×0.8, DPS ×0.85, gruppo not, slot pieni, indexed,
 *    collapse; se total < 5: mod e DPS a ×0.6, poi via il mod di peso minore finché ne resta
 *    uno (il gruppo not e i vincoli sugli slot restano sempre);
 * 2. fetch dei primi 20 risultati, salvati nello store; prezzo al 25° percentile, verdetto dal
 *    prezzo (parityPriceFor); con meno di 3 prezzi nessun verdetto (R26);
 * 3. contributo di ogni mod della query finale: p25(base) - p25(senza il mod e con la sua stat
 *    nel not), sui primi 10 prezzi; nascosto se una delle due ha meno di 3 prezzi;
 * 4. se il lato del mod più debole non ha slot liberi, confronto con oggetti alla pari con uno
 *    slot libero su quel lato.
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

  /** Recupera i primi `n` risultati, li salva e restituisce i prezzi in exalted. */
  const fetchPrices = async (r: SearchResult, n: number): Promise<number[]> => {
    if (r.total === 0 || r.result.length === 0) return []
    const raw = await client.fetchListings(r.result.slice(0, n), r.id, 'user', signal)
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
  if (priced.verdict === null) {
    // meno di 3 prezzi: nessun verdetto, solo la spiegazione
    result.warnings = [priced.comparablesCount === 0 ? DEEP_NO_DATA_MESSAGE : DEEP_FEW_DATA_MESSAGE]
    return result
  }

  const baseP25 = sampleP25(basePrices)
  const contributions: NonNullable<Valuation['contributions']> = []
  if (baseP25 !== null) {
    // 3. contributi: oggetti alla pari senza quell'affisso
    for (const m of queryMods) {
      if (!budgetLeft()) break
      const r = await search({
        ...current(),
        mods: queryMods.filter((x) => x !== m),
        extraExclude: [m.statId]
      })
      const p25 = sampleP25(await fetchPrices(r, SIDE_FETCH))
      if (p25 === null) continue
      const delta = baseP25 - p25
      contributions.push({
        statId: m.statId,
        text: m.text,
        deltaExalted: Math.sign(delta) * roundPrice(Math.abs(delta)) || 0
      })
    }

    // 4. slot occupati: la stima resta sugli oggetti alla pari (stessi slot pieni)
    const weakest = sortModsByWeight(item.explicits, weightsFor(item.itemClass) ?? {}).at(-1)
    const side = weakest?.type === 'prefix' || weakest?.type === 'suffix' ? weakest.type : null
    const sideFull = side === 'prefix' ? item.openPrefixes === 0 : item.openSuffixes === 0
    if (side && sideFull && budgetLeft()) {
      const r = await search({ ...current(), openSlotSide: side })
      const openP25 = sampleP25(await fetchPrices(r, SIDE_FETCH))
      if (openP25 !== null && openP25 > baseP25) result.warnings.push(openSlotsWarning(openP25))
    }
  }
  result.searches = searches

  if (modsRemoved) {
    // stima su una parte degli affissi: non è la stima dell'oggetto intero (I3)
    result.warnings.push(partialModsWarning(queryMods.length, plan.mods.length))
  }
  if (contributions.length > 0) result.contributions = contributions
  return result
}
