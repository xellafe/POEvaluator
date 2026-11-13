import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ListingStore } from '../../src/core/db/listing-store'
import { initParserData, parseItemText } from '../../src/core/parser/parse-item'
import { DEFAULT_SETTINGS } from '../../src/core/settings'
import { isAbortError, type TradeClient } from '../../src/core/trade/trade-client'
import { EMPTY_PREFIX_STAT_ID, EMPTY_SUFFIX_STAT_ID } from '../../src/core/trade/query-builder'
import type { ItemMod, RareItem, Valuation } from '../../src/core/types'
import {
  deepAnalysis,
  LOCAL_DAMAGE_STATS,
  parityPlan,
  spreadSample,
  parityQuery,
  type DeepDeps
} from '../../src/core/valuation/deep-analysis'

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/trade/fetch-response.json', import.meta.url), 'utf8')
) as { result: unknown[] }

beforeAll(async () => {
  await initParserData(join(__dirname, '../../data/en'))
})

const NOW = new Date('2026-11-12T12:00:00.000Z')
// pesi armour.boots: MOVE 1, LIFE 0.8, FIRE_RES 0.5, COLD_RES 0.5, LIGHTNING_RES 0.5,
// CHAOS_RES 0.4, DEX 0.2
const MOVE = 'explicit.stat_2250533757'
const LIFE = 'explicit.stat_3299347043'
const FIRE_RES = 'explicit.stat_3372524247'
const COLD_RES = 'explicit.stat_4220027924'
const DEX = 'explicit.stat_3261801346'
const LIGHTNING_RES = 'explicit.stat_1671376347'
const CHAOS_RES = 'explicit.stat_2923486259'

function mod(
  statId: string,
  tradeValue: number,
  type: ItemMod['type'] = 'prefix',
  tier?: number
): ItemMod {
  const m: ItemMod = { statId, text: `text ${statId}`, values: [tradeValue], tradeValue, type }
  if (tier !== undefined) m.tier = tier
  return m
}

