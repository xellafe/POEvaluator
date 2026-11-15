// Pesi appresi dalle inserzioni dell'archivio (R40): regressione ridge su ln(prezzo) con
// l'intensità del roll di ogni stat explicit, fusa con la tabella (prior). Modulo puro.
import type { Listing } from '../types'
import { MAX_MEDIAN_RATIO, percentile } from './price-strategy'
import type { Weights } from './weights'

/** Inserzioni minime (dopo la pulizia) perché una classe abbia pesi appresi. */
export const MIN_CLASS_LISTINGS = 50
/** Inserzioni minime con la stat perché entri nella regressione. */
export const MIN_STAT_LISTINGS = 8
/** Inserzioni minime perché una stat assente dalla tabella entri nei pesi. */
export const MIN_NEW_STAT_LISTINGS = 15
/** Peso fuso minimo perché una stat assente dalla tabella entri nei pesi. */
export const MIN_NEW_STAT_WEIGHT = 0.2
/** Penalità ridge sui coefficienti delle stat (intercetta e item level esclusi). */
export const RIDGE_LAMBDA = 3
/** Effetto minimo (a roll pieno) dell'affisso più forte perché i pesi appresi siano usati. */
export const MIN_LEARNED_EFFECT = 1.2
/** Quota del peso della tabella sotto cui un affisso della tabella non scende. */
export const MIN_PRIOR_SHARE = 0.5
/** Inserzioni con la stat per la fiducia piena nel peso appreso (alpha). */
const FULL_STAT_LISTINGS = 40
/** Inserzioni della classe per la fiducia piena nel peso appreso (alpha). */
const FULL_CLASS_LISTINGS = 200
/** Intensità massima del roll (|valore| / p90 della stat). */
const MAX_INTENSITY = 1.5
/** Penalità minima sull'item level: evita la matrice singolare se il livello è costante. */
const EPS = 1e-6

export interface LearnedStat {
  statId: string
  /** peso della tabella (0 se assente) */
  prior: number
  /** clamp(beta / ln 10, 0, 1) */
  learned: number
  /** fiducia nel peso appreso: min(1, n/40) × min(1, N/200) */
  alpha: number
  /** inserzioni della classe con la stat */
  n: number
  /** moltiplicatore del prezzo per un roll pieno: exp(beta) */
  effect: number
}

export interface LearnedClass {
  /** pesi fusi da usare al posto della tabella */
  weights: Weights
  /** stat stimate, per effetto decrescente */
  report: LearnedStat[]
  /** inserzioni usate (dopo la pulizia) */
  listings: number
}

/**
 * Risolve A·x = b con eliminazione gaussiana e pivot parziale (A quadrata, non singolare).
 * Non modifica gli argomenti.
 */
export function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let p = col
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[p][col])) p = r
    ;[m[col], m[p]] = [m[p], m[col]]
    const pivot = m[col][col]
    for (let r = col + 1; r < n; r++) {
      const f = m[r][col] / pivot
      if (f === 0) continue
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let s = m[i][n]
    for (let c = i + 1; c < n; c++) s -= m[i][c] * x[c]
    x[i] = s / m[i][i]
  }
  return x
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const round3 = (v: number): number => Math.round(v * 1000) / 1000

/** |valore| per stat explicit dell'inserzione; stessa stat su più righe sommata. */
function explicitValues(l: Listing): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of l.mods) {
    if (!m.statId.startsWith('explicit.stat_')) continue
    out.set(m.statId, (out.get(m.statId) ?? 0) + Math.abs(m.value))
  }
  return out
}

/**
 * Pesi appresi di una classe dalle sue inserzioni (stessa league), fusi con `prior` (la tabella
 * della classe). Null con meno di MIN_CLASS_LISTINGS inserzioni dopo la pulizia.
 *
 * - Pulizia: prezzo > 0 e non oltre MAX_MEDIAN_RATIO volte la mediana (come R39).
 * - Feature: per le stat in almeno MIN_STAT_LISTINGS inserzioni, x = clamp(|v| / p90, 0, 1.5)
 *   (0 se assente); item level / 100 (centrato) come controllo, non penalizzato.
 * - Ridge su ln(prezzo), λ = RIDGE_LAMBDA, intercetta non penalizzata.
 * - Peso appreso = beta / beta massimo della classe × peso massimo della tabella (stessa scala
 *   della tabella; beta negativi → 0); nessun affisso sopra ×1,2 → pesi della tabella.
 * - Fusione: alpha = min(1, n/40) × min(1, N/200), peso = (1 − alpha)·prior + alpha·appreso,
 *   mai sotto metà del prior.
 *   Stat fuori tabella solo con n >= 15 e peso fuso >= 0,2; stat della tabella non stimabili
 *   (meno di 8 inserzioni) col prior.
 */
