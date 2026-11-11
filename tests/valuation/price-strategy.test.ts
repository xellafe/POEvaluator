import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/core/settings'
import {
  cleanPrices,
  confidenceFor,
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
    expect(verdictFor(300, T)).toBe('vendi_subito')
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

  it('vendi_subito usa p75 e aggiunge il warning', () => {
    // [400,400,400,400]: tutti i percentili = 400
    expect(priceFor([400, 400, 400, 400], T)).toEqual({
      verdict: 'vendi_subito',
      confidence: 'media',
      price: { suggested: 400, min: 400, max: 400 },
      comparablesCount: 4,
      warnings: ['Oggetto eccezionale: verifica il prezzo a mano']
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

  it('array vuoto: pessimo, bassa, warning, nessun prezzo', () => {
    const r = priceFor([], T)
    expect(r).toEqual({
      verdict: 'pessimo',
      confidence: 'bassa',
      comparablesCount: 0,
      warnings: ['Troppo pochi oggetti simili sul mercato']
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

  it('stima 400 da pochi dati: vendi_subito + warning eccezionale', () => {
    const r = priceFor([380, 420], T)
    expect(r.verdict).toBe('vendi_subito')
    expect(r.warnings).toEqual(['Oggetto eccezionale: verifica il prezzo a mano'])
    // mediana 400; p75 h = 0.75 -> 380 + 0.75·40 = 410
    expect(r.price).toEqual({ suggested: 410, min: 384, max: 416 })
  })
})
