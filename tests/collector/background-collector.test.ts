import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BackgroundCollector, buildSeeds } from '../../src/core/collector/background-collector'
import { ListingStore } from '../../src/core/db/listing-store'
import { initParserData } from '../../src/core/parser/parse-item'
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings'
import type { Listing } from '../../src/core/types'
import { DEFAULT_WEIGHTS } from '../../src/core/valuation/features'

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/trade/fetch-response.json', import.meta.url), 'utf8')
) as { result: unknown[] }

beforeAll(async () => {
  await initParserData(join(__dirname, '../../data/en'))
})

afterEach(() => vi.useRealTimers())

const now = new Date('2026-11-12T10:00:00Z')
const toExalted = (a: number, c: string): number | null => (c === 'exalted' ? a : null)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = any

interface FakeClient {
  idle: boolean
  ratio: number
  blocked: number
  total: number
  searches: { league: string; query: Q; priority: string }[]
  fetches: { ids: string[]; queryId: string; priority: string }[]
  failNext: boolean
  isIdle(): boolean
  remainingRatio(): number
  blockedForMs(): number
  search(league: string, query: object, priority: string): Promise<unknown>
  fetchListings(ids: string[], queryId: string, priority: string): Promise<unknown[]>
}

function makeClient(
  over: Partial<{ idle: boolean; ratio: number; blocked: number; total: number }> = {}
): FakeClient {
  const c: FakeClient = {
    idle: over.idle ?? true,
    ratio: over.ratio ?? 1,
    blocked: over.blocked ?? 0,
    total: over.total ?? 30,
    searches: [],
    fetches: [],
    failNext: false,
    isIdle() {
      return this.idle
    },
    remainingRatio() {
      return this.ratio
    },
    blockedForMs() {
      return this.blocked
    },
    async search(league: string, query: object, priority: string) {
      this.searches.push({ league, query, priority })
      if (this.failNext) {
        this.failNext = false
        throw new Error('boom')
      }
      return {
        id: 'qid',
        result: Array.from({ length: Math.min(this.total, 100) }, (_, i) => `id${i}`),
        total: this.total
      }
    },
    async fetchListings(ids: string[], queryId: string, priority: string) {
      this.fetches.push({ ids, queryId, priority })
      return fixture.result
    }
  }
  return c
}

function setup(
  opts: {
    client?: FakeClient
    settings?: Partial<Settings>
    toExalted?: (a: number, c: string) => number | null
  } = {}
): {
  client: FakeClient
  store: ListingStore
  settings: Settings
  collector: BackgroundCollector
  log: ReturnType<typeof vi.fn>
} {
  const client = opts.client ?? makeClient()
  const store = new ListingStore(':memory:')
  const settings: Settings = { ...DEFAULT_SETTINGS, ...opts.settings }
  const log = vi.fn()
  const collector = new BackgroundCollector({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: client as any,
    store,
    toExalted: opts.toExalted ?? toExalted,
    settings: () => settings,
    now: () => now,
    log
  })
  return { client, store, settings, collector, log }
}

const statOf = (c: FakeClient, i: number): string =>
  c.searches[i].query.query.stats[0].filters[0].id
const classOf = (c: FakeClient, i: number): string =>
  c.searches[i].query.query.filters.type_filters.filters.category.option

describe('buildSeeds', () => {
  it('coppie (classe, stat) con peso >= 0.5, classi in ordine di tabella, stat per peso decrescente', () => {
    const seeds = buildSeeds()
    expect(seeds.length).toBeGreaterThan(0)
    expect(seeds.every((s) => DEFAULT_WEIGHTS[s.itemClass][s.statId] >= 0.5)).toBe(true)
    const classes = [...new Set(seeds.map((s) => s.itemClass))]
    expect(classes).toEqual(Object.keys(DEFAULT_WEIGHTS).filter((c) => classes.includes(c)))
    const first = seeds.filter((s) => s.itemClass === classes[0])
    const weights = first.map((s) => DEFAULT_WEIGHTS[s.itemClass][s.statId])
    expect(weights).toEqual([...weights].sort((a, b) => b - a))
  })
})