export function learnClassWeights(listings: Listing[], prior: Weights): LearnedClass | null {
  const positive = listings.filter((l) => Number.isFinite(l.priceExalted) && l.priceExalted > 0)
  if (positive.length === 0) return null
  const cap =
    percentile(
      positive.map((l) => l.priceExalted).sort((a, b) => a - b),
      0.5
    ) * MAX_MEDIAN_RATIO
  const data = positive.filter((l) => l.priceExalted <= cap)
  const N = data.length
  if (N < MIN_CLASS_LISTINGS) return null

  const values = data.map(explicitValues)
  const byStat = new Map<string, number[]>()
  for (const v of values) {
    for (const [id, x] of v) {
      const arr = byStat.get(id)
      if (arr) arr.push(x)
      else byStat.set(id, [x])
    }
  }
  const stats = [...byStat.entries()]
    .filter(([, xs]) => xs.length >= MIN_STAT_LISTINGS)
    .map(([id, xs]) => ({
      id,
      n: xs.length,
      p90: percentile(
        xs.sort((a, b) => a - b),
        0.9
      )
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  // colonne: intercetta, item level (centrato), stat
  const meanLvl = data.reduce((s, l) => s + l.itemLevel / 100, 0) / N
  const k = stats.length + 2
  const rows = data.map((l, i) => {
    const row = new Array<number>(k)
    row[0] = 1
    row[1] = l.itemLevel / 100 - meanLvl
    stats.forEach((s, j) => {
      const v = values[i].get(s.id)
      row[j + 2] = v === undefined ? 0 : s.p90 > 0 ? clamp(v / s.p90, 0, MAX_INTENSITY) : 1
    })
    return row
  })
  const y = data.map((l) => Math.log(l.priceExalted))
  const a = Array.from({ length: k }, () => new Array<number>(k).fill(0))
  const b = new Array<number>(k).fill(0)
  rows.forEach((row, r) => {
    for (let i = 0; i < k; i++) {
      if (row[i] === 0) continue
      b[i] += row[i] * y[r]
      for (let j = i; j < k; j++) a[i][j] += row[i] * row[j]
    }
  })
  for (let i = 0; i < k; i++) for (let j = 0; j < i; j++) a[i][j] = a[j][i]
  a[1][1] += EPS
  for (let i = 2; i < k; i++) a[i][i] += RIDGE_LAMBDA
  const beta = solveLinear(a, b)

  // Scala (R40, correzione): i pesi appresi della classe vanno sulla scala della tabella, così le
  // soglie della deep (gruppo not >= 0,4) restano valide: l'affisso con l'effetto maggiore prende
  // il peso massimo della tabella, gli altri in proporzione al loro coefficiente. Se nessun
  // affisso alza il prezzo di almeno MIN_LEARNED_EFFECT, i dati non dicono nulla: pesi = tabella.
  const maxCoef = Math.max(0, ...stats.map((_, j) => beta[j + 2]))
  const maxPrior = Math.max(0, ...Object.values(prior))
  const scale = maxPrior > 0 ? maxPrior : 1
  const informative = maxCoef >= Math.log(MIN_LEARNED_EFFECT)

  const classTrust = Math.min(1, N / FULL_CLASS_LISTINGS)
  const weights: Weights = { ...prior }
  const report: LearnedStat[] = stats.map((s, j) => {
    const coef = beta[j + 2]
    const p = prior[s.id] ?? 0
    const learned = informative ? clamp((Math.max(0, coef) / maxCoef) * scale, 0, 1) : p
    const alpha = Math.min(1, s.n / FULL_STAT_LISTINGS) * classTrust
    // minimo: un affisso della tabella non scende sotto metà del suo peso (distorsioni note:
    // affissi quasi universali o tipici degli oggetti da livellamento)
    const fused = round3(Math.max((1 - alpha) * p + alpha * learned, p * MIN_PRIOR_SHARE))
    if (s.id in prior) weights[s.id] = fused
    else if (s.n >= MIN_NEW_STAT_LISTINGS && fused >= MIN_NEW_STAT_WEIGHT) weights[s.id] = fused
    return {
      statId: s.id,
      prior: p,
      learned: round3(learned),
      alpha: round3(alpha),
      n: s.n,
      effect: Math.round(Math.exp(coef) * 100) / 100
    }
  })
  report.sort((x, y2) => y2.effect - x.effect)
  return { weights, report, listings: N }
}

/**
 * Pesi appresi per ogni classe presente nelle inserzioni (una league), con la tabella `priors`
 * come punto di partenza. Le classi con poche inserzioni non compaiono (resta la tabella).
 */
export function learnAllClasses(
  listings: Listing[],
  priors: Readonly<Record<string, Weights>>
): Record<string, LearnedClass> {
  const byClass = new Map<string, Listing[]>()
  for (const l of listings) {
    const arr = byClass.get(l.itemClass)
    if (arr) arr.push(l)
    else byClass.set(l.itemClass, [l])
  }
  const out: Record<string, LearnedClass> = {}
  for (const [cls, ls] of byClass) {
    const res = learnClassWeights(ls, priors[cls] ?? {})
    if (res) out[cls] = res
  }
  return out
}
