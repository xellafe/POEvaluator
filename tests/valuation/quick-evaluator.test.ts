import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ListingStore } from '../../src/core/db/listing-store'
import { DEFAULT_SETTINGS } from '../../src/core/settings'
import type { ItemMod, Listing, RareItem } from '../../src/core/types'
import { DEFAULT_WEIGHTS, featureVector, weightScore } from '../../src/core/valuation/features'
import { quickEvaluate } from '../../src/core/valuation/quick-evaluator'

const NOW = new Date('2026-11-12T12:00:00.000Z')
const LIFE = 'explicit.stat_3299347043'
const MOVE = 'explicit.stat_2250533757'
const FIRE_RES = 'explicit.stat_3372524247'
const MANA = 'explicit.stat_1050105434'
const INT = 'explicit.stat_328541901'

function mod(
  statId: string,
  tradeValue: number,
  max?: number,
  type: ItemMod['type'] = 'prefix'
): ItemMod {
  const m: ItemMod = { statId, text: statId, values: [tradeValue], tradeValue, type }
  if (max !== undefined) m.range = { min: Math.round(max * 0.8), max }
  return m
}

function boots(explicits: ItemMod[], over: Partial<RareItem> = {}): RareItem {
  return {
    raw: '',
    itemClass: 'armour.boots',
    baseType: 'Dunerunner Sandals',
    name: 'Test Stride',
    itemLevel: 80,
    quality: 0,
    corrupted: false,
    explicits,
    implicits: [],
    openPrefixes: 1,
    openSuffixes: 1,
    ...over
  }
}

function listing(i: number, life: number, over: Partial<Listing> = {}): Listing {
  return {
    id: `l${i}`,
    league: 'Standard',
    itemClass: 'armour.boots',
    baseType: 'Dunerunner Sandals',
    itemLevel: 80,
    mods: [
      { statId: LIFE, value: life },
      { statId: MOVE, value: 25 }
    ],
    openPrefixes: 1,
    openSuffixes: 1,
    priceAmount: life / 2,
    priceCurrency: 'exalted',
    priceExalted: life / 2,
    indexedAt: '2026-11-10T00:00:00.000Z',
    seenAt: '2026-11-12T00:00:00.000Z',
    ...over
  }
}

