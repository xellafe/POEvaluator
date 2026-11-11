export type ModType = 'prefix' | 'suffix' | 'implicit' | 'rune' | 'enchant'

export interface ItemMod {
  /** id stat del trade, es. "explicit.stat_3299347043" */
  statId: string
  /** riga come in gioco (senza i range del testo avanzato) */
  text: string
  /** numeri della riga, nell'ordine in cui compaiono */
  values: number[]
  type: ModType
  tier?: number
  /**
   * Range del tier, dal testo avanzato, nelle unità del valore trade: per le stat con più
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
  /** 3 - prefix presenti (contati per modificatore, non per stat) */
  openPrefixes: number
  openSuffixes: number
}

export type ParseResult =
  | { ok: true; item: RareItem }
  | { ok: false; reason: 'empty' | 'not_poe_item' | 'unidentified' | 'unsupported_rarity' }

export type Verdict = 'pessimo' | 'buono' | 'ottimo' | 'vendi_subito'
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
