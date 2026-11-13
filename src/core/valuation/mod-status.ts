// Stato degli affissi nell'analisi approfondita (R34): quali entrano nella ricerca, quali sono
// già nel DPS, quali sono esclusi. Senza dipendenze dal parser: lo usa anche il renderer.
import type { DeepMod, RareItem } from '../types'
import { weightsFor } from './weights'

/** Sotto questo DPS un'arma non ha quel tipo di danno (arrotondamenti del testo). */
export const DPS_EPSILON = 1

/**
 * Stat di danno locali delle armi (data/en/stats.ndjson, id interni `local_*`): nelle armi
 * d'attacco il loro effetto è già nel DPS, quindi la query usa `pdps`/`edps` al posto loro.
 */
export const LOCAL_PHYSICAL_STATS: readonly string[] = [
  'explicit.stat_1509134228', // #% increased Physical Damage (local_physical_damage_+%)
  'explicit.stat_1940865751' // Adds # to # Physical Damage (local_minimum_added_physical_damage)
]
export const LOCAL_ELEMENTAL_STATS: readonly string[] = [
  'explicit.stat_709508406', // Adds # to # Fire Damage (local_minimum_added_fire_damage)
  'explicit.stat_1037193709', // Adds # to # Cold Damage (local_minimum_added_cold_damage)
  'explicit.stat_3336890334' // Adds # to # Lightning Damage (local_minimum_added_lightning_damage)
]
/** #% increased Attack Speed (local_attack_speed_+%): entra sia nel pdps sia nell'edps. */
const LOCAL_ATTACK_SPEED = 'explicit.stat_210067635'
export const LOCAL_DAMAGE_STATS: readonly string[] = [
  ...LOCAL_PHYSICAL_STATS,
  ...LOCAL_ELEMENTAL_STATS,
  LOCAL_ATTACK_SPEED
]

/** Armi senza danno d'attacco (incantatori): nessun filtro DPS. */
const CASTER_WEAPONS = new Set(['weapon.wand', 'weapon.staff', 'weapon.sceptre'])

/** Categorie `weapon.*` con danno d'attacco (tutte tranne bacchette, bastoni e scettri). */
export function isAttackWeapon(itemClass: string): boolean {
  return itemClass.startsWith('weapon.') && !CASTER_WEAPONS.has(itemClass)
}

/**
 * Stat di danno locali coperte dal filtro DPS dell'oggetto. Un tipo di danno è coperto solo se
 * l'arma lo ha: su un'arma solo fisica (edps 0) non c'è filtro edps, quindi i flat elementali
 * restano stat normali (nel not se hanno peso); lo stesso per il fisico con pdps ~0.
 * La velocità d'attacco locale entra in tutti e due i DPS.
 */
export function dpsCoverage(item: RareItem): (statId: string) => boolean {
  const weapon = isAttackWeapon(item.itemClass) ? item.weapon : undefined
  if (!weapon) return () => false
  const covered = new Set<string>()
  if (weapon.pdps >= DPS_EPSILON) LOCAL_PHYSICAL_STATS.forEach((id) => covered.add(id))
  if (weapon.edps >= DPS_EPSILON) LOCAL_ELEMENTAL_STATS.forEach((id) => covered.add(id))
  if (covered.size > 0) covered.add(LOCAL_ATTACK_SPEED)
  return (statId) => covered.has(statId)
}

/**
 * Tutti gli explicit dell'oggetto, nell'ordine del testo, con il loro stato nella ricerca:
 * - `dps`: mod di danno locale già coperto dal filtro DPS;
 * - `unweighted`: senza peso nella tabella della classe (se la classe ha una tabella);
 * - `relaxed`: tolto dal rilassamento (`removed`, noto solo a fine analisi);
 * - `used`: nella ricerca.
 * Il contributo (`deltaExalted`) lo aggiunge l'analisi approfondita.
 */
export function modStatuses(item: RareItem, removed: ReadonlySet<string> = new Set()): DeepMod[] {
  const weights = weightsFor(item.itemClass)
  const coveredByDps = dpsCoverage(item)
  return item.explicits.map((m) => {
    const status: DeepMod['status'] = coveredByDps(m.statId)
      ? 'dps'
      : weights && (weights[m.statId] ?? 0) <= 0
        ? 'unweighted'
        : removed.has(m.statId)
          ? 'relaxed'
          : 'used'
    const out: DeepMod = { statId: m.statId, text: m.text, status }
    if (m.tier !== undefined) out.tier = m.tier
    if (m.tierCount !== undefined) out.tierCount = m.tierCount
    return out
  })
}