describe('default-weights.json', () => {
  const statIds = new Set(
    readFileSync(join(__dirname, '../../data/en/stats.ndjson'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((l) =>
        Object.values((JSON.parse(l).trade?.ids ?? {}) as Record<string, string[]>).flat()
      )
  )

  it('ignora le chiavi "_" e copre le classi principali', () => {
    expect(Object.keys(DEFAULT_WEIGHTS).some((k) => k.startsWith('_'))).toBe(false)
    for (const c of [
      'armour.boots',
      'armour.gloves',
      'armour.helmet',
      'armour.chest',
      'accessory.belt',
      'accessory.ring',
      'accessory.amulet',
      'armour.focus',
      'armour.quiver',
      'weapon.bow',
      'weapon.wand',
      'jewel'
    ]) {
      expect(DEFAULT_WEIGHTS[c], c).toBeDefined()
    }
  })

  it('pesi in 0..1, 5-10 stat per classe, id trade esistenti', () => {
    for (const [cls, w] of Object.entries(DEFAULT_WEIGHTS)) {
      const entries = Object.entries(w)
      expect(entries.length, cls).toBeGreaterThanOrEqual(5)
      expect(entries.length, cls).toBeLessThanOrEqual(10)
      for (const [id, v] of entries) {
        expect(statIds.has(id), `${cls} ${id}`).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('featureVector', () => {
  it('normalizza per scale, salta stat senza scala, aggiunge open e ilvl', () => {
    const f = featureVector(
      [
        { statId: LIFE, value: 50 },
        { statId: MOVE, value: 30 }
      ],
      1,
      2,
      82,
      { [LIFE]: 100, [MOVE]: 0 }
    )
    expect(f[LIFE]).toBeCloseTo(0.5)
    expect(f[MOVE]).toBeUndefined()
    expect(f.open).toBeCloseTo(0.5)
    expect(f.ilvl).toBeCloseTo(0.82)
  })

  it('open normalizzato con maxAffixes della classe (gioielli 2)', () => {
    const f = featureVector([], 1, 1, 80, {}, 2)
    expect(f.open).toBeCloseTo(0.5)
  })
})

describe('weightScore', () => {
  const w = { [LIFE]: 1, [MOVE]: 0.5, a: 0.5, b: 0.5, c: 0.5, d: 0.5, e: 0.1 }

  it('somma pesata / somma dei top 2·maxAffixes pesi, ignorando implicit', () => {
    const item = boots([mod(LIFE, 84, 84), mod(MOVE, 15)], {
      implicits: [mod(LIFE, 100, 100, 'implicit')]
    })
    // (1·1 + 0.5·0.5) / (1 + 0.5·5) = 1.25 / 3.5
    expect(weightScore(item, w)).toBeCloseTo(1.25 / 3.5)
  })

  it('valore negativo usa il modulo, clamp a 1', () => {
    expect(weightScore(boots([mod(LIFE, -200, 84)]), w)).toBeCloseTo(1 / 3.5)
  })

  it('classe senza pesi -> 0', () => {
    expect(weightScore(boots([mod(LIFE, 84, 84)]), {})).toBe(0)
  })
})

describe('quickEvaluate', () => {
  let store: ListingStore
  beforeEach(() => {
    store = new ListingStore(':memory:')
  })
  afterEach(() => store.close())

  it('store vuoto: fallback a pesi, boots vita+velocità alte -> almeno buono, bassa, nessun prezzo', () => {
    const item = boots([mod(MOVE, 30, 30), mod(LIFE, 84, 84), mod(FIRE_RES, 25, 25, 'suffix')])
    const v = quickEvaluate(item, store, DEFAULT_SETTINGS, NOW)
    expect(['buono', 'ottimo', 'eccellente']).toContain(v.verdict)
    expect(v.confidence).toBe('bassa')
    expect(v.price).toBeUndefined()
    expect(v.comparablesCount).toBe(0)
    expect(v.warnings).toContain(
      "Pochi oggetti simili raccolti: il verdetto è indicativo, usa l'analisi approfondita"
    )
  })

  it('boots con soli mod a peso 0 -> pessimo', () => {
    const item = boots([mod(MANA, 64, 64), mod(INT, 20, 20, 'suffix')])
    const v = quickEvaluate(item, store, DEFAULT_SETTINGS, NOW)
    expect(v.verdict).toBe('pessimo')
    expect(v.confidence).toBe('bassa')
  })

  it('classe senza pesi -> nessun verdetto (dati insufficienti) con il messaggio del quick', () => {
    const item = boots([mod(LIFE, 84, 84)], { itemClass: 'map.tablet' })
    const v = quickEvaluate(item, store, DEFAULT_SETTINGS, NOW)
    expect(v.verdict).toBeNull()
    expect(v.confidence).toBe('bassa')
    expect(v.price).toBeUndefined()
    expect(v.warnings).toEqual([
      "Non ho abbastanza oggetti simili per valutarlo: usa l'analisi approfondita"
    ])
  })

  it('jewel: ha pesi, nessun warning "senza pesi"', () => {
    const item = boots([mod('explicit.stat_587431675', 15, 15)], {
      itemClass: 'jewel',
      openPrefixes: 1,
      openSuffixes: 1
    })
    const v = quickEvaluate(item, store, DEFAULT_SETTINGS, NOW)
    expect(v.verdict).not.toBeNull()
    expect(v.warnings).toContain(
      "Pochi oggetti simili raccolti: il verdetto è indicativo, usa l'analisi approfondita"
    )
  })

  it('40 listing di boots: kNN, più vita -> prezzo suggerito più alto, confidenza non alta', () => {
    store.upsert(Array.from({ length: 40 }, (_, i) => listing(i, 40 + i * 2)))
    const high = quickEvaluate(
      boots([mod(LIFE, 118, 120), mod(MOVE, 25)]),
      store,
      DEFAULT_SETTINGS,
      NOW
    )
    const low = quickEvaluate(
      boots([mod(LIFE, 42, 50), mod(MOVE, 25)]),
      store,
      DEFAULT_SETTINGS,
      NOW
    )
    expect(high.price).toBeDefined()
    expect(low.price).toBeDefined()
    expect(high.price!.suggested).toBeGreaterThan(low.price!.suggested)
    expect(high.confidence).not.toBe('alta')
    expect(low.confidence).not.toBe('alta')
    expect(high.comparablesCount).toBe(10)
    expect(high.warnings).not.toContain(
      "Pochi oggetti simili raccolti: il verdetto è indicativo, usa l'analisi approfondita"
    )
  })

  it('≥ 30 listing ma meno di 10 nella finestra di età -> fallback', () => {
    store.upsert(
      Array.from({ length: 35 }, (_, i) =>
        listing(i, 40 + i * 2, i < 5 ? {} : { indexedAt: '2026-10-01T00:00:00.000Z' })
      )
    )
    const v = quickEvaluate(
      boots([mod(LIFE, 118, 120), mod(MOVE, 25)]),
      store,
      DEFAULT_SETTINGS,
      NOW
    )
    expect(v.price).toBeUndefined()
    expect(v.confidence).toBe('bassa')
  })
})
