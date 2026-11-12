import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ListingStore } from '../../src/core/db/listing-store'
import { initParserData } from '../../src/core/parser/parse-item'
import type { CurrencyRates } from '../../src/core/pricing/currency'
import { DEFAULT_SETTINGS } from '../../src/core/settings'
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
  search(): Promise<unknown>
  fetchListings(ids: string[]): Promise<unknown[]>
}

function makeClient(): FakeClient {
  return {
    searches: 0,
    fetches: 0,
    fail: false,
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
  fetchRates: () => Promise<CurrencyRates> = () => new Promise(() => {})
): EvaluatorService {
  return new EvaluatorService({
    client: client as unknown as TradeClient,
    store,
    settings: () => DEFAULT_SETTINGS,
    fetchRates,
    now: () => NOW,
    log: () => {}
  })
}

describe('EvaluatorService.quick', () => {
  it('testo vuoto: messaggio e nessuna chiamata al client', () => {
    const r = service().quick('')
    expect(r).toEqual({ ok: false, message: MESSAGES.empty })
    expect(MESSAGES.empty).toBe('Nessun oggetto copiato: passa il mouse su un oggetto e riprova')
    expect(client.searches + client.fetches).toBe(0)
  })

  it('messaggi per gli altri errori del parser', () => {
    const s = service()
    expect(s.quick('ciao')).toEqual({
      ok: false,
      message: 'Il testo copiato non è un oggetto di PoE2'
    })
    expect(s.quick(unidentified)).toEqual({ ok: false, message: 'Oggetto non identificato' })
    expect(s.quick(unique)).toEqual({ ok: false, message: 'Per ora valuto solo oggetti rari' })
    expect(MESSAGES.unsupported_item).toBe('Tipo di oggetto non ancora supportato')
    expect(MESSAGES.not_advanced).toBe("Copia l'oggetto con il testo avanzato (Ctrl+Alt+C)")
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
  it('prima dei tassi restituisce comunque una Valuation (inserzioni scartate → bassa)', async () => {
    const progress: [number, number][] = []
    const r = await service().deep(rareBoots, (d, t) => progress.push([d, t]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.valuation.confidence).toBe('bassa')
    expect(r.valuation.comparablesCount).toBe(0)
    expect(client.searches).toBeGreaterThan(0)
    expect(progress.length).toBeGreaterThan(0)
  })

  it('con i tassi caricati usa le inserzioni', async () => {
    const s = service(async () => RATES)
    await s.init()
    await s.refreshRates()
    const r = await s.deep(rareBoots, () => {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.valuation.comparablesCount).toBeGreaterThan(0)
    s.stop()
  })

  it('testo non valido: messaggio senza rete', async () => {
    const r = await service().deep('', () => {})
    expect(r).toEqual({ ok: false, message: MESSAGES.empty })
    expect(client.searches).toBe(0)
  })

  it('errore del trade: ok:false con messaggio', async () => {
    client.fail = true
    const r = await service().deep(rareBoots, () => {})
    expect(r).toEqual({ ok: false, message: MESSAGES.tradeError })
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
})
