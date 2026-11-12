import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  BackgroundCollector,
  buildSeeds,
  COLLECT_INTERVAL_MS,
  DEEP_COOLDOWN_MS,
  MAX_REQUESTED_CLASSES,
  MIN_RATIO,
  MIN_SEARCH_INTERVAL_MS,
  SEARCH_INTERVAL_TOLERANCE_MS,
  RESTRICTION_COOLDOWN_MS,
  STARTUP_DELAY_MS
} from '../../src/core/collector/background-collector'
import { ListingStore } from '../../src/core/db/listing-store'
import { tradePausedError } from '../../src/core/trade/trade-client'
import { initParserData } from '../../src/core/parser/parse-item'
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings'
import type { Listing } from '../../src/core/types'
import { DEFAULT_WEIGHTS } from '../../src/core/valuation/features'
import { KNN_MIN_LISTINGS } from '../../src/core/valuation/quick-evaluator'

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
  /** Millisecondi dalla fine dell'ultimo blocco (Infinity: mai bloccato). */
  sinceBlock: number
  total: number
  searches: { league: string; query: Q; priority: string }[]
  fetches: { ids: string[]; queryId: string; priority: string }[]
  failNext: boolean
  isIdle(): boolean
  remainingRatio(): number
  blockedForMs(): number
  blockEndedAgoMs(): number
  search(league: string, query: object, priority: string): Promise<unknown>
  fetchListings(ids: string[], queryId: string, priority: string): Promise<unknown[]>
}

