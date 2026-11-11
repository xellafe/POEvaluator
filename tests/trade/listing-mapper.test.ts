import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { toListing } from '../../src/core/trade/listing-mapper'

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/trade/fetch-response.json', import.meta.url), 'utf8')
) as { result: unknown[] }

const now = new Date('2026-11-12T10:00:00Z')
const toExalted = (amount: number, currency: string): number | null =>
  currency === 'exalted' ? amount : currency === 'divine' ? amount * 100 : null

describe('toListing', () => {
  it('mappa prezzo, data, base e livello', () => {
    const l = toListing(fixture.result[1], 'Standard', toExalted, now)!
    expect(l.id).toBe('5e86a23c7482c35aaf0454b68ad2f36cb2b97286f398c7a62af45ac49a918feb')
    expect(l.league).toBe('Standard')
    expect(l.itemClass).toBe('armour.boots')
    expect(l.baseType).toBe('Threaded Shoes')
    expect(l.itemLevel).toBe(35)
    expect(l.priceAmount).toBe(1)
    expect(l.priceCurrency).toBe('exalted')
    expect(l.priceExalted).toBe(1)
    expect(l.indexedAt).toBe('2024-12-27T00:25:18Z')
    expect(l.seenAt).toBe(now.toISOString())
  })

  it('mappa i mod con id e valore in unità trade (dal testo, non dal range del tier)', () => {
    const l = toListing(fixture.result[1], 'Standard', toExalted, now)!
    expect(l.mods).toContainEqual({ statId: 'explicit.stat_3299347043', value: 84 })
    expect(l.mods).toContainEqual({ statId: 'explicit.stat_3917489142', value: 8 })
    expect(l.mods.length).toBe(4)
  })

  it('conta gli slot liberi dai tier P/S dei mod (3/3 per le boots)', () => {
    const full = toListing(fixture.result[0], 'Standard', toExalted, now)!
    expect([full.openPrefixes, full.openSuffixes]).toEqual([0, 0])
    const one = toListing(fixture.result[1], 'Standard', toExalted, now)!
    expect([one.openPrefixes, one.openSuffixes]).toEqual([2, 0])
    const mid = toListing(fixture.result[2], 'Standard', toExalted, now)!
    expect([mid.openPrefixes, mid.openSuffixes]).toEqual([1, 1])
  })

  it('valore negativo per le stat "reduced"', () => {
    const l = toListing(fixture.result[0], 'Standard', toExalted, now)!
    expect(l.mods).toContainEqual({ statId: 'explicit.stat_99927264', value: -52 })
  })

  it('restituisce null se la valuta non è convertibile', () => {
    const raw = structuredClone(fixture.result[0]) as { listing: { price: { currency: string } } }
    raw.listing.price.currency = 'mirror-of-unknown'
    expect(toListing(raw, 'Standard', toExalted, now)).toBeNull()
  })

  it('restituisce null per dati malformati o senza prezzo', () => {
    expect(toListing(null, 'Standard', toExalted, now)).toBeNull()
    expect(toListing({ id: 'a', listing: {}, item: {} }, 'Standard', toExalted, now)).toBeNull()
  })
})
