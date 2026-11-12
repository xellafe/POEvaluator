import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/core/settings'
import {
  cleanPrices,
  confidenceFor,
  parityPriceFor,
  percentile,
  priceFor,
  roundPrice,
  verdictFor
} from '../../src/core/valuation/price-strategy'

const T = DEFAULT_SETTINGS.thresholds

/*
 * Caso principale: [10,12,14,15,16,18,20,22,25,1000], n = 10, R-7 (h = (n-1)·p).
 *  Q1: h = 2.25 -> 14 + 0.25·(15-14) = 14.25
 *  Q3: h = 6.75 -> 20 + 0.75·(22-20) = 21.5
 *  IQR = 7.25; fence alta = 21.5 + 1.5·7.25 = 32.375; fence bassa = 14.25 - 10.875 = 3.375
 *  -> 1000 rimosso; pulito = [10,12,14,15,16,18,20,22,25] (n = 9)
 *  mediana (h = 4) = 16 -> buono (5 <= 16 < 50)
 *  suggested = p20: h = 1.6 -> 12 + 0.6·2 = 13.2 -> 13
 *  min = p10: h = 0.8 -> 10 + 0.8·2 = 11.6 -> 12
 *  max = p90: h = 7.2 -> 22 + 0.2·3 = 22.6 -> 23
 *  confidenza: n = 9 < 10 -> media
 */
const MAIN = [10, 12, 14, 15, 16, 18, 20, 22, 25, 1000]

describe('percentile', () => {
  it('interpola linearmente (R-7)', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25)
    expect(percentile([10, 20, 30, 40], 0)).toBe(10)
    expect(percentile([10, 20, 30, 40], 1)).toBe(40)
    expect(percentile([7], 0.9)).toBe(7)
  })
})

describe('roundPrice', () => {
  it('>= 10 a intero, < 10 a un decimale', () => {
    expect(roundPrice(13.2)).toBe(13)
    expect(roundPrice(22.6)).toBe(23)
    expect(roundPrice(9.96)).toBe(10)
    expect(roundPrice(4.26)).toBe(4.3)
  })
})

describe('cleanPrices', () => {
  it('rimuove outlier con Tukey', () => {
    expect(cleanPrices(MAIN)).toEqual([10, 12, 14, 15, 16, 18, 20, 22, 25])
  })
  it('con n < 4 restituisce l input ordinato senza filtrare', () => {
    expect(cleanPrices([1000, 1, 2])).toEqual([1, 2, 1000])
  })
  it('scarta valori non finiti e non positivi prima di tutto', () => {
    expect(cleanPrices([NaN, Infinity, -1, 0, 5, 3])).toEqual([3, 5])
  })
  it('restituisce ordinato crescente', () => {
    expect(cleanPrices([5, 4, 3, 2, 1])).toEqual([1, 2, 3, 4, 5])
  })
})

describe('confidenceFor', () => {
  it('alta: n >= 10 e IQR/mediana <= 0.5', () => {
    // [10..19]: Q1 12.25, Q3 16.75, IQR 4.5, mediana 14.5 -> 0.31
    expect(confidenceFor([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])).toBe('alta')
  })
  it('media: n >= 10 ma dispersione alta', () => {
    // Q1 1, Q3 10, IQR 9, mediana 5.5 -> 1.64
    expect(confidenceFor([1, 1, 1, 1, 1, 10, 10, 10, 10, 10])).toBe('media')
  })
  it('media: 4 <= n < 10', () => {
    expect(confidenceFor([10, 11, 12, 13])).toBe('media')
  })
  it('bassa: n < 4', () => {
    expect(confidenceFor([10, 11, 12])).toBe('bassa')
    expect(confidenceFor([])).toBe('bassa')
  })
})

describe('verdictFor', () => {
  it('confini: uguale alla soglia va alla classe superiore', () => {
    expect(verdictFor(4.99, T)).toBe('pessimo')
    expect(verdictFor(5, T)).toBe('buono')
    expect(verdictFor(49.99, T)).toBe('buono')
    expect(verdictFor(50, T)).toBe('ottimo')
    expect(verdictFor(299.99, T)).toBe('ottimo')
    expect(verdictFor(300, T)).toBe('eccellente')
  })
})

