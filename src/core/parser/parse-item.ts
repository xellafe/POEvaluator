// Adapter tra il parser vendorizzato di Exiled Exchange 2 (ParsedItem) e RareItem di POEvaluator.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ItemMod, ModType, ParseResult, RareItem, WeaponStats } from '../types'
import { parseModTiers, tierCountOf, type ModTiers } from './mod-tiers'
import { init } from './vendor/data'
import { ModifierType } from './vendor/parser/modifiers'
import type { ParsedModifier } from './vendor/parser/advanced-mod-desc'
import { ItemCategory } from './vendor/parser/meta'
import { ItemRarity } from './vendor/parser/ParsedItem'
import { parseClipboard, type ParserState } from './vendor/parser/Parser'
import { tryParseTranslation } from './vendor/parser/stat-translations'

/** Numero massimo di prefix (e di suffix) di un raro: 3, i gioielli 2. */
const DEFAULT_MAX_AFFIXES = 3
const MAX_AFFIXES: ReadonlyMap<ItemCategory, number> = new Map([[ItemCategory.Jewel, 2]])

/** Max prefix (e suffix) per categoria trade, es. "armour.boots" -> 3, "jewel" -> 2. */
export function maxAffixes(itemClass: string): number {
  return itemClass === 'jewel' || itemClass.startsWith('jewel.') ? 2 : DEFAULT_MAX_AFFIXES
}

/** Errore di EE2 quando la base (o il nome) non è nei dati. */
const UNKNOWN_ITEM_ERROR = 'item.unknown'

/**
 * Categoria EE2 -> categoria del trade PoE2. Ripresa da EE2
 * (renderer/src/web/price-check/trade/pathofexile-trade.ts), limitata alle categorie
 * PoE2 che possono essere rare.
 */
const TRADE_CATEGORY: ReadonlyMap<ItemCategory, string> = new Map([
  [ItemCategory.Helmet, 'armour.helmet'],
  [ItemCategory.BodyArmour, 'armour.chest'],
  [ItemCategory.Gloves, 'armour.gloves'],
  [ItemCategory.Boots, 'armour.boots'],
  [ItemCategory.Shield, 'armour.shield'],
  [ItemCategory.Buckler, 'armour.buckler'],
  [ItemCategory.Focus, 'armour.focus'],
  [ItemCategory.Quiver, 'armour.quiver'],
  [ItemCategory.Amulet, 'accessory.amulet'],
  [ItemCategory.Ring, 'accessory.ring'],
  [ItemCategory.Belt, 'accessory.belt'],
  [ItemCategory.Jewel, 'jewel'],
  [ItemCategory.Flask, 'flask'],
  [ItemCategory.Charm, 'flask.charm'],
  [ItemCategory.Bow, 'weapon.bow'],
  [ItemCategory.Crossbow, 'weapon.crossbow'],
  [ItemCategory.Wand, 'weapon.wand'],
  [ItemCategory.Sceptre, 'weapon.sceptre'],
  [ItemCategory.Staff, 'weapon.staff'],
  [ItemCategory.Warstaff, 'weapon.warstaff'],
  [ItemCategory.Claw, 'weapon.claw'],
  [ItemCategory.Dagger, 'weapon.dagger'],
  [ItemCategory.Spear, 'weapon.spear'],
  [ItemCategory.Flail, 'weapon.flail'],
  [ItemCategory.Talisman, 'weapon.talisman'],
  [ItemCategory.OneHandedAxe, 'weapon.oneaxe'],
  [ItemCategory.TwoHandedAxe, 'weapon.twoaxe'],
  [ItemCategory.OneHandedMace, 'weapon.onemace'],
  [ItemCategory.TwoHandedMace, 'weapon.twomace'],
  [ItemCategory.OneHandedSword, 'weapon.onesword'],
  [ItemCategory.TwoHandedSword, 'weapon.twosword'],
  [ItemCategory.Tablet, 'map.tablet']
])

/** Tipi EE2 che occupano uno slot prefix/suffix (il prefix/suffix è in info.generation). */
const AFFIX_TYPES = new Set<ModifierType>([
  ModifierType.Explicit,
  ModifierType.Fractured,
  ModifierType.Desecrated,
  ModifierType.Crafted
])

