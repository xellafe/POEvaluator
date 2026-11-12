export type ModType = 'prefix' | 'suffix' | 'implicit' | 'rune' | 'enchant'

export interface ItemMod {
  /** id stat del trade, es. "explicit.stat_3299347043" */
  statId: string
  /** riga come in gioco (senza i range del testo avanzato) */
  text: string
  /** numeri grezzi della riga, nell'ordine e col segno con cui compaiono (es. [21, 39]) */
  values: number[]
  /**
   * Valore nelle unità del trade, calcolato da EE2: con segno (le stat "reduced" sono negative)
   * e mediato per le stat con più numeri ("Adds 21 to 39" -> 30). Vale 1 per le stat senza numeri.
   */
  tradeValue: number
  type: ModType
  tier?: number
  /**
   * Range del tier, dal testo avanzato, nelle stesse unità di tradeValue: per le stat con più
   * numeri (es. "Adds # to # Fire Damage") min e max sono la media dei rispettivi estremi.
   */
  range?: { min: number; max: number }
}

export interface RareItem {
  raw: string
  /** categoria trade, es. "armour.boots" */
  itemClass: string
  baseType: string
  name: string
  itemLevel: number
  quality: number
  corrupted: boolean
  /** prefix + suffix (una voce per stat: un mod ibrido produce più voci) */
  explicits: ItemMod[]
  /** implicit, rune, enchant */
  implicits: ItemMod[]
  /** max prefix della categoria (3, gioielli 2) - prefix presenti, contati per modificatore */
  openPrefixes: number
  openSuffixes: number
}

export type ParseResult =
  | { ok: true; item: RareItem }
  | {
      ok: false
      reason:
        | 'empty'
        | 'not_poe_item'
        | 'unidentified'
        | 'unsupported_rarity'
        /** raro identificato ma di categoria non supportata o con base assente dai dati */
        | 'unsupported_item'
        /** testo copiato con Ctrl+C semplice: mancano gli header avanzati dei mod */
        | 'not_advanced'
    }

export type Verdict = 'pessimo' | 'buono' | 'ottimo' | 'eccellente'
export type Confidence = 'alta' | 'media' | 'bassa'

export interface Listing {
  id: string
  league: string
  itemClass: string
  baseType: string
  itemLevel: number
  mods: { statId: string; value: number }[]
  openPrefixes: number
  openSuffixes: number
  priceAmount: number
  priceCurrency: string
  priceExalted: number
  /** ISO */
  indexedAt: string
  /** ISO */
  seenAt: string
}

export interface Valuation {
  verdict: Verdict
  confidence: Confidence
  /** exalted */
  price?: { suggested: number; min: number; max: number }
  contributions?: { statId: string; text: string; deltaExalted: number }[]
  comparablesCount: number
  tradeUrl?: string
  warnings: string[]
}
