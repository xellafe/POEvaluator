import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { initParserData, parseItemText } from '../../src/core/parser/parse-item'
import type { RareItem } from '../../src/core/types'
import { modStatuses } from '../../src/core/valuation/mod-status'

beforeAll(async () => {
  await initParserData(join(__dirname, '../../data/en'))
})

const fixtureItem = (name: string): RareItem => {
  const r = parseItemText(readFileSync(join(__dirname, '../fixtures/items', name), 'utf8'))
  if (!r.ok) throw new Error(`${name}: ${r.reason}`)
  return r.item
}

describe('modStatuses (R34)', () => {
  it('quarterstaff: danni locali nel DPS, affissi senza peso esclusi, ordine del testo e tier', () => {
    const item = fixtureItem('rare-quarterstaff.txt')
    expect(modStatuses(item).map((m) => [m.text, m.status, m.tier])).toEqual([
      ['+273 to Accuracy Rating · +105 to Accuracy Rating', 'unweighted', 3],
      ['Adds 54 to 82 Cold Damage', 'dps', 4],
      ['51% increased Physical Damage', 'dps', 4],
      ['Causes 50% increased Stun Buildup', 'unweighted', 4],
      ['Gain 3 Mana per enemy killed', 'unweighted', 8]
    ])
  })

  it('arma senza danno elementale: il flat elementale non è nel DPS e conta come affisso', () => {
    const item = fixtureItem('rare-quarterstaff.txt')
    item.weapon = { pdps: 150, edps: 0.5, aps: 1.3 }
    const cold = modStatuses(item).find((m) => m.statId === 'explicit.stat_1037193709')
    expect(cold?.status).toBe('used')
  })

  it('bastone: tutti gli affissi hanno peso', () => {
    const item = fixtureItem('rare-staff.txt')
    expect(modStatuses(item).map((m) => m.status)).toEqual(['used', 'used', 'used', 'used'])
  })

  it('affissi tolti dal rilassamento: relaxed', () => {
    const item = fixtureItem('rare-staff.txt')
    const removed = new Set(['explicit.stat_328541901'])
    const int = modStatuses(item, removed).find((m) => m.statId === 'explicit.stat_328541901')
    expect(int?.status).toBe('relaxed')
  })

  it('classe senza pesi: tutti usati', () => {
    const item = fixtureItem('rare-staff.txt')
    item.itemClass = 'flask.charm'
    expect(modStatuses(item).every((m) => m.status === 'used')).toBe(true)
  })
})

describe('affissi senza peso di tier alto (R39)', () => {
  it('T1 senza peso: usato, non escluso', () => {
    const item = fixtureItem('rare-quarterstaff.txt')
    const mana = item.explicits.find((m) => m.text === 'Gain 3 Mana per enemy killed')!
    mana.tier = 1
    expect(modStatuses(item).find((m) => m.statId === mana.statId)?.status).toBe('used')
  })
})
