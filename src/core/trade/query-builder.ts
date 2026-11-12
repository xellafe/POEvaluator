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
}

interface StatFilter {
  id: string
  value: { min?: number; max?: number }
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
  return {
    query: {
      status: { option: 'online' },
      stats: [{ type: 'and', filters }, ...countGroups],
      filters: {
        type_filters: {
          filters: {
            category: { option: item.itemClass },
            rarity: { option: 'rare' }
          }
        }
      }
    },
    sort: opts.sort === 'indexed' ? { indexed: 'desc' } : { price: 'asc' }
  }
}
