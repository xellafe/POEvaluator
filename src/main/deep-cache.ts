// Cache in memoria delle analisi approfondite: lo stesso oggetto rivalutato entro 30 minuti
// risponde subito, senza richieste al trade.
import type { Valuation } from '../core/types'

export const DEEP_CACHE_TTL_MS = 30 * 60_000
export const DEEP_CACHE_MAX_ENTRIES = 50

/** Testo dell'oggetto confrontabile: righe trimmate, a capo uniformi, senza righe vuote in fondo. */
export function normalizeItemText(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

const keyOf = (league: string, text: string): string => `${league}\u0000${normalizeItemText(text)}`

export class DeepCache {
  /** Ordine di inserimento = dalla voce più vecchia alla più recente. */
  private readonly entries = new Map<string, { valuation: Valuation; at: Date }>()

  get size(): number {
    return this.entries.size
  }

  /** Risultato ancora valido (meno di 30 minuti) per league e oggetto; null altrimenti. */
  get(league: string, text: string, now: Date): { valuation: Valuation; at: Date } | null {
    const key = keyOf(league, text)
    const e = this.entries.get(key)
    if (!e) return null
    if (now.getTime() - e.at.getTime() >= DEEP_CACHE_TTL_MS) {
      this.entries.delete(key)
      return null
    }
    return e
  }

  set(league: string, text: string, valuation: Valuation, now: Date): void {
    const key = keyOf(league, text)
    this.entries.delete(key) // reinserita in fondo: diventa la più recente
    this.entries.set(key, { valuation, at: now })
    while (this.entries.size > DEEP_CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value as string
      this.entries.delete(oldest)
    }
  }
}
