import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { initParserData, parseItemText } from '../../src/core/parser/parse-item'
import type { RareItem } from '../../src/core/types'

const fixture = (name: string): string =>
  readFileSync(join(__dirname, '../fixtures/items', name), 'utf8')

function parseRare(name: string): RareItem {
  const result = parseItemText(fixture(name))
  if (!result.ok) throw new Error(`${name}: atteso ok, ottenuto ${result.reason}`)
  return result.item
}

beforeAll(async () => {
  await initParserData(join(__dirname, '../../data/en'))
})

describe('parseItemText', () => {
  it('rare-boots: categoria trade, prefix/suffix e stat id explicit', () => {
    const item = parseRare('rare-boots.txt')

    expect(item.itemClass).toBe('armour.boots')
    expect(item.explicits.filter((m) => m.type === 'prefix').length).toBe(3)
    expect(item.explicits.filter((m) => m.type === 'suffix').length).toBe(2)
    expect(item.openPrefixes).toBe(0)
    expect(item.openSuffixes).toBe(1)
    for (const mod of item.explicits) {
      expect(mod.statId.startsWith('explicit.')).toBe(true)
    }
  })

  it('rare-boots: dati di base, valori, tier e range dal testo avanzato', () => {
    const item = parseRare('rare-boots.txt')

    expect(item.name).toBe('Gale Stride')
    expect(item.baseType).toBe('Dunerunner Sandals')
    expect(item.itemLevel).toBe(81)
    expect(item.quality).toBe(10)
    expect(item.corrupted).toBe(false)
    expect(item.raw).toBe(fixture('rare-boots.txt'))

    const life = item.explicits.find((m) => m.statId === 'explicit.stat_3299347043')
    expect(life).toEqual({
      statId: 'explicit.stat_3299347043',
      text: '+74 to maximum Life',
      values: [74],
      tradeValue: 74,
      type: 'prefix',
      tier: 6,
      range: { min: 70, max: 84 }
    })

    const speed = item.explicits.find((m) => m.text === '25% increased Movement Speed')
    expect(speed).toMatchObject({ type: 'prefix', tier: 3, values: [25] })
    expect(speed?.range).toBeUndefined()

    expect(item.implicits).toEqual([
      expect.objectContaining({ type: 'rune', text: '+14% to Fire Resistance', values: [14] })
    ])
    expect(item.implicits[0].statId.startsWith('rune.')).toBe(true)
  })

  it('rare-ring-corrupted: corrotto, implicit e mod ibrido', () => {
    const item = parseRare('rare-ring-corrupted.txt')

    expect(item.corrupted).toBe(true)
    expect(item.itemClass).toBe('accessory.ring')
    expect(item.implicits.map((m) => m.type)).toEqual(['implicit'])
    expect(item.implicits[0].statId.startsWith('implicit.')).toBe(true)
    // "of Warmth" ha due stat ma occupa un solo slot suffix
    expect(item.explicits.filter((m) => m.type === 'suffix').length).toBe(4)
    expect(item.openPrefixes).toBe(2)
    expect(item.openSuffixes).toBe(0)
  })

  it('rare-jewel: i gioielli hanno 2 prefix e 2 suffix', () => {
    const item = parseRare('rare-jewel.txt')

    expect(item.itemClass).toBe('jewel')
    expect(item.explicits.map((m) => m.type)).toEqual(['prefix', 'prefix', 'suffix'])
    expect(item.openPrefixes).toBe(0)
    expect(item.openSuffixes).toBe(1)
  })

  it('tradeValue: mediato per le stat a più valori, negativo per le "reduced"', () => {
    const item = parseRare('rare-bow-augments.txt')

    const adds = item.explicits.find((m) => m.text === 'Adds 21 to 39 Physical Damage')
    expect(adds).toMatchObject({ values: [21, 39], tradeValue: 30, range: { min: 22, max: 33 } })

    expect(item.implicits.find((m) => m.type === 'implicit')).toMatchObject({
      text: '50% reduced Projectile Range',
      values: [50],
      tradeValue: -50
    })
  })

  it('raro di categoria non supportata -> unsupported_item', () => {
    expect(parseItemText(fixture('rare-waystone.txt'))).toEqual({
      ok: false,
      reason: 'unsupported_item'
    })
  })

  it('raro con base assente dai dati -> unsupported_item', () => {
    const text = fixture('rare-boots.txt').replace('Dunerunner Sandals', 'Imaginary Sandals')
    expect(parseItemText(text)).toEqual({ ok: false, reason: 'unsupported_item' })
  })

  it('testo Ctrl+C semplice (senza header avanzati) -> not_advanced', () => {
    expect(parseItemText(fixture('rare-boots-plain.txt'))).toEqual({
      ok: false,
      reason: 'not_advanced'
    })
  })

  it('testo vuoto -> empty', () => {
    expect(parseItemText('')).toEqual({ ok: false, reason: 'empty' })
  })

  it('testo qualsiasi -> not_poe_item', () => {
    expect(parseItemText('ciao')).toEqual({ ok: false, reason: 'not_poe_item' })
  })

  it('oggetto non identificato -> unidentified', () => {
    expect(parseItemText(fixture('unidentified.txt'))).toEqual({
      ok: false,
      reason: 'unidentified'
    })
  })

  it.each(['unique.txt', 'gem.txt'])('%s -> unsupported_rarity', (name) => {
    expect(parseItemText(fixture(name))).toEqual({ ok: false, reason: 'unsupported_rarity' })
  })
})
