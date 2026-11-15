import { describe, expect, it } from 'vitest'
import type { Listing } from '../../src/core/types'
import {
  learnAllClasses,
  learnClassWeights,
  MIN_CLASS_LISTINGS,
  solveLinear
} from '../../src/core/valuation/learned-weights'

const UP = 'explicit.stat_up'
const DOWN = 'explicit.stat_down'
const NOISE = 'explicit.stat_noise'
const NEW = 'explicit.stat_new'
const LVL = 'explicit.stat_lvl'

/** Generatore pseudo-casuale deterministico (LCG) per dati sintetici ripetibili. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

let nextId = 0
function listing(
  mods: { statId: string; value: number }[],
  priceExalted: number,
  over: Partial<Listing> = {}
): Listing {
  return {
    id: `l${nextId++}`,
    league: 'L',
    itemClass: 'armour.boots',
    baseType: 'B',
    itemLevel: 80,
    mods,
    openPrefixes: 0,
    openSuffixes: 0,
    priceAmount: priceExalted,
    priceCurrency: 'exalted',
    priceExalted,
    indexedAt: '2026-11-10T00:00:00.000Z',
    seenAt: '2026-11-10T00:00:00.000Z',
    ...over
  }
}

/**
 * N inserzioni: UP (presente nella metà, roll pieno) raddoppia il prezzo, DOWN lo dimezza, NOISE
 * non conta; rumore log-normale piccolo.
 */
function synthetic(
  n: number,
  seed = 1,
  extra?: (r: () => number) => { statId: string; value: number }[]
): Listing[] {
  const r = rng(seed)
  const out: Listing[] = []
  for (let i = 0; i < n; i++) {
    const mods: { statId: string; value: number }[] = []
    let lnP = Math.log(10) + (r() - 0.5) * 0.2
    if (r() < 0.5) {
      mods.push({ statId: UP, value: 40 })
      lnP += Math.log(2)
    }
    if (r() < 0.5) {
      mods.push({ statId: DOWN, value: 20 })
      lnP -= Math.log(2)
    }
    if (r() < 0.5) mods.push({ statId: NOISE, value: 10 })
    for (const m of extra?.(r) ?? []) {
      mods.push(m)
      if (m.statId === NEW) lnP += Math.log(5)
    }
    out.push(listing(mods, Math.exp(lnP)))
  }
  return out
}

describe('solveLinear', () => {
  it('risolve un sistema con pivot parziale', () => {
    const x = solveLinear(
      [
        [0, 2, 1],
        [1, 1, 0],
        [2, 0, 3]
      ],
      [7, 3, 11]
    )
    expect(x[0]).toBeCloseTo(1)
    expect(x[1]).toBeCloseTo(2)
    expect(x[2]).toBeCloseTo(3)
  })
})

