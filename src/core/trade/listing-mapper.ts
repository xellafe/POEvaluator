import { maxAffixes } from '../parser/parse-item'
import type { Listing } from '../types'

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Nome della prima proprietà dell'item nel trade -> categoria trade (fallback quando il chiamante non la passa). */
const CLASS_BY_PROPERTY: Record<string, string> = {
  Boots: 'armour.boots',
  Gloves: 'armour.gloves',
  Helmet: 'armour.helmet',
  'Body Armour': 'armour.chest',
  Shield: 'armour.shield',
  Buckler: 'armour.buckler',
  Focus: 'armour.focus',
  Quiver: 'armour.quiver'
}

function inferItemClass(item: Obj): string {
  const props = Array.isArray(item.properties) ? item.properties : []
  const name = isObj(props[0]) && typeof props[0].name === 'string' ? props[0].name : ''
  return CLASS_BY_PROPERTY[name] ?? ''
}

/** Valore in unità trade dalla riga del mod: numeri mediati, negativo per "reduced"/"less"/"-N". */
function valueFromDescription(description: string): number | null {
  const nums = [...description.matchAll(/(-?)(\d+(?:\.\d+)?)/g)]
  if (nums.length === 0) return null
  const avg = nums.reduce((s, m) => s + Number(m[2]), 0) / nums.length
  const negative =
    nums[0][1] === '-' || /\b(reduced|less|lower|slower|decreased)\b/i.test(description)
  return negative ? -avg : avg
}

function magnitudeAverage(entry: Obj): number | null {
  const mods = Array.isArray(entry.mods) ? entry.mods : []
  const mags = isObj(mods[0]) && Array.isArray(mods[0].magnitudes) ? mods[0].magnitudes : []
  const vals = mags
    .filter(isObj)
    .map((m) => (Number(m.min) + Number(m.max)) / 2)
    .filter(Number.isFinite)
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
}

function entryValue(entry: unknown): number {
  if (!isObj(entry)) return 1
  const fromText =
    typeof entry.description === 'string' ? valueFromDescription(entry.description) : null
  return fromText ?? magnitudeAverage(entry) ?? 1
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

/**
 * Converte un risultato di `fetch` trade2 in `Listing`. Restituisce null se i dati sono incompleti
 * o se la valuta non è convertibile in exalted. `itemClass` (se noto, es. dalla query) ha la
 * precedenza sulla categoria dedotta dalle proprietà dell'item.
 */
export function toListing(
  raw: unknown,
  league: string,
  toExalted: (amount: number, currency: string) => number | null,
  now: Date,
  itemClass?: string
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

  const explicitMods = Array.isArray(item.explicitMods) ? item.explicitMods : []
  // Nota: gli indici di extended.hashes NON puntano a explicitMods (ordine diverso, verificato sulla
  // risposta reale): lo statId si legge dal campo `hash` di ogni riga ("stat.explicit.stat_123").
  // Più righe con la stessa stat (es. due righe di vita) si sommano, come fa il trade.
  const byStat = new Map<string, number>()
  for (const entry of explicitMods) {
    if (!isObj(entry) || typeof entry.hash !== 'string') continue
    const statId = entry.hash.replace(/^stat\./, '')
    byStat.set(statId, (byStat.get(statId) ?? 0) + entryValue(entry))
  }
  const mods = [...byStat].map(([statId, value]) => ({ statId, value }))

  const cls = itemClass ?? inferItemClass(item)
  const max = maxAffixes(cls)
  const { prefixes, suffixes } = countAffixes(explicitMods)

  return {
    id: raw.id,
    league,
    itemClass: cls,
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
