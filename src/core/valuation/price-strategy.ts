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

/** Prezzi puliti minimi per dare un verdetto nell'analisi approfondita. */
export const MIN_PARITY_PRICES = 3
/**
 * Pulizia dei prezzi dell'analisi approfondita: Tukey 1.5×IQR su log(prezzo), con n >= 4, solo
 * verso l'alto (R33): le richieste fuori scala (price fixing, prezzi di prova) si tolgono, i prezzi
 * bassi restano perché sono le inserzioni con cui compete chi vuole vendere subito. Su scala log il
 * criterio è sui rapporti. Con IQR sotto ln(1.1) (prezzi quasi tutti uguali) non scarta nulla: i limiti
 * sarebbero così stretti da togliere prezzi normali. Con 3 prezzi i quartili non hanno senso:
 * nessuna pulizia. Restituisce i prezzi ordinati.
 */
const MIN_LOG_IQR = Math.log(1.1)

export function cleanParityPrices(pricesExalted: number[]): number[] {
  const sorted = pricesExalted.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b)
  if (sorted.length < 4) return sorted
  const logs = sorted.map(Math.log)
  const q1 = percentile(logs, 0.25)
  const q3 = percentile(logs, 0.75)
  const iqr = q3 - q1
  if (iqr < MIN_LOG_IQR) return sorted
  // Solo la coda alta (R33): i prezzi bassi sono la concorrenza reale per chi vuole vendere subito.
  const hi = q3 + 1.5 * iqr
  return sorted.filter((_, i) => logs[i] <= hi)
}

/** Prezzi puliti per la confidenza alta / media dell'analisi approfondita. */
const PARITY_HIGH_COUNT = 15
const PARITY_MEDIUM_COUNT = 6

/** Margine minimo del prezzo "se puoi aspettare" sul consigliato (+20%). */
const PATIENT_MIN_RATIO = 1.2

/**
 * Prezzo dell'analisi approfondita sul confronto "alla pari" (R31, R32): prezzo consigliato al
 * 10° percentile dei prezzi puliti (cleanParityPrices), cioè tra i più economici, il prezzo che
 * vende subito; min al 5°, max al 50°. Il verdetto viene dal prezzo consigliato (non dalla
 * mediana: le richieste del trade sono gonfiate rispetto alle vendite). Per Ottimo ed Eccellente
 * `patient` = 25° percentile, solo se supera il consigliato di almeno il 20%.
 * Con meno di 3 prezzi puliti nessun verdetto (il messaggio lo aggiunge il chiamante).
 * Confidenza: alta con >= 15 prezzi e `fullMatch` (nessun mod tolto e gruppo not presente),
 * media con >= 6, altrimenti bassa. Pessimo resta senza prezzo (decisione utente del Task 13).
 */
export function parityPriceFor(
  prices: number[],
  t: Settings['thresholds'],
  opts: { fullMatch: boolean }
): Result {
  const clean = cleanParityPrices(prices)
  if (clean.length < MIN_PARITY_PRICES) {
    return { verdict: null, confidence: 'bassa', comparablesCount: clean.length, warnings: [] }
  }
  const suggested = roundPrice(percentile(clean, 0.1))
  const verdict = verdictFor(suggested, t)
  const confidence: Confidence =
    clean.length >= PARITY_HIGH_COUNT && opts.fullMatch
      ? 'alta'
      : clean.length >= PARITY_MEDIUM_COUNT
        ? 'media'
        : 'bassa'
  const result: Result = {
    verdict,
    confidence,
    comparablesCount: clean.length,
    warnings: verdict === 'eccellente' && confidence !== 'alta' ? [EXCEPTIONAL_WARNING] : []
  }
  if (verdict !== 'pessimo') {
    result.price = {
      suggested,
      min: roundPrice(percentile(clean, 0.05)),
      max: roundPrice(percentile(clean, 0.5))
    }
    const patient = roundPrice(percentile(clean, 0.25))
    if (
      (verdict === 'ottimo' || verdict === 'eccellente') &&
      patient >= suggested * PATIENT_MIN_RATIO
    ) {
      result.price.patient = patient
    }
  }
  return result
}
