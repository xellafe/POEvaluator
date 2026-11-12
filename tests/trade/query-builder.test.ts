import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { initParserData } from '../../src/core/parser/parse-item'
import {
  buildQuery,
  EMPTY_PREFIX_STAT_ID,
  EMPTY_SUFFIX_STAT_ID
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
