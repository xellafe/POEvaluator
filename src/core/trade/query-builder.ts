import { statAlternatives } from '../parser/parse-item'
import type { ItemMod, RareItem } from '../types'

/** Stat pseudo del trade: numero di prefix/suffix vuoti (da data/en/stats.ndjson, "# Empty Prefix/Suffix Modifiers"). */
export const EMPTY_PREFIX_STAT_ID = 'pseudo.pseudo_number_of_empty_prefix_mods'
export const EMPTY_SUFFIX_STAT_ID = 'pseudo.pseudo_number_of_empty_suffix_mods'

export interface QueryOptions {
  mods: ItemMod[]
  /** fattore applicato al valore del mod per rilassare il filtro (es. 0.8 = 80%) */
  valueFactor: number
  minOpenPrefixes?: number
  minOpenSuffixes?: number
  /**
   * Ordinamento dei risultati: 'price' (default) dal più economico, 'indexed' dalle inserzioni
   * più recenti (raccolta in background: dati nuovi a ogni giro, non sempre gli stessi).
   */
  sort?: 'price' | 'indexed'
  /**
   * Stat da escludere: gruppo `not` (scarta le inserzioni che hanno almeno una di queste stat).
   * Ogni stat è espansa con tutte le sue varianti explicit; i filtri non hanno valore.
   */
  exclude?: string[]
  /** Numero massimo di prefix/suffix vuoti (es. 0: l'oggetto ha gli slot pieni). */
  /** Solo 0 è supportato: "nessuno slot vuoto" (pseudo nel gruppo `not`). */
  maxOpenPrefixes?: 0
  maxOpenSuffixes?: 0
  /** DPS minimi (equipment_filters `pdps`/`edps`); i valori <= 0 non producono filtri. */
  dps?: { pdps?: number; edps?: number }
  /** Età massima delle inserzioni (trade_filters `indexed`). */
  indexed?: IndexedOption
  /** Una sola inserzione per account (trade_filters `collapse`). */
  collapse?: boolean
}

/** Opzioni del filtro `indexed` del trade2 (GET /api/trade2/data/filters). */
export type IndexedOption = '1day' | '3days' | '1week' | '2weeks' | '1month' | '2months'

const INDEXED_STEPS: [maxDays: number, option: IndexedOption][] = [
  [1, '1day'],
  [3, '3days'],
  [7, '1week'],
  [14, '2weeks'],
  [30, '1month']
]

/** Opzione `indexed` più vicina per eccesso a `days` (oltre 30 giorni: '2months'). */
export function indexedOptionFor(days: number): IndexedOption {
  return INDEXED_STEPS.find(([max]) => days <= max)?.[1] ?? '2months'
}

interface StatFilter {
  id: string
  value: { min?: number; max?: number }
}

interface NotGroup {
  type: 'not'
  filters: { id: string }[]
}

/**
 * Filtro di un mod: per valori positivi `min = floor(tradeValue * factor)`; per valori negativi
 * (stat "reduced") il filtro rilassato è un tetto, quindi `max = ceil(tradeValue * factor)`
 * (es. -52 con 0.8 -> max -41, cioè meno restrittivo di -52).
 */
function modFilter(mod: ItemMod, valueFactor: number): StatFilter {
  // tradeValue 0: nessun limite sul valore (es. semi della raccolta senza dati locali)
  if (mod.tradeValue === 0) return { id: mod.statId, value: {} }
  const scaled = mod.tradeValue * valueFactor
  return mod.tradeValue < 0
    ? { id: mod.statId, value: { max: Math.ceil(scaled) } }
    : { id: mod.statId, value: { min: Math.floor(scaled) } }
}

interface CountGroup {
  type: 'count'
  value: { min: number }
  filters: StatFilter[]
}

/**
 * Le stat con più id explicit (es. attack speed locale/globale) vanno cercate con tutte le
 * varianti: un gruppo "count" (almeno 1) per mod, con lo stesso limite per ogni id.
 * Le altre stanno nel gruppo "and". Senza `initParserData` ogni stat ha un solo id.
 * Le opzioni del confronto alla pari (exclude, slot pieni, dps, indexed, collapse)
 * sono facoltative: senza di esse la query è quella usata dalla raccolta in background.
 */
export function buildQuery(item: RareItem, opts: QueryOptions): object {
  const filters: StatFilter[] = []
  const countGroups: CountGroup[] = []
  for (const m of opts.mods) {
    const f = modFilter(m, opts.valueFactor)
    const alternatives = statAlternatives(m.statId)
    if (alternatives.length > 1) {
      countGroups.push({
        type: 'count',
        value: { min: 1 },
        filters: alternatives.map((id) => ({ id, value: f.value }))
      })
    } else {
      filters.push(f)
    }
  }
  if (opts.minOpenPrefixes && opts.minOpenPrefixes > 0) {
    filters.push({ id: EMPTY_PREFIX_STAT_ID, value: { min: opts.minOpenPrefixes } })
  }
  if (opts.minOpenSuffixes && opts.minOpenSuffixes > 0) {
    filters.push({ id: EMPTY_SUFFIX_STAT_ID, value: { min: opts.minOpenSuffixes } })
  }
  // Slot pieni: il trade non indicizza la pseudo "slot vuoti" quando vale 0, quindi `max: 0`
  // non trova nulla (verificato su trade2 il 2026-11-12). "Nessuno slot vuoto" = pseudo nel `not`.
  const notFilters: { id: string }[] = []
  if (opts.maxOpenPrefixes === 0) notFilters.push({ id: EMPTY_PREFIX_STAT_ID })
  if (opts.maxOpenSuffixes === 0) notFilters.push({ id: EMPTY_SUFFIX_STAT_ID })
  for (const id of opts.exclude ?? []) {
    for (const alt of statAlternatives(id)) notFilters.push({ id: alt })
  }
  const notGroups: NotGroup[] = notFilters.length > 0 ? [{ type: 'not', filters: notFilters }] : []

  const queryFilters: Record<string, unknown> = {
    type_filters: {
      filters: {
        category: { option: item.itemClass },
        rarity: { option: 'rare' }
      }
    }
  }
  const equipment: Record<string, { min: number }> = {}
  if (opts.dps?.pdps && opts.dps.pdps > 0) equipment.pdps = { min: opts.dps.pdps }
  if (opts.dps?.edps && opts.dps.edps > 0) equipment.edps = { min: opts.dps.edps }
  if (Object.keys(equipment).length > 0) queryFilters.equipment_filters = { filters: equipment }
  const trade: Record<string, { option: string }> = {}
  if (opts.indexed) trade.indexed = { option: opts.indexed }
  if (opts.collapse) trade.collapse = { option: 'true' }
  if (Object.keys(trade).length > 0) queryFilters.trade_filters = { filters: trade }

  return {
    query: {
      status: { option: 'online' },
      stats: [{ type: 'and', filters }, ...countGroups, ...notGroups],
      filters: queryFilters
    },
    sort: opts.sort === 'indexed' ? { indexed: 'desc' } : { price: 'asc' }
  }
}