/** Tipi EE2 riportati come implicits, con la chiave degli id trade da usare. */
const IMPLICIT_TYPES = new Map<ModifierType, { type: ModType; tradeKey: string }>([
  [ModifierType.Implicit, { type: 'implicit', tradeKey: 'implicit' }],
  [ModifierType.Augment, { type: 'rune', tradeKey: 'rune' }],
  [ModifierType.AddedAugment, { type: 'rune', tradeKey: 'rune' }],
  [ModifierType.Enchant, { type: 'enchant', tradeKey: 'enchant' }]
])

/**
 * Carica stats/items di EE2 da `dataDir` (es. `data/en`) e, se c'è, `mod-tiers.json` dalla
 * cartella sopra (senza quel file gli affissi non hanno `tierCount`). Va chiamata prima di
 * parseItemText.
 */
export async function initParserData(dataDir: string): Promise<void> {
  const [itemsNdjson, statsNdjson, modTiersJson] = await Promise.all([
    readFile(join(dataDir, 'items.ndjson'), 'utf8'),
    readFile(join(dataDir, 'stats.ndjson'), 'utf8'),
    readFile(join(dataDir, '..', 'mod-tiers.json'), 'utf8').catch(() => null)
  ])
  init({ itemsNdjson, statsNdjson })
  EXPLICIT_ALTERNATIVES = explicitAlternatives(statsNdjson)
  MOD_TIERS = null
  if (modTiersJson !== null) {
    try {
      MOD_TIERS = parseModTiers(JSON.parse(modTiersJson))
    } catch {
      MOD_TIERS = null
    }
  }
}

/** Tier per famiglia e base (data/mod-tiers.json); null se il file manca o non è valido. */
let MOD_TIERS: ModTiers | null = null

/** id explicit trade -> tutti gli id explicit della stessa stat (canonico = primo). */
let EXPLICIT_ALTERNATIVES = new Map<string, readonly string[]>()

function explicitAlternatives(statsNdjson: string): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>()
  for (const line of statsNdjson.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const ids = (JSON.parse(line) as { trade?: { ids?: Record<string, string[]> } }).trade?.ids
      ?.explicit
    if (!ids) continue
    for (const id of ids) if (!out.has(id)) out.set(id, ids)
  }
  return out
}

/**
 * Id explicit equivalenti di una stat (es. attack speed locale/globale), canonico per primo.
 * Per stat con un solo id o sconosciute: `[statId]`. Richiede `initParserData`.
 */
export function statAlternatives(statId: string): string[] {
  const ids = EXPLICIT_ALTERNATIVES.get(statId)
  if (!ids) return [statId]
  return [ids[0], ...ids.filter((id) => id !== ids[0])]
}

/** Legge il testo copiato dal gioco (formato avanzato, Ctrl+Alt+C) di un oggetto raro. */
export function parseItemText(text: string): ParseResult {
  if (text.trim() === '') return { ok: false, reason: 'empty' }
  // Senza riga "Rarity:" non è un oggetto: evita di passare testo arbitrario al parser EE2.
  if (!/^Rarity: /m.test(text)) return { ok: false, reason: 'not_poe_item' }

  const parsed = parseClipboard(text)
  if (parsed.isErr()) {
    if (parsed.error !== UNKNOWN_ITEM_ERROR) return { ok: false, reason: 'not_poe_item' }
    return unknownItemFailure(text)
  }
  const item = parsed.value as ParserState

  if (item.rarity !== ItemRarity.Rare) return { ok: false, reason: 'unsupported_rarity' }
  if (item.isUnidentified) return { ok: false, reason: 'unidentified' }

  const itemClass = item.category && TRADE_CATEGORY.get(item.category)
  if (!itemClass) return { ok: false, reason: 'unsupported_item' }

  // Con Ctrl+C semplice mancano gli header "{ … }": EE2 non legge i mod explicit, oppure
  // li legge senza sapere se sono prefix o suffix.
  const missingGeneration = item.newMods.some(
    (mod) =>
      AFFIX_TYPES.has(mod.info.type) &&
      mod.info.generation !== 'prefix' &&
      mod.info.generation !== 'suffix'
  )
  if (!MOD_HEADER.test(text) || missingGeneration) return { ok: false, reason: 'not_advanced' }

  const explicits: ItemMod[] = []
  const implicits: ItemMod[] = []
  let prefixes = 0
  let suffixes = 0

  for (const mod of item.newMods) {
    if (AFFIX_TYPES.has(mod.info.type)) {
      const { generation } = mod.info
      if (generation !== 'prefix' && generation !== 'suffix') continue
      if (generation === 'prefix') prefixes++
      else suffixes++
      const tierCount = explicitTierCount(mod, item.info.refName, generation)
      explicits.push(...toItemMods(mod, generation, ['explicit', mod.info.type], tierCount))
    } else if (mod.info.type === ModifierType.Veiled) {
      // Mod "Desecrated Prefix/Suffix" non ancora rivelato: occupa lo slot ma non ha stat.
      if (mod.info.generation === 'prefix') prefixes++
      else if (mod.info.generation === 'suffix') suffixes++
    } else {
      const implicit = IMPLICIT_TYPES.get(mod.info.type)
      if (implicit) implicits.push(...toItemMods(mod, implicit.type, [implicit.tradeKey]))
    }
  }

  const maxSlots = MAX_AFFIXES.get(item.category!) ?? DEFAULT_MAX_AFFIXES

  const rare: RareItem = {
    raw: text,
    itemClass,
    baseType: item.info.refName,
    name: item.name,
    itemLevel: item.itemLevel ?? 0,
    quality: item.quality ?? 0,
    corrupted: item.isCorrupted,
    explicits: mergeSameStat(explicits),
    implicits,
    openPrefixes: Math.max(0, maxSlots - prefixes),
    openSuffixes: Math.max(0, maxSlots - suffixes)
  }
  const weapon = weaponStats(item)
  if (weapon) rare.weapon = weapon
  return { ok: true, item: rare }
}

