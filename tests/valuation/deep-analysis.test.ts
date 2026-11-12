import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ListingStore } from '../../src/core/db/listing-store'
import { initParserData } from '../../src/core/parser/parse-item'
import { DEFAULT_SETTINGS } from '../../src/core/settings'
import { isAbortError, type TradeClient } from '../../src/core/trade/trade-client'
import { EMPTY_PREFIX_STAT_ID, EMPTY_SUFFIX_STAT_ID } from '../../src/core/trade/query-builder'
import type { ItemMod, RareItem } from '../../src/core/types'
import { deepAnalysis, type DeepDeps } from '../../src/core/valuation/deep-analysis'

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/trade/fetch-response.json', import.meta.url), 'utf8')
) as { result: unknown[] }

beforeAll(async () => {
  await initParserData(join(__dirname, '../../data/en'))
})

const NOW = new Date('2026-11-12T12:00:00.000Z')
// pesi armour.boots: MOVE 1, LIFE 0.8, FIRE_RES 0.5, LIGHTNING_RES 0.5, DEX 0.2
const MOVE = 'explicit.stat_2250533757'
const LIFE = 'explicit.stat_3299347043'
const FIRE_RES = 'explicit.stat_3372524247'
const DEX = 'explicit.stat_3261801346'
const LIGHTNING_RES = 'explicit.stat_1671376347'

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

type Query = { query: { stats: { type: string; filters: { id: string }[] }[] } }

/** Stat dei mod nella query (un gruppo count = un mod; esclusi i pseudo degli slot vuoti). */
function modIdsOf(query: object): string[] {
  const stats = (query as Query).query.stats
  const ids: string[] = []
  for (const g of stats) {
    if (g.type === 'and') {
      for (const f of g.filters) if (!f.id.startsWith('pseudo.')) ids.push(f.id)
    } else {
      ids.push(g.filters[0].id)
    }
  }
  return ids
}

function pseudoIdsOf(query: object): string[] {
  return (query as Query).query.stats[0].filters
    .map((f) => f.id)
    .filter((id) => id.startsWith('pseudo.'))
}

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

