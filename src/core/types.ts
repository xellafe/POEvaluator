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
  /** Tier totali della famiglia del mod su questa base (data/mod-tiers.json): "Tier 4 di 8". */
  tierCount?: number
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
  /**
   * Armi d'attacco: DPS dalle proprietà del testo (valori mostrati in gioco, già con mod locali e
   * qualità). pdps = media del danno fisico × aps; edps = somma delle medie elementali × aps.
   * Assente se l'oggetto non ha "Attacks per Second".
   */
  weapon?: WeaponStats
}

export interface WeaponStats {
  pdps: number
  edps: number
  aps: number
  critChance?: number
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

/** Stato di un affisso nell'analisi approfondita (R34). */
export type ModStatus = 'used' | 'dps' | 'unweighted' | 'relaxed'

export interface DeepMod {
  statId: string
  text: string
  tier?: number
  /** Tier totali della famiglia del mod sulla base, se noti. */
  tierCount?: number
  status: ModStatus
  /** Contributo in exalted (solo `used`). */
  deltaExalted?: number
}

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
  /**
   * null: nessun prezzo utilizzabile, quindi nessun giudizio ("Dati insufficienti", R26).
   * In quel caso `warnings[0]` spiega il motivo.
   */
  verdict: Verdict | null
  confidence: Confidence
  /**
   * exalted. `patient` (solo analisi approfondita, R32): prezzo "se puoi aspettare", presente
   * solo per Ottimo ed Eccellente quando supera il consigliato di almeno il 20%.
   */
  price?: {
    /** Analisi approfondita: "Vende subito" (10° percentile); valutatore rapido: prezzo consigliato. */
    suggested: number
    min: number
    max: number
    /** Solo deep: "Se puoi aspettare" (25° percentile). */
    patient?: number
    /** Solo deep: "Richiesta tipica" (mediana). */
    typical?: number
    /** Solo deep: prezzi puliti ordinati (al massimo 20), per la barra della distribuzione. */
    sample?: number[]
  }
  /**
   * Solo deep (R34): tutti gli explicit dell'oggetto nell'ordine del testo, con stato e, per
   * quelli usati, il contributo (assente se non calcolato o nascosto per pochi prezzi).
   */
  mods?: DeepMod[]
  /**
   * Solo deep: motivi per cui la stima è incerta (pochi prezzi, confronto su meno di metà degli
   * affissi), in minuscolo per comporli in una frase. Assente se la stima è solida o non c'è.
   */
  uncertain?: string[]
  comparablesCount: number
  tradeUrl?: string
  /** Ricerche trade eseguite dall'analisi approfondita (solo deep). */
  searches?: number
  /** Istante (ISO) dell'analisi approfondita restituita dalla cache; assente se appena eseguita. */
  cachedAt?: string
  /**
   * Solo deep (R37): stato dei contributi degli affissi, calcolati su richiesta. `available`:
   * calcolabili (c'è `basis`) e non ancora calcolati; `done`: calcolati. Assente se non
   * calcolabili (nessun verdetto, nessun affisso usato) o in analisi salvate prima di R37.
   */
  contributions?: 'available' | 'done'
  /** Solo deep con `contributions: 'available'`: quanto serve a riprendere l'analisi (R37). */
  basis?: DeepBasis
  warnings: string[]
}

/**
 * Punto di ripresa dell'analisi approfondita per i contributi (R37): rifà le query dei contributi
 * senza ripetere la ricerca base. Solo dati serializzabili (viaggia sull'IPC).
 */
export interface DeepBasis {
  /** statId dei mod della query finale, nell'ordine del piano (peso decrescente). */
  queryMods: string[]
  /** Fattori di mod e DPS della query finale (0.8/0.85, o 0.6 dopo il rilassamento). */
  valueFactor: number
  dpsFactor: number
  /** 10° percentile del campione base (10 prezzi equidistanti, puliti). */
  baseP10: number
  /** Ricerche previste per i contributi: mod della query + controllo slot, entro il budget. */
  plannedSearches: number
}