/** Arrotonda a un decimale (evita il rumore dei float, es. 117.65000000000001). */
const round1 = (v: number): number => Math.round(v * 10) / 10

/**
 * DPS di un'arma d'attacco dalle proprietà lette da EE2 ("Physical Damage: a-b",
 * "Fire/Cold/Lightning Damage: a-b", "Attacks per Second: x"). EE2 dà già le medie
 * (weaponPHYSICAL, weaponELEMENTAL = somma delle medie elementali). Senza aps: undefined.
 */
function weaponStats(item: ParserState): WeaponStats | undefined {
  const aps = item.weaponAS
  if (aps === undefined || !Number.isFinite(aps) || aps <= 0) return undefined
  const out: WeaponStats = {
    pdps: round1((item.weaponPHYSICAL ?? 0) * aps),
    edps: round1((item.weaponELEMENTAL ?? 0) * aps),
    aps
  }
  if (item.weaponCRIT !== undefined && Number.isFinite(item.weaponCRIT)) {
    out.critChance = item.weaponCRIT
  }
  return out
}

/** Header di un mod nel testo avanzato, es. `{ Prefix Modifier "Stalwart" (Tier: 6) — Life }`. */
const MOD_HEADER = /^\{.*\}$/m

/** EE2 non trova base/nome nei dati: per un raro identificato l'oggetto non è supportato. */
function unknownItemFailure(text: string): ParseResult {
  const rarity = /^Rarity: (.*)$/m.exec(text)?.[1]?.trim()
  if (rarity !== ItemRarity.Rare) return { ok: false, reason: 'unsupported_rarity' }
  if (/^Unidentified/m.test(text)) return { ok: false, reason: 'unidentified' }
  return { ok: false, reason: 'unsupported_item' }
}

/**
 * Tier totali della famiglia di un explicit sulla base; undefined senza dati, nome o tier, o se
 * il conteggio è incoerente con il tier del testo (dati di un'altra versione del gioco).
 */
function explicitTierCount(
  mod: ParsedModifier,
  baseType: string,
  generation: 'prefix' | 'suffix'
): number | undefined {
  const { name, tier } = mod.info
  if (!MOD_TIERS || !name || tier === undefined) return undefined
  const count = tierCountOf(MOD_TIERS, baseType, generation, name)
  return count !== undefined && count >= tier ? count : undefined
}