describe('priceFor', () => {
  it('caso principale: buono con p20/p10/p90', () => {
    expect(priceFor(MAIN, T)).toEqual({
      verdict: 'buono',
      confidence: 'media',
      price: { suggested: 13, min: 12, max: 23 },
      comparablesCount: 9,
      warnings: []
    })
  })

  it('ottimo usa p60', () => {
    // [40,50,60,70,80]: mediana 60; Q1 50, Q3 70, fence 20..100 (nessun outlier)
    // suggested p60: h = 2.4 -> 60 + 0.4·10 = 64; min p10: h = 0.4 -> 44; max p90: h = 3.6 -> 76
    expect(priceFor([40, 50, 60, 70, 80], T)).toEqual({
      verdict: 'ottimo',
      confidence: 'media',
      price: { suggested: 64, min: 44, max: 76 },
      comparablesCount: 5,
      warnings: []
    })
  })

  it('eccellente usa p75 e aggiunge il warning', () => {
    // [400,400,400,400]: tutti i percentili = 400
    expect(priceFor([400, 400, 400, 400], T)).toEqual({
      verdict: 'eccellente',
      confidence: 'media',
      price: { suggested: 400, min: 400, max: 400 },
      comparablesCount: 4,
      warnings: ['Pochi oggetti simili in vendita: controlla il prezzo sul trade prima di venderlo']
    })
  })

  it('pessimo: nessun prezzo', () => {
    // [1,2,3,4,5]: mediana 3 < 5
    const r = priceFor([1, 2, 3, 4, 5], T)
    expect(r.verdict).toBe('pessimo')
    expect(r.price).toBeUndefined()
    expect(r.confidence).toBe('media')
    expect(r.comparablesCount).toBe(5)
    expect(r.warnings).toEqual([])
  })

  it('array vuoto: nessun verdetto (dati insufficienti, R26), bassa, nessun prezzo', () => {
    const r = priceFor([], T)
    expect(r).toEqual({
      verdict: null,
      confidence: 'bassa',
      comparablesCount: 0,
      warnings: []
    })
    expect(r.price).toBeUndefined()
  })

  it('un solo prezzo: verdetto dal prezzo, bassa, nessun prezzo', () => {
    expect(priceFor([60], T)).toEqual({
      verdict: 'ottimo',
      confidence: 'bassa',
      comparablesCount: 1,
      warnings: ['Troppo pochi oggetti simili sul mercato']
    })
  })

  it('stima 400 da pochi dati: eccellente + warning eccezionale', () => {
    const r = priceFor([380, 420], T)
    expect(r.verdict).toBe('eccellente')
    expect(r.warnings).toEqual([
      'Pochi oggetti simili in vendita: controlla il prezzo sul trade prima di venderlo'
    ])
    // mediana 400; p75 h = 0.75 -> 380 + 0.75·40 = 410
    expect(r.price).toEqual({ suggested: 410, min: 384, max: 416 })
  })

  it('un solo prezzo >= eccellente: entrambi i warning, nessun prezzo', () => {
    const r = priceFor([400], T)
    expect(r.verdict).toBe('eccellente')
    expect(r.confidence).toBe('bassa')
    expect(r.price).toBeUndefined()
    expect(r.warnings).toEqual([
      'Troppo pochi oggetti simili sul mercato',
      'Pochi oggetti simili in vendita: controlla il prezzo sul trade prima di venderlo'
    ])
  })
})