function makeClient(
  over: Partial<{
    idle: boolean
    ratio: number
    blocked: number
    sinceBlock: number
    total: number
  }> = {}
): FakeClient {
  const c: FakeClient = {
    idle: over.idle ?? true,
    ratio: over.ratio ?? 1,
    blocked: over.blocked ?? 0,
    sinceBlock: over.sinceBlock ?? Infinity,
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
    blockEndedAgoMs() {
      return this.sinceBlock
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
    now?: () => Date
    /** Default 0 nei test: tick consecutivi con lo stesso `now` non vengono saltati. */
    minSearchIntervalMs?: number
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
    now: opts.now ?? (() => now),
    log,
    minSearchIntervalMs: opts.minSearchIntervalMs ?? 0
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

  it('lavora solo con almeno il 60% del budget libero', async () => {
    expect(MIN_RATIO).toBe(0.6)
    const low = setup({ client: makeClient({ ratio: 0.55 }) })
    expect(await low.collector.tick()).toBe('skipped')
    expect(low.client.searches).toHaveLength(0)
    const ok = setup({ client: makeClient({ ratio: 0.6 }) })
    expect(await ok.collector.tick()).toBe('collected')
  })

  it('dopo un 429 o una restrizione resta ferma 15 minuti oltre la fine del blocco', async () => {
    expect(RESTRICTION_COOLDOWN_MS).toBe(15 * 60_000)
    const client = makeClient({ sinceBlock: RESTRICTION_COOLDOWN_MS - 1 })
    const { collector } = setup({ client })
    expect(await collector.tick()).toBe('skipped')
    expect(client.searches).toHaveLength(0)
    client.sinceBlock = RESTRICTION_COOLDOWN_MS
    expect(await collector.tick()).toBe('collected')
  })

  it('al massimo una ricerca ogni 60 s (tolleranza 2 s per il jitter del timer)', async () => {
    let t = now.getTime()
    expect(MIN_SEARCH_INTERVAL_MS).toBe(60_000)
    expect(SEARCH_INTERVAL_TOLERANCE_MS).toBe(2_000)
    const { client, collector } = setup({
      now: () => new Date(t),
      minSearchIntervalMs: MIN_SEARCH_INTERVAL_MS
    })
    expect(await collector.tick()).toBe('collected')
    t += 30_000
    expect(await collector.tick()).toBe('skipped')
    t += 27_999
    expect(await collector.tick()).toBe('skipped')
    t += 1
    expect(await collector.tick()).toBe('collected')
    expect(client.searches).toHaveLength(2)
  })

  it('con il timer reale la cadenza resta di una ricerca ogni 60 s, anche se il tick arriva in anticipo', async () => {
    vi.useFakeTimers()
    let skew = 0
    const { client, collector } = setup({
      // l'orologio del sistema corre qualche ms avanti o indietro rispetto al timer
      now: () => new Date(Date.now() + skew),
      minSearchIntervalMs: MIN_SEARCH_INTERVAL_MS
    })
    collector.start(COLLECT_INTERVAL_MS, 0)
    for (let i = 1; i <= 4; i++) {
      skew = i % 2 === 0 ? -50 : 50
      await vi.advanceTimersByTimeAsync(COLLECT_INTERVAL_MS)
      expect(client.searches).toHaveLength(i)
    }
    collector.stop()
  })

  it('una richiesta rifiutata perché il trade è in pausa è un giro saltato, senza log', async () => {
    const client = makeClient()
    client.search = async () => {
      throw tradePausedError()
    }
    const { collector, log } = setup({ client })
    expect(await collector.tick()).toBe('skipped')
    expect(log).not.toHaveBeenCalled()
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

  it('senza dati locali: nessun limite minimo sul valore, inserzioni più recenti prima (R28)', async () => {
    const { client, collector } = setup()
    await collector.tick()
    expect(client.searches[0].query.query.stats[0].filters[0].value).toEqual({})
    expect(client.searches[0].query.sort).toEqual({ indexed: 'desc' })
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
    collector.start(1000, 0)
    collector.start(1000, 0)
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
    collector.start(1000, 0)
    await vi.advanceTimersByTimeAsync(3500)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.searches).toHaveLength(1)
    collector.stop()
  })
})

/** Inserzioni finte di una classe (per i conteggi della league). */
function fill(store: ListingStore, itemClass: string, n: number, league = 'Standard'): void {
  store.upsert(
    Array.from({ length: n }, (_, i): Listing => ({
      id: `${league}-${itemClass}-${i}`,
      league,
      itemClass,
      baseType: 'x',
      itemLevel: 80,
      mods: [],
      openPrefixes: 0,
      openSuffixes: 0,
      priceAmount: 1,
      priceCurrency: 'exalted',
      priceExalted: 1,
      indexedAt: now.toISOString(),
      seenAt: now.toISOString()
    }))
  )
}

describe('BackgroundCollector: classi richieste', () => {
  const seeds = buildSeeds()
  const classes = [...new Set(seeds.map((s) => s.itemClass))]
  const seedsOf = (c: string): string[] =>
    seeds.filter((s) => s.itemClass === c).map((s) => s.statId)
  // una classe lontana dall'inizio del giro normale
  const target = classes[classes.length - 1]

  it('una classe con meno di KNN_MIN_LISTINGS inserzioni viene servita per prima, a turno sulle sue stat', async () => {
    const { client, store, collector } = setup()
    fill(store, target, KNN_MIN_LISTINGS - 1)
    collector.noteValuation(target)
    const n = seedsOf(target).length + 1
    for (let i = 0; i < n; i++) await collector.tick()
    for (let i = 0; i < n; i++) expect(classOf(client, i)).toBe(target)
    // tutti gli id della query (le stat con più id stanno in un gruppo "count")
    const idsOf = (i: number): string[] =>
      client.searches[i].query.query.stats.flatMap((g: Q) => g.filters.map((f: Q) => f.id))
    const expected = [...seedsOf(target), seedsOf(target)[0]]
    expected.forEach((statId, i) => expect(idsOf(i)).toContain(statId))
  })

  it('con almeno KNN_MIN_LISTINGS inserzioni la classe non viene richiesta', async () => {
    const { client, store, collector } = setup()
    fill(store, target, KNN_MIN_LISTINGS)
    collector.noteValuation(target)
    await collector.tick()
    expect(classOf(client, 0)).toBe(seeds[0].itemClass)
  })

  it('il conteggio è quello della league corrente', async () => {
    const { client, store, collector } = setup()
    fill(store, target, 100, 'Altra')
    collector.noteValuation(target)
    await collector.tick()
    expect(classOf(client, 0)).toBe(target)
  })

  it('arrivata a 2 × KNN_MIN_LISTINGS la classe esce e si torna al giro normale', async () => {
    const { client, store, collector } = setup()
    fill(store, target, 10)
    collector.noteValuation(target)
    await collector.tick()
    expect(classOf(client, 0)).toBe(target)
    fill(store, target, 2 * KNN_MIN_LISTINGS)
    await collector.tick()
    expect([classOf(client, 1), statOf(client, 1)]).toEqual([seeds[0].itemClass, seeds[0].statId])
  })

  it('una classe che non arriva a 2 × KNN_MIN_LISTINGS esce dopo due giri sulle sue stat', async () => {
    const { client, store, collector } = setup()
    fill(store, target, 10)
    collector.noteValuation(target)
    const max = 2 * seedsOf(target).length
    for (let i = 0; i < max + 1; i++) await collector.tick()
    for (let i = 0; i < max; i++) expect(classOf(client, i)).toBe(target)
    expect([classOf(client, max), statOf(client, max)]).toEqual([
      seeds[0].itemClass,
      seeds[0].statId
    ])
  })

  it('più classi richieste: servite a turno, la più recente prima; al massimo 5', async () => {
    expect(MAX_REQUESTED_CLASSES).toBe(5)
    const { client, collector } = setup()
    const req = classes.slice(0, 6)
    for (const c of req) collector.noteValuation(c)
    for (let i = 0; i < 6; i++) await collector.tick()
    // le 5 più recenti, dalla più recente; la prima richiesta è uscita
    const recent = [...req].reverse().slice(0, 5)
    expect(client.searches.slice(0, 5).map((_, i) => classOf(client, i))).toEqual(recent)
    expect(classOf(client, 5)).toBe(recent[0])
  })

  it('una classe richiesta di nuovo torna in testa', async () => {
    const { client, collector } = setup()
    collector.noteValuation(classes[0])
    collector.noteValuation(classes[1])
    collector.noteValuation(classes[0])
    await collector.tick()
    await collector.tick()
    await collector.tick()
    expect([0, 1, 2].map((i) => classOf(client, i))).toEqual([classes[0], classes[1], classes[0]])
  })

  it('classi senza pesi (nessun seed) vengono ignorate', async () => {
    const { client, collector } = setup()
    collector.noteValuation('flask')
    await collector.tick()
    expect(classOf(client, 0)).toBe(seeds[0].itemClass)
  })
})

describe('BackgroundCollector: pausa per le analisi approfondite', () => {
  it('non lavora durante una deep né nei 3 minuti dopo la fine', async () => {
    let t = now.getTime()
    const { client, collector } = setup({ now: () => new Date(t) })
    collector.deepStarted()
    expect(await collector.tick()).toBe('skipped')
    t += 10 * 60_000
    expect(await collector.tick()).toBe('skipped') // ancora in corso
    collector.deepEnded()
    t += DEEP_COOLDOWN_MS - 1
    expect(await collector.tick()).toBe('skipped')
    t += 1
    expect(await collector.tick()).toBe('collected')
    expect(client.searches).toHaveLength(1)
    expect(DEEP_COOLDOWN_MS).toBe(3 * 60_000)
  })

  it('due deep sovrapposte (una annullata): la pausa dura finché finiscono entrambe', async () => {
    let t = now.getTime()
    const { collector } = setup({ now: () => new Date(t) })
    collector.deepStarted()
    collector.deepStarted()
    collector.deepEnded()
    t += DEEP_COOLDOWN_MS
    expect(await collector.tick()).toBe('skipped')
    collector.deepEnded()
    t += DEEP_COOLDOWN_MS
    expect(await collector.tick()).toBe('collected')
  })

  it("start: nessun tick prima di 60 s dall'avvio, poi uno ogni 60 s", async () => {
    vi.useFakeTimers()
    expect(STARTUP_DELAY_MS).toBe(60_000)
    expect(COLLECT_INTERVAL_MS).toBe(60_000)
    const { client, collector } = setup()
    collector.start()
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + COLLECT_INTERVAL_MS - 1)
    expect(client.searches).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(client.searches).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(COLLECT_INTERVAL_MS)
    expect(client.searches).toHaveLength(2)
    collector.stop()
    await vi.advanceTimersByTimeAsync(100_000)
    expect(client.searches).toHaveLength(2)
  })

  it('stop prima della fine del ritardo iniziale: nessun tick', async () => {
    vi.useFakeTimers()
    const { client, collector } = setup()
    collector.start(1000)
    collector.stop()
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 5000)
    expect(client.searches).toHaveLength(0)
  })
})