describe('learnClassWeights', () => {
  it('la stat con l effetto maggiore prende il peso massimo della tabella (stessa scala)', () => {
    const res = learnClassWeights(synthetic(400), { [UP]: 0.3, [NOISE]: 0.8 })!
    const up = res.report.find((r) => r.statId === UP)!
    // UP raddoppia il prezzo ed è l'effetto più forte: peso appreso = massimo della tabella (0,8)
    expect(up.learned).toBeCloseTo(0.8, 2)
    expect(up.effect).toBeGreaterThan(1.8)
    expect(up.effect).toBeLessThan(2.1)
    expect(up.alpha).toBe(1)
  })

  it('una stat che abbassa il prezzo → peso appreso 0', () => {
    const res = learnClassWeights(synthetic(400), { [DOWN]: 0.6 })!
    const down = res.report.find((r) => r.statId === DOWN)!
    expect(down.learned).toBe(0)
    expect(down.effect).toBeLessThan(0.6)
    // alpha 1 (n e N alti): il peso appreso è 0, ma un affisso della tabella non scende sotto
    // metà del suo peso
    expect(res.weights[DOWN]).toBe(0.3)
  })

  it('nessun affisso alza il prezzo di almeno ×1,2: restano i pesi della tabella', () => {
    const flat = synthetic(400).map((l) => ({ ...l, priceExalted: 10 }))
    const res = learnClassWeights(flat, { [UP]: 0.7, [DOWN]: 0.4 })!
    expect(res.weights[UP]).toBe(0.7)
    expect(res.weights[DOWN]).toBe(0.4)
  })

  it('con poche inserzioni (alpha piccolo) il peso resta vicino al prior', () => {
    const res = learnClassWeights(synthetic(60), { [UP]: 0.9 })!
    const up = res.report.find((r) => r.statId === UP)!
    expect(up.alpha).toBeLessThan(0.3)
    expect(Math.abs(res.weights[UP] - 0.9)).toBeLessThan(0.3 * 0.9)
  })

  it('stat assente dalla tabella con n alto ed effetto forte → entra', () => {
    const res = learnClassWeights(
      synthetic(400, 3, (r) => (r() < 0.2 ? [{ statId: NEW, value: 7 }] : [])),
      {}
    )!
    expect(res.weights[NEW]).toBeGreaterThanOrEqual(0.2)
    // senza prior, stat irrilevanti o negative non entrano
    expect(res.weights[NOISE]).toBeUndefined()
    expect(res.weights[DOWN]).toBeUndefined()
  })

  it('stat assente dalla tabella con n < 15 → non entra', () => {
    let count = 0
    const res = learnClassWeights(
      synthetic(400, 3, () => (count++ < 12 ? [{ statId: NEW, value: 7 }] : [])),
      {}
    )!
    expect(res.report.find((r) => r.statId === NEW)?.n).toBe(12)
    expect(res.weights[NEW]).toBeUndefined()
  })

  it('stat della tabella con meno di 8 inserzioni: resta il prior', () => {
    let count = 0
    const res = learnClassWeights(
      synthetic(400, 3, () => (count++ < 5 ? [{ statId: NEW, value: 7 }] : [])),
      { [NEW]: 0.45 }
    )!
    expect(res.weights[NEW]).toBe(0.45)
    expect(res.report.find((r) => r.statId === NEW)).toBeUndefined()
  })

  it("controllo dell'item level: prezzi che dipendono solo dal livello non pesano le stat correlate", () => {
    const r = rng(7)
    const data: Listing[] = []
    for (let i = 0; i < 400; i++) {
      const ilvl = 65 + Math.floor(r() * 21)
      // LVL compare (quasi) solo sugli oggetti di livello alto, ma non incide sul prezzo
      const mods = ilvl >= 80 || r() < 0.05 ? [{ statId: LVL, value: 3 }] : []
      data.push(listing(mods, Math.exp(1 + (6 * ilvl) / 100), { itemLevel: ilvl }))
    }
    const res = learnClassWeights(data, {})!
    const lvl = res.report.find((x) => x.statId === LVL)!
    expect(Math.abs(Math.log(lvl.effect))).toBeLessThan(0.05)
    expect(lvl.learned).toBeLessThan(0.02)
  })

  it("l'intensità del roll conta: un roll basso pesa meno di uno pieno", () => {
    // UP con roll da 10 a 40: il prezzo cresce con l'intensità
    const r = rng(11)
    const data: Listing[] = []
    for (let i = 0; i < 400; i++) {
      const v = 10 + Math.floor(r() * 31)
      data.push(listing([{ statId: UP, value: v }], Math.exp(2 + Math.log(4) * (v / 40))))
    }
    const res = learnClassWeights(data, {})!
    const up = res.report.find((x) => x.statId === UP)!
    // p90 dei roll ≈ 37: un roll pieno (x = 1) vale circa ×4^(37/40)
    expect(up.effect).toBeGreaterThan(3)
    expect(up.effect).toBeLessThan(4.2)
  })

  it('scarta i prezzi oltre 50 volte la mediana e quelli non positivi', () => {
    const data = synthetic(200)
    const clean = learnClassWeights(data, {})!
    const dirty = learnClassWeights(
      [
        ...data,
        listing([{ statId: NOISE, value: 10 }], 1e6),
        listing([{ statId: NOISE, value: 10 }], 0)
      ],
      {}
    )!
    expect(dirty.listings).toBe(200)
    expect(dirty.weights).toEqual(clean.weights)
  })

  it(`classe con meno di ${MIN_CLASS_LISTINGS} inserzioni → null`, () => {
    expect(learnClassWeights(synthetic(MIN_CLASS_LISTINGS - 1), {})).toBeNull()
    expect(learnClassWeights(synthetic(MIN_CLASS_LISTINGS), {})).not.toBeNull()
  })

  it('report ordinato per effetto decrescente; ignora gli affissi non explicit', () => {
    const data = synthetic(200).map((l) => ({
      ...l,
      mods: [...l.mods, { statId: 'pseudo.pseudo_total_life', value: 50 }]
    }))
    const res = learnClassWeights(data, {})!
    const effects = res.report.map((x) => x.effect)
    expect(effects).toEqual([...effects].sort((a, b) => b - a))
    expect(res.report.some((x) => x.statId.startsWith('pseudo.'))).toBe(false)
  })
})

describe('learnAllClasses', () => {
  it('raggruppa per classe e salta quelle con poche inserzioni', () => {
    const boots = synthetic(120)
    const gloves = synthetic(20).map((l) => ({ ...l, itemClass: 'armour.gloves' }))
    const res = learnAllClasses([...boots, ...gloves], {
      'armour.boots': { [UP]: 0.5 }
    })
    expect(Object.keys(res)).toEqual(['armour.boots'])
    expect(res['armour.boots'].listings).toBe(120)
    expect(res['armour.boots'].weights[UP]).toBeGreaterThan(0)
  })
})
