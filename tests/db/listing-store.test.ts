import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ListingStore } from '../../src/core/db/listing-store'
import type { Listing } from '../../src/core/types'
import type { CurrencyRates } from '../../src/core/pricing/currency'

const NOW = new Date('2026-11-12T12:00:00.000Z')

function listing(over: Partial<Listing> = {}): Listing {
  return {
    id: 'a',
    league: 'Standard',
    itemClass: 'armour.boots',
    baseType: 'Wayfarer Boots',
    itemLevel: 80,
    mods: [{ statId: 'explicit.stat_1', value: 30 }],
    openPrefixes: 1,
    openSuffixes: 0,
    priceAmount: 2,
    priceCurrency: 'exalted',
    priceExalted: 2,
    indexedAt: '2026-11-10T00:00:00.000Z',
    seenAt: '2026-11-12T00:00:00.000Z',
    ...over
  }
}

describe('ListingStore', () => {
  let store: ListingStore
  beforeEach(() => {
    store = new ListingStore(':memory:')
  })
  afterEach(() => store.close())

  it('upsert dello stesso id aggiorna prezzo e seenAt senza duplicare', () => {
    store.upsert([listing({ priceExalted: 2 })])
    store.upsert([listing({ priceExalted: 5, priceAmount: 5, seenAt: '2026-11-12T10:00:00.000Z' })])
    const res = store.comparables({
      league: 'Standard',
      itemClass: 'armour.boots',
      maxAgeDays: 30,
      now: NOW
    })
    expect(res).toHaveLength(1)
    expect(res[0].priceExalted).toBe(5)
    expect(res[0].seenAt).toBe('2026-11-12T10:00:00.000Z')
  })

  it('comparables esclude altre league, altre classi e inserzioni troppo vecchie', () => {
    store.upsert([
      listing({ id: 'ok' }),
      listing({ id: 'other-league', league: 'Hardcore' }),
      listing({ id: 'other-class', itemClass: 'armour.gloves' }),
      listing({ id: 'old', indexedAt: '2026-10-01T00:00:00.000Z' })
    ])
    const res = store.comparables({
      league: 'Standard',
      itemClass: 'armour.boots',
      maxAgeDays: 14,
      now: NOW
    })
    expect(res.map((l) => l.id)).toEqual(['ok'])
  })

  it('comparables ordina per prezzo crescente e ripristina i mod', () => {
    store.upsert([
      listing({ id: 'x', priceExalted: 9 }),
      listing({ id: 'y', priceExalted: 1, mods: [{ statId: 'explicit.stat_2', value: -4.5 }] })
    ])
    const res = store.comparables({
      league: 'Standard',
      itemClass: 'armour.boots',
      maxAgeDays: 30,
      now: NOW
    })
    expect(res.map((l) => l.id)).toEqual(['y', 'x'])
    expect(res[0].mods).toEqual([{ statId: 'explicit.stat_2', value: -4.5 }])
    expect(res[0]).toEqual(
      listing({ id: 'y', priceExalted: 1, mods: [{ statId: 'explicit.stat_2', value: -4.5 }] })
    )
  })

  it('countByClass conta per classe nella league', () => {
    store.upsert([
      listing({ id: '1' }),
      listing({ id: '2' }),
      listing({ id: '3', itemClass: 'armour.gloves' }),
      listing({ id: '4', league: 'Hardcore' })
    ])
    expect(store.countByClass('Standard')).toEqual({ 'armour.boots': 2, 'armour.gloves': 1 })
    expect(store.countByClass('Nessuna')).toEqual({})
  })

  it('upsert è atomico: un errore annulla l intero batch', () => {
    const bad = { ...listing({ id: 'bad' }), mods: undefined } as unknown as Listing
    expect(() => store.upsert([listing({ id: 'good' }), bad])).toThrow()
    expect(store.countByClass('Standard')).toEqual({})
  })

  it('saveRates tiene solo gli ultimi tassi per league; latestRates null se assenti', () => {
    expect(store.latestRates('Standard')).toBeNull()
    const r1: CurrencyRates = {
      league: 'Standard',
      fetchedAt: '2026-11-11T00:00:00.000Z',
      exaltedPer: { divine: 200, exalted: 1 }
    }
    const r2: CurrencyRates = {
      league: 'Standard',
      fetchedAt: '2026-11-12T00:00:00.000Z',
      exaltedPer: { divine: 250, exalted: 1 }
    }
    store.saveRates(r1)
    store.saveRates(r2)
    store.saveRates({ league: 'Hardcore', fetchedAt: r1.fetchedAt, exaltedPer: { exalted: 1 } })
    expect(store.latestRates('Standard')).toEqual(r2)
    expect(store.latestRates('Hardcore')?.exaltedPer).toEqual({ exalted: 1 })
  })

  it('listingsOfLeague restituisce tutte le classi della league, senza limite di età', () => {
    store.upsert([
      listing({ id: 'a', indexedAt: '2020-01-01T00:00:00.000Z' }),
      listing({ id: 'b', itemClass: 'armour.gloves' }),
      listing({ id: 'c', league: 'Hardcore' })
    ])
    const res = store.listingsOfLeague('Standard')
    expect(res.map((l) => l.id).sort()).toEqual(['a', 'b'])
    expect(res.find((l) => l.id === 'a')?.mods).toEqual([{ statId: 'explicit.stat_1', value: 30 }])
  })
})