function boots(explicits: ItemMod[], over: Partial<RareItem> = {}): RareItem {
  return {
    raw: '',
    itemClass: 'armour.boots',
    baseType: 'Sandsworn Sandals',
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

type Filter = { id: string; value?: { min?: number; max?: number } }
type Query = {
  query: {
    stats: { type: string; filters: Filter[] }[]
    filters: Record<string, { filters: Record<string, unknown> }>
  }
}

/** Stat dei mod nella query (un gruppo count = un mod; esclusi i pseudo e il gruppo not). */
function modIdsOf(query: object): string[] {
  const stats = (query as Query).query.stats
  const ids: string[] = []
  for (const g of stats) {
    if (g.type === 'and') {
      for (const f of g.filters) if (!f.id.startsWith('pseudo.')) ids.push(f.id)
    } else if (g.type === 'count') {
      ids.push(g.filters[0].id)
    }
  }
  return ids
}

/** Filtri dei mod (gruppo and, senza pseudo) con i loro valori. */
function modFiltersOf(query: object): Filter[] {
  return (query as Query).query.stats[0].filters.filter((f) => !f.id.startsWith('pseudo.'))
}

/** Filtri pseudo degli slot vuoti, con il loro valore. */
function pseudoOf(query: object): Filter[] {
  return (query as Query).query.stats[0].filters.filter((f) => f.id.startsWith('pseudo.'))
}

/** Id del gruppo not (vuoto se assente), escluse le pseudo degli slot pieni. */
function notIdsOf(query: object): string[] {
  return (
    (query as Query).query.stats
      .find((g) => g.type === 'not')
      ?.filters.map((f) => f.id)
      .filter((id) => !id.startsWith('pseudo.')) ?? []
  )
}

/** Pseudo "slot vuoti" nel gruppo not = lati pieni. */
function fullSlotsOf(query: object): string[] {
  return (
    (query as Query).query.stats
      .find((g) => g.type === 'not')
      ?.filters.map((f) => f.id)
      .filter((id) => id.startsWith('pseudo.')) ?? []
  )
}

/** Ricerca degli oggetti con uno slot libero in più (filtro pseudo con min). */
const openSlotSearch = (q: object): boolean => pseudoOf(q).some((f) => f.value?.min !== undefined)

interface Response {
  total: number
  prices: number[]
}

function rawListing(id: string, price: number): unknown {
  const raw = structuredClone(fixture.result[0]) as {
    id: string
    listing: { price: { amount: number } }
  }
  raw.id = id
  raw.listing.price.amount = price
  return raw
}

/** TradeClient finto: `respond` decide totale e prezzi in base alla query. */
function fakeClient(respond: (query: object, call: number) => Response): {
  client: TradeClient
  searches: object[]
  fetches: { ids: string[]; queryId: string }[]
} {
  const searches: object[] = []
  const fetches: { ids: string[]; queryId: string }[] = []
  const byQuery = new Map<string, number[]>()
  const client = {
    search: async (_league: string, query: object) => {
      searches.push(query)
      const id = `q${searches.length}`
      const r = respond(query, searches.length)
      byQuery.set(id, r.prices)
      return { id, result: r.prices.map((_, i) => `${id}-${i}`), total: r.total }
    },
    fetchListings: async (ids: string[], queryId: string) => {
      fetches.push({ ids, queryId })
      const prices = byQuery.get(queryId) ?? []
      return ids.map((lid) => rawListing(lid, prices[Number(lid.split('-')[1])]))
    }
  } as unknown as TradeClient
  return { client, searches, fetches }
}

const range = (n: number, f: (i: number) => number): number[] =>
  Array.from({ length: n }, (_, i) => f(i))

const toExalted = (amount: number, currency: string): number | null =>
  currency === 'exalted' ? amount : null

let store: ListingStore
beforeEach(() => {
  store = new ListingStore(':memory:')
})
afterEach(() => {
  store.close()
})

function deps(client: TradeClient, over: Partial<DeepDeps> = {}): DeepDeps {
  return { client, store, toExalted, settings: DEFAULT_SETTINGS, now: () => NOW, ...over }
}

const fourMods = (): ItemMod[] => [
  mod(DEX, 30, 'suffix'),
  mod(LIFE, 80, 'prefix'),
  mod(FIRE_RES, 30, 'suffix'),
  mod(MOVE, 25, 'prefix')
]

// Stat di valore degli stivali che fourMods() non ha (peso >= 0.4, per peso decrescente).
const BOOTS_NOT = [COLD_RES, LIGHTNING_RES, CHAOS_RES]

/** Contributi (mod usati con delta) dal nuovo campo `mods` (R34). */
function contributionsOf(
  v: Valuation
): { statId: string; text: string; deltaExalted: number }[] | undefined {
  const out = (v.mods ?? [])
    .filter((m) => m.deltaExalted !== undefined)
    .map((m) => ({ statId: m.statId, text: m.text, deltaExalted: m.deltaExalted as number }))
  return out.length > 0 ? out : undefined
}

const fixtureItem = (name: string): RareItem => {
  const r = parseItemText(readFileSync(join(__dirname, '../fixtures/items', name), 'utf8'))
  if (!r.ok) throw new Error(`${name}: ${r.reason}`)
  return r.item
}

describe('deepAnalysis: query base alla pari', () => {
  it('quarterstaff: pdps/edps al posto dei mod di danno locali, not, slot pieni, indexed e collapse', () => {
    const item = fixtureItem('rare-quarterstaff.txt')
    const q = parityQuery(item, parityPlan(item), DEFAULT_SETTINGS) as Query
    // pdps 117.7 × 0.85 = 100.04, edps 88.4 × 0.85 = 75.14
    expect(q.query.filters.equipment_filters).toEqual({
      filters: { pdps: { min: 100 }, edps: { min: 75 } }
    })
    const allIds = JSON.stringify(q.query.stats)
    for (const id of LOCAL_DAMAGE_STATS) expect(allIds).not.toContain(`"${id}"`)
    // Accuracy, Stun Buildup e Mana per kill non hanno peso: assenti
    expect(modIdsOf(q)).toEqual([])
    expect(allIds).not.toContain('stat_691932474')
    expect(allIds).not.toContain('stat_791928121')
    // stat di valore assenti: livelli melee (0.9), critico locale (0.6), danno critico (0.4)
    expect(notIdsOf(q)).toEqual([
      'explicit.stat_9187492',
      'explicit.stat_518292764',
      'explicit.stat_3556824919'
    ])
    // 3 prefix (pieni), 2 suffix (uno libero)
    expect(pseudoOf(q)).toEqual([])
    expect(fullSlotsOf(q)).toEqual([EMPTY_PREFIX_STAT_ID])
    expect(q.query.filters.trade_filters).toEqual({
      filters: {
        indexed: { option: '1week' },
        collapse: { option: 'true' }
      }
    })
    expect(q.query.filters.type_filters).toEqual({
      filters: { category: { option: 'weapon.warstaff' }, rarity: { option: 'rare' } }
    })
    expect((q as unknown as { sort: object }).sort).toEqual({ price: 'asc' })
  })

  it('bastone e scettro (incantatori): nessun filtro DPS', () => {
    for (const name of ['rare-staff.txt', 'rare-sceptre.txt']) {
      const item = fixtureItem(name)
      const q = parityQuery(item, parityPlan(item), DEFAULT_SETTINGS) as Query
      expect(q.query.filters.equipment_filters).toBeUndefined()
    }
  })

  it('bastone: mod con peso nei filtri (×0.8), stat di valore assenti nel not, suffix pieni', () => {
    const item = fixtureItem('rare-staff.txt')
    const q = parityQuery(item, parityPlan(item), DEFAULT_SETTINGS) as Query
    // +3 Cold Spell Skills 0.7 (tier 3), cast speed 0.7 (tier 5), mana 0.3, int 0.2
    expect(modFiltersOf(q)).toEqual([
      { id: 'explicit.stat_2254480358', value: { min: 2 } },
      { id: 'explicit.stat_2891184298', value: { min: 22 } },
      { id: 'explicit.stat_1050105434', value: { min: 148 } },
      { id: 'explicit.stat_328541901', value: { min: 19 } }
    ])
    // stat di valore assenti: Spell 1, Spell Damage 0.8, livelli per elemento 0.7, critico 0.5,
    // danno critico 0.4
    expect(notIdsOf(q)).toEqual([
      'explicit.stat_124131830',
      'explicit.stat_2974417149',
      'explicit.stat_591105508',
      'explicit.stat_1545858329',
      'explicit.stat_4226189338',
      'explicit.stat_1600707273',
      'explicit.stat_737908626',
      'explicit.stat_274716455'
    ])
    expect(pseudoOf(q)).toEqual([])
    expect(fullSlotsOf(q)).toEqual([EMPTY_SUFFIX_STAT_ID])
  })

  it('scettro: filtri sui mod "Allies in your Presence", not con le stat di valore assenti', () => {
    const item = fixtureItem('rare-sceptre.txt')
    const q = parityQuery(item, parityPlan(item), DEFAULT_SETTINGS) as Query
    // cast speed degli alleati 0.5 (tier 2), attacco fuoco degli alleati 0.5 (tier 4), int 0.2
    expect(modFiltersOf(q)).toEqual([
      { id: 'explicit.stat_289128254', value: { min: 11 } },
      { id: 'explicit.stat_849987426', value: { min: 16 } },
      { id: 'explicit.stat_328541901', value: { min: 8 } }
    ])
    const not = notIdsOf(q)
    expect(not.slice(0, 3)).toEqual([
      'explicit.stat_2704225257',
      'explicit.stat_3981240776',
      'explicit.stat_2162097452'
    ])
    for (const id of [
      'explicit.stat_2347036682',
      'explicit.stat_2854751904',
      'explicit.stat_1574590649',
      'explicit.stat_1798257884',
      'explicit.stat_1998951374',
      'explicit.stat_262946222',
      'explicit.stat_2901986750'
    ]) {
      expect(not).toContain(id)
    }
    expect(not).not.toContain('explicit.stat_849987426')
    expect(not).not.toContain('explicit.stat_289128254')
    expect(fullSlotsOf(q)).toEqual([EMPTY_SUFFIX_STAT_ID])
  })

  it('arma solo fisica (edps 0): i flat elementali locali vanno nel not', () => {
    const item = fixtureItem('rare-quarterstaff.txt')
    item.weapon = { pdps: 200, edps: 0, aps: 1.3 }
    item.explicits = item.explicits.filter((m) => m.statId !== 'explicit.stat_1037193709')
    const plan = parityPlan(item)
    expect(plan.exclude).toEqual(
      expect.arrayContaining([
        'explicit.stat_709508406',
        'explicit.stat_1037193709',
        'explicit.stat_3336890334'
      ])
    )
    // fisico e velocità d'attacco restano coperti dal DPS
    expect(plan.exclude).not.toContain('explicit.stat_1940865751')
    expect(plan.exclude).not.toContain('explicit.stat_210067635')
    const q = parityQuery(item, plan, DEFAULT_SETTINGS) as Query
    expect(q.query.filters.equipment_filters).toEqual({ filters: { pdps: { min: 170 } } })
  })

  it('arma senza danno fisico (pdps ~0): i mod di danno fisico locale vanno nel not', () => {
    const item = fixtureItem('rare-quarterstaff.txt')
    item.weapon = { pdps: 0, edps: 120, aps: 1.3 }
    item.explicits = item.explicits.filter((m) => m.statId !== 'explicit.stat_1509134228')
    const plan = parityPlan(item)
    expect(plan.exclude).toEqual(
      expect.arrayContaining(['explicit.stat_1509134228', 'explicit.stat_1940865751'])
    )
    // il freddo aggiunto è coperto dall'edps
    expect(plan.exclude).not.toContain('explicit.stat_1037193709')
    expect(plan.exclude).not.toContain('explicit.stat_709508406')
  })

  it('DPS sotto 1: nessun filtro su quel danno; da 1 in su filtro con min almeno 1', () => {
    const item = fixtureItem('rare-quarterstaff.txt')
    item.explicits = item.explicits.filter((m) => m.statId !== 'explicit.stat_1037193709')
    item.weapon = { pdps: 150, edps: 0.9, aps: 1.3 }
    let plan = parityPlan(item)
    let q = parityQuery(item, plan, DEFAULT_SETTINGS) as Query
    expect(q.query.filters.equipment_filters).toEqual({ filters: { pdps: { min: 127 } } })
    expect(plan.exclude).toContain('explicit.stat_1037193709')
    // edps 1.1: coperto dal DPS, quindi serve il filtro (floor(1.1 × 0.85) = 0 -> min 1)
    item.weapon = { pdps: 150, edps: 1.1, aps: 1.3 }
    plan = parityPlan(item)
    q = parityQuery(item, plan, DEFAULT_SETTINGS) as Query
    expect(q.query.filters.equipment_filters).toEqual({
      filters: { pdps: { min: 127 }, edps: { min: 1 } }
    })
    expect(plan.exclude).not.toContain('explicit.stat_1037193709')
  })

  it('indexed dalla età massima delle impostazioni', () => {
    const item = boots(fourMods())
    const settings = { ...DEFAULT_SETTINGS, maxListingAgeDays: 2 }
    const q = parityQuery(item, parityPlan(item), settings) as Query
    expect(q.query.filters.trade_filters.filters.indexed).toEqual({ option: '3days' })
  })

  it('il gruppo not ha al massimo 12 stat, per peso decrescente', () => {
    // scettro senza mod: le 12 stat con peso >= 0.4 della tabella entrano tutte (con il limite
    // di 10 le due da 0.4 restavano fuori)
    const item = boots([], { itemClass: 'weapon.sceptre' })
    const plan = parityPlan(item)
    expect(plan.exclude).toHaveLength(12)
    expect(plan.exclude[0]).toBe('explicit.stat_2704225257')
  })

  it('classe senza pesi: tutti i mod nella query, nessun gruppo not', () => {
    const item = boots([mod(MOVE, 25), mod(LIFE, 80)], { itemClass: 'flask.charm' })
    const q = parityQuery(item, parityPlan(item), DEFAULT_SETTINGS)
    expect(modIdsOf(q).sort()).toEqual([LIFE, MOVE].sort())
    expect(notIdsOf(q)).toEqual([])
  })
})

describe('deepAnalysis', () => {
  it('rilassa prima i valori a ×0.6, poi toglie il mod di peso minore', async () => {
    const { client, searches } = fakeClient((q) =>
      modIdsOf(q).length >= 4
        ? { total: 2, prices: [10, 20] }
        : { total: 12, prices: range(12, () => 50) }
    )
    const v = await deepAnalysis(boots(fourMods()), deps(client, { maxSearches: 3 }))
    expect(searches.length).toBe(3)
    expect(modIdsOf(searches[0]).sort()).toEqual([DEX, FIRE_RES, LIFE, MOVE].sort())
    expect(modFiltersOf(searches[0]).find((f) => f.id === LIFE)?.value).toEqual({ min: 64 })
    expect(modIdsOf(searches[1]).sort()).toEqual([DEX, FIRE_RES, LIFE, MOVE].sort())
    expect(modFiltersOf(searches[1]).find((f) => f.id === LIFE)?.value).toEqual({ min: 48 })
    expect(modIdsOf(searches[2]).sort()).toEqual([FIRE_RES, LIFE, MOVE].sort())
    expect(v.tradeUrl).toMatch(/\/q3$/)
  })

  it('il rilassamento non tocca mai il gruppo not né i vincoli sugli slot', async () => {
    const { client, searches } = fakeClient(() => ({ total: 1, prices: [10] }))
    await deepAnalysis(boots(fourMods(), { openPrefixes: 0, openSuffixes: 0 }), deps(client))
    expect(searches.length).toBe(5)
    for (const q of searches) {
      expect(notIdsOf(q)).toEqual(BOOTS_NOT)
      expect(fullSlotsOf(q)).toEqual([EMPTY_PREFIX_STAT_ID, EMPTY_SUFFIX_STAT_ID])
    }
  })

  it('non rilassa oltre un mod', async () => {
    const { client, searches } = fakeClient(() => ({ total: 1, prices: [10] }))
    await deepAnalysis(boots(fourMods()), deps(client))
    expect(searches.map((q) => modIdsOf(q))).toEqual([
      [MOVE, LIFE, FIRE_RES, DEX],
      [MOVE, LIFE, FIRE_RES, DEX],
      [MOVE, LIFE, FIRE_RES],
      [MOVE, LIFE],
      [MOVE]
    ])
  })

  it('arma: il rilassamento porta anche il DPS a ×0.6', async () => {
    const item = fixtureItem('rare-quarterstaff.txt')
    const { client, searches } = fakeClient(() => ({ total: 1, prices: [10] }))
    await deepAnalysis(item, deps(client))
    // nessun mod con peso: base e valori a ×0.6, poi niente da togliere
    expect(searches.length).toBe(2)
    expect((searches[1] as Query).query.filters.equipment_filters).toEqual({
      filters: { pdps: { min: 70 }, edps: { min: 53 } }
    })
    expect(notIdsOf(searches[1])).toEqual(notIdsOf(searches[0]))
  })

  it('a parità di peso ordina per tier migliore, senza tier in fondo', async () => {
    // FIRE_RES e LIGHTNING_RES hanno lo stesso peso (0.5)
    const { client, searches } = fakeClient(() => ({ total: 0, prices: [] }))
    const item = boots([
      mod(FIRE_RES, 30, 'suffix'),
      mod(LIGHTNING_RES, 30, 'suffix', 1),
      mod(MOVE, 25, 'prefix', 3)
    ])
    await deepAnalysis(item, deps(client, { maxSearches: 1 }))
    expect(modIdsOf(searches[0])).toEqual([MOVE, LIGHTNING_RES, FIRE_RES])
  })

  it('i mod senza peso non entrano nella query', async () => {
    const { client, searches } = fakeClient(() => ({ total: 0, prices: [] }))
    const accuracy = mod('explicit.stat_691932474', 300, 'prefix')
    await deepAnalysis(boots([mod(MOVE, 25), accuracy]), deps(client, { maxSearches: 1 }))
    expect(modIdsOf(searches[0])).toEqual([MOVE])
  })

  it('non supera mai maxSearches chiamate a search', async () => {
    const respond = (): Response => ({ total: 30, prices: range(20, (i) => 10 + i) })
    for (const maxSearches of [1, 3, 5]) {
      const { client, searches } = fakeClient(respond)
      await deepAnalysis(
        boots(fourMods(), { openPrefixes: 0, openSuffixes: 0 }),
        deps(client, { maxSearches })
      )
      expect(searches.length).toBe(maxSearches)
    }
    const { client, searches } = fakeClient(respond)
    await deepAnalysis(boots(fourMods(), { openPrefixes: 0, openSuffixes: 0 }), deps(client))
    // base + 4 contributi + slot liberi = 6 <= 8
    expect(searches.length).toBe(6)
  })

  it('fetch di 20 id per la base e 10 per le altre; nessun fetch con total 0', async () => {
    const { client, fetches } = fakeClient((q) => {
      const n = modIdsOf(q).length
      if (n === 4) return { total: 40, prices: range(25, () => 50) }
      if (modIdsOf(q).includes(MOVE)) return { total: 0, prices: [] }
      return { total: 25, prices: range(25, () => 30) }
    })
    await deepAnalysis(boots(fourMods()), deps(client))
    expect(fetches[0].queryId).toBe('q1')
    expect(fetches[0].ids).toHaveLength(20)
    // solo la ricerca senza MOVE ha risultati
    expect(fetches.length).toBe(2)
    expect(fetches[1].ids.length).toBe(10)
  })

  it('campione equidistante con 22 risultati: 20 id su tutto il range, primo e ultimo inclusi', async () => {
    const { client, fetches } = fakeClient(() => ({ total: 22, prices: range(22, (i) => 10 + i) }))
    await deepAnalysis(boots([mod(MOVE, 25)]), deps(client, { maxSearches: 1 }))
    const idx = fetches[0].ids.map((id) => Number(id.split('-')[1]))
    expect(idx).toHaveLength(20)
    expect(idx[0]).toBe(0)
    expect(idx[19]).toBe(21)
    expect(new Set(idx).size).toBe(20)
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
  })

  it('campione equidistante con 100 risultati: id distribuiti sui primi 60', async () => {
    const { client, fetches } = fakeClient((q) =>
      modIdsOf(q).length === 2
        ? { total: 500, prices: range(100, (i) => 10 + i) }
        : { total: 500, prices: range(100, (i) => 5 + i) }
    )
    await deepAnalysis(boots([mod(MOVE, 25), mod(LIFE, 80)]), deps(client, { maxSearches: 2 }))
    const base = fetches[0].ids.map((id) => Number(id.split('-')[1]))
    expect(base).toHaveLength(20)
    expect(base[0]).toBe(0)
    expect(base[19]).toBe(59)
    // passo ~3.1: nessun buco più grande di 4 posizioni
    for (let i = 1; i < base.length; i++) expect(base[i] - base[i - 1]).toBeLessThanOrEqual(4)
    const side = fetches[1].ids.map((id) => Number(id.split('-')[1]))
    expect(side).toHaveLength(10)
    expect(side[0]).toBe(0)
    expect(side[9]).toBe(59)
  })

  it('salva nello store le inserzioni recuperate', async () => {
    const { client } = fakeClient(() => ({ total: 12, prices: range(12, (i) => 10 + i) }))
    await deepAnalysis(boots(fourMods()), deps(client, { maxSearches: 2 }))
    const saved = store.comparables({
      league: 'Standard',
      itemClass: 'armour.boots',
      maxAgeDays: 100_000,
      now: NOW
    })
    // base: 12 listing (q1-*); contributo: 10 listing (q2-*)
    expect(saved.length).toBe(22)
    expect(saved.some((l) => l.id === 'q1-0')).toBe(true)
    expect(saved.find((l) => l.id === 'q1-5')!.priceExalted).toBe(15)
  })

  it('contributo = p10(base) - p10(senza il mod e con la sua stat nel not)', async () => {
    const mods = [mod(MOVE, 25, 'prefix'), mod(LIFE, 80, 'prefix'), mod(FIRE_RES, 30, 'suffix')]
    const { client, searches } = fakeClient((q) => {
      const ids = modIdsOf(q)
      if (ids.length === 3) return { total: 12, prices: range(12, () => 100) }
      if (!ids.includes(MOVE)) return { total: 12, prices: range(12, () => 40) }
      if (!ids.includes(LIFE)) return { total: 12, prices: range(12, () => 100) }
      return { total: 12, prices: range(12, () => 120) }
    })
    const v = await deepAnalysis(boots(mods), deps(client))
    expect(contributionsOf(v)).toEqual([
      { statId: MOVE, text: `text ${MOVE}`, deltaExalted: 60 },
      { statId: LIFE, text: `text ${LIFE}`, deltaExalted: 0 },
      { statId: FIRE_RES, text: `text ${FIRE_RES}`, deltaExalted: -20 }
    ])
    // ricerche dei contributi: la stat tolta va nel gruppo not, accanto a quelle della base
    expect(notIdsOf(searches[1])).toEqual([...notIdsOf(searches[0]), MOVE])
    expect(notIdsOf(searches[2])).toEqual([...notIdsOf(searches[0]), LIFE])
    expect(notIdsOf(searches[3])).toEqual([...notIdsOf(searches[0]), FIRE_RES])
    expect(v.verdict).toBe('ottimo')
    expect(v.comparablesCount).toBe(12)
    expect(v.tradeUrl).toBe('https://www.pathofexile.com/trade2/search/poe2/Standard/q1')
  })

  it('contributo nascosto se una delle due popolazioni ha meno di 3 prezzi', async () => {
    const mods = [mod(MOVE, 25, 'prefix'), mod(LIFE, 80, 'prefix')]
    const { client } = fakeClient((q) => {
      const ids = modIdsOf(q)
      if (ids.length === 2) return { total: 12, prices: range(12, () => 100) }
      if (!ids.includes(MOVE)) return { total: 2, prices: [10, 20] }
      return { total: 12, prices: range(12, () => 70) }
    })
    const v = await deepAnalysis(boots(mods), deps(client))
    expect(contributionsOf(v)).toEqual([{ statId: LIFE, text: `text ${LIFE}`, deltaExalted: 30 }])
  })

  it('meno di 3 prezzi dopo il rilassamento: nessun verdetto, niente contributi né slot', async () => {
    const { client, searches } = fakeClient(() => ({ total: 2, prices: [100, 120] }))
    const v = await deepAnalysis(
      boots([mod(MOVE, 25)], { openPrefixes: 0, openSuffixes: 0 }),
      deps(client)
    )
    // base + valori a ×0.6; con un solo mod non si toglie altro
    expect(searches.length).toBe(2)
    expect(v.verdict).toBeNull()
    expect(v.price).toBeUndefined()
    expect(v.confidence).toBe('bassa')
    expect(contributionsOf(v)).toBeUndefined()
    expect(v.warnings).toEqual(['Troppo pochi oggetti simili in vendita per una stima'])
  })

  it('prezzo al 10° percentile e verdetto dal prezzo, non dalla mediana', async () => {
    const prices = [20, 25, 30, 40, 300, 320, 340, 360, 380, 400]
    const { client } = fakeClient(() => ({ total: 10, prices }))
    const v = await deepAnalysis(boots([mod(MOVE, 25)]), deps(client))
    // mediana 310 (Eccellente col modello precedente), p10 = 24.5
    expect(v.verdict).toBe('buono')
    expect(v.price?.suggested).toBe(25)
    expect(v.warnings.some((w) => w.startsWith('Pochi oggetti simili'))).toBe(false)
  })

  it('slot occupati: cerca alla pari con uno slot libero sul lato del mod più debole e avvisa se valgono di più', async () => {
    const mods = [mod(MOVE, 25, 'prefix'), mod(FIRE_RES, 30, 'suffix'), mod(LIFE, 80, 'prefix')]
    const { client, searches } = fakeClient((q) => {
      if (openSlotSearch(q)) return { total: 12, prices: range(12, () => 150) }
      return { total: 12, prices: range(12, () => 100) }
    })
    const v = await deepAnalysis(boots(mods, { openPrefixes: 0, openSuffixes: 0 }), deps(client))
    const last = searches[searches.length - 1]
    // mod più debole: FIRE_RES (0.5), suffix: oggetti alla pari con uno slot libero al suo
    // posto (FIRE_RES tolto dai mod ma non messo nel not)
    expect(pseudoOf(last)).toEqual([{ id: EMPTY_SUFFIX_STAT_ID, value: { min: 1 } }])
    expect(fullSlotsOf(last)).toEqual([EMPTY_PREFIX_STAT_ID])
    expect(modIdsOf(last).sort()).toEqual([LIFE, MOVE].sort())
    expect(notIdsOf(last)).toEqual(notIdsOf(searches[0]))
    expect(v.warnings).toContain(
      'Gli oggetti simili con uno slot libero si vendono intorno a 150 ex'
    )
    // la stima resta quella degli oggetti simili base
    expect(v.price?.suggested).toBe(100)
  })

  it('slot occupati: mod più debole prefix -> slot prefix libero; prezzo più basso ignorato', async () => {
    const mods = [mod(MOVE, 25, 'suffix'), mod(LIFE, 80, 'prefix')]
    const { client, searches } = fakeClient((q) => {
      if (openSlotSearch(q)) return { total: 12, prices: range(12, () => 50) }
      return { total: 12, prices: range(12, () => 100) }
    })
    const v = await deepAnalysis(boots(mods, { openPrefixes: 0, openSuffixes: 0 }), deps(client))
    const last = searches[searches.length - 1]
    expect(pseudoOf(last)).toEqual([{ id: EMPTY_PREFIX_STAT_ID, value: { min: 1 } }])
    expect(fullSlotsOf(last)).toEqual([EMPTY_SUFFIX_STAT_ID])
    expect(modIdsOf(last)).toEqual([MOVE])
    expect(v.warnings.some((w) => w.startsWith('Gli oggetti simili con uno slot libero'))).toBe(
      false
    )
  })

  it('niente ricerca slot liberi se il lato del mod più debole ha slot liberi', async () => {
    const { client, searches } = fakeClient(() => ({ total: 12, prices: range(12, () => 100) }))
    await deepAnalysis(boots([mod(MOVE, 25), mod(LIFE, 80)]), deps(client))
    expect(searches.every((q) => !openSlotSearch(q))).toBe(true)
    expect(searches.length).toBe(3)
  })

  it('mod neutro con prezzi crescenti: delta 0 (stesso quantile, stessa granularità)', async () => {
    // stessa distribuzione con e senza il mod: 10, 15, ..., 105 (fetch base 20, altre 10);
    // il contributo confronta 10 prezzi equidistanti della base con i 10 della variante
    const { client } = fakeClient(() => ({ total: 20, prices: range(20, (i) => 10 + i * 5) }))
    const v = await deepAnalysis(boots([mod(MOVE, 25), mod(LIFE, 80)]), deps(client))
    expect(contributionsOf(v)).toEqual([
      { statId: MOVE, text: `text ${MOVE}`, deltaExalted: 0 },
      { statId: LIFE, text: `text ${LIFE}`, deltaExalted: 0 }
    ])
    // il prezzo resta su tutti i 20 prezzi base (p10 = 19.5)
    expect(v.comparablesCount).toBe(20)
    expect(v.price?.suggested).toBe(20)
  })

  it('slot liberi: confronto sullo stesso quantile (10 prezzi equidistanti)', async () => {
    // base 10..200: 10 equidistanti da 10 a 200; la pulizia toglie solo la coda alta (R33),
    // il 10 resta: p10 ~ 28. Slot liberi 70..108: 10 equidistanti 70, 74, ..., 108, p10 = 73.6
    const { client } = fakeClient((q) =>
      openSlotSearch(q)
        ? { total: 20, prices: range(20, (i) => 70 + i * 2) }
        : { total: 20, prices: range(20, (i) => 10 + i * 10) }
    )
    const v = await deepAnalysis(
      boots([mod(MOVE, 25, 'prefix'), mod(FIRE_RES, 30, 'suffix')], {
        openPrefixes: 0,
        openSuffixes: 0
      }),
      deps(client)
    )
    expect(v.warnings).toContain(
      'Gli oggetti simili con uno slot libero si vendono intorno a 74 ex'
    )
  })

  it('query finale con un solo mod: contributo con la stat nel not', async () => {
    const { client, searches } = fakeClient((q) => {
      const n = modIdsOf(q).length
      if (n >= 2) return { total: 2, prices: [10, 20] }
      if (n === 1) return { total: 12, prices: range(12, () => 100) }
      return { total: 12, prices: range(12, () => 60) }
    })
    const v = await deepAnalysis(boots([mod(MOVE, 25), mod(LIFE, 80)]), deps(client))
    expect(searches.map((q) => modIdsOf(q))).toEqual([[MOVE, LIFE], [MOVE, LIFE], [MOVE], []])
    expect(notIdsOf(searches[3])).toEqual([...notIdsOf(searches[2]), MOVE])
    expect(contributionsOf(v)).toEqual([{ statId: MOVE, text: `text ${MOVE}`, deltaExalted: 40 }])
    expect(v.comparablesCount).toBe(12)
  })

  it('onProgress: total === maxSearches, una chiamata per ricerca; searches = ricerche eseguite', async () => {
    const { client } = fakeClient(() => ({ total: 12, prices: range(12, () => 100) }))
    const calls: [number, number][] = []
    const v = await deepAnalysis(
      boots([mod(MOVE, 25), mod(LIFE, 80)]),
      deps(client, { maxSearches: 6 }),
      (d, t) => calls.push([d, t])
    )
    expect(calls).toEqual([
      [1, 6],
      [2, 6],
      [3, 6]
    ])
    expect(v.searches).toBe(3)
  })

  it('nessun risultato: nessun verdetto (dati insufficienti) e messaggio della deep', async () => {
    const { client } = fakeClient(() => ({ total: 0, prices: [] }))
    const v = await deepAnalysis(boots([mod(MOVE, 25), mod(LIFE, 80)]), deps(client))
    expect(v.verdict).toBeNull()
    expect(v.price).toBeUndefined()
    expect(v.confidence).toBe('bassa')
    expect(v.comparablesCount).toBe(0)
    expect(v.warnings).toEqual(['Non ho trovato oggetti simili in vendita'])
  })

  it('inserzioni tutte scartate (valuta non convertibile): nessun verdetto', async () => {
    const { client } = fakeClient(() => ({ total: 12, prices: range(12, () => 100) }))
    const v = await deepAnalysis(boots([mod(MOVE, 25)]), deps(client, { toExalted: () => null }))
    expect(v.verdict).toBeNull()
    expect(v.warnings).toEqual(['Non ho trovato oggetti simili in vendita'])
  })

  it('rilassamento: avvisa degli affissi esclusi e limita la confidenza a media', async () => {
    const { client } = fakeClient((q) =>
      modIdsOf(q).length >= 4
        ? { total: 2, prices: [10, 20] }
        : { total: 20, prices: range(20, () => 50) }
    )
    const v = await deepAnalysis(boots(fourMods()), deps(client))
    expect(v.verdict).toBe('ottimo')
    // 20 prezzi uguali con il gruppo not darebbero confidenza alta
    expect(v.confidence).toBe('media')
    expect(v.warnings).toContain(
      'Stima basata su 3 affissi su 4: per gli altri non ci sono abbastanza oggetti simili'
    )
  })

  it('rilassamento fino a un solo affisso: stima incerta al singolare, senza avviso doppio', async () => {
    const { client } = fakeClient((q) =>
      modIdsOf(q).length >= 2
        ? { total: 2, prices: [10, 20] }
        : { total: 20, prices: range(20, () => 50) }
    )
    const v = await deepAnalysis(boots(fourMods()), deps(client))
    expect(v.uncertain).toEqual(['confronto su 1 affisso su 4'])
    expect(v.warnings.some((w) => w.startsWith('Stima basata su'))).toBe(false)
    expect(v.confidence).toBe('media')
  })

  it('stima incerta: meno di 6 prezzi', async () => {
    const { client } = fakeClient(() => ({ total: 8, prices: [30, 300, 640, 700] }))
    const v = await deepAnalysis(boots(fourMods()), deps(client))
    expect(v.verdict).not.toBeNull()
    expect(v.uncertain).toEqual(['solo 4 oggetti simili in vendita'])
  })

  it('stima incerta: pochi prezzi e metà degli affissi tolti insieme', async () => {
    const { client } = fakeClient((q) =>
      modIdsOf(q).length >= 2 ? { total: 0, prices: [] } : { total: 3, prices: [30, 300, 640] }
    )
    const v = await deepAnalysis(boots(fourMods()), deps(client))
    expect(v.uncertain).toEqual(['solo 3 oggetti simili in vendita', 'confronto su 1 affisso su 4'])
  })

  it('stima non incerta: 3 affissi su 4 e prezzi sufficienti (resta l avviso parziale)', async () => {
    const { client } = fakeClient((q) =>
      modIdsOf(q).length >= 4
        ? { total: 2, prices: [10, 20] }
        : { total: 20, prices: range(20, () => 50) }
    )
    const v = await deepAnalysis(boots(fourMods()), deps(client))
    expect(v.uncertain).toBeUndefined()
  })

  it('dati insufficienti: nessuna stima incerta (non c è stima)', async () => {
    const { client } = fakeClient(() => ({ total: 0, prices: [] }))
    const v = await deepAnalysis(boots(fourMods()), deps(client))
    expect(v.verdict).toBeNull()
    expect(v.uncertain).toBeUndefined()
  })

  it('senza mod tolti, con il gruppo not e >= 15 prezzi: confidenza alta', async () => {
    const { client } = fakeClient(() => ({ total: 20, prices: range(20, () => 50) }))
    const v = await deepAnalysis(boots(fourMods()), deps(client))
    expect(v.confidence).toBe('alta')
    expect(v.warnings.some((w) => w.startsWith('Stima basata su'))).toBe(false)
  })

  it('solo valori a ×0.6 (nessun mod tolto): confidenza alta possibile, nessun avviso', async () => {
    const { client } = fakeClient((_q, call) =>
      call === 1 ? { total: 2, prices: [10, 20] } : { total: 20, prices: range(20, () => 50) }
    )
    const v = await deepAnalysis(boots(fourMods()), deps(client))
    expect(v.confidence).toBe('alta')
    expect(v.warnings.some((w) => w.startsWith('Stima basata su'))).toBe(false)
  })

  it('classe senza pesi: confidenza al massimo media', async () => {
    const { client } = fakeClient(() => ({ total: 20, prices: range(20, () => 50) }))
    const v = await deepAnalysis(
      boots([mod(MOVE, 25), mod(LIFE, 80)], { itemClass: 'flask.charm' }),
      deps(client)
    )
    expect(v.confidence).toBe('media')
  })

  it('Eccellente con confidenza non alta: avviso "Pochi oggetti simili"', async () => {
    const { client } = fakeClient(() => ({ total: 8, prices: range(8, (i) => 400 + i) }))
    const v = await deepAnalysis(boots(fourMods()), deps(client))
    expect(v.verdict).toBe('eccellente')
    expect(v.warnings).toContain(
      'Pochi oggetti simili in vendita: controlla il prezzo sul trade prima di venderlo'
    )
  })

  it('onProgress con maxSearches di default (8)', async () => {
    const { client } = fakeClient(() => ({ total: 12, prices: range(12, () => 100) }))
    const totals = new Set<number>()
    await deepAnalysis(boots([mod(MOVE, 25)]), deps(client), (_d, t) => totals.add(t))
    expect([...totals]).toEqual([8])
  })

  it('propaga gli errori del client dopo aver salvato le inserzioni già recuperate', async () => {
    const { client } = fakeClient(() => ({ total: 12, prices: range(12, () => 100) }))
    const err = new Error('Trade API: timeout dopo 20 s')
    let calls = 0
    const search = client.search.bind(client)
    client.search = (async (...args: Parameters<TradeClient['search']>) => {
      if (++calls === 2) throw err
      return search(...args)
    }) as TradeClient['search']
    await expect(deepAnalysis(boots([mod(MOVE, 25), mod(LIFE, 80)]), deps(client))).rejects.toBe(
      err
    )
    expect(store.countByClass('Standard')['armour.boots']).toBe(12)
  })

  it('usa la league delle impostazioni e priorità user', async () => {
    const seen: unknown[][] = []
    const { client } = fakeClient(() => ({ total: 12, prices: range(12, () => 100) }))
    const search = client.search.bind(client)
    const fetchListings = client.fetchListings.bind(client)
    client.search = ((...a: Parameters<TradeClient['search']>) => {
      seen.push(['search', a[0], a[2]])
      return search(...a)
    }) as TradeClient['search']
    client.fetchListings = ((...a: Parameters<TradeClient['fetchListings']>) => {
      seen.push(['fetch', a[2]])
      return fetchListings(...a)
    }) as TradeClient['fetchListings']
    const settings = { ...DEFAULT_SETTINGS, league: 'Dawn' }
    const v = await deepAnalysis(boots([mod(MOVE, 25)]), deps(client, { settings, maxSearches: 1 }))
    expect(seen).toEqual([
      ['search', 'Dawn', 'user'],
      ['fetch', 'user']
    ])
    expect(v.tradeUrl).toBe('https://www.pathofexile.com/trade2/search/poe2/Dawn/q1')
    expect(store.countByClass('Dawn')['armour.boots']).toBe(12)
  })
})

describe('deepAnalysis: annullamento', () => {
  it('si ferma tra un passo e l’altro, non chiama onProgress dopo l’annullamento e passa il signal al client', async () => {
    const ac = new AbortController()
    const signals: (AbortSignal | undefined)[] = []
    const { client, searches } = fakeClient((_q, call) => {
      if (call === 2) ac.abort() // annullato mentre la seconda ricerca è in volo
      return { total: 2, prices: [10, 20] }
    })
    const search = client.search.bind(client)
    client.search = ((...a: Parameters<TradeClient['search']>) => {
      signals.push(a[3])
      return search(...a)
    }) as TradeClient['search']
    const progress: number[] = []
    const err = await deepAnalysis(boots(fourMods()), deps(client, { signal: ac.signal }), (d) =>
      progress.push(d)
    ).catch((e) => e)
    expect(isAbortError(err)).toBe(true)
    expect(searches).toHaveLength(2)
    expect(progress).toEqual([1])
    expect(signals.every((s) => s === ac.signal)).toBe(true)
  })

  it('con il signal già annullato non fa ricerche', async () => {
    const ac = new AbortController()
    ac.abort()
    const { client, searches } = fakeClient(() => ({ total: 12, prices: range(12, () => 50) }))
    const err = await deepAnalysis(boots(fourMods()), deps(client, { signal: ac.signal })).catch(
      (e) => e
    )
    expect(isAbortError(err)).toBe(true)
    expect(searches).toHaveLength(0)
  })

  it('le inserzioni scaricate prima dell’annullamento restano nel database', async () => {
    const ac = new AbortController()
    const { client } = fakeClient((_q, call) => {
      if (call === 2) ac.abort()
      return { total: 12, prices: range(12, () => 50) }
    })
    const err = await deepAnalysis(boots(fourMods()), deps(client, { signal: ac.signal })).catch(
      (e) => e
    )
    expect(isAbortError(err)).toBe(true)
    expect(store.countByClass('Standard')['armour.boots']).toBe(12)
  })
})

describe('spreadSample', () => {
  const ids = (n: number): number[] => range(n, (i) => i)

  it('n <= 1: nessun elemento o solo il primo', () => {
    expect(spreadSample(ids(30), 0)).toEqual([])
    expect(spreadSample(ids(30), 1)).toEqual([0])
    expect(spreadSample([], 1)).toEqual([])
  })

  it('con al massimo n elementi li prende tutti', () => {
    expect(spreadSample(ids(7), 10)).toEqual(ids(7))
    expect(spreadSample(ids(10), 10)).toEqual(ids(10))
  })

  it('n elementi equidistanti fra i primi min(length, 60), primo e ultimo inclusi', () => {
    expect(spreadSample(ids(22), 10)).toEqual([0, 2, 5, 7, 9, 12, 14, 16, 19, 21])
    expect(spreadSample(ids(100), 10)).toEqual([0, 7, 13, 20, 26, 33, 39, 46, 52, 59])
  })
})

describe('deepAnalysis: stato degli affissi (R34)', () => {
  it('tutti gli explicit nell ordine del testo, con tier, stato e contributo', async () => {
    const mods = [
      mod(DEX, 30, 'suffix', 6),
      mod(LIFE, 80, 'prefix', 2),
      mod('explicit.stat_691932474', 100, 'prefix'),
      mod(FIRE_RES, 30, 'suffix', 4),
      mod(MOVE, 25, 'prefix', 1)
    ]
    // con DEX la ricerca non trova abbastanza oggetti: DEX tolta dal rilassamento
    const { client } = fakeClient((q) =>
      modIdsOf(q).includes(DEX)
        ? { total: 2, prices: [10, 20] }
        : { total: 12, prices: range(12, () => 50) }
    )
    const v = await deepAnalysis(boots(mods), deps(client))
    expect(v.mods?.map((m) => [m.statId, m.status, m.tier])).toEqual([
      [DEX, 'relaxed', 6],
      [LIFE, 'used', 2],
      ['explicit.stat_691932474', 'unweighted', undefined],
      [FIRE_RES, 'used', 4],
      [MOVE, 'used', 1]
    ])
    expect(v.mods?.find((m) => m.statId === LIFE)?.deltaExalted).toBe(0)
    expect(v.mods?.find((m) => m.statId === DEX)?.deltaExalted).toBeUndefined()
  })

  it('senza verdetto gli affissi ci sono lo stesso', async () => {
    const { client } = fakeClient(() => ({ total: 0, prices: [] }))
    const v = await deepAnalysis(boots([mod(MOVE, 25)]), deps(client))
    expect(v.verdict).toBeNull()
    expect(v.mods?.map((m) => m.status)).toEqual(['used'])
  })
})
