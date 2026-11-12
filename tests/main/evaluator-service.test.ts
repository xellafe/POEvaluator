import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ListingStore } from '../../src/core/db/listing-store'
import { initParserData } from '../../src/core/parser/parse-item'
import type { CurrencyRates } from '../../src/core/pricing/currency'
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings'
import type { TradeClient } from '../../src/core/trade/trade-client'
import {
  EvaluatorService,
  MESSAGES,
  RATES_REFRESH_MS,
  RATES_TIMEOUT_MS
} from '../../src/main/evaluator-service'

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/trade/fetch-response.json', import.meta.url), 'utf8')
) as { result: unknown[] }
const rareBoots = readFileSync(join(__dirname, '../fixtures/items/rare-boots.txt'), 'utf8')
const unidentified = readFileSync(join(__dirname, '../fixtures/items/unidentified.txt'), 'utf8')
const unique = readFileSync(join(__dirname, '../fixtures/items/unique.txt'), 'utf8')

beforeAll(async () => {
  await initParserData(join(__dirname, '../../data/en'))
})

const NOW = new Date('2026-11-12T12:00:00.000Z')
const RATES: CurrencyRates = {
  league: 'Standard',
  fetchedAt: '2026-11-12T11:00:00.000Z',
  exaltedPer: { exalted: 1, divine: 250 }
}

interface FakeClient {
  searches: number
  fetches: number
  fail: boolean
  blocked: number
  blockedForMs(): number
  search(): Promise<unknown>
  fetchListings(ids: string[]): Promise<unknown[]>
}

function makeClient(): FakeClient {
  return {
    searches: 0,
    fetches: 0,
    fail: false,
    blocked: 0,
    blockedForMs() {
      return this.blocked
    },
    async search() {
      this.searches++
      if (this.fail) throw new Error('HTTP 503')
      return { id: 'q1', total: 50, result: ['a', 'b', 'c'] }
    },
    async fetchListings(ids: string[]) {
      this.fetches++
      return fixture.result.slice(0, ids.length)
    }
  }
}

let store: ListingStore
let client: FakeClient

beforeEach(() => {
  store = new ListingStore(':memory:')
  client = makeClient()
})

afterEach(() => {
  store.close()
  vi.useRealTimers()
})

function service(
  fetchRates: () => Promise<CurrencyRates> = () => new Promise(() => {}),
  settings: () => Settings = () => DEFAULT_SETTINGS
): EvaluatorService {
  return new EvaluatorService({
    client: client as unknown as TradeClient,
    store,
    settings,
    fetchRates,
    now: () => NOW,
    log: () => {}
  })
}

/** Servizio con i tassi già caricati. */
async function withRates(): Promise<EvaluatorService> {
  const s = service(async () => RATES)
  await s.init()
  await s.refreshRates()
  return s
}

describe('EvaluatorService.quick', () => {
  it('testo vuoto: messaggio e nessuna chiamata al client', () => {
    const r = service().quick('')
    expect(r).toEqual({ ok: false, ...MESSAGES.empty })
    expect(MESSAGES.empty).toEqual({
      title: 'Impossibile valutare',
      message: 'Nessun oggetto trovato: tieni il mouse sopra un oggetto e riprova'
    })
    expect(client.searches + client.fetches).toBe(0)
  })

  it('messaggi per gli altri errori del parser', () => {
    const s = service()
    expect(s.quick('ciao')).toEqual({
      ok: false,
      title: 'Impossibile valutare',
      message: 'Il testo copiato non è un oggetto di PoE2'
    })
    expect(s.quick(unidentified)).toEqual({
      ok: false,
      title: 'Impossibile valutare',
      message: "L'oggetto non è identificato"
    })
    expect(s.quick(unique)).toEqual({
      ok: false,
      title: 'Oggetto non supportato',
      message: 'Per ora valuto solo gli oggetti rari'
    })
    expect(MESSAGES.unsupported_item).toEqual({
      title: 'Oggetto non supportato',
      message: 'Questo tipo di oggetto non è ancora supportato'
    })
    expect(MESSAGES.not_advanced).toEqual({
      title: 'Impossibile valutare',
      message: "Serve la descrizione avanzata: copia l'oggetto con Ctrl+Alt+C e riprova"
    })
    expect(MESSAGES.tradeError).toEqual({
      title: 'Impossibile valutare',
      message: 'La ricerca sul trade non è riuscita: riprova tra poco'
    })
  })

  it('raro: ok senza chiamate di rete', () => {
    const r = service().quick(rareBoots)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.item.itemClass).toBe('armour.boots')
    expect(r.valuation.verdict).toBeDefined()
    expect(client.searches + client.fetches).toBe(0)
  })
})

