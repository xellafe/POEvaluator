// Adapter tra il parser vendorizzato di Exiled Exchange 2 (ParsedItem) e RareItem di POEvaluator.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ItemMod, ModType, ParseResult } from '../types'
import { init } from './vendor/data'
import { ModifierType } from './vendor/parser/modifiers'
import type { ParsedModifier } from './vendor/parser/advanced-mod-desc'
import { ItemCategory } from './vendor/parser/meta'
import { ItemRarity } from './vendor/parser/ParsedItem'
import { parseClipboard, type ParserState } from './vendor/parser/Parser'

const MAX_PREFIXES = 3
const MAX_SUFFIXES = 3

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
  [ItemCategory.Waystone, 'map.waystone'],
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

/** Carica stats/items di EE2 da `dataDir` (es. `data/en`). Va chiamata prima di parseItemText. */
export async function initParserData(dataDir: string): Promise<void> {
  const [itemsNdjson, statsNdjson] = await Promise.all([
    readFile(join(dataDir, 'items.ndjson'), 'utf8'),
    readFile(join(dataDir, 'stats.ndjson'), 'utf8')
  ])
  init({ itemsNdjson, statsNdjson })
}

/** Legge il testo copiato dal gioco (formato avanzato, Ctrl+Alt+C) di un oggetto raro. */
export function parseItemText(text: string): ParseResult {
  if (text.trim() === '') return { ok: false, reason: 'empty' }
  // Senza riga "Rarity:" non è un oggetto: evita di passare testo arbitrario al parser EE2.
  if (!/^Rarity: /m.test(text)) return { ok: false, reason: 'not_poe_item' }

  const parsed = parseClipboard(text)
  if (parsed.isErr()) return { ok: false, reason: 'not_poe_item' }
  const item = parsed.value as ParserState

  if (item.rarity !== ItemRarity.Rare) return { ok: false, reason: 'unsupported_rarity' }
  if (item.isUnidentified) return { ok: false, reason: 'unidentified' }

  const itemClass = item.category && TRADE_CATEGORY.get(item.category)
  if (!itemClass) return { ok: false, reason: 'not_poe_item' }

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
      explicits.push(...toItemMods(mod, generation, ['explicit', mod.info.type]))
    } else if (mod.info.type === ModifierType.Veiled) {
      // Mod "Desecrated Prefix/Suffix" non ancora rivelato: occupa lo slot ma non ha stat.
      if (mod.info.generation === 'prefix') prefixes++
      else if (mod.info.generation === 'suffix') suffixes++
    } else {
      const implicit = IMPLICIT_TYPES.get(mod.info.type)
      if (implicit) implicits.push(...toItemMods(mod, implicit.type, [implicit.tradeKey]))
    }
  }

  return {
    ok: true,
    item: {
      raw: text,
      itemClass,
      baseType: item.info.refName,
      name: item.name,
      itemLevel: item.itemLevel ?? 0,
      quality: item.quality ?? 0,
      corrupted: item.isCorrupted,
      explicits,
      implicits,
      openPrefixes: Math.max(0, MAX_PREFIXES - prefixes),
      openSuffixes: Math.max(0, MAX_SUFFIXES - suffixes)
    }
  }
}

/** Un ItemMod per stat; le stat senza id trade per i tipi richiesti vengono scartate. */
function toItemMods(mod: ParsedModifier, type: ModType, tradeKeys: string[]): ItemMod[] {
  const out: ItemMod[] = []
  for (const stat of mod.stats) {
    const ids = stat.stat.trade.ids
    const statId = tradeKeys.map((key) => ids[key]?.[0]).find((id) => id !== undefined)
    if (!statId) continue

    const source = stat.sourceText ?? stat.translation.string
    const text = stripRanges(source)
    const itemMod: ItemMod = { statId, text, values: numbersIn(text), type }
    if (mod.info.tier !== undefined) itemMod.tier = mod.info.tier
    if (stat.roll && hasRanges(source)) {
      itemMod.range = { min: stat.roll.min, max: stat.roll.max }
    }
    out.push(itemMod)
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