describe('parityPriceFor (analisi approfondita, confronto alla pari)', () => {
  const steps = (n: number, from: number, step: number): number[] =>
    Array.from({ length: n }, (_, i) => from + i * step)

  it('prezzo consigliato al 10° percentile, min al 5°, max al 50°, se puoi aspettare al 25° (R32)', () => {
    // 40..230 (nessun outlier su scala log): p10 = 59, p5 = 49.5, p50 = 135, p25 = 87.5
    const r = parityPriceFor(steps(20, 40, 10), T, { fullMatch: true })
    expect(r.price).toEqual({ suggested: 59, min: 50, max: 135, patient: 88 })
    expect(r.verdict).toBe('ottimo')
    expect(r.comparablesCount).toBe(20)
  })

  it('se puoi aspettare: solo se il p25 supera il consigliato di almeno il 20%', () => {
    // 20 prezzi da 100 a 119: p10 = 101.9, p25 = 104.75 (+3%)
    const r = parityPriceFor(steps(20, 100, 1), T, { fullMatch: true })
    expect(r.verdict).toBe('ottimo')
    expect(r.price?.patient).toBeUndefined()
  })

  it('se puoi aspettare: solo per Ottimo ed Eccellente', () => {
    // 10..48 (passo 2): p10 = 13.8 (Buono), p25 = 19.5
    const buono = parityPriceFor(steps(20, 10, 2), T, { fullMatch: true })
    expect(buono.verdict).toBe('buono')
    expect(buono.price?.patient).toBeUndefined()
    // 300..1250 (passo 50): p10 = 395 (Eccellente), p25 = 537.5
    const ecc = parityPriceFor(steps(20, 300, 50), T, { fullMatch: true })
    expect(ecc.verdict).toBe('eccellente')
    expect(ecc.price?.patient).toBe(538)
  })

  it('verdetto dal prezzo consigliato, non dalla mediana (niente circolarità)', () => {
    // mediana 310 (sarebbe Eccellente), p10 = 24.5 -> Buono
    const r = parityPriceFor([20, 25, 30, 40, 300, 320, 340, 360, 380, 400], T, {
      fullMatch: true
    })
    expect(r.verdict).toBe('buono')
    expect(r.price?.suggested).toBe(25)
  })

  it('Pessimo: nessun prezzo (decisione utente del Task 13)', () => {
    const r = parityPriceFor([1, 2, 2, 3, 4, 5], T, { fullMatch: true })
    expect(r.verdict).toBe('pessimo')
    expect(r.price).toBeUndefined()
  })

  it('meno di 3 prezzi puliti: nessun verdetto', () => {
    for (const prices of [[], [100], [100, 120]]) {
      const r = parityPriceFor(prices, T, { fullMatch: true })
      expect(r.verdict).toBeNull()
      expect(r.price).toBeUndefined()
      expect(r.confidence).toBe('bassa')
      expect(r.comparablesCount).toBe(prices.length)
    }
  })

  it('confidenza: alta con >= 15 prezzi e confronto pieno; media con >= 6; bassa altrimenti', () => {
    const p15 = steps(15, 10, 1)
    expect(parityPriceFor(p15, T, { fullMatch: true }).confidence).toBe('alta')
    expect(parityPriceFor(p15, T, { fullMatch: false }).confidence).toBe('media')
    expect(parityPriceFor(steps(14, 10, 1), T, { fullMatch: true }).confidence).toBe('media')
    expect(parityPriceFor(steps(6, 10, 1), T, { fullMatch: true }).confidence).toBe('media')
    expect(parityPriceFor(steps(5, 10, 1), T, { fullMatch: true }).confidence).toBe('bassa')
  })

  it('Eccellente: avviso solo con confidenza non alta', () => {
    const warn = 'Pochi oggetti simili in vendita: controlla il prezzo sul trade prima di venderlo'
    const high = parityPriceFor(steps(15, 400, 10), T, { fullMatch: true })
    expect(high.verdict).toBe('eccellente')
    expect(high.warnings).toEqual([])
    const low = parityPriceFor(steps(5, 400, 10), T, { fullMatch: true })
    expect(low.verdict).toBe('eccellente')
    expect(low.warnings).toEqual([warn])
  })

  it('pulizia su scala log: toglie i prezzi segnaposto bassi, tiene la coda alta', () => {
    // scala lineare: limite inferiore negativo (1 resta), 600 tolto
    const r = parityPriceFor([1, 20, 30, 50, 80, 150, 300, 600], T, { fullMatch: true })
    expect(r.comparablesCount).toBe(7)
    // max = p50 di [20, 30, 50, 80, 150, 300, 600]
    expect(r.price?.max).toBe(80)
  })

  it('IQR nullo (molti prezzi uguali): nessun prezzo scartato', () => {
    const r = parityPriceFor([5, 5, 5, 5, 5, 5, 8], T, { fullMatch: true })
    expect(r.comparablesCount).toBe(7)
  })

  it('IQR sotto ln(1.1) (prezzi quasi uguali): nessun prezzo scartato', () => {
    // IQR dei log = ln(104.5/101.5) ~ 0.029: senza soglia il 200 verrebbe scartato
    const r = parityPriceFor([100, 101, 102, 103, 104, 105, 200], T, { fullMatch: true })
    expect(r.comparablesCount).toBe(7)
  })

  it('scarta gli outlier prima dei percentili', () => {
    const r = parityPriceFor([10, 12, 14, 15, 16, 18, 20, 22, 25, 1000], T, { fullMatch: true })
    expect(r.comparablesCount).toBe(9)
  })
})
