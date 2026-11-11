import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  fetchRates,
  makeConverter,
  ninjaRatesUrl,
  type CurrencyRates
} from '../../src/core/pricing/currency'

const fixtureText = readFileSync(new URL('../fixtures/ninja-rates.json', import.meta.url), 'utf8')
const UA = 'POEvaluator/0.1.0 (+https://github.com/xellafe/POEvaluator)'

const okResponse = (body: string): typeof fetch =>
  vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch

const rates: CurrencyRates = {
  league: 'Test',
  fetchedAt: '2026-11-12T10:00:00.000Z',
  exaltedPer: { exalted: 1, divine: 250, chaos: 25 }
}

describe('makeConverter', () => {
  const conv = makeConverter(rates)
  it('converte con il tasso della valuta', () => {
    expect(conv(2, 'divine')).toBe(500)
    expect(conv(4, 'chaos')).toBe(100)
  })
  it('exalted è identità', () => {
    expect(conv(3.5, 'exalted')).toBe(3.5)
  })
  it('valuta assente → null', () => {
    expect(conv(1, 'mirror')).toBeNull()
    expect(conv(1, 'toString')).toBeNull()
  })
  it('importo non valido → null', () => {
    expect(conv(0, 'divine')).toBeNull()
    expect(conv(-1, 'divine')).toBeNull()
    expect(conv(Number.NaN, 'exalted')).toBeNull()
    expect(conv(Number.POSITIVE_INFINITY, 'exalted')).toBeNull()
  })
  it('senza tassi restituisce sempre null (anche per exalted)', () => {
    const none = makeConverter(null)
    expect(none(5, 'exalted')).toBeNull()
    expect(none(1, 'divine')).toBeNull()
  })
})

describe('fetchRates', () => {
  it('produce i tassi dalla fixture poe.ninja', async () => {
    const fetchImpl = okResponse(fixtureText)
    const r = await fetchRates('Forbidden Rites', fetchImpl, UA)
    expect(r.league).toBe('Forbidden Rites')
    expect(Number.isNaN(Date.parse(r.fetchedAt))).toBe(false)
    expect(r.exaltedPer.exalted).toBe(1)
    expect(r.exaltedPer.divine).toBeGreaterThan(1)
    expect(r.exaltedPer.divine).toBeCloseTo(620.1, 5)
    expect(r.exaltedPer.chaos).toBeCloseTo(62.01, 5)
    expect(r.exaltedPer.mirror).toBeGreaterThan(r.exaltedPer.divine)
    for (const v of Object.values(r.exaltedPer)) {
      expect(Number.isFinite(v) && v > 0).toBe(true)
    }
  })
  it('chiama l’URL corretto con User-Agent', async () => {
    const fetchImpl = okResponse(fixtureText)
    await fetchRates('Forbidden Rites', fetchImpl, UA)
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit
    ]
    expect(url).toBe(ninjaRatesUrl('Forbidden Rites'))
    expect(url).toContain('league=Forbidden%20Rites')
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(UA)
    expect(init.credentials).toBe('omit')
  })
  it('rifiuta su HTTP non OK', async () => {
    const f = vi.fn(async () => new Response('x', { status: 503 })) as unknown as typeof fetch
    await expect(fetchRates('L', f, UA)).rejects.toThrow(/503/)
  })
  it('rifiuta su JSON non valido o forma inattesa', async () => {
    await expect(fetchRates('L', okResponse('not json'), UA)).rejects.toThrow(/poe\.ninja/)
    await expect(fetchRates('L', okResponse('{}'), UA)).rejects.toThrow(/poe\.ninja/)
    await expect(
      fetchRates('L', okResponse('{"core":{"rates":{"exalted":0}},"lines":[]}'), UA)
    ).rejects.toThrow(/poe\.ninja/)
    await expect(
      fetchRates('L', okResponse('{"core":{"rates":{"exalted":600}},"lines":"x"}'), UA)
    ).rejects.toThrow(/poe\.ninja/)
  })
  it('scarta le righe malformate senza restituire valori spuri', async () => {
    const body = JSON.stringify({
      core: { rates: { exalted: 100 }, primary: 'divine' },
      lines: [{ id: 'chaos', primaryValue: 0.1 }, { id: 'bad', primaryValue: -1 }, { id: 5 }, null]
    })
    const r = await fetchRates('L', okResponse(body), UA)
    expect(r.exaltedPer).toEqual({ divine: 100, chaos: 10, exalted: 1 })
  })
})
