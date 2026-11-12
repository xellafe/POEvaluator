import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimiter } from '../../src/core/trade/rate-limiter'
import {
  loadRateLimiters,
  RATE_LIMITS_SAVE_DELAY_MS,
  RateLimitFile
} from '../../src/main/rate-limit-file'

const T0 = Date.parse('2026-11-12T12:00:00.000Z')

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'poe-ratelimits-'))
  path = join(dir, 'rate-limits.json')
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const EMPTY = { rules: [], requests: [], serverHits: [], blockedUntil: 0 }

function limiterAt(t: number): RateLimiter {
  const l = new RateLimiter(() => t)
  l.update(
    new Headers({
      'X-Rate-Limit-Rules': 'Ip',
      'X-Rate-Limit-Ip': '5:10:60,15:60:300',
      'X-Rate-Limit-Ip-State': '2:10:0,9:60:0'
    })
  )
  l.recordRequest()
  return l
}

describe('loadRateLimiters', () => {
  it('file assente: limiter vuoti per ogni endpoint', () => {
    const log = vi.fn()
    const l = loadRateLimiters(path, () => T0, log)
    for (const k of ['search', 'fetch', 'data'] as const) expect(l[k].toJSON()).toEqual(EMPTY)
    expect(log).not.toHaveBeenCalled()
  })

  it('file corrotto: limiter vuoti e una riga di log', () => {
    writeFileSync(path, '{ non json')
    const log = vi.fn()
    const l = loadRateLimiters(path, () => T0, log)
    expect(l.search.toJSON()).toEqual(EMPTY)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('ripristina lo stato salvato e scarta ciò che è scaduto', () => {
    const search = limiterAt(T0 - 30_000).toJSON()
    writeFileSync(path, JSON.stringify({ search, fetch: 'rotto' }))
    const l = loadRateLimiters(
      path,
      () => T0,
      () => {}
    )
    const s = l.search.toJSON()
    expect(s.rules).toHaveLength(2)
    // richiesta di 30 s fa: dentro la finestra di 60 s; stato della regola da 10 s scaduto
    expect(s.requests).toEqual([T0 - 30_000])
    expect(s.serverHits).toEqual([{ group: 'Ip', periodSec: 60, hits: 9, at: T0 - 30_000 }])
    expect(l.fetch.toJSON()).toEqual(EMPTY)
    expect(l.data.toJSON()).toEqual(EMPTY)
  })
})

describe('RateLimitFile', () => {
  it('scrive 2 s dopo l ultima risposta (debounce)', () => {
    vi.useFakeTimers()
    let n = 0
    const file = new RateLimitFile({
      path,
      snapshot: () => ({ n: ++n }),
      log: () => {}
    })
    file.schedule()
    vi.advanceTimersByTime(RATE_LIMITS_SAVE_DELAY_MS - 1)
    file.schedule()
    vi.advanceTimersByTime(RATE_LIMITS_SAVE_DELAY_MS - 1)
    expect(existsSync(path)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ n: 1 })
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('flush scrive subito e annulla la scrittura in attesa', () => {
    vi.useFakeTimers()
    let n = 0
    const file = new RateLimitFile({ path, snapshot: () => ({ n: ++n }), log: () => {} })
    file.schedule()
    file.flush()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ n: 1 })
    vi.advanceTimersByTime(RATE_LIMITS_SAVE_DELAY_MS * 2)
    expect(n).toBe(1)
  })

  it('un errore di scrittura viene loggato senza lanciare', () => {
    const log = vi.fn()
    const file = new RateLimitFile({
      path: join(dir, 'manca', 'rate-limits.json'),
      snapshot: () => ({}),
      log
    })
    expect(() => file.flush()).not.toThrow()
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('giro completo: lo snapshot salvato torna uguale al caricamento', () => {
    const search = limiterAt(T0)
    const file = new RateLimitFile({
      path,
      snapshot: () => ({ search: search.toJSON() }),
      log: () => {}
    })
    file.flush()
    const l = loadRateLimiters(
      path,
      () => T0,
      () => {}
    )
    expect(l.search.toJSON()).toEqual(search.toJSON())
  })
})