describe('EvaluatorService.deep', () => {
  it('prima dei tassi: errore esplicito senza cercare sul trade', async () => {
    const s = service()
    const r = await s.deep(rareBoots, () => {})
    expect(r).toEqual({
      ok: false,
      title: 'Impossibile valutare',
      message: 'Tassi di cambio non ancora disponibili: riprova tra poco'
    })
    expect(s.deepUnavailable()).toEqual(MESSAGES.noRates)
    expect(client.searches + client.fetches).toBe(0)
  })

  it('trade in pausa da più di 10 s: errore immediato con il tempo di attesa', async () => {
    const s = await withRates()
    client.blocked = 90_000
    expect(await s.deep(rareBoots, () => {})).toEqual({
      ok: false,
      title: 'Trade in pausa',
      message: 'Il sito del trade ha limitato le richieste: riprova tra 90 s'
    })
    client.blocked = 299_000
    expect(s.deepUnavailable()).toEqual({
      title: 'Trade in pausa',
      message: 'Il sito del trade ha limitato le richieste: riprova tra 5 min'
    })
    client.blocked = 120_000
    expect(s.deepUnavailable()?.message).toBe(
      'Il sito del trade ha limitato le richieste: riprova tra 2 min'
    )
    expect(client.searches).toBe(0)
    s.stop()
  })

  it("pausa breve (fino a 10 s): l'analisi parte e attende in coda", async () => {
    const s = await withRates()
    client.blocked = 10_000
    expect(s.deepUnavailable()).toBeNull()
    const r = await s.deep(rareBoots, () => {})
    expect(r?.ok).toBe(true)
    expect(client.searches).toBeGreaterThan(0)
    s.stop()
  })

  it('con i tassi caricati usa le inserzioni', async () => {
    const s = service(async () => RATES)
    await s.init()
    await s.refreshRates()
    const r = await s.deep(rareBoots, () => {})
    expect(r?.ok).toBe(true)
    if (!r?.ok) return
    expect(r.valuation.comparablesCount).toBeGreaterThan(0)
    s.stop()
  })

  it('testo non valido: messaggio senza rete', async () => {
    const r = await service().deep('', () => {})
    expect(r).toEqual({ ok: false, ...MESSAGES.empty })
    expect(client.searches).toBe(0)
  })

  it('errore del trade: ok:false con messaggio', async () => {
    const s = await withRates()
    client.fail = true
    const r = await s.deep(rareBoots, () => {})
    expect(r).toEqual({ ok: false, ...MESSAGES.tradeError })
    s.stop()
  })

  it('annullata: nessun risultato (null) e nessun avanzamento dopo l’annullamento', async () => {
    const s = await withRates()
    const ac = new AbortController()
    const search = client.search.bind(client)
    client.search = async () => {
      const r = await search()
      ac.abort()
      return r
    }
    const progress: number[] = []
    const r = await s.deep(rareBoots, (d) => progress.push(d), ac.signal)
    expect(r).toBeNull()
    expect(progress).toEqual([])
    s.stop()
  })
})

describe('EvaluatorService tassi', () => {
  it('init carica i tassi dallo store prima della rete', async () => {
    store.saveRates(RATES)
    const s = service()
    await s.init()
    expect(s.toExalted(2, 'divine')).toBe(500)
    s.stop()
  })

  it('refresh salva i tassi, il converter cambia; un errore tiene i vecchi', async () => {
    let next: () => Promise<CurrencyRates> = async () => RATES
    const s = service(() => next())
    await s.init()
    await s.refreshRates()
    expect(s.toExalted(1, 'divine')).toBe(250)
    expect(store.latestRates('Standard')?.exaltedPer.divine).toBe(250)
    next = async () => {
      throw new Error('rete giù')
    }
    await s.refreshRates()
    expect(s.toExalted(1, 'divine')).toBe(250)
    next = async () => ({ ...RATES, exaltedPer: { exalted: 1, divine: 300 } })
    await s.refreshRates()
    expect(s.toExalted(1, 'divine')).toBe(300)
    s.stop()
  })

  it('timeout di 20 s sul fetch dei tassi, aggiornamento ogni 30 min', async () => {
    vi.useFakeTimers()
    expect(RATES_TIMEOUT_MS).toBe(20_000)
    expect(RATES_REFRESH_MS).toBe(30 * 60 * 1000)
    let calls = 0
    const s = service(() => {
      calls++
      return new Promise(() => {})
    })
    await s.init()
    const pending = s.refreshRates()
    await vi.advanceTimersByTimeAsync(RATES_TIMEOUT_MS)
    await pending // risolve (non resta appeso) anche se fetchRates non risponde
    const before = calls
    await vi.advanceTimersByTimeAsync(RATES_REFRESH_MS)
    expect(calls).toBe(before + 1)
    s.stop()
  })

  it('cambio league senza tassi salvati: niente tassi vecchi (converter null)', async () => {
    store.saveRates(RATES)
    let settings: Settings = DEFAULT_SETTINGS
    const s = service(
      () => new Promise(() => {}),
      () => settings
    )
    await s.init()
    expect(s.toExalted(1, 'divine')).toBe(250)
    settings = { ...DEFAULT_SETTINGS, league: 'Dawn' }
    void s.reloadRates()
    expect(s.toExalted(1, 'divine')).toBeNull()
    s.stop()
  })

  it('cambio league durante un refresh in corso: secondo fetch subito per la nuova league', async () => {
    vi.useFakeTimers()
    let settings: Settings = DEFAULT_SETTINGS
    const calls: string[] = []
    const s = service(
      () => {
        const league = settings.league
        calls.push(league)
        return new Promise((r) =>
          setTimeout(() => r({ ...RATES, league, exaltedPer: { exalted: 1, divine: 100 } }), 1000)
        )
      },
      () => settings
    )
    await s.init() // fetch per Standard in volo
    expect(calls).toEqual(['Standard'])
    settings = { ...DEFAULT_SETTINGS, league: 'Dawn' }
    const reload = s.reloadRates()
    await vi.advanceTimersByTimeAsync(1000) // il fetch Standard termina (scartato)
    expect(calls).toEqual(['Standard', 'Dawn'])
    await vi.advanceTimersByTimeAsync(1000)
    await reload
    expect(s.toExalted(1, 'divine')).toBe(100)
    expect(store.latestRates('Dawn')?.exaltedPer.divine).toBe(100)
    expect(store.latestRates('Standard')).toBeNull()
    s.stop()
  })
})
