import type { ListingStore } from '../db/listing-store'
import { maxAffixes } from '../parser/parse-item'
import type { Settings } from '../settings'
import type { Listing, RareItem, Valuation, Verdict } from '../types'
import { featureVector, weightScore, weightsFor, type Weights } from './features'
import { percentile, priceFor } from './price-strategy'

/** Listing minimi della classe (in league) per usare il kNN. */
export const KNN_MIN_LISTINGS = 30
export const KNN_K = 10
/** Peso nella distanza delle feature senza peso di default (incluse `open` e `ilvl`). */
const UNWEIGHTED = 0.1

export const FEW_DATA_WARNING = "Pochi dati locali: verdetto indicativo, usa l'analisi approfondita"
export const NO_WEIGHTS_WARNING = 'Classe di oggetto senza pesi: verdetto non disponibile'

/**
 * Verdetto istantaneo senza rete: kNN sui listing locali se ce ne sono abbastanza,
 * altrimenti punteggio con la tabella dei pesi di default.
 */
export function quickEvaluate(
  item: RareItem,
  store: ListingStore,
  settings: Settings,
  now: Date
): Valuation {
  const weights = weightsFor(item.itemClass)
  const count = store.countByClass(settings.league)[item.itemClass] ?? 0
  if (count >= KNN_MIN_LISTINGS) {
    const comparables = store.comparables({
      league: settings.league,
      itemClass: item.itemClass,
      maxAgeDays: settings.maxListingAgeDays,
      now
    })
    if (comparables.length >= KNN_K) return knn(item, comparables, weights ?? {}, settings)
  }
  return fallback(item, weights)
}

function knn(
  item: RareItem,
  comparables: Listing[],
  weights: Weights,
  settings: Settings
): Valuation {
  const scale = scaleOf(comparables)
  const slots = maxAffixes(item.itemClass)
  const target = featureVector(
    item.explicits.map((m) => ({ statId: m.statId, value: m.tradeValue })),
    item.openPrefixes,
    item.openSuffixes,
    item.itemLevel,
    scale,
    slots
  )
  const nearest = comparables
    .map((l) => ({
      price: l.priceExalted,
      d: distance(
        target,
        featureVector(l.mods, l.openPrefixes, l.openSuffixes, l.itemLevel, scale, slots),
        weights
      )
    }))
    .sort((a, b) => a.d - b.d)
    .slice(0, Math.min(KNN_K, comparables.length))

  const result = priceFor(
    nearest.map((n) => n.price),
    settings.thresholds
  )
  return {
    ...result,
    // pochi vicini e niente verifica sul mercato: mai più di media
    confidence: result.confidence === 'alta' ? 'media' : result.confidence
  }
}

/** 95° percentile di |valore| per stat sui listing; le stat con scala 0 restano fuori. */
function scaleOf(listings: Listing[]): Record<string, number> {
  const values: Record<string, number[]> = {}
  for (const l of listings) {
    for (const m of l.mods) (values[m.statId] ??= []).push(Math.abs(m.value))
  }
  const scale: Record<string, number> = {}
  for (const [statId, vs] of Object.entries(values)) {
    const s = percentile(
      vs.sort((a, b) => a - b),
      0.95
    )
    if (s > 0) scale[statId] = s
  }
  return scale
}

/** Euclidea pesata: peso di default della stat, 0.1 se assente. */
function distance(a: Record<string, number>, b: Record<string, number>, weights: Weights): number {
  let sum = 0
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const w = weights[key] ?? UNWEIGHTED
    const diff = (a[key] ?? 0) - (b[key] ?? 0)
    sum += w * diff * diff
  }
  return Math.sqrt(sum)
}

function verdictForScore(score: number): Verdict {
  if (score < 0.3) return 'pessimo'
  if (score < 0.6) return 'buono'
  if (score < 0.85) return 'ottimo'
  return 'vendi_subito'
}

function fallback(item: RareItem, weights: Weights | undefined): Valuation {
  if (!weights) {
    return {
      verdict: 'pessimo',
      confidence: 'bassa',
      comparablesCount: 0,
      warnings: [NO_WEIGHTS_WARNING]
    }
  }
  return {
    verdict: verdictForScore(weightScore(item, weights)),
    confidence: 'bassa',
    comparablesCount: 0,
    warnings: [FEW_DATA_WARNING]
  }
}
