import { describe, expect, it } from 'vitest'
import {
  describeRateLimitHeaders,
  hasActiveRestriction,
  parseRateLimitHeaders,
  RateLimiter
} from '../../src/core/trade/rate-limiter'

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

  it('blockFor blocca per almeno il tempo indicato senza accorciare un blocco più lungo', () => {
    let t = 0
    const l = new RateLimiter(() => t)
    l.blockFor(1000)
    expect(l.delayMs()).toBe(1000)
    l.update(headers({ 'Retry-After': '5' }))
    l.blockFor(1000)
    expect(l.delayMs()).toBe(5000)
    t = 5000
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

describe('diagnostica degli header', () => {
  it('describeRateLimitHeaders: policy, regole, stati e Retry-After in una riga', () => {
    const line = describeRateLimitHeaders(
      headers({
        'X-Rate-Limit-Policy': 'trade-search-request-limit',
        'X-Rate-Limit-Rules': 'Ip,Account',
        'X-Rate-Limit-Ip': '8:10:60,15:60:120',
        'X-Rate-Limit-Ip-State': '9:10:60,9:60:0',
        'X-Rate-Limit-Account': '3:5:30',
        'X-Rate-Limit-Account-State': '1:5:0',
        'Retry-After': '60'
      })
    )
    expect(line).toBe(
      'policy=trade-search-request-limit rules=Ip,Account Ip=8:10:60,15:60:120 ' +
        'Ip-State=9:10:60,9:60:0 Account=3:5:30 Account-State=1:5:0 Retry-After=60'
    )
  })

  it('describeRateLimitHeaders: header assenti come "-"', () => {
    expect(describeRateLimitHeaders(headers({}))).toBe('policy=- rules=- Retry-After=-')
  })

  it('hasActiveRestriction: vero solo con il terzo numero di uno -State > 0', () => {
    expect(hasActiveRestriction(headers(BASE))).toBe(false)
    expect(
      hasActiveRestriction(headers({ ...BASE, 'X-Rate-Limit-Ip-State': '1:10:0,9:60:30' }))
    ).toBe(true)
  })
})

describe('budget delle richieste background (50% di ogni regola)', () => {
  it('8:10: background si ferma a 4 hit, user prosegue fino a 7', () => {
    const l = new RateLimiter(() => 0)
    l.update(headers({ 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': '8:10:60' }))
    for (let i = 0; i < 3; i++) l.recordRequest()
    // 3 hit: la quarta porta al 50% esatto, consentita
    expect(l.delayMs(true)).toBe(0)
    l.recordRequest()
    // 4 hit: la quinta supererebbe il 50%
    expect(l.delayMs(true)).toBe(10_000)
    expect(l.delayMs()).toBe(0)
  })

  it('usa anche lo stato del server e la regola più stretta', () => {
    const l = new RateLimiter(() => 0)
    l.update(
      headers({
        'X-Rate-Limit-Rules': 'Ip',
        'X-Rate-Limit-Ip': '20:10:60,5:60:120',
        'X-Rate-Limit-Ip-State': '1:10:0,2:60:0'
      })
    )
    // 5:60 → al massimo 2 hit (floor 2.5): con 2 hit nel server il background attende
    expect(l.delayMs(true)).toBe(60_000)
    expect(l.delayMs()).toBe(0)
  })
})

describe('fine del blocco', () => {
  it('blockEndedAgoMs: Infinity senza blocchi, negativo durante, positivo dopo', () => {
    let t = 1000
    const l = new RateLimiter(() => t)
    expect(l.blockEndedAgoMs()).toBe(Infinity)
    l.update(headers({ 'Retry-After': '10' }))
    expect(l.blockEndedAgoMs()).toBe(-10_000)
    t = 31_000
    expect(l.blockEndedAgoMs()).toBe(20_000)
  })
})

describe('stato persistente (toJSON / fromJSON)', () => {
  const RULES = { 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': '8:10:60,15:300:120' }

  it('ripristina regole, richieste recenti, stato del server e blocco', () => {
    let t = 1_000_000
    const l = new RateLimiter(() => t)
    l.update(headers({ ...RULES, 'X-Rate-Limit-Ip-State': '3:10:0,12:300:0' }))
    l.recordRequest()
    l.update(headers({ 'Retry-After': '30' }))
    const json = JSON.parse(JSON.stringify(l.toJSON()))
    t += 5_000
    const r = RateLimiter.fromJSON(json, () => t)
    expect(r.toJSON()).toEqual(l.toJSON())
    expect(r.blockedForMs()).toBe(25_000)
    // 12 hit su 15 nei 300 s: anche finito il blocco, sotto il tetto 14 ma ratio ridotto
    t += 25_000
    expect(r.remainingRatio()).toBeCloseTo(3 / 15)
  })

  it('scarta richieste e stati del server fuori dalla finestra più lunga', () => {
    let t = 1_000_000
    const l = new RateLimiter(() => t)
    l.update(headers({ ...RULES, 'X-Rate-Limit-Ip-State': '7:10:0,7:300:0' }))
    l.recordRequest()
    const json = l.toJSON()
    t += 301_000
    const r = RateLimiter.fromJSON(json, () => t)
    expect(r.toJSON().requests).toEqual([])
    expect(r.toJSON().serverHits).toEqual([])
    expect(r.toJSON().rules).toHaveLength(2)
    expect(r.delayMs()).toBe(0)
    expect(r.remainingRatio()).toBe(1)
  })

  it('le richieste della sessione precedente contano ancora nella finestra (H1)', () => {
    let t = 1_000_000
    const l = new RateLimiter(() => t)
    l.update(headers({ 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': '3:60:60' }))
    l.recordRequest()
    l.recordRequest()
    t += 20_000
    const r = RateLimiter.fromJSON(l.toJSON(), () => t)
    // tetto 2 raggiunto: si attende che la prima esca dalla finestra (40 s)
    expect(r.delayMs()).toBe(40_000)
  })

  it('input non valido: stato vuoto senza lanciare', () => {
    for (const bad of [null, 'x', 42, { rules: 'no' }, { rules: [{ maxHits: 'a' }] }]) {
      const r = RateLimiter.fromJSON(bad, () => 0)
      expect(r.toJSON()).toEqual({ rules: [], requests: [], serverHits: [], blockedUntil: 0 })
    }
  })

  it('voci malformate scartate, le valide restano', () => {
    const r = RateLimiter.fromJSON(
      {
        rules: [{ group: 'Ip', maxHits: 8, periodSec: 10, restrictSec: 60 }, { group: 1 }],
        requests: [5000, 'x', -1],
        serverHits: [{ group: 'Ip', periodSec: 10, hits: 2, at: 4000 }, { hits: 'a' }],
        blockedUntil: 'nope'
      },
      () => 6000
    )
    expect(r.toJSON()).toEqual({
      rules: [{ group: 'Ip', maxHits: 8, periodSec: 10, restrictSec: 60 }],
      requests: [5000],
      serverHits: [{ group: 'Ip', periodSec: 10, hits: 2, at: 4000 }],
      blockedUntil: 0
    })
  })
})