/** Un ItemMod per stat; le stat senza id trade per i tipi richiesti vengono scartate. */
function toItemMods(
  mod: ParsedModifier,
  type: ModType,
  tradeKeys: string[],
  tierCount?: number
): ItemMod[] {
  const out: ItemMod[] = []
  for (const stat of mod.stats) {
    const ids = stat.stat.trade.ids
    const statId = tradeKeys.map((key) => ids[key]?.[0]).find((id) => id !== undefined)
    if (!statId) continue

    const source = stat.sourceText ?? stat.translation.string
    const text = stripRanges(source)
    const itemMod: ItemMod = {
      statId,
      text,
      values: numbersIn(text),
      // come EE2 (statSourcesTotal): una stat senza numeri conta 1
      tradeValue: stat.roll?.value ?? 1,
      type
    }
    if (mod.info.tier !== undefined) itemMod.tier = mod.info.tier
    if (tierCount !== undefined) itemMod.tierCount = tierCount
    if (stat.roll && hasRanges(source)) {
      itemMod.range = { min: stat.roll.min, max: stat.roll.max }
    }
    out.push(itemMod)
  }
  return out
}

/**
 * Explicit con lo stesso statId (es. due mod di mana massimo) uniti in un solo ItemMod, come il
 * trade che li somma: tradeValue e range sommati, testi uniti con " · ", tipo e tier del primo.
 * Gli slot occupati sono già contati per mod, non per stat.
 */
function mergeSameStat(mods: ItemMod[]): ItemMod[] {
  const out: ItemMod[] = []
  const byStat = new Map<string, ItemMod>()
  for (const m of mods) {
    const prev = byStat.get(m.statId)
    if (!prev) {
      const copy = { ...m, values: [...m.values] }
      byStat.set(m.statId, copy)
      out.push(copy)
      continue
    }
    prev.text = `${prev.text} · ${m.text}`
    prev.values.push(...m.values)
    prev.tradeValue += m.tradeValue
    if (prev.range && m.range) {
      prev.range = { min: prev.range.min + m.range.min, max: prev.range.max + m.range.max }
    } else {
      delete prev.range
    }
  }
  return out
}

/** Range del testo avanzato: "+74(70-84)" -> "+74". */
const RANGE = /(\d)\([^()]*\)/g

function stripRanges(line: string): string {
  return line.replace(RANGE, '$1')
}

function hasRanges(line: string): boolean {
  return /\d\([^()]*\)/.test(line)
}

function numbersIn(line: string): number[] {
  return (line.match(/[+-]?\d+(?:\.\d+)?/g) ?? []).map(Number)
}

const CATEGORY_BY_TRADE_CLASS = new Map<string, ItemCategory>(
  [...TRADE_CATEGORY].map(([category, tradeClass]) => [tradeClass, category])
)

const TRADE_LINE_TYPES: Record<string, ModifierType> = {
  explicit: ModifierType.Explicit,
  fractured: ModifierType.Fractured,
  desecrated: ModifierType.Desecrated,
  crafted: ModifierType.Crafted
}

/**
 * Valore in unità trade di una riga di mod di un'inserzione (es. "52% reduced Shock duration on
 * you"), calcolato con lo stesso matcher EE2 usato per gli item (segno e media come `tradeValue`).
 * `statId` è l'id trade atteso (hash dell'inserzione senza "stat.", es. "explicit.stat_123"):
 * se il matcher trova un'altra stat o nessuna, restituisce null. Richiede `initParserData`.
 * Lo `statId` restituito è canonico come per gli item (`trade.ids.explicit[0]` della stat), così
 * "explicit.stat_681332047" (attack speed globale) o "fractured.stat_X" coincidono con l'id dell'item;
 * resta l'hash solo se la stat non ha id explicit.
 */
export function parseTradeLine(
  line: string,
  itemClass: string,
  statId: string
): { value: number; statId: string } | null {
  const modTypeKey = statId.split('.')[0]
  const modType = TRADE_LINE_TYPES[modTypeKey]
  if (!modType) return null
  const clean = line.replace(/\[([^\]|]*)\|([^\]]*)\]/g, '$2').replace(/\[([^\]|]*)\]/g, '$1')
  const found = tryParseTranslation(
    { string: clean, unscalable: false },
    modType,
    CATEGORY_BY_TRADE_CLASS.get(itemClass)
  )
  if (!found || !found.stat.trade.ids[modTypeKey]?.includes(statId)) return null
  return {
    // come EE2: una stat senza numeri conta 1
    value: found.roll?.value ?? 1,
    statId: found.stat.trade.ids.explicit?.[0] ?? statId
  }
}
