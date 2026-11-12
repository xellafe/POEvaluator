import { describe, expect, it } from 'vitest'
import { parseRateLimitHeaders, RateLimiter } from '../../src/core/trade/rate-limiter'

function headers(init: Record<string, string>): Headers {
  return new Headers(init)
}

const BASE = {
  'X-Rate-Limit-Rules': 'Ip',
  'X-Rate-Limit-Ip': '8:10:60,15:60:120',
  'X-Rate-Limit-Ip-State': '1:10:0,1:60:0'
}

describe('parseRateLimitHeaders', () => {
  it('legge regole e stati', () => {
    const { rules, state } = parseRateLimitHeaders(headers(BASE))
    expect(rules).toEqual([
      { group: 'Ip', maxHits: 8, periodSec: 10, restrictSec: 60 },
      { group: 'Ip', maxHits: 15, periodSec: 60, restrictSec: 120 }
    ])
    expect(state).toEqual([
      { group: 'Ip', hits: 1, periodSec: 10, activeRestrictionSec: 0 },
      { group: 'Ip', hits: 1, periodSec: 60, activeRestrictionSec: 0 }
    ])
  })

  it('gestisce più regole e nomi case-insensitive', () => {
    const { rules } = parseRateLimitHeaders(
      headers({
        'x-rate-limit-rules': 'Ip,Account',
        'x-rate-limit-ip': '8:10:60',
        'x-rate-limit-account': '3:5:30'
      })
    )
    expect(rules).toHaveLength(2)
    expect(rules[1]).toEqual({ group: 'Account', maxHits: 3, periodSec: 5, restrictSec: 30 })
  })

  it('ignora header mancanti o malformati senza lanciare', () => {
    expect(parseRateLimitHeaders(headers({}))).toEqual({ rules: [], state: [] })
    const r = parseRateLimitHeaders(
      headers({ 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': 'abc,8:10:60' })
    )
    expect(r.rules).toEqual([{ group: 'Ip', maxHits: 8, periodSec: 10, restrictSec: 60 }])
  })
})

describe('RateLimiter', () => {
  it('prima di vedere header non ritarda', () => {
    const l = new RateLimiter(() => 0)
    l.recordRequest()
    expect(l.delayMs()).toBe(0)
    expect(l.remainingRatio()).toBe(1)
  })

  it('ritarda quando la finestra è piena (margine maxHits - 1)', () => {
    let t = 0
    const l = new RateLimiter(() => t)
    l.update(headers({ 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': '8:10:60' }))
    for (let i = 0; i < 8; i++) {
      l.recordRequest()
      t += 100
    }
    t = 1000
    const d = l.delayMs()
    expect(d).toBeGreaterThan(0)
    expect(d).toBeLessThanOrEqual(10000)
  })

  it('con 6 hit su 8 (sotto il tetto 7) non ritarda, con 7 sì', () => {
    const l = new RateLimiter(() => 0)
    l.update(headers({ 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': '8:10:60' }))
    for (let i = 0; i < 6; i++) l.recordRequest()
    expect(l.delayMs()).toBe(0)
    l.recordRequest()
    expect(l.delayMs()).toBe(10000)
  })

  it('la finestra scorre: dopo il periodo si può richiamare', () => {
    let t = 0
    const l = new RateLimiter(() => t)
    l.update(headers({ 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': '8:10:60' }))
    for (let i = 0; i < 8; i++) l.recordRequest()
    t = 10001
    expect(l.delayMs()).toBe(0)
  })

  it('restrizione attiva nello stato', () => {
    const l = new RateLimiter(() => 0)
    l.update(
      headers({
        ...BASE,
        'X-Rate-Limit-Ip-State': '1:10:0,1:60:45'
      })
    )
    expect(l.delayMs()).toBe(45000)
  })

  it('Retry-After', () => {
    const l = new RateLimiter(() => 0)
    l.update(headers({ 'Retry-After': '30' }))
    expect(l.delayMs()).toBe(30000)
  })

  it('il blocco scade con il tempo', () => {
    let t = 0
    const l = new RateLimiter(() => t)
    l.update(headers({ 'Retry-After': '30' }))
    t = 12000
    expect(l.delayMs()).toBe(18000)
    t = 30000
    expect(l.delayMs()).toBe(0)
  })

  it('restrizione più lunga del periodo: remainingRatio 0 e blockedForMs fino alla fine del blocco', () => {
    let t = 0
    const l = new RateLimiter(() => t)
    l.update(headers({ ...BASE, 'X-Rate-Limit-Ip-State': '9:10:0,9:60:300' }))
    // scaduto il periodo della regola (60 s) il blocco di 300 s resta attivo
    t = 61_000
    expect(l.remainingRatio()).toBe(0)
    expect(l.blockedForMs()).toBe(239_000)
    t = 300_000
    expect(l.blockedForMs()).toBe(0)
    expect(l.remainingRatio()).toBe(1)
  })

  it('blockedForMs: 0 senza blocchi, Retry-After conta come blocco', () => {
    let t = 0
    const l = new RateLimiter(() => t)
    expect(l.blockedForMs()).toBe(0)
    l.update(headers({ 'Retry-After': '30' }))
    t = 10_000
    expect(l.blockedForMs()).toBe(20_000)
    expect(l.remainingRatio()).toBe(0)
  })

  it('remainingRatio con 4 hit su 8:10', () => {
    const l = new RateLimiter(() => 0)
    l.update(headers({ 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': '8:10:60' }))
    for (let i = 0; i < 4; i++) l.recordRequest()
    expect(l.remainingRatio()).toBe(0.5)
  })

  it('remainingRatio prende il minimo tra le regole', () => {
    const l = new RateLimiter(() => 0)
    l.update(headers({ 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': '8:10:60,4:60:60' }))
    for (let i = 0; i < 3; i++) l.recordRequest()
    expect(l.remainingRatio()).toBe(0.25)
  })

  it('si fida dello stato del server se supera il conteggio locale', () => {
    const l = new RateLimiter(() => 0)
    l.update(headers({ ...BASE, 'X-Rate-Limit-Ip-State': '7:10:0,1:60:0' }))
    expect(l.remainingRatio()).toBeCloseTo(1 / 8)
    expect(l.delayMs()).toBe(10000)
  })

  it('header malformati non cancellano le regole precedenti', () => {
    const l = new RateLimiter(() => 0)
    l.update(headers(BASE))
    l.update(headers({ 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': 'zzz' }))
    for (let i = 0; i < 4; i++) l.recordRequest()
    expect(l.remainingRatio()).toBeLessThan(1)
  })

  it('lo stato del server è separato per gruppo anche con lo stesso periodo', () => {
    const l = new RateLimiter(() => 0)
    l.update(
      headers({
        'X-Rate-Limit-Rules': 'Ip,Account',
        'X-Rate-Limit-Ip': '8:10:60',
        'X-Rate-Limit-Ip-State': '1:10:0',
        'X-Rate-Limit-Account': '3:10:30',
        'X-Rate-Limit-Account-State': '3:10:0'
      })
    )
    // Account è a 3/3 (tetto 2): blocca anche se Ip è a 1/8
    expect(l.delayMs()).toBe(10000)
    expect(l.remainingRatio()).toBe(0)
  })

  it('l ordine degli header dei gruppi non fa perdere lo stato di Ip', () => {
    const l = new RateLimiter(() => 0)
    l.update(
      headers({
        'X-Rate-Limit-Rules': 'Ip,Account',
        'X-Rate-Limit-Ip': '8:10:60',
        'X-Rate-Limit-Ip-State': '7:10:0',
        'X-Rate-Limit-Account': '3:10:30',
        'X-Rate-Limit-Account-State': '1:10:0'
      })
    )
    expect(l.delayMs()).toBe(10000)
    expect(l.remainingRatio()).toBeCloseTo(1 / 8)
  })
})
