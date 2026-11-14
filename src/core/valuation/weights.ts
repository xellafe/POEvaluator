// Tabelle dei pesi per classe (default-weights.json), senza dipendenze dal parser: le usa anche
// il renderer (stato degli affissi nel pannello dell'analisi approfondita).
import rawWeights from './default-weights.json'

export type Weights = Record<string, number>

/** default-weights.json senza le chiavi di documentazione ("_comment", …). */
export const DEFAULT_WEIGHTS: Readonly<Record<string, Weights>> = Object.fromEntries(
  Object.entries(rawWeights as unknown as Record<string, unknown>).filter(
    (entry): entry is [string, Weights] =>
      !entry[0].startsWith('_') && typeof entry[1] === 'object' && entry[1] !== null
  )
)

/** Pesi della classe trade, o undefined se la classe non è nella tabella. */
export function weightsFor(itemClass: string): Weights | undefined {
  return Object.prototype.hasOwnProperty.call(DEFAULT_WEIGHTS, itemClass)
    ? DEFAULT_WEIGHTS[itemClass]
    : undefined
}

/** Mod con quanto serve a pesarlo (sottoinsieme di ItemMod, usabile anche dal renderer). */
interface WeightedMod {
  statId: string
  tier?: number
  tierCount?: number
}

/**
 * Qualità relativa del tier (R39): 1 per il tier migliore, 1/totale per il peggiore; senza totale
 * 1 per il T1 e null per gli altri (non si sa dove stanno nella scala).
 */
export function tierQuality(m: WeightedMod): number | null {
  if (m.tier === undefined) return null
  if (m.tierCount !== undefined && m.tierCount >= m.tier) return 1 - (m.tier - 1) / m.tierCount
  return m.tier <= 1 ? 1 : null
}

/** Sopra questa qualità un affisso senza peso entra comunque nella ricerca (T1; T2 su 7+ tier). */
export const TOP_TIER_QUALITY = 0.85

/** Peso di un affisso senza peso in tabella ma di tier alto: il più basso, esce per primo. */
export const TOP_TIER_WEIGHT = 0.1

/**
 * Peso di un affisso per la ricerca (R39): quello della tabella; senza peso in tabella, ma con un
 * tier alto (qualità >= 0,85), TOP_TIER_WEIGHT, così un T1 non viene scartato in silenzio.
 */
export function modWeight(m: WeightedMod, weights: Weights): number {
  const w = weights[m.statId] ?? 0
  if (w > 0) return w
  return (tierQuality(m) ?? 0) >= TOP_TIER_QUALITY ? TOP_TIER_WEIGHT : 0
}

/**
 * Punteggio per ordinare gli affissi (e scegliere quale togliere nel rilassamento): peso × (0,7 +
 * 0,3 × qualità del tier). A pesi simili esce prima il tier peggiore; senza tier noto il peso
 * resta pieno.
 */
export function modScore(m: WeightedMod, weights: Weights): number {
  const q = tierQuality(m) ?? 1
  return modWeight(m, weights) * (0.7 + 0.3 * q)
}
