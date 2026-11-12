import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { initParserData } from '../../src/core/parser/parse-item'
import {
  buildQuery,
  EMPTY_PREFIX_STAT_ID,
  EMPTY_SUFFIX_STAT_ID,
  indexedOptionFor
} from '../../src/core/trade/query-builder'
import type { ItemMod, RareItem } from '../../src/core/types'

function mod(partial: Partial<ItemMod> & { statId: string; tradeValue: number }): ItemMod {
  return { text: 'x', values: [partial.tradeValue], type: 'prefix', ...partial }
}

const vita = mod({ statId: 'explicit.stat_3299347043', tradeValue: 84 })

const boots: RareItem = {
  raw: '',
  itemClass: 'armour.boots',
  baseType: 'Threaded Shoes',
  name: 'Rune Road',
  itemLevel: 35,
  quality: 0,
  corrupted: false,
  explicits: [vita],
  implicits: [],
  openPrefixes: 2,
  openSuffixes: 1
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = any

beforeAll(async () => {
  await initParserData(join(__dirname, '../../data/en'))
})

describe('buildQuery', () => {
  it('stat con più id explicit (attack speed locale/globale): gruppo count con tutte le varianti', () => {
    const as = mod({ statId: 'explicit.stat_210067635', tradeValue: 10 })
    const q = buildQuery(boots, { mods: [vita, as], valueFactor: 0.8 }) as Q
    expect(q.query.stats).toHaveLength(2)
    expect(q.query.stats[0]).toEqual({
      type: 'and',
      filters: [{ id: vita.statId, value: { min: 67 } }]
    })
    expect(q.query.stats[1]).toEqual({
      type: 'count',
      value: { min: 1 },
      filters: [
        { id: 'explicit.stat_210067635', value: { min: 8 } },
        { id: 'explicit.stat_681332047', value: { min: 8 } }
      ]
    })
  })

  it('gruppo count anche per valori negativi (stesso tetto max per ogni variante)', () => {
    const as = mod({ statId: 'explicit.stat_210067635', tradeValue: -10 })
    const q = buildQuery(boots, { mods: [as], valueFactor: 0.8 }) as Q
    expect(q.query.stats[0]).toEqual({ type: 'and', filters: [] })
    expect(q.query.stats[1].filters.map((f: Q) => f.value)).toEqual([{ max: -8 }, { max: -8 }])
  })

  it('produce categoria, status, gruppo and con min scalato e sort per prezzo', () => {
    const q = buildQuery(boots, { mods: [vita], valueFactor: 0.8 }) as Q
    expect(q.query.filters.type_filters.filters.category.option).toBe('armour.boots')
    expect(q.query.status.option).toBe('online')
    expect(q.query.stats).toHaveLength(1)
    expect(q.query.stats[0].type).toBe('and')
    expect(q.query.stats[0].filters).toEqual([
      { id: vita.statId, value: { min: Math.floor(84 * 0.8) } }
    ])
    expect(q.sort).toEqual({ price: 'asc' })
  })

  it("sort 'indexed': inserzioni più recenti prima; 'price' esplicito come il default", () => {
    const recent = buildQuery(boots, { mods: [vita], valueFactor: 1, sort: 'indexed' }) as Q
    expect(recent.sort).toEqual({ indexed: 'desc' })
    const byPrice = buildQuery(boots, { mods: [vita], valueFactor: 1, sort: 'price' }) as Q
    expect(byPrice.sort).toEqual({ price: 'asc' })
  })

  it('con tradeValue negativo usa max (arrotondato verso zero) invece di min', () => {
    const neg = mod({ statId: 'explicit.stat_1', tradeValue: -52 })
    const q = buildQuery(boots, { mods: [neg], valueFactor: 0.8 }) as Q
    // -52 * 0.8 = -41.6 -> ceil = -41 (meno restrittivo di -52)
    expect(q.query.stats[0].filters).toEqual([{ id: 'explicit.stat_1', value: { max: -41 } }])
  })

  it('usa tradeValue (media) e non values[0] per le stat multi-valore', () => {
    const dmg = mod({ statId: 'explicit.stat_2', tradeValue: 30, values: [21, 39] })
    const q = buildQuery(boots, { mods: [dmg], valueFactor: 1 }) as Q
    expect(q.query.stats[0].filters[0].value).toEqual({ min: 30 })
  })

  it('senza opzioni slot non aggiunge filtri pseudo', () => {
    const q = buildQuery(boots, { mods: [vita], valueFactor: 1 }) as Q
    expect(JSON.stringify(q)).not.toContain('pseudo.')
  })

  it('con minOpenPrefixes/minOpenSuffixes aggiunge i filtri pseudo sugli slot liberi', () => {
    const q = buildQuery(boots, {
      mods: [vita],
      valueFactor: 1,
      minOpenPrefixes: 1,
      minOpenSuffixes: 2
    }) as Q
    expect(EMPTY_PREFIX_STAT_ID).toBe('pseudo.pseudo_number_of_empty_prefix_mods')
    expect(EMPTY_SUFFIX_STAT_ID).toBe('pseudo.pseudo_number_of_empty_suffix_mods')
    const filters = q.query.stats[0].filters
    expect(filters).toContainEqual({ id: EMPTY_PREFIX_STAT_ID, value: { min: 1 } })
    expect(filters).toContainEqual({ id: EMPTY_SUFFIX_STAT_ID, value: { min: 2 } })
  })

  it('tradeValue 0: nessun limite minimo sul valore', () => {
    const q = buildQuery(boots, {
      mods: [mod({ statId: 'explicit.stat_1', tradeValue: 0 })],
      valueFactor: 1
    }) as Q
    expect(q.query.stats[0].filters).toEqual([{ id: 'explicit.stat_1', value: {} }])
  })
})

describe('buildQuery: opzioni del confronto alla pari', () => {
  it('exclude: gruppo not con tutte le varianti di ogni stat, senza valori', () => {
    const q = buildQuery(boots, {
      mods: [vita],
      valueFactor: 0.8,
      exclude: ['explicit.stat_2250533757', 'explicit.stat_210067635']
    }) as Q
    expect(q.query.stats[q.query.stats.length - 1]).toEqual({
      type: 'not',
      filters: [
        { id: 'explicit.stat_2250533757' },
        { id: 'explicit.stat_210067635' },
        { id: 'explicit.stat_681332047' }
      ]
    })
  })

  it('exclude vuoto: nessun gruppo not', () => {
    const q = buildQuery(boots, { mods: [vita], valueFactor: 0.8, exclude: [] }) as Q
    expect(q.query.stats.some((g: Q) => g.type === 'not')).toBe(false)
  })

  it('maxOpenPrefixes/maxOpenSuffixes: filtri pseudo con max', () => {
    const q = buildQuery(boots, {
      mods: [vita],
      valueFactor: 1,
      maxOpenPrefixes: 0,
      maxOpenSuffixes: 0
    }) as Q
    const filters = q.query.stats[0].filters
    expect(filters).toContainEqual({ id: EMPTY_PREFIX_STAT_ID, value: { max: 0 } })
    expect(filters).toContainEqual({ id: EMPTY_SUFFIX_STAT_ID, value: { max: 0 } })
  })

  it('dps: equipment_filters con pdps/edps min; i valori 0 o assenti non producono filtri', () => {
    const q = buildQuery(boots, { mods: [], valueFactor: 1, dps: { pdps: 100, edps: 75 } }) as Q
    expect(q.query.filters.equipment_filters).toEqual({
      filters: { pdps: { min: 100 }, edps: { min: 75 } }
    })
    const onlyPhys = buildQuery(boots, {
      mods: [],
      valueFactor: 1,
      dps: { pdps: 100, edps: 0 }
    }) as Q
    expect(onlyPhys.query.filters.equipment_filters).toEqual({ filters: { pdps: { min: 100 } } })
    const none = buildQuery(boots, { mods: [], valueFactor: 1, dps: { pdps: 0, edps: 0 } }) as Q
    expect(none.query.filters.equipment_filters).toBeUndefined()
  })

  it('indexed, collapse e saleType: trade_filters', () => {
    const q = buildQuery(boots, {
      mods: [vita],
      valueFactor: 1,
      indexed: '1week',
      collapse: true,
      saleType: 'priced_with_info'
    }) as Q
    expect(q.query.filters.trade_filters).toEqual({
      filters: {
        indexed: { option: '1week' },
        collapse: { option: 'true' },
        sale_type: { option: 'priced_with_info' }
      }
    })
  })

  it('senza le nuove opzioni la query resta quella di prima (raccolta in background)', () => {
    const q = buildQuery(boots, { mods: [vita], valueFactor: 1, sort: 'indexed' })
    expect(q).toEqual({
      query: {
        status: { option: 'online' },
        stats: [{ type: 'and', filters: [{ id: vita.statId, value: { min: 84 } }] }],
        filters: {
          type_filters: {
            filters: { category: { option: 'armour.boots' }, rarity: { option: 'rare' } }
          }
        }
      },
      sort: { indexed: 'desc' }
    })
  })
})

describe('indexedOptionFor', () => {
  it("sceglie l'opzione più vicina per eccesso", () => {
    const cases: [number, string][] = [
      [0, '1day'],
      [1, '1day'],
      [2, '3days'],
      [3, '3days'],
      [4, '1week'],
      [7, '1week'],
      [8, '2weeks'],
      [14, '2weeks'],
      [15, '1month'],
      [30, '1month'],
      [31, '2months'],
      [365, '2months']
    ]
    for (const [days, option] of cases) expect(indexedOptionFor(days)).toBe(option)
  })
})
