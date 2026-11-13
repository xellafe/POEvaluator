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