describe('deepAnalysis', () => {
  it('rilassa togliendo il mod di peso minore finché total >= 5', async () => {
    const { client, searches } = fakeClient((q) =>
      modIdsOf(q).length >= 4
        ? { total: 2, prices: [10, 20] }
        : { total: 12, prices: range(12, () => 50) }
    )
    const v = await deepAnalysis(boots(fourMods()), deps(client, { maxSearches: 2 }))
    expect(searches.length).toBe(2)
    expect(modIdsOf(searches[0]).sort()).toEqual([DEX, FIRE_RES, LIFE, MOVE].sort())
    expect(modIdsOf(searches[1]).sort()).toEqual([FIRE_RES, LIFE, MOVE].sort())
    expect(v.tradeUrl).toMatch(/\/q2$/)
  })

  it('non rilassa oltre un mod', async () => {
    const { client, searches } = fakeClient(() => ({ total: 1, prices: [10] }))
    await deepAnalysis(boots(fourMods()), deps(client))
    expect(searches.slice(0, 4).map((q) => modIdsOf(q))).toEqual([
      [MOVE, LIFE, FIRE_RES, DEX],
      [MOVE, LIFE, FIRE_RES],
      [MOVE, LIFE],
      [MOVE]
    ])
    expect(searches.length).toBe(4)
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

  it('contributo positivo per il mod la cui rimozione abbassa la mediana', async () => {
    const mods = [mod(MOVE, 25, 'prefix'), mod(LIFE, 80, 'prefix'), mod(FIRE_RES, 30, 'suffix')]
    const { client } = fakeClient((q) => {
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
    expect(v.verdict).toBe('ottimo')
    expect(v.comparablesCount).toBe(12)
    expect(v.tradeUrl).toBe('https://www.pathofexile.com/trade2/search/poe2/Standard/q1')
  })

  it('omette i contributi le cui ricerche non danno prezzi', async () => {
    const mods = [mod(MOVE, 25, 'prefix'), mod(LIFE, 80, 'prefix')]
    const { client } = fakeClient((q) => {
      const ids = modIdsOf(q)
      if (ids.length === 2) return { total: 12, prices: range(12, () => 100) }
      if (!ids.includes(MOVE)) return { total: 0, prices: [] }
      return { total: 12, prices: range(12, () => 70) }
    })
    const v = await deepAnalysis(boots(mods), deps(client))
    expect(v.contributions).toEqual([{ statId: LIFE, text: `text ${LIFE}`, deltaExalted: 30 }])
  })

  it('con meno di 2 prezzi base salta contributi e slot, confidenza bassa', async () => {
    const { client, searches } = fakeClient(() => ({ total: 1, prices: [100] }))
    const v = await deepAnalysis(
      boots([mod(MOVE, 25)], { openPrefixes: 0, openSuffixes: 0 }),
      deps(client)
    )
    expect(searches.length).toBe(1)
    expect(v.confidence).toBe('bassa')
    expect(v.contributions).toBeUndefined()
    expect(v.warnings).toContain('Troppo pochi oggetti simili sul mercato')
  })

  it('slot occupati: cerca con slot liberi sul lato del mod più debole e avvisa se valgono di più', async () => {
    const mods = [mod(MOVE, 25, 'prefix'), mod(FIRE_RES, 30, 'suffix'), mod(LIFE, 80, 'prefix')]
    const { client, searches } = fakeClient((q) => {
      if (pseudoIdsOf(q).length > 0) return { total: 12, prices: range(12, () => 150) }
      return { total: 12, prices: range(12, () => 100) }
    })
    const v = await deepAnalysis(boots(mods, { openPrefixes: 0, openSuffixes: 0 }), deps(client))
    const last = searches[searches.length - 1]
    // mod più debole: FIRE_RES (0.5), suffix
    expect(pseudoIdsOf(last)).toEqual([EMPTY_SUFFIX_STAT_ID])
    expect(modIdsOf(last).length).toBe(3)
    expect(v.warnings).toContain(
      'Gli oggetti simili con uno slot libero si vendono intorno a 150 ex'
    )
    // la stima resta quella dei comparabili base
    expect(v.price?.suggested).toBe(100)
  })

  it('slot occupati: mod più debole prefix -> minOpenPrefixes; mediana più bassa ignorata', async () => {
    const mods = [mod(MOVE, 25, 'suffix'), mod(LIFE, 80, 'prefix')]
    const { client, searches } = fakeClient((q) => {
      if (pseudoIdsOf(q).length > 0) return { total: 12, prices: range(12, () => 50) }
      return { total: 12, prices: range(12, () => 100) }
    })
    const v = await deepAnalysis(boots(mods, { openPrefixes: 0, openSuffixes: 0 }), deps(client))
    expect(pseudoIdsOf(searches[searches.length - 1])).toEqual([EMPTY_PREFIX_STAT_ID])
    expect(v.warnings.some((w) => w.startsWith('Gli oggetti simili con uno slot libero'))).toBe(
      false
    )
  })

  it("niente ricerca slot liberi se l'oggetto ha slot liberi", async () => {
    const { client, searches } = fakeClient(() => ({ total: 12, prices: range(12, () => 100) }))
    await deepAnalysis(boots([mod(MOVE, 25), mod(LIFE, 80)]), deps(client))
    expect(searches.every((q) => pseudoIdsOf(q).length === 0)).toBe(true)
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
    // priceFor resta su tutti i 20 prezzi base (mediana 57.5 -> ottimo, p60 = 67)
    expect(v.comparablesCount).toBe(20)
    expect(v.price?.suggested).toBe(67)
  })

  it('slot liberi: confronto sui 10 prezzi base più economici', async () => {
    // base 10..200 (10 più economici: mediana 55; tutti e 20: 105); slot liberi 70..88 (mediana 79)
    const { client } = fakeClient((q) =>
      pseudoIdsOf(q).length > 0
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
      'Gli oggetti simili con uno slot libero si vendono intorno a 79 ex'
    )
  })

  it('query finale con un solo mod: nessuna ricerca di contributo', async () => {
    const { client, searches } = fakeClient((q) =>
      modIdsOf(q).length >= 2
        ? { total: 2, prices: [10, 20] }
        : { total: 12, prices: range(12, () => 100) }
    )
    const v = await deepAnalysis(boots([mod(MOVE, 25), mod(LIFE, 80)]), deps(client))
    expect(searches.map((q) => modIdsOf(q))).toEqual([[MOVE, LIFE], [MOVE]])
    expect(v.contributions).toBeUndefined()
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
        : { total: 12, prices: range(12, () => 50) }
    )
    const v = await deepAnalysis(boots(fourMods()), deps(client))
    expect(v.verdict).toBe('ottimo')
    // 12 prezzi uguali darebbero confidenza alta
    expect(v.confidence).toBe('media')
    expect(v.warnings).toContain(
      'Stima basata su 3 affissi su 4: per gli altri non ci sono abbastanza oggetti simili'
    )
  })

  it('rilassamento fino a un solo affisso: avviso al singolare', async () => {
    const { client } = fakeClient((q) =>
      modIdsOf(q).length >= 2
        ? { total: 2, prices: [10, 20] }
        : { total: 12, prices: range(12, () => 50) }
    )
    const v = await deepAnalysis(boots(fourMods()), deps(client))
    expect(v.warnings).toContain(
      'Stima basata su 1 affisso su 4: per gli altri non ci sono abbastanza oggetti simili'
    )
    expect(v.confidence).toBe('media')
  })

  it('senza rilassamento nessun avviso sugli affissi e confidenza piena', async () => {
    const { client } = fakeClient(() => ({ total: 12, prices: range(12, () => 50) }))
    const v = await deepAnalysis(boots(fourMods()), deps(client))
    expect(v.confidence).toBe('alta')
    expect(v.warnings.some((w) => w.startsWith('Stima basata su'))).toBe(false)
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
