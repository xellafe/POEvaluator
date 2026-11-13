import { maxAffixes } from '../parser/parse-item'
import type { RareItem } from '../types'
import type { Weights } from './weights'

export { DEFAULT_WEIGHTS, weightsFor, type Weights } from './weights'

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/**
 * Vettore delle feature per il kNN: per stat `value / scale[statId]` (stat senza scala o con
 * scala 0 ignorate; stessa stat su più righe sommata), `open` = slot liberi / (2·maxAffixes),
 * `ilvl` = item level / 100.
 */
export function featureVector(
  mods: { statId: string; value: number }[],
  openPrefixes: number,
  openSuffixes: number,
  itemLevel: number,
  scale: Record<string, number>,
  maxAffixesPerSide = 3
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of mods) {
    const s = scale[m.statId]
    if (!s) continue
    out[m.statId] = (out[m.statId] ?? 0) + m.value / s
  }
  out.open = (openPrefixes + openSuffixes) / (2 * maxAffixesPerSide)
  out.ilvl = itemLevel / 100
  return out
}

/**
 * Punteggio 0..1 dei mod explicit: Σ peso·v / somma dei 2·maxAffixes pesi più alti della classe,
 * con v = |tradeValue| / |range.max| limitato a 0..1 (0.5 se il mod non ha range).
 * Implicit e rune non contano.
 */
export function weightScore(item: RareItem, weights: Weights): number {
  const top = Object.values(weights)
    .sort((a, b) => b - a)
    .slice(0, 2 * maxAffixes(item.itemClass))
    .reduce((sum, w) => sum + w, 0)
  if (top <= 0) return 0
  let sum = 0
  for (const mod of item.explicits) {
    const w = weights[mod.statId]
    if (!w) continue
    const max = mod.range ? Math.abs(mod.range.max) : 0
    const v = max > 0 ? clamp01(Math.abs(mod.tradeValue) / max) : 0.5
    sum += w * v
  }
  return clamp01(sum / top)
}
