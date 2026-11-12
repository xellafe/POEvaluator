import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ListingStore } from '../../src/core/db/listing-store'
import { initParserData, parseItemText } from '../../src/core/parser/parse-item'
import { DEFAULT_SETTINGS } from '../../src/core/settings'
import { isAbortError, type TradeClient } from '../../src/core/trade/trade-client'
import { EMPTY_PREFIX_STAT_ID, EMPTY_SUFFIX_STAT_ID } from '../../src/core/trade/query-builder'
import type { ItemMod, RareItem } from '../../src/core/types'
import {
  deepAnalysis,
  LOCAL_DAMAGE_STATS,
  parityPlan,
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
    // cast speed 0.7, mana 0.3, int 0.2; "+3 Cold Spell Skills" non ha peso
    expect(modFiltersOf(q)).toEqual([
      { id: 'explicit.stat_2891184298', value: { min: 22 } },
      { id: 'explicit.stat_1050105434', value: { min: 148 } },
      { id: 'explicit.stat_328541901', value: { min: 19 } }
    ])
    expect(notIdsOf(q)).toEqual([
      'explicit.stat_124131830',
      'explicit.stat_2974417149',
      'explicit.stat_737908626',
      'explicit.stat_274716455'
    ])
    expect(pseudoOf(q)).toEqual([])
    expect(fullSlotsOf(q)).toEqual([EMPTY_SUFFIX_STAT_ID])
  })

  it('indexed dalla età massima delle impostazioni', () => {
    const item = boots(fourMods())
    const settings = { ...DEFAULT_SETTINGS, maxListingAgeDays: 2 }
    const q = parityQuery(item, parityPlan(item), settings) as Query
    expect(q.query.filters.trade_filters.filters.indexed).toEqual({ option: '3days' })
  })

  it('il gruppo not ha al massimo 10 stat, per peso decrescente', () => {
    // anello: l'oggetto non ha nessuna delle stat di valore della tabella
    const item = boots([mod(DEX, 10, 'suffix')], { itemClass: 'accessory.ring' })
    const plan = parityPlan(item)
    expect(plan.exclude.length).toBeGreaterThan(0)
    expect(plan.exclude.length).toBeLessThanOrEqual(10)
    expect(plan.exclude[0]).toBe('explicit.stat_2901986750')
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

  it('fetch dei primi 20 per la base e 10 per le altre; nessun fetch con total 0', async () => {
    const { client, fetches } = fakeClient((q) => {
      const n = modIdsOf(q).length
      if (n === 4) return { total: 40, prices: range(25, () => 50) }
      if (modIdsOf(q).includes(MOVE)) return { total: 0, prices: [] }
      return { total: 25, prices: range(25, () => 30) }
    })
    await deepAnalysis(boots(fourMods()), deps(client))
    expect(fetches[0]).toEqual({
      ids: Array.from({ length: 20 }, (_, i) => `q1-${i}`),
      queryId: 'q1'
    })
    // solo la ricerca senza MOVE ha risultati
    expect(fetches.length).toBe(2)
    expect(fetches[1].ids.length).toBe(10)
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

  it('contributo = p25(base) - p25(senza il mod e con la sua stat nel not)', async () => {
    const mods = [mod(MOVE, 25, 'prefix'), mod(LIFE, 80, 'prefix'), mod(FIRE_RES, 30, 'suffix')]
    const { client, searches } = fakeClient((q) => {
      const ids = modIdsOf(q)
      if (ids.length === 3) return { total: 12, prices: range(12, () => 100) }
      if (!ids.includes(MOVE)) return { total: 12, prices: range(12, () => 40) }
      if (!ids.includes(LIFE)) return { total: 12, prices: range(12, () => 100) }
      return { total: 12, prices: range(12, () => 120) }
    })
    const v = await deepAnalysis(boots(mods), deps(client))
    expect(v.contributions).toEqual([
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
    expect(v.contributions).toEqual([{ statId: LIFE, text: `text ${LIFE}`, deltaExalted: 30 }])
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
    expect(v.contributions).toBeUndefined()
    expect(v.warnings).toEqual(['Troppo pochi oggetti simili in vendita per una stima'])
  })

  it('prezzo al 25° percentile e verdetto dal prezzo, non dalla mediana', async () => {
    const prices = [20, 25, 30, 40, 300, 320, 340, 360, 380, 400]
    const { client } = fakeClient(() => ({ total: 10, prices }))
    const v = await deepAnalysis(boots([mod(MOVE, 25)]), deps(client))
    // mediana 310 (Eccellente col modello precedente), p25 = 32.5
    expect(v.verdict).toBe('buono')
    expect(v.price?.suggested).toBe(33)
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
    // mod più debole: FIRE_RES (0.5), suffix
    expect(pseudoOf(last)).toEqual([{ id: EMPTY_SUFFIX_STAT_ID, value: { min: 1 } }])
    expect(fullSlotsOf(last)).toEqual([EMPTY_PREFIX_STAT_ID])
    expect(modIdsOf(last).length).toBe(3)
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
    expect(pseudoOf(searches[searches.length - 1])).toContainEqual({
      id: EMPTY_PREFIX_STAT_ID,
      value: { min: 1 }
    })
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

  it('mod neutro con prezzi crescenti: delta ~0 (stesso campione di 10 prezzi)', async () => {
    // stessa distribuzione con e senza il mod: 10, 15, ..., 105 (fetch base 20, altre 10)
    const { client } = fakeClient(() => ({ total: 20, prices: range(20, (i) => 10 + i * 5) }))
    const v = await deepAnalysis(boots([mod(MOVE, 25), mod(LIFE, 80)]), deps(client))
    expect(v.contributions).toEqual([
      { statId: MOVE, text: `text ${MOVE}`, deltaExalted: 0 },
      { statId: LIFE, text: `text ${LIFE}`, deltaExalted: 0 }
    ])
    // il prezzo resta su tutti i 20 prezzi base (p25 = 33.75)
    expect(v.comparablesCount).toBe(20)
    expect(v.price?.suggested).toBe(34)
  })

  it('slot liberi: confronto sui 10 prezzi base più economici', async () => {
    // base 10..200 (10 più economici: p25 32.5); slot liberi 70..108 (10 più economici: p25 74.5)
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
      'Gli oggetti simili con uno slot libero si vendono intorno a 75 ex'
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
    expect(v.contributions).toEqual([{ statId: MOVE, text: `text ${MOVE}`, deltaExalted: 40 }])
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

  it('rilassamento fino a un solo affisso: avviso al singolare', async () => {
    const { client } = fakeClient((q) =>
      modIdsOf(q).length >= 2
        ? { total: 2, prices: [10, 20] }
        : { total: 20, prices: range(20, () => 50) }
    )
    const v = await deepAnalysis(boots(fourMods()), deps(client))
    expect(v.warnings).toContain(
      'Stima basata su 1 affisso su 4: per gli altri non ci sono abbastanza oggetti simili'
    )
    expect(v.confidence).toBe('media')
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
