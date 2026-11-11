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
  const scaled = mod.tradeValue * valueFactor
  return mod.tradeValue < 0
    ? { id: mod.statId, value: { max: Math.ceil(scaled) } }
    : { id: mod.statId, value: { min: Math.floor(scaled) } }
}

export function buildQuery(item: RareItem, opts: QueryOptions): object {
  const filters: StatFilter[] = opts.mods.map((m) => modFilter(m, opts.valueFactor))
  if (opts.minOpenPrefixes && opts.minOpenPrefixes > 0) {
    filters.push({ id: EMPTY_PREFIX_STAT_ID, value: { min: opts.minOpenPrefixes } })
  }
  if (opts.minOpenSuffixes && opts.minOpenSuffixes > 0) {
    filters.push({ id: EMPTY_SUFFIX_STAT_ID, value: { min: opts.minOpenSuffixes } })
  }
  return {
    query: {
      status: { option: 'online' },
      stats: [{ type: 'and', filters }],
      filters: {
        type_filters: {
          filters: {
            category: { option: item.itemClass },
            rarity: { option: 'rare' }
          }
        }
      }
    },
    sort: { price: 'asc' }
  }
}
