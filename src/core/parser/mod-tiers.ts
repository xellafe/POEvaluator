// Numero di tier di un affisso su una base, da data/mod-tiers.json (generato da
// scripts/build-mod-tiers.mjs con i dati di RePoE). Serve a dire "Tier 4 di 8".

/** Pesi di comparsa di un tier: [[tag, peso], ...]; vale il primo tag che la base possiede. */
type SpawnWeights = [string, number][]

export interface ModTiers {
  tagSets: string[][]
  /** Nome della base → indice in `tagSets`. */
  bases: Record<string, number>
  /** "<prefix|suffix>|<famiglia>" → pesi di ogni tier della famiglia. */
  families: Record<string, SpawnWeights[]>
  /** "<prefix|suffix>|<nome del mod>" → famiglie con un mod di quel nome. */
  names: Record<string, string[]>
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** Valida il JSON di mod-tiers (solo la forma di primo livello); null se non è utilizzabile. */
export function parseModTiers(json: unknown): ModTiers | null {
  if (!isObj(json)) return null
  const { tagSets, bases, families, names } = json
  if (!Array.isArray(tagSets) || !isObj(bases) || !isObj(families) || !isObj(names)) return null
  return json as unknown as ModTiers
}

/** Il tier può comparire sulla base: decide il primo tag dei pesi che la base possiede. */
function spawnsOn(weights: SpawnWeights, tags: ReadonlySet<string>): boolean {
  for (const entry of weights) {
    if (!Array.isArray(entry)) continue
    const [tag, weight] = entry
    if (tags.has(tag)) return typeof weight === 'number' && weight > 0
  }
  return false
}

/**
 * Tier che la famiglia del mod `name` ha sulla base `baseType`; undefined se base o nome non
 * sono nei dati. Con più famiglie dallo stesso nome (es. "of Expertise": velocità di lancio
 * propria o degli alleati) vale la prima che compare sulla base.
 */
export function tierCountOf(
  data: ModTiers,
  baseType: string,
  generation: 'prefix' | 'suffix',
  name: string
): number | undefined {
  const tagIdx = data.bases[baseType]
  const tagList = tagIdx === undefined ? undefined : data.tagSets[tagIdx]
  if (!Array.isArray(tagList)) return undefined
  const tags = new Set(tagList)
  for (const fam of data.names[`${generation}|${name}`] ?? []) {
    const tiers = data.families[fam]
    if (!Array.isArray(tiers)) continue
    const n = tiers.filter((w) => Array.isArray(w) && spawnsOn(w, tags)).length
    if (n > 0) return n
  }
  return undefined
}
