import type { ListingStore } from '../db/listing-store'
import type { Settings } from '../settings'
import { buildQuery, indexedOptionFor, type QueryOptions } from '../trade/query-builder'
import { abortError, tradeUrl, type SearchResult, type TradeClient } from '../trade/trade-client'
import { toListing } from '../trade/listing-mapper'
import type { ItemMod, Listing, RareItem, Valuation } from '../types'
import { modScore, modWeight, weightsFor, type Weights } from './weights'
import { dpsCoverage, DPS_EPSILON, isAttackWeapon, modStatuses } from './mod-status'

export { isAttackWeapon, LOCAL_DAMAGE_STATS } from './mod-status'
import {
  cleanParityPrices,
  MIN_PARITY_PRICES,
  parityP10,
  parityPriceFor,
  roundPrice,
  sampleForChart
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

/** Prezzi scaricati per la ricerca del tetto (R38). */
export const CEILING_FETCH = 10
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

/** Sotto questo numero di prezzi puliti la stima è incerta (= soglia della confidenza media). */
export const UNCERTAIN_MAX_PRICES = 6

export const fewPricesReason = (n: number): string => `solo ${n} oggetti simili in vendita`

export const fewModsReason = (used: number, total: number): string =>
  `confronto su ${used} ${used === 1 ? 'affisso' : 'affissi'} su ${total}`

export const openSlotsWarning = (priceExalted: number): string =>
  `Gli oggetti simili con uno slot libero si vendono intorno a ${roundPrice(priceExalted)} ex`

/**
 * Mod espliciti per punteggio decrescente (`modScore`: peso corretto dalla qualità del tier, R39);
 * a parità il tier migliore (numero più basso) prima, i mod senza tier in fondo. Ogni ItemMod è
 * indipendente.
 */
export function sortModsByWeight(mods: ItemMod[], weights: Weights): ItemMod[] {
  const tier = (m: ItemMod): number => m.tier ?? Number.POSITIVE_INFINITY
  return [...mods].sort((a, b) => modScore(b, weights) - modScore(a, weights) || tier(a) - tier(b))
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
        candidates.filter((m) => modWeight(m, weights) > 0),
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
  /** Senza gruppo not: oggetti con gli stessi affissi e altri in più (ricerca del tetto, R38). */
  noExclude?: boolean
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
    exclude: step.noExclude ? [] : [...plan.exclude, ...(step.extraExclude ?? [])],
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
  return clean.length >= MIN_PARITY_PRICES ? parityP10(clean) : null
}

/**
 * Ricerche e fetch dell'analisi approfondita con budget, avanzamento e annullamento comuni:
 * ogni chiamata a `search` conta nel budget e chiama `onProgress(fatte, total)`; i fetch
 * salvano le inserzioni nello store.
 */
function tradeSession(
  item: RareItem,
  plan: ParityPlan,
  deps: DeepDeps,
  total: number,
  onProgress?: (done: number, total: number) => void
): {
  search: (step: ParityStep) => Promise<SearchResult>
  fetchPrices: (r: SearchResult, n: number) => Promise<number[]>
  checkAborted: () => void
  count: () => number
} {
  const { client, store, settings, signal } = deps
  const league = settings.league
  const now = deps.now()
  let searches = 0
  const checkAborted = (): void => {
    if (signal?.aborted) throw abortError()
  }
  const search = async (step: ParityStep): Promise<SearchResult> => {
    const r = await client.search(league, parityQuery(item, plan, settings, step), 'user', signal)
    checkAborted()
    searches++
    onProgress?.(searches, total)
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
  return { search, fetchPrices, checkAborted, count: () => searches }
}

const budgetOf = (deps: DeepDeps): number => Math.max(1, deps.maxSearches ?? DEFAULT_MAX_SEARCHES)

/**
 * Controllo degli slot occupati (R31): il mod più debole dell'oggetto e il suo lato, se quel lato
 * non ha slot liberi; null se il controllo non si applica.
 */
function openSlotCheck(item: RareItem): { weakest: ItemMod; side: 'prefix' | 'suffix' } | null {
  const weakest = sortModsByWeight(item.explicits, weightsFor(item.itemClass) ?? {}).at(-1)
  const side = weakest?.type === 'prefix' || weakest?.type === 'suffix' ? weakest.type : null
  if (!weakest || !side) return null
  const sideFull = side === 'prefix' ? item.openPrefixes === 0 : item.openSuffixes === 0
  return sideFull ? { weakest, side } : null
}

/** Ricerche dei contributi: una per mod della query, più il controllo slot, entro il budget. */
const plannedContributionSearches = (item: RareItem, modCount: number, budget: number): number =>
  Math.min(budget, modCount + (openSlotCheck(item) ? 1 : 0))

/**
 * Analisi approfondita con il confronto "alla pari" (R31, priorità user):
 * 1. ricerca base (parityPlan): mod utili ×0.8, DPS ×0.85, gruppo not, slot pieni, indexed,
 *    collapse; se total < 5: mod e DPS a ×0.6, poi via il mod di peso minore finché ne resta
 *    uno (il gruppo not e i vincoli sugli slot restano sempre);
 * 2. fetch di 20 risultati equidistanti fra i primi 60 (spreadSample), salvati nello store;
 *    prezzo consigliato al 10° percentile del campione (R32), verdetto dal prezzo
 *    (parityPriceFor); con meno di 3 prezzi nessun verdetto (R26).
 * I contributi degli affissi e il controllo degli slot liberi non partono qui (R37): con un
 * verdetto e almeno un affisso usato il risultato porta `basis` e `contributions: 'available'`,
 * e `deepContributions` li calcola su richiesta.
 * Ogni ricerca conta nel budget `maxSearches`; gli errori del client vengono propagati (le
 * inserzioni già recuperate restano salvate). Con `deps.signal` annullato rigetta con AbortError
 * al passo successivo, senza altri `onProgress`.
 */
export async function deepAnalysis(
  item: RareItem,
  deps: DeepDeps,
  onProgress?: (done: number, total: number) => void
): Promise<Valuation> {
  const { settings } = deps
  const maxSearches = budgetOf(deps)
  const plan = parityPlan(item)
  const { search, fetchPrices, checkAborted, count } = tradeSession(
    item,
    plan,
    deps,
    maxSearches,
    onProgress
  )
  checkAborted()
  const budgetLeft = (): boolean => count() < maxSearches

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
    tradeUrl: tradeUrl(settings.league, base.id),
    searches: count()
  }
  // stato degli affissi (R34): quelli tolti dal rilassamento sono "relaxed"
  const kept = new Set(queryMods.map((m) => m.statId))
  const removed = new Set(plan.mods.filter((m) => !kept.has(m.statId)).map((m) => m.statId))
  result.mods = modStatuses(item, removed)
  if (priced.verdict === null) {
    // meno di 3 prezzi: nessun verdetto, solo la spiegazione
    result.warnings = [priced.comparablesCount === 0 ? DEEP_NO_DATA_MESSAGE : DEEP_FEW_DATA_MESSAGE]
    // tetto (R38): oggetti con tutti gli affissi dell'oggetto (valori ×0.6) e altri in più,
    // quindi di valore almeno pari; se non ce ne sono, con i soli affissi rimasti dopo il
    // rilassamento. Senza gruppo not (classe senza pesi) sarebbe la stessa ricerca: niente tetto.
    if (plan.exclude.length > 0) {
      const steps: ParityStep[] = [
        { mods: plan.mods, valueFactor: RELAXED_FACTOR, dpsFactor: RELAXED_FACTOR, noExclude: true }
      ]
      if (queryMods.length < plan.mods.length) {
        steps.push({ ...current(), noExclude: true })
      }
      for (const step of steps) {
        if (!budgetLeft()) break
        const r = await search(step)
        if (r.total === 0) continue
        const clean = cleanParityPrices(await fetchPrices(r, CEILING_FETCH)).sort((a, b) => a - b)
        if (clean.length === 0) continue
        result.ceiling = {
          exalted: roundPrice(parityP10(clean)),
          count: clean.length,
          sample: sampleForChart(clean),
          tradeUrl: tradeUrl(settings.league, r.id)
        }
        break
      }
      result.searches = count()
    }
    return result
  }

  // stima incerta: pochi prezzi o confronto su meno di metà degli affissi
  const uncertain: string[] = []
  if (priced.comparablesCount < UNCERTAIN_MAX_PRICES) {
    uncertain.push(fewPricesReason(priced.comparablesCount))
  }
  const fewMods = queryMods.length * 2 < plan.mods.length
  if (fewMods) uncertain.push(fewModsReason(queryMods.length, plan.mods.length))
  if (uncertain.length > 0) result.uncertain = uncertain
  if (modsRemoved && !fewMods) {
    // stima su una parte degli affissi: non è la stima dell'oggetto intero (I3); con meno di
    // metà degli affissi lo dice già la stima incerta
    result.warnings.push(partialModsWarning(queryMods.length, plan.mods.length))
  }

  // punto di ripresa per i contributi su richiesta (R37)
  const baseP10 = sampleP10(basePrices)
  if (baseP10 !== null && queryMods.length > 0) {
    result.basis = {
      queryMods: queryMods.map((m) => m.statId),
      valueFactor,
      dpsFactor,
      baseP10,
      plannedSearches: plannedContributionSearches(item, queryMods.length, maxSearches)
    }
    result.contributions = 'available'
  }
  return result
}

/**
 * Mod del piano corrispondenti agli statId della basis, nello stesso ordine (ogni statId prende
 * il primo mod non ancora usato). Errore se l'oggetto non è quello dell'analisi.
 */
function resolveQueryMods(planMods: ItemMod[], statIds: string[]): ItemMod[] {
  const used = new Set<ItemMod>()
  return statIds.map((id) => {
    const m = planMods.find((x) => x.statId === id && !used.has(x))
    if (!m) throw new Error(`deepContributions: mod ${id} assente dal piano dell'oggetto`)
    used.add(m)
    return m
  })
}

/**
 * Contributi degli affissi su richiesta (R37): riprende l'analisi da `valuation.basis` senza
 * ripetere la ricerca base.
 * 3. contributo di ogni mod della query finale: p10(base) - p10(senza il mod e con la sua stat
 *    nel not), su campioni equidistanti di 10 prezzi; nascosto se la variante ha meno di 3 prezzi;
 * 4. se il lato del mod più debole non ha slot liberi, confronto con oggetti alla pari che hanno
 *    uno slot libero su quel lato al posto di quel mod (avviso se valgono di più).
 * Budget `maxSearches` separato da quello della base (priorità 3 > 4); `onProgress(fatte,
 * previste)`. Restituisce una nuova Valuation (`searches` = base + contributi, `contributions:
 * 'done'`, senza `basis`); stessi errori, annullamento e salvataggio di `deepAnalysis`.
 */
export async function deepContributions(
  item: RareItem,
  valuation: Valuation,
  deps: DeepDeps,
  onProgress?: (done: number, total: number) => void
): Promise<Valuation> {
  const basis = valuation.basis
  if (!basis) throw new Error('deepContributions: valutazione senza basis')
  const maxSearches = budgetOf(deps)
  const plan = parityPlan(item)
  const queryMods = resolveQueryMods(plan.mods, basis.queryMods)
  const { search, fetchPrices, checkAborted, count } = tradeSession(
    item,
    plan,
    deps,
    plannedContributionSearches(item, queryMods.length, maxSearches),
    onProgress
  )
  checkAborted()
  const budgetLeft = (): boolean => count() < maxSearches
  const current = (): ParityStep => ({
    mods: queryMods,
    valueFactor: basis.valueFactor,
    dpsFactor: basis.dpsFactor
  })
  const warnings = [...valuation.warnings]

  // 3. contributi: oggetti alla pari senza quell'affisso
  const deltas = new Map<string, number>()
  for (const m of queryMods) {
    if (!budgetLeft()) break
    const r = await search({
      ...current(),
      mods: queryMods.filter((x) => x !== m),
      extraExclude: [m.statId]
    })
    const p10 = sampleP10(await fetchPrices(r, SIDE_FETCH))
    if (p10 === null) continue
    const delta = basis.baseP10 - p10
    deltas.set(m.statId, Math.sign(delta) * roundPrice(Math.abs(delta)) || 0)
  }

  // 4. slot occupati: la stima resta sugli oggetti alla pari (stessi slot pieni)
  const slot = openSlotCheck(item)
  if (slot && budgetLeft()) {
    // il mod più debole esce dai mod (non va nel not): oggetti alla pari con uno slot libero al
    // suo posto; tenerlo renderebbe la ricerca impossibile se il lato è tutto nella query
    const r = await search({
      ...current(),
      mods: queryMods.filter((m) => m !== slot.weakest),
      openSlotSide: slot.side
    })
    const openP10 = sampleP10(await fetchPrices(r, SIDE_FETCH))
    if (openP10 !== null && openP10 > basis.baseP10) warnings.push(openSlotsWarning(openP10))
  }

  const result: Valuation = {
    ...valuation,
    warnings,
    searches: (valuation.searches ?? 0) + count(),
    contributions: 'done',
    mods: valuation.mods?.map((m) => {
      const d = deltas.get(m.statId)
      return d !== undefined && m.status === 'used' ? { ...m, deltaExalted: d } : { ...m }
    })
  }
  delete result.basis
  return result
}
