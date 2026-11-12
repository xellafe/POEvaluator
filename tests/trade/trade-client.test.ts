import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimiter } from '../../src/core/trade/rate-limiter'
import {
  isAbortError,
  parseLeagues,
  TradeClient,
  tradeUrl
} from '../../src/core/trade/trade-client'

const UA = 'POEvaluator/0.1.0 (+test)'

type Call = { url: string; init: RequestInit }

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

function makeFetch(handler: (c: Call, n: number) => Response | Promise<Response>): {
  calls: Call[]
  impl: typeof fetch
} {
  const calls: Call[] = []
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} }
    calls.push(c)
    return handler(c, calls.length)
  })
  return { calls, impl: impl as unknown as typeof fetch }
}

const emptySearch = { id: 'q', result: [], total: 0 }

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('TradeClient', () => {
  it('search: POST sulla lega codificata con body JSON', async () => {
    const f = makeFetch(() => json({ id: 'q1', result: ['a', 'b'], total: 2 }))
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    const res = await client.search('Rise of the Abyssal', { query: {} }, 'user')
    expect(res).toEqual({ id: 'q1', result: ['a', 'b'], total: 2 })
    expect(f.calls[0].url).toBe(
      'https://www.pathofexile.com/api/trade2/search/poe2/Rise%20of%20the%20Abyssal'
    )
    expect(f.calls[0].init.method).toBe('POST')
    expect(f.calls[0].init.body).toBe(JSON.stringify({ query: {} }))
  })

  it('ogni richiesta ha lo User-Agent passato', async () => {
    const f = makeFetch((c) =>
      c.init.method === 'POST' ? json(emptySearch) : json({ result: [] })
    )
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    await client.search('Standard', {}, 'user')
    await client.fetchListings(['a'], 'q', 'user')
    expect(f.calls).toHaveLength(2)
    for (const c of f.calls) {
      expect((c.init.headers as Record<string, string>)['User-Agent']).toBe(UA)
    }
  })

  it('fetchListings con 23 id fa 3 GET (10+10+3) e concatena i risultati', async () => {
    const f = makeFetch((c) => {
      const ids = c.url.split('/fetch/')[1].split('?')[0].split(',')
      return json({ result: ids.map((id) => ({ id })) })
    })
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    const ids = Array.from({ length: 23 }, (_, i) => `id${i}`)
    const out = await client.fetchListings(ids, 'QID', 'user')
    expect(f.calls).toHaveLength(3)
    expect(f.calls.every((c) => c.init.method === 'GET')).toBe(true)
    expect(f.calls[0].url).toBe(
      `https://www.pathofexile.com/api/trade2/fetch/${ids.slice(0, 10).join(',')}?query=QID`
    )
    expect(out.map((o) => (o as { id: string }).id)).toEqual(ids)
  })

  it('fetchListings senza id non fa richieste', async () => {
    const f = makeFetch(() => json({ result: [] }))
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    expect(await client.fetchListings([], 'q', 'user')).toEqual([])
    expect(f.calls).toHaveLength(0)
  })

  it('una richiesta user parte prima di una background accodata prima (FIFO a pari priorità)', async () => {
    const order: string[] = []
    const f = makeFetch((c) => {
      order.push(JSON.parse(String(c.init.body)).tag)
      return json(emptySearch)
    })
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    const p1 = client.search('Standard', { tag: 'background' }, 'background')
    const p2 = client.search('Standard', { tag: 'stash' }, 'stash')
    const p3 = client.search('Standard', { tag: 'user' }, 'user')
    const p4 = client.search('Standard', { tag: 'user2' }, 'user')
    await vi.runAllTimersAsync()
    await Promise.all([p1, p2, p3, p4])
    expect(order).toEqual(['user', 'user2', 'stash', 'background'])
  })

  it('429 con Retry-After: 2 ripete dopo >= 2000 ms senza errore verso il chiamante', async () => {
    const f = makeFetch((_c, n) =>
      n === 1
        ? json({ error: 'rate' }, 429, { 'Retry-After': '2' })
        : json({ id: 'q', result: ['x'], total: 1 })
    )
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    const p = client.search('Standard', {}, 'user')
    await vi.advanceTimersByTimeAsync(1999)
    expect(f.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    const res = await p
    expect(f.calls).toHaveLength(2)
    expect(res.result).toEqual(['x'])
  })

  it('ogni 429 viene segnalato a onRateLimited con endpoint, tentativo e header', async () => {
    const f = makeFetch((_c, n) =>
      n === 1
        ? json({ error: 'rate' }, 429, {
            'Retry-After': '1',
            'X-Rate-Limit-Policy': 'trade-search-request-limit',
            'X-Rate-Limit-Rules': 'Ip',
            'X-Rate-Limit-Ip': '10:10:60',
            'X-Rate-Limit-Ip-State': '6:10:1'
          })
        : json({ id: 'q', result: [], total: 0 })
    )
    const seen: string[] = []
    const client = new TradeClient({
      userAgent: UA,
      fetchImpl: f.impl,
      onRateLimited: (kind, attempt, headers) => seen.push(`${kind}:${attempt} ${headers}`)
    })
    const p = client.search('Standard', {}, 'user')
    await vi.advanceTimersByTimeAsync(1000)
    await p
    expect(seen).toEqual([
      'search:1 policy=trade-search-request-limit rules=Ip Ip=10:10:60 Ip-State=6:10:1 Retry-After=1'
    ])
  })

  it('una risposta non 429 con restrizione attiva va a onRestriction, una normale no', async () => {
    const f = makeFetch((_c, n) =>
      json(emptySearch, 200, {
        'X-Rate-Limit-Policy': 'p',
        'X-Rate-Limit-Rules': 'Ip',
        'X-Rate-Limit-Ip': '10:10:60',
        'X-Rate-Limit-Ip-State': n === 1 ? '1:10:0' : '1:10:5'
      })
    )
    const seen: string[] = []
    const rateLimited: string[] = []
    const client = new TradeClient({
      userAgent: UA,
      fetchImpl: f.impl,
      onRestriction: (kind, headers) => seen.push(`${kind} ${headers}`),
      onRateLimited: (kind) => rateLimited.push(kind)
    })
    await client.search('Standard', {}, 'user')
    expect(seen).toEqual([])
    await client.search('Standard', {}, 'user')
    expect(seen).toEqual(['search policy=p rules=Ip Ip=10:10:60 Ip-State=1:10:5 Retry-After=-'])
    expect(rateLimited).toEqual([])
  })

  it('dopo 3 ripetizioni su 429 rifiuta con un errore chiaro', async () => {
    const f = makeFetch(() => json({}, 429, { 'Retry-After': '1' }))
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    const p = client.search('Standard', {}, 'user')
    const assertion = expect(p).rejects.toThrow(/429/)
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
    expect(f.calls).toHaveLength(4)
  })

  it('un errore HTTP non-429 rifiuta subito con status e corpo', async () => {
    const f = makeFetch(() => new Response('Bad query: boom', { status: 400 }))
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    await expect(client.search('Standard', {}, 'user')).rejects.toThrow(/400.*Bad query: boom/)
    expect(f.calls).toHaveLength(1)
  })

  it('rispetta il rate limiter: attende delayMs prima di inviare', async () => {
    const f = makeFetch(() =>
      json(emptySearch, 200, {
        'X-Rate-Limit-Rules': 'Ip',
        'X-Rate-Limit-Ip': '2:10:60',
        'X-Rate-Limit-Ip-State': '1:10:0'
      })
    )
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    await client.search('Standard', {}, 'user')
    const p = client.search('Standard', {}, 'user')
    await vi.advanceTimersByTimeAsync(100)
    expect(f.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_000)
    await p
    expect(f.calls).toHaveLength(2)
  })

  it('isIdle: falso con richieste user/stash in coda o in volo, vero con solo background', async () => {
    const f = makeFetch(() => json(emptySearch))
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    expect(client.isIdle()).toBe(true)
    const bg = client.search('Standard', {}, 'background')
    expect(client.isIdle()).toBe(true)
    const u = client.search('Standard', {}, 'user')
    expect(client.isIdle()).toBe(false)
    await vi.runAllTimersAsync()
    await Promise.all([bg, u])
    expect(client.isIdle()).toBe(true)
  })

  it('remainingRatio è il minimo tra i limiter di search e fetch', async () => {
    const rate = (hits: number): Record<string, string> => ({
      'X-Rate-Limit-Rules': 'Ip',
      'X-Rate-Limit-Ip': '10:10:60',
      'X-Rate-Limit-Ip-State': `${hits}:10:0`
    })
    const f = makeFetch((c) =>
      c.init.method === 'POST'
        ? json({ id: 'q', result: ['a'], total: 1 }, 200, rate(5))
        : json({ result: [] }, 200, rate(8))
    )
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    expect(client.remainingRatio()).toBe(1)
    await client.search('Standard', {}, 'user')
    expect(client.remainingRatio()).toBeCloseTo(0.5)
    await client.fetchListings(['a'], 'q', 'user')
    expect(client.remainingRatio()).toBeCloseTo(0.2)
  })

  it('blockedForMs: il blocco più lungo tra search e fetch', async () => {
    const f = makeFetch((c) =>
      c.init.method === 'POST'
        ? json({ id: 'q', result: ['a'], total: 1 }, 200, {
            'X-Rate-Limit-Rules': 'Ip',
            'X-Rate-Limit-Ip': '10:10:60',
            'X-Rate-Limit-Ip-State': '1:10:0'
          })
        : json({ result: [] }, 200, {
            'X-Rate-Limit-Rules': 'Ip',
            'X-Rate-Limit-Ip': '10:10:60',
            'X-Rate-Limit-Ip-State': '1:10:90'
          })
    )
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    expect(client.blockedForMs()).toBe(0)
    await client.search('Standard', {}, 'user')
    expect(client.blockedForMs()).toBe(0)
    await client.fetchListings(['a'], 'q', 'user')
    expect(client.blockedForMs()).toBe(90_000)
    expect(client.remainingRatio()).toBe(0)
  })
})

describe('timeout', () => {
  it('una richiesta bloccata va in timeout e la coda prosegue', async () => {
    const f = makeFetch((_c, n) =>
      n === 1 ? new Promise<Response>(() => {}) : json({ id: 'q', result: ['ok'], total: 1 })
    )
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    const p1 = client.search('Standard', {}, 'user')
    const a1 = expect(p1).rejects.toThrow(/timeout/)
    const p2 = client.search('Standard', {}, 'user')
    await vi.advanceTimersByTimeAsync(20_000)
    await a1
    expect((await p2).result).toEqual(['ok'])
    expect(f.calls).toHaveLength(2)
  })
})

describe('tradeUrl', () => {
  it('costruisce il link alla pagina di ricerca', () => {
    expect(tradeUrl('Rise of the Abyssal', 'abc')).toBe(
      'https://www.pathofexile.com/trade2/search/poe2/Rise%20of%20the%20Abyssal/abc'
    )
  })

  it('leagues: GET su data/leagues e restituisce solo gli id PoE2', async () => {
    const f = makeFetch(() =>
      json({
        result: [
          { id: 'Runes of Aldur', realm: 'poe2', text: 'Runes of Aldur' },
          { id: 'Standard', realm: 'poe2', text: 'Standard' },
          { id: 'Settlers', realm: 'pc', text: 'Settlers' },
          { id: 42 }
        ]
      })
    )
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    const p = client.leagues('user')
    await vi.advanceTimersByTimeAsync(0)
    expect(await p).toEqual(['Runes of Aldur', 'Standard'])
    expect(f.calls[0].url).toBe('https://www.pathofexile.com/api/trade2/data/leagues')
  })

  it('parseLeagues rifiuta una risposta senza result', () => {
    expect(() => parseLeagues({})).toThrow(/league/)
  })
})

describe('scheduler senza blocco in testa (D1)', () => {
  const blocked = (sec: number): RateLimiter => {
    const l = new RateLimiter()
    l.update(new Headers({ 'Retry-After': String(sec) }))
    return l
  }
  const tagOf = (c: Call): string => JSON.parse(String(c.init.body)).tag
  /** Finestra piena per `sec` secondi (attesa del solo limiter, nessun blocco globale). */
  const saturated = (sec: number): RateLimiter => {
    const l = new RateLimiter()
    l.update(new Headers({ 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': `2:${sec}:60` }))
    l.recordRequest()
    return l
  }

  it('un job background che attende il limiter fetch non ritarda un job user su search', async () => {
    const f = makeFetch((c) =>
      c.init.method === 'POST' ? json({ id: 'q', result: ['u'], total: 1 }) : json({ result: [] })
    )
    const client = new TradeClient({
      userAgent: UA,
      fetchImpl: f.impl,
      limiters: { fetch: saturated(60) }
    })
    const bg = client.fetchListings(['a'], 'q', 'background')
    await vi.advanceTimersByTimeAsync(10)
    const u = client.search('Standard', {}, 'user')
    await vi.advanceTimersByTimeAsync(10)
    expect((await u).result).toEqual(['u'])
    expect(f.calls.map((c) => c.init.method)).toEqual(['POST'])
    await vi.advanceTimersByTimeAsync(60_000)
    await bg
    expect(f.calls.map((c) => c.init.method)).toEqual(['POST', 'GET'])
  })

  it('un job background che attende il limiter fetch non ritarda le league (data)', async () => {
    const f = makeFetch((c) =>
      c.url.includes('/data/leagues')
        ? json({ result: [{ id: 'Standard', realm: 'poe2' }] })
        : json({ result: [] })
    )
    const client = new TradeClient({
      userAgent: UA,
      fetchImpl: f.impl,
      limiters: { fetch: saturated(120) }
    })
    void client.fetchListings(['a'], 'q', 'background')
    await vi.advanceTimersByTimeAsync(10)
    const p = client.leagues('user')
    await vi.advanceTimersByTimeAsync(10)
    expect(await p).toEqual(['Standard'])
  })

  it('un 429 con Retry-After su search ferma anche fetch e data fino alla scadenza (blocco globale)', async () => {
    let searchCalls = 0
    const f = makeFetch((c) => {
      if (c.url.includes('/data/leagues'))
        return json({ result: [{ id: 'Standard', realm: 'poe2' }] })
      if (c.init.method === 'GET') return json({ result: [{ id: 'a' }] })
      searchCalls++
      return searchCalls === 1
        ? json({}, 429, { 'Retry-After': '60' })
        : json({ id: 'q', result: ['s'], total: 1 })
    })
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    const s1 = client.search('Standard', {}, 'background')
    await vi.advanceTimersByTimeAsync(10)
    expect(f.calls).toHaveLength(1)
    expect(client.blockedForMs()).toBeGreaterThan(59_000)
    const g = client.fetchListings(['a'], 'q', 'user')
    const l = client.leagues('user')
    await vi.advanceTimersByTimeAsync(59_000)
    expect(f.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await g).toEqual([{ id: 'a' }])
    expect(await l).toEqual(['Standard'])
    expect((await s1).result).toEqual(['s'])
    // dopo il blocco: prima i job user, poi il background ripetuto
    expect(f.calls.map((c) => c.init.method)).toEqual(['POST', 'GET', 'GET', 'POST'])
  })

  it('una restrizione attiva nello -State di fetch ferma anche search', async () => {
    const f = makeFetch((c) =>
      c.init.method === 'GET'
        ? json({ result: [] }, 200, {
            'X-Rate-Limit-Rules': 'Ip',
            'X-Rate-Limit-Ip': '10:10:60',
            'X-Rate-Limit-Ip-State': '11:10:30'
          })
        : json(emptySearch)
    )
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    await client.fetchListings(['a'], 'q', 'user')
    const s = client.search('Standard', {}, 'user')
    await vi.advanceTimersByTimeAsync(29_999)
    expect(f.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await s
    expect(f.calls).toHaveLength(2)
  })

  it('un limiter caricato con un blocco in corso ferma tutta la coda', async () => {
    const f = makeFetch(() => json({ result: [] }))
    const client = new TradeClient({
      userAgent: UA,
      fetchImpl: f.impl,
      limiters: { data: blocked(20) }
    })
    expect(client.blockedForMs()).toBe(20_000)
    expect(client.remainingRatio()).toBe(0)
    const p = client.fetchListings(['a'], 'q', 'user')
    await vi.advanceTimersByTimeAsync(19_999)
    expect(f.calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(f.calls).toHaveLength(1)
  })

  it('un 429 rimette il job in coda: un job user sullo stesso limiter accodato dopo passa prima', async () => {
    const order: string[] = []
    const f = makeFetch((c, n) => {
      order.push(tagOf(c))
      return n === 1
        ? json({}, 429, { 'Retry-After': '5' })
        : json({ id: tagOf(c), result: [], total: 0 })
    })
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    const bg = client.search('Standard', { tag: 'bg' }, 'background')
    await vi.advanceTimersByTimeAsync(10)
    const u = client.search('Standard', { tag: 'user' }, 'user')
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.all([bg, u])
    expect(order).toEqual(['bg', 'user', 'bg'])
  })

  it('429 senza Retry-After: attesa di sicurezza di 1 s per tutta la coda, poi prima il job user', async () => {
    const f = makeFetch((c, n) => {
      if (c.init.method === 'GET') return json({ result: [] })
      return n === 1 ? json({}, 429) : json({ id: 'q', result: ['x'], total: 1 })
    })
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    const s = client.search('Standard', {}, 'background')
    await vi.advanceTimersByTimeAsync(10)
    const g = client.fetchListings(['a'], 'q', 'user')
    await vi.advanceTimersByTimeAsync(10)
    expect(f.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await g
    expect((await s).result).toEqual(['x'])
    expect(f.calls.map((c) => c.init.method)).toEqual(['POST', 'GET', 'POST'])
  })

  it('con il limiter bloccato, alla scadenza parte prima il job di priorità più alta (FIFO a parità)', async () => {
    const order: string[] = []
    const f = makeFetch((c) => {
      order.push(tagOf(c))
      return json(emptySearch)
    })
    const client = new TradeClient({
      userAgent: UA,
      fetchImpl: f.impl,
      limiters: { search: blocked(3) }
    })
    const ps = [
      client.search('Standard', { tag: 'bg' }, 'background'),
      client.search('Standard', { tag: 'u1' }, 'user'),
      client.search('Standard', { tag: 'stash' }, 'stash'),
      client.search('Standard', { tag: 'u2' }, 'user')
    ]
    await vi.advanceTimersByTimeAsync(2_999)
    expect(order).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all(ps)
    expect(order).toEqual(['u1', 'u2', 'stash', 'bg'])
  })

  it('un job di priorità inferiore non usa il budget del limiter su cui attende un job più importante', async () => {
    // search consente una richiesta ogni 10 s (2:10): user e background competono per lo stesso budget
    const order: string[] = []
    const f = makeFetch((c) => {
      order.push(tagOf(c))
      return json(emptySearch, 200, {
        'X-Rate-Limit-Rules': 'Ip',
        'X-Rate-Limit-Ip': '2:10:60',
        'X-Rate-Limit-Ip-State': '1:10:0'
      })
    })
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    await client.search('Standard', { tag: 'first' }, 'user')
    const bg = client.search('Standard', { tag: 'bg' }, 'background')
    const u = client.search('Standard', { tag: 'user' }, 'user')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(order).toEqual(['first', 'user'])
    await vi.advanceTimersByTimeAsync(10_000)
    await Promise.all([bg, u])
    expect(order).toEqual(['first', 'user', 'bg'])
  })

  it('un enqueue risveglia il pump in attesa e un job pronto parte subito', async () => {
    const f = makeFetch((c) =>
      c.init.method === 'POST' ? json(emptySearch) : json({ result: [] })
    )
    const client = new TradeClient({
      userAgent: UA,
      fetchImpl: f.impl,
      limiters: { search: saturated(300) }
    })
    void client.search('Standard', {}, 'background')
    await vi.advanceTimersByTimeAsync(1_000)
    const p = client.fetchListings(['a'], 'q', 'stash')
    await vi.advanceTimersByTimeAsync(0)
    await p
    expect(f.calls.map((c) => c.init.method)).toEqual(['GET'])
  })

  it('una sola richiesta HTTP in volo alla volta, anche su endpoint diversi', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const f = makeFetch(async (c) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 50))
      inFlight--
      if (c.url.includes('/data/leagues')) return json({ result: [] })
      return c.init.method === 'POST' ? json(emptySearch) : json({ result: [] })
    })
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    const ps = [
      client.search('Standard', {}, 'background'),
      client.fetchListings(['a', 'b'], 'q', 'user'),
      client.leagues('stash'),
      client.search('Standard', {}, 'user')
    ]
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.all(ps)
    expect(f.calls).toHaveLength(4)
    expect(maxInFlight).toBe(1)
  })
})

describe('annullamento (signal)', () => {
  it('con il signal già annullato rifiuta con AbortError senza richieste', async () => {
    const f = makeFetch(() => json(emptySearch))
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    const ac = new AbortController()
    ac.abort()
    const err = await client.search('Standard', {}, 'user', ac.signal).catch((e) => e)
    expect(isAbortError(err)).toBe(true)
    await vi.runAllTimersAsync()
    expect(f.calls).toHaveLength(0)
  })

  it('i job in coda vengono tolti e rifiutati con AbortError; gli altri proseguono', async () => {
    const order: string[] = []
    const f = makeFetch((c) => {
      order.push(c.url)
      return c.init.method === 'POST' ? json(emptySearch) : json({ result: [{ id: 'x' }] })
    })
    const client = new TradeClient({
      userAgent: UA,
      fetchImpl: f.impl,
      limiters: {
        fetch: (() => {
          const l = new RateLimiter()
          l.update(new Headers({ 'Retry-After': '30' }))
          return l
        })()
      }
    })
    const ac = new AbortController()
    const mine = client.fetchListings(['a', 'b'], 'q', 'user', ac.signal)
    const other = client.fetchListings(['c'], 'q', 'background')
    const mineErr = mine.catch((e) => e)
    await vi.advanceTimersByTimeAsync(10)
    expect(client.isIdle()).toBe(false)
    ac.abort()
    expect(isAbortError(await mineErr)).toBe(true)
    expect(client.isIdle()).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await other).toEqual([{ id: 'x' }])
    expect(order).toHaveLength(1)
    expect(order[0]).toContain('/fetch/c?')
  })

  it('la richiesta in volo si completa ma il risultato si scarta (AbortError)', async () => {
    const f = makeFetch(async () => {
      await new Promise((r) => setTimeout(r, 100))
      return json({ id: 'q', result: ['x'], total: 1 })
    })
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    const ac = new AbortController()
    const err = client.search('Standard', {}, 'user', ac.signal).catch((e) => e)
    await vi.advanceTimersByTimeAsync(10)
    expect(f.calls).toHaveLength(1)
    ac.abort()
    await vi.advanceTimersByTimeAsync(100)
    expect(isAbortError(await err)).toBe(true)
    expect(f.calls).toHaveLength(1)
  })

  it('un job rimesso in coda dopo un 429 viene tolto se annullato', async () => {
    const f = makeFetch(() => json({}, 429, { 'Retry-After': '10' }))
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    const ac = new AbortController()
    const err = client.leagues('user', ac.signal).catch((e) => e)
    await vi.advanceTimersByTimeAsync(10)
    expect(f.calls).toHaveLength(1)
    ac.abort()
    expect(isAbortError(await err)).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.calls).toHaveLength(1)
  })
})

describe('budget background (50% di ogni regola)', () => {
  it('un job background già in coda non parte se supererebbe il 50%; un job user sì', async () => {
    const order: string[] = []
    const f = makeFetch((c) => {
      order.push(JSON.parse(String(c.init.body)).tag)
      return json(emptySearch, 200, {
        'X-Rate-Limit-Rules': 'Ip',
        'X-Rate-Limit-Ip': '4:10:60'
      })
    })
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    // 4:10 → background al massimo 2 hit nella finestra
    const ps = [
      client.search('Standard', { tag: 'b1' }, 'background'),
      client.search('Standard', { tag: 'b2' }, 'background'),
      client.search('Standard', { tag: 'b3' }, 'background')
    ]
    await vi.advanceTimersByTimeAsync(100)
    expect(order).toEqual(['b1', 'b2'])
    const u = client.search('Standard', { tag: 'u' }, 'user')
    await vi.advanceTimersByTimeAsync(10)
    await u
    expect(order).toEqual(['b1', 'b2', 'u'])
    await vi.advanceTimersByTimeAsync(10_000)
    await Promise.all(ps)
    expect(order).toEqual(['b1', 'b2', 'u', 'b3'])
  })
})

describe('stato dei limiter', () => {
  it('blockEndedAgoMs: il blocco più recente tra i limiter', async () => {
    const f = makeFetch((_c, n) =>
      n === 1 ? json({}, 429, { 'Retry-After': '10' }) : json({ result: [] })
    )
    const client = new TradeClient({ userAgent: UA, fetchImpl: f.impl })
    expect(client.blockEndedAgoMs()).toBe(Infinity)
    const p = client.fetchListings(['a'], 'q', 'user')
    await vi.advanceTimersByTimeAsync(10)
    expect(client.blockEndedAgoMs()).toBeLessThan(0)
    await vi.advanceTimersByTimeAsync(10_000)
    await p
    await vi.advanceTimersByTimeAsync(5_000)
    expect(client.blockEndedAgoMs()).toBeGreaterThanOrEqual(5_000)
  })

  it('onResponse dopo ogni risposta (anche 429); snapshot con lo stato di ogni endpoint', async () => {
    const f = makeFetch((_c, n) =>
      n === 1
        ? json({}, 429, { 'Retry-After': '1' })
        : json(emptySearch, 200, { 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': '8:10:60' })
    )
    let responses = 0
    const client = new TradeClient({
      userAgent: UA,
      fetchImpl: f.impl,
      onResponse: () => responses++
    })
    const p = client.search('Standard', {}, 'user')
    await vi.advanceTimersByTimeAsync(1_000)
    await p
    expect(responses).toBe(2)
    const snap = client.snapshot()
    expect(Object.keys(snap).sort()).toEqual(['data', 'fetch', 'search'])
    expect(snap.search.rules).toEqual([{ group: 'Ip', maxHits: 8, periodSec: 10, restrictSec: 60 }])
    expect(snap.search.requests).toHaveLength(2)
    expect(snap.fetch.requests).toEqual([])
  })
})
