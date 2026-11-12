import { maxAffixes, parseTradeLine } from '../parser/parse-item'
import type { Listing } from '../types'

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Conta prefix e suffix occupati dai tier espliciti ("P5"/"S2") di `item.explicitMods[].mods[]`
 * (un mod ibrido compare più volte con lo stesso nome: contato una volta).
 */
function countAffixes(explicitMods: unknown[]): { prefixes: number; suffixes: number } {
  const seen = new Set<string>()
  let prefixes = 0
  let suffixes = 0
  for (const entry of explicitMods) {
    if (!isObj(entry) || !Array.isArray(entry.mods)) continue
    for (const m of entry.mods) {
      if (!isObj(m) || typeof m.tier !== 'string') continue
      const kind = /^([PS])\d+$/.exec(m.tier)?.[1]
      if (!kind) continue
      const key = `${kind}|${String(m.name ?? m.tier)}`
      if (seen.has(key)) continue
      seen.add(key)
      if (kind === 'P') prefixes++
      else suffixes++
    }
  }
  return { prefixes, suffixes }
}

/** Chiavi dell'item trade2 con mod che occupano slot prefix/suffix. */
const AFFIX_KEYS = ['explicitMods', 'fracturedMods', 'desecratedMods', 'craftedMods']

/**
 * Converte un risultato di `fetch` trade2 in `Listing`. Restituisce null se i dati sono incompleti
 * o se la valuta non è convertibile in exalted. `itemClass` è la categoria trade della query.
 * Richiede `initParserData`: i valori dei mod passano dallo stesso matcher degli item; un mod
 * non riconosciuto (o con stat diversa dall'hash) viene scartato, mai inventato.
 */
export function toListing(
  raw: unknown,
  league: string,
  toExalted: (amount: number, currency: string) => number | null,
  now: Date,
  itemClass: string
): Listing | null {
  if (!isObj(raw) || !isObj(raw.listing) || !isObj(raw.item) || typeof raw.id !== 'string') {
    return null
  }
  const { listing, item } = raw
  const price = listing.price
  if (!isObj(price) || typeof price.amount !== 'number' || typeof price.currency !== 'string') {
    return null
  }
  if (!(price.amount > 0) || typeof listing.indexed !== 'string') return null
  const priceExalted = toExalted(price.amount, price.currency)
  if (priceExalted === null) return null

  const affixMods = AFFIX_KEYS.flatMap((k) =>
    Array.isArray(item[k]) ? (item[k] as unknown[]) : []
  )

  // Più righe con la stessa stat (es. due righe di vita) si sommano, come fa il trade.
  // Gli indici di extended.hashes non puntano a questi array: lo statId è nel campo `hash`.
  // I mod sono indicizzati per id canonico (come gli item): locale/globale e fractured coincidono.
  const byStat = new Map<string, number>()
  for (const entry of affixMods) {
    if (!isObj(entry) || typeof entry.hash !== 'string' || typeof entry.description !== 'string') {
      continue
    }
    const parsed = parseTradeLine(entry.description, itemClass, entry.hash.replace(/^stat\./, ''))
    if (parsed === null) continue
    byStat.set(parsed.statId, (byStat.get(parsed.statId) ?? 0) + parsed.value)
  }
  const mods = [...byStat].map(([statId, value]) => ({ statId, value }))

  const max = maxAffixes(itemClass)
  const { prefixes, suffixes } = countAffixes(affixMods)

  return {
    id: raw.id,
    league,
    itemClass,
    baseType: typeof item.baseType === 'string' ? item.baseType : '',
    itemLevel: typeof item.ilvl === 'number' ? item.ilvl : 0,
    mods,
    openPrefixes: Math.max(0, max - prefixes),
    openSuffixes: Math.max(0, max - suffixes),
    priceAmount: price.amount,
    priceCurrency: price.currency,
    priceExalted,
    indexedAt: listing.indexed,
    seenAt: now.toISOString()
  }
}
