/* eslint-disable @typescript-eslint/explicit-function-return-type -- script Node in JavaScript, senza tipi */
// Genera data/mod-tiers.json dai dati di RePoE per PoE2 (https://repoe-fork.github.io/poe2/):
// per ogni prefix/suffix la famiglia di mod e i pesi di comparsa, per ogni base i tag. Serve a
// sapere quanti tier ha un affisso su una base ("Tier 4 di 8").
//
// Uso: node scripts/build-mod-tiers.mjs [cartella]
//   senza cartella scarica mods.min.json e base_items.min.json da repoe-fork.github.io;
//   con la cartella li legge da lì.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SOURCE = 'https://repoe-fork.github.io/poe2/'
const USER_AGENT = 'POEvaluator/0.1.0 (+https://github.com/xellafe/POEvaluator)'
const OUT = new URL('../data/mod-tiers.json', import.meta.url)

async function load(name) {
  const dir = process.argv[2]
  if (dir) return JSON.parse(await readFile(join(dir, name), 'utf8'))
  const res = await fetch(SOURCE + name, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
  return res.json()
}

const mods = await load('mods.min.json')
const baseItems = await load('base_items.min.json')

/** Pesi di comparsa compatti: [[tag, peso], ...] nell'ordine di RePoE (vale il primo tag della base). */
const weightsOf = (m) => (m.spawn_weights ?? []).map((w) => [w.tag, w.weight])

// famiglie: "<prefix|suffix>|<type>" → pesi di ogni tier; nomi: "<prefix|suffix>|<nome>" → famiglie
const families = {}
const names = {}
for (const m of Object.values(mods)) {
  if (m.domain !== 'item') continue
  if (m.generation_type !== 'prefix' && m.generation_type !== 'suffix') continue
  if (!m.name || !m.type) continue
  const weights = weightsOf(m)
  if (!weights.some(([, w]) => w > 0)) continue
  const fam = `${m.generation_type}|${m.type}`
  ;(families[fam] ??= []).push(weights)
  const key = `${m.generation_type}|${m.name}`
  const list = (names[key] ??= [])
  if (!list.includes(fam)) list.push(fam)
}

// basi equipaggiabili: nome → indice del gruppo di tag (gruppi deduplicati)
const tagSets = []
const tagIndex = new Map()
const bases = {}
for (const b of Object.values(baseItems)) {
  if (b.domain !== 'item' || b.release_state !== 'released' || !b.name || !b.tags) continue
  if (bases[b.name] !== undefined) continue
  const key = b.tags.join(',')
  if (!tagIndex.has(key)) {
    tagIndex.set(key, tagSets.length)
    tagSets.push(b.tags)
  }
  bases[b.name] = tagIndex.get(key)
}

const out = {
  _comment:
    'Generato da scripts/build-mod-tiers.mjs con i dati di RePoE (MIT, contenuti di Grinding Gear Games). Non modificare a mano.',
  source: SOURCE,
  generated: new Date().toISOString().slice(0, 10),
  tagSets,
  bases,
  families,
  names
}
await writeFile(OUT, JSON.stringify(out))
console.log(
  `mod-tiers.json: ${Object.keys(bases).length} basi, ${tagSets.length} gruppi di tag, ` +
    `${Object.keys(families).length} famiglie, ${Object.keys(names).length} nomi`
)
