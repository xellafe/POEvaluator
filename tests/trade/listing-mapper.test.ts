import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { initParserData } from '../../src/core/parser/parse-item'
import { toListing } from '../../src/core/trade/listing-mapper'

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/trade/fetch-response.json', import.meta.url), 'utf8')
) as { result: unknown[] }

beforeAll(async () => {
  await initParserData(join(__dirname, '../../data/en'))
})

type Obj = Record<string, unknown>

const BOOTS = 'armour.boots'
const now = new Date('2026-11-12T10:00:00Z')
const toExalted = (amount: number, currency: string): number | null =>
  currency === 'exalted' ? amount : currency === 'divine' ? amount * 100 : null

describe('toListing', () => {
  it('mappa prezzo, data, base e livello', () => {
    const l = toListing(fixture.result[1], 'Standard', toExalted, now, BOOTS)!
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

  it('mappa i mod con id e valore in unità trade (dal matcher, non dal range del tier)', () => {
    const l = toListing(fixture.result[1], 'Standard', toExalted, now, BOOTS)!
    expect(l.mods).toContainEqual({ statId: 'explicit.stat_3299347043', value: 84 })
    expect(l.mods).toContainEqual({ statId: 'explicit.stat_3917489142', value: 8 })
    expect(l.mods.length).toBe(4)
  })

  it('conta gli slot liberi dai tier P/S dei mod (3/3 per le boots)', () => {
    const full = toListing(fixture.result[0], 'Standard', toExalted, now, BOOTS)!
    expect([full.openPrefixes, full.openSuffixes]).toEqual([0, 0])
    const one = toListing(fixture.result[1], 'Standard', toExalted, now, BOOTS)!
    expect([one.openPrefixes, one.openSuffixes]).toEqual([2, 0])
    const mid = toListing(fixture.result[2], 'Standard', toExalted, now, BOOTS)!
    expect([mid.openPrefixes, mid.openSuffixes]).toEqual([1, 1])
  })

  it('stat definita in negativo ("reduced Shock duration"): valore +52 come per un item', () => {
    const l = toListing(fixture.result[0], 'Standard', toExalted, now, BOOTS)!
    expect(l.mods).toContainEqual({ statId: 'explicit.stat_99927264', value: 52 })
  })

  it('stat con matcher negate ("reduced Movement Speed"): valore negativo', () => {
    const raw = structuredClone(fixture.result[0]) as { item: { explicitMods: Obj[] } }
    const ms = raw.item.explicitMods.find((m) => m.hash === 'stat.explicit.stat_2250533757')!
    ms.description = '10% reduced Movement Speed'
    const l = toListing(raw, 'Standard', toExalted, now, BOOTS)!
    expect(l.mods).toContainEqual({ statId: 'explicit.stat_2250533757', value: -10 })
  })

  it('scarta il mod se la riga non corrisponde allo statId (nessun valore inventato)', () => {
    const raw = structuredClone(fixture.result[1]) as { item: { explicitMods: Obj[] } }
    const life = raw.item.explicitMods.find((m) => m.hash === 'stat.explicit.stat_3299347043')!
    life.description = 'Some unknown line 12'
    const l = toListing(raw, 'Standard', toExalted, now, BOOTS)!
    expect(l.mods.find((m) => m.statId === 'explicit.stat_3299347043')).toBeUndefined()
    expect(l.mods.length).toBe(3)
  })

  it('i mod fractured occupano slot e finiscono in mods', () => {
    const raw = structuredClone(fixture.result[2]) as { item: Record<string, unknown> }
    raw.item.fracturedMods = [
      {
        description: '+30 to maximum Life',
        domain: 'fractured',
        hash: 'stat.fractured.stat_3299347043',
        mods: [{ name: 'Hale', tier: 'P5', level: 1, magnitudes: [{ min: '30', max: '40' }] }]
      }
    ]
    const l = toListing(raw, 'Standard', toExalted, now, BOOTS)!
    // result[2] ha 2P/2S: il fractured aggiunge un prefix
    expect([l.openPrefixes, l.openSuffixes]).toEqual([0, 1])
    // id canonico come per gli item (R14)
    expect(l.mods).toContainEqual({ statId: 'explicit.stat_3299347043', value: 30 })
    expect(l.mods.some((m) => m.statId.startsWith('fractured.'))).toBe(false)
  })

  it('due mod con la stessa stat (mana massimo): un solo mod con i valori sommati (D5)', () => {
    const raw = structuredClone(fixture.result[2]) as { item: { explicitMods: Obj[] } }
    raw.item.explicitMods = [
      { description: '+97 to maximum Mana', hash: 'stat.explicit.stat_1050105434', mods: [] },
      { description: '+28 to maximum Mana', hash: 'stat.explicit.stat_1050105434', mods: [] }
    ]
    const l = toListing(raw, 'Standard', toExalted, now, BOOTS)!
    expect(l.mods).toEqual([{ statId: 'explicit.stat_1050105434', value: 125 }])
  })

  it('id alternativo della stessa stat (attack speed globale dei guanti) -> id canonico', () => {
    const raw = structuredClone(fixture.result[2]) as { item: { explicitMods: Obj[] } }
    raw.item.explicitMods.push({
      description: '12% increased Attack Speed',
      hash: 'stat.explicit.stat_681332047',
      mods: []
    })
    const l = toListing(raw, 'Standard', toExalted, now, 'armour.gloves')!
    expect(l.mods).toContainEqual({ statId: 'explicit.stat_210067635', value: 12 })
    expect(l.mods.find((m) => m.statId === 'explicit.stat_681332047')).toBeUndefined()
  })

  it('gioielli: massimo 2 prefix/suffix', () => {
    const l = toListing(fixture.result[1], 'Standard', toExalted, now, 'jewel')!
    expect([l.openPrefixes, l.openSuffixes]).toEqual([1, 0])
  })

  it('restituisce null se la valuta non è convertibile', () => {
    const raw = structuredClone(fixture.result[0]) as { listing: { price: { currency: string } } }
    raw.listing.price.currency = 'mirror-of-unknown'
    expect(toListing(raw, 'Standard', toExalted, now, BOOTS)).toBeNull()
  })

  it('restituisce null per dati malformati o senza prezzo', () => {
    expect(toListing(null, 'Standard', toExalted, now, BOOTS)).toBeNull()
    expect(
      toListing({ id: 'a', listing: {}, item: {} }, 'Standard', toExalted, now, BOOTS)
    ).toBeNull()
  })
})
