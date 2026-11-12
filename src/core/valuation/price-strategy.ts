import type { Settings } from '../settings'
import type { Confidence, Valuation, Verdict } from '../types'

type Result = Pick<Valuation, 'verdict' | 'confidence' | 'price' | 'comparablesCount' | 'warnings'>

/** Percentile con interpolazione lineare (R-7). `sorted` deve essere ordinato crescente e non vuoto. */
export function percentile(sorted: number[], p: number): number {
  const h = (sorted.length - 1) * p
  const lo = Math.floor(h)
  const hi = Math.ceil(h)
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo])
}

/** Valori >= 10 a intero, < 10 a un decimale. */
export function roundPrice(v: number): number {
  return v >= 10 ? Math.round(v) : Math.round(v * 10) / 10
}

/** Scarta valori non validi e (con n >= 4) gli outlier Tukey 1.5×IQR. Restituisce i prezzi ordinati. */
export function cleanPrices(pricesExalted: number[]): number[] {
  const sorted = pricesExalted.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b)
  if (sorted.length < 4) return sorted
  const q1 = percentile(sorted, 0.25)
  const q3 = percentile(sorted, 0.75)
  const iqr = q3 - q1
  const lo = q1 - 1.5 * iqr
  const hi = q3 + 1.5 * iqr
  return sorted.filter((v) => v >= lo && v <= hi)
}

/** alta: n >= 10 e IQR/mediana <= 0.5; media: n >= 4; bassa: altrimenti. */
export function confidenceFor(prices: number[]): Confidence {
  const n = prices.length
  if (n < 4) return 'bassa'
  if (n >= 10) {
    const sorted = [...prices].sort((a, b) => a - b)
    const median = percentile(sorted, 0.5)
    const iqr = percentile(sorted, 0.75) - percentile(sorted, 0.25)
    if (median > 0 && iqr / median <= 0.5) return 'alta'
  }
  return 'media'
}

export function verdictFor(estimateExalted: number, t: Settings['thresholds']): Verdict {
  if (estimateExalted < t.buono) return 'pessimo'
  if (estimateExalted < t.ottimo) return 'buono'
  if (estimateExalted < t.eccellente) return 'ottimo'
  return 'eccellente'
}

const EXCEPTIONAL_WARNING =
  'Pochi oggetti simili in vendita: controlla il prezzo sul trade prima di venderlo'

const SUGGESTED_PERCENTILE: Partial<Record<Verdict, number>> = {
  buono: 0.2,
  ottimo: 0.6,
  eccellente: 0.75
}

/**
 * Verdetto, confidenza e prezzo dai prezzi in exalted. Senza prezzi utilizzabili il verdetto è
 * null (R26: nessun dato non vuol dire Pessimo); il messaggio lo aggiunge il chiamante.
 */
export function priceFor(prices: number[], t: Settings['thresholds']): Result {
  const clean = cleanPrices(prices)
  if (clean.length === 0) {
    return { verdict: null, confidence: 'bassa', comparablesCount: 0, warnings: [] }
  }
  if (clean.length < 2) {
    const verdict = verdictFor(clean[0], t)
    const warnings = ['Troppo pochi oggetti simili sul mercato']
    if (verdict === 'eccellente') warnings.push(EXCEPTIONAL_WARNING)
    return { verdict, confidence: 'bassa', comparablesCount: clean.length, warnings }
  }
  const verdict = verdictFor(percentile(clean, 0.5), t)
  const warnings: string[] = []
  if (verdict === 'eccellente') warnings.push(EXCEPTIONAL_WARNING)
  const result: Result = {
    verdict,
    confidence: confidenceFor(clean),
    comparablesCount: clean.length,
    warnings
  }
  const sp = SUGGESTED_PERCENTILE[verdict]
  if (sp !== undefined) {
    result.price = {
      suggested: roundPrice(percentile(clean, sp)),
      min: roundPrice(percentile(clean, 0.1)),
      max: roundPrice(percentile(clean, 0.9))
    }
  }
  return result
}