describe('BackgroundCollector.tick', () => {
  it('salta con setting disattivato', async () => {
    const { client, collector } = setup({ settings: { backgroundCollection: false } })
    expect(await collector.tick()).toBe('skipped')
    expect(client.searches).toHaveLength(0)
  })

  it('salta con client non idle', async () => {
    const { client, collector } = setup({ client: makeClient({ idle: false }) })
    expect(await collector.tick()).toBe('skipped')
    expect(client.searches).toHaveLength(0)
  })

  it('salta con remainingRatio 0.3', async () => {
    const { client, collector } = setup({ client: makeClient({ ratio: 0.3 }) })
    expect(await collector.tick()).toBe('skipped')
    expect(client.searches).toHaveLength(0)
  })

  it('salta durante una restrizione del trade (Review Focus 2), anche con ratio pieno', async () => {
    const { client, collector } = setup({ client: makeClient({ blocked: 120_000 }) })
    expect(await collector.tick()).toBe('skipped')
    expect(client.searches).toHaveLength(0)
  })

  it('salta senza tassi di cambio (le inserzioni verrebbero tutte scartate)', async () => {
    const { client, collector } = setup({ toExalted: () => null })
    expect(await collector.tick()).toBe('skipped')
    expect(client.searches).toHaveLength(0)
  })

  it('un errore nei controlli iniziali viene loggato e il tick non rigetta', async () => {
    const client = makeClient()
    client.isIdle = () => {
      throw new Error('rotto')
    }
    const { collector, log } = setup({ client })
    await expect(collector.tick()).resolves.toBe('skipped')
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('con condizioni ok: 1 search, fetch dei primi 20 id in background, salva nella league corrente', async () => {
    const { client, store, collector } = setup({ settings: { league: 'Dawn' } })
    expect(await collector.tick()).toBe('collected')
    expect(client.searches).toHaveLength(1)
    expect(client.searches[0].league).toBe('Dawn')
    expect(client.searches[0].priority).toBe('background')
    expect(client.fetches).toHaveLength(1)
    expect(client.fetches[0].ids).toHaveLength(20)
    expect(client.fetches[0].queryId).toBe('qid')
    expect(client.fetches[0].priority).toBe('background')
    const itemClass = buildSeeds()[0].itemClass
    const f = { itemClass, maxAgeDays: 3650, now }
    expect(store.comparables({ league: 'Dawn', ...f }).length).toBeGreaterThan(0)
    expect(store.comparables({ league: 'Standard', ...f })).toHaveLength(0)
  })

  it('legge la league a ogni tick', async () => {
    const { settings, store, collector } = setup()
    const total = (l: string): number =>
      Object.values(store.countByClass(l)).reduce((a, b) => a + b, 0)
    settings.league = 'A'
    await collector.tick()
    expect(total('A')).toBeGreaterThan(0)
    expect(total('B')).toBe(0)
    // le stesse inserzioni (id � la chiave) passano alla league corrente
    settings.league = 'B'
    await collector.tick()
    expect(total('B')).toBeGreaterThan(0)
  })

  it('total 0: nessun fetch', async () => {
    const { client, collector } = setup({ client: makeClient({ total: 0 }) })
    expect(await collector.tick()).toBe('collected')
    expect(client.fetches).toHaveLength(0)
  })

  it('due tick consecutivi usano seed diversi; il giro si chiude', async () => {
    const { client, collector } = setup()
    const seeds = buildSeeds()
    await collector.tick()
    await collector.tick()
    expect([classOf(client, 0), statOf(client, 0)]).toEqual([seeds[0].itemClass, seeds[0].statId])
    expect([classOf(client, 1), statOf(client, 1)]).toEqual([seeds[1].itemClass, seeds[1].statId])
    for (let i = 2; i < seeds.length; i++) await collector.tick()
    await collector.tick()
    expect(client.searches).toHaveLength(seeds.length + 1)
    expect([classOf(client, seeds.length), statOf(client, seeds.length)]).toEqual([
      seeds[0].itemClass,
      seeds[0].statId
    ])
  })

  it('senza dati locali: nessun limite minimo sul valore, ordine per prezzo crescente', async () => {
    const { client, collector } = setup()
    await collector.tick()
    expect(client.searches[0].query.query.stats[0].filters[0].value).toEqual({})
    expect(client.searches[0].query.sort).toEqual({ price: 'asc' })
  })

  it('con dati locali: soglia = floor(0.5 * p95 di |valore|) della stat', async () => {
    const { client, store, collector } = setup()
    const seed = buildSeeds()[0]
    const mk = (i: number, value: number): Listing => ({
      id: `l${i}`,
      league: 'Standard',
      itemClass: seed.itemClass,
      baseType: 'x',
      itemLevel: 80,
      mods: [{ statId: seed.statId, value }],
      openPrefixes: 0,
      openSuffixes: 0,
      priceAmount: 1,
      priceCurrency: 'exalted',
      priceExalted: 1,
      indexedAt: '2020-01-01T00:00:00Z',
      seenAt: now.toISOString()
    })
    // valori 1..101 -> p95 = 96 -> floor(48)
    store.upsert(Array.from({ length: 101 }, (_, i) => mk(i, i + 1)))
    await collector.tick()
    expect(client.searches[0].query.query.stats[0].filters[0].value).toEqual({ min: 48 })
  })

  it('errore di rete: loggato, "skipped", e il cursore avanza', async () => {
    const client = makeClient()
    client.failNext = true
    const { collector, log } = setup({ client })
    expect(await collector.tick()).toBe('skipped')
    expect(log).toHaveBeenCalledTimes(1)
    await collector.tick()
    expect(statOf(client, 1)).toBe(buildSeeds()[1].statId)
  })

  it('un tick saltato non avanza il cursore', async () => {
    const { client, settings, collector } = setup()
    settings.backgroundCollection = false
    await collector.tick()
    settings.backgroundCollection = true
    await collector.tick()
    expect(statOf(client, 0)).toBe(buildSeeds()[0].statId)
  })
})

describe('BackgroundCollector.start/stop', () => {
  it('un tick a ogni intervallo, start doppio non crea due loop, stop li ferma', async () => {
    vi.useFakeTimers()
    const { client, collector } = setup()
    collector.start(1000)
    collector.start(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(client.searches).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(client.searches).toHaveLength(2)
    collector.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(client.searches).toHaveLength(2)
  })

  it('non sovrappone i tick', async () => {
    vi.useFakeTimers()
    const client = makeClient()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const orig = client.search.bind(client)
    client.search = async (l: string, q: object, p: string) => {
      await gate
      return orig(l, q, p)
    }
    const { collector } = setup({ client })
    collector.start(1000)
    await vi.advanceTimersByTimeAsync(3500)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.searches).toHaveLength(1)
    collector.stop()
  })
})
