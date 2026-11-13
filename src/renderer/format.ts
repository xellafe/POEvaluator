// Formattazione dei testi dell'interfaccia (pura: niente DOM, testata in Vitest).
import type { Confidence, ModStatus, Verdict } from '../core/types'

/** Valori >= 10 a intero, < 10 a un decimale (come roundPrice del core); niente ".0" finale. */
function num(v: number): string {
  const r = Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10
  return String(r)
}

/** Divine a un decimale, senza ".0" finale. */
const div = (exalted: number, exaltedPerDivine: number): string =>
  String(Math.round((exalted / exaltedPerDivine) * 10) / 10)

const hasDivine = (exalted: number, rate: number | null): rate is number =>
  rate !== null && rate > 0 && exalted >= rate

/**
 * Prezzo diviso in parte principale e unità, per lo stile del mockup (unità più piccola):
 * { main: "45", unit: "ex" } oppure { main: "1.8 div", unit: "(450 ex)" }.
 */
export function priceParts(
  exalted: number,
  exaltedPerDivine: number | null
): { main: string; unit: string } {
  if (!hasDivine(exalted, exaltedPerDivine)) return { main: num(exalted), unit: 'ex' }
  return { main: `${div(exalted, exaltedPerDivine)} div`, unit: `(${num(exalted)} ex)` }
}

/** "45 ex"; da 1 divine in su "1.8 div (450 ex)"; senza tasso del divine solo exalted. */
export function formatPrice(exalted: number, exaltedPerDivine: number | null): string {
  const p = priceParts(exalted, exaltedPerDivine)
  return `${p.main} ${p.unit}`
}

/** Prezzo breve, senza exalted tra parentesi: "30 ex", "1.8 div". */
export function shortPrice(exalted: number, exaltedPerDivine: number | null): string {
  return hasDivine(exalted, exaltedPerDivine)
    ? `${div(exalted, exaltedPerDivine)} div`
    : `${num(exalted)} ex`
}

/**
 * Prezzi trovati per una stima incerta: tutti se sono al massimo 5 ("30 ex · 1 div · 10 div"),
 * altrimenti dal più basso al più alto ("30 ex – 10 div").
 */
export function foundPrices(sample: number[], exaltedPerDivine: number | null): string {
  const sorted = [...sample].sort((a, b) => a - b)
  if (sorted.length === 0) return ''
  if (sorted.length <= 5) return sorted.map((p) => shortPrice(p, exaltedPerDivine)).join(' · ')
  const lo = shortPrice(sorted[0], exaltedPerDivine)
  const hi = shortPrice(sorted[sorted.length - 1], exaltedPerDivine)
  return `${lo} – ${hi}`
}

/** Spiegazione di una stima incerta dai motivi del core: "Solo 3 oggetti simili in vendita: …". */
export function uncertainText(reasons: string[]): string {
  const s = reasons.join(', ')
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}: il prezzo può variare molto`
}

/** Prezzo in exalted ("280 ex"), arrotondato come nel resto dell'interfaccia. */
export const formatExalted = (exalted: number): string => `${num(exalted)} ex`

/** "1 oggetto simile" / "23 oggetti simili". */
export const similarCount = (n: number): string =>
  n === 1 ? '1 oggetto simile' : `${n} oggetti simili`

/** Fascia di prezzo: "12–25 ex", oppure "1.4–2.4 div" quando anche il minimo arriva a 1 divine. */
export function formatRange(min: number, max: number, exaltedPerDivine: number | null): string {
  if (!hasDivine(min, exaltedPerDivine)) return `${num(min)}–${num(max)} ex`
  return `${div(min, exaltedPerDivine)}–${div(max, exaltedPerDivine)} div`
}

/** Contributo di un affisso: "+118 ex", "−4 ex" (meno tipografico), "0 ex". */
export function formatDelta(deltaExalted: number): string {
  if (deltaExalted > 0) return `+${num(deltaExalted)} ex`
  if (deltaExalted < 0) return `−${num(-deltaExalted)} ex`
  return '0 ex'
}

const VERDICT_LABELS: Record<Verdict, string> = {
  pessimo: 'Pessimo',
  buono: 'Buono',
  ottimo: 'Ottimo',
  eccellente: 'Eccellente'
}

/** Etichetta del verdetto; null (nessun prezzo utilizzabile, R26) -> "Dati insufficienti". */
export function verdictLabel(v: Verdict | null): string {
  return v === null ? 'Dati insufficienti' : VERDICT_LABELS[v]
}

/** Età di un'analisi approfondita presa dalla cache: "Analisi di N min fa" / "Analisi di poco fa". */
export function analysisAge(cachedAt: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(cachedAt).getTime()) / 60_000)
  return minutes < 1 ? 'Analisi di poco fa' : `Analisi di ${minutes} min fa`
}

/** Numero di tacche dell'indicatore di affidabilità. */
export const CONFIDENCE_LEVEL: Record<Confidence, 1 | 2 | 3> = { bassa: 1, media: 2, alta: 3 }

const CLASS_LABELS: Record<string, string> = {
  'armour.helmet': 'Elmo raro',
  'armour.chest': 'Armatura rara',
  'armour.gloves': 'Guanti rari',
  'armour.boots': 'Stivali rari',
  'armour.shield': 'Scudo raro',
  'armour.buckler': 'Brocchiere raro',
  'armour.focus': 'Focus raro',
  'armour.quiver': 'Faretra rara',
  'accessory.amulet': 'Amuleto raro',
  'accessory.ring': 'Anello raro',
  'accessory.belt': 'Cintura rara',
  jewel: 'Gioiello raro',
  flask: 'Ampolla rara',
  'flask.charm': 'Ciondolo raro',
  'weapon.bow': 'Arco raro',
  'weapon.crossbow': 'Balestra rara',
  'weapon.wand': 'Bacchetta rara',
  'weapon.sceptre': 'Scettro raro',
  'weapon.staff': 'Bastone raro',
  'weapon.warstaff': 'Bastone da guerra raro',
  'weapon.claw': 'Artiglio raro',
  'weapon.dagger': 'Pugnale raro',
  'weapon.spear': 'Lancia rara',
  'weapon.flail': 'Flagello raro',
  'weapon.talisman': 'Talismano raro',
  'weapon.oneaxe': 'Ascia a una mano rara',
  'weapon.twoaxe': 'Ascia a due mani rara',
  'weapon.onemace': 'Mazza a una mano rara',
  'weapon.twomace': 'Mazza a due mani rara',
  'weapon.onesword': 'Spada a una mano rara',
  'weapon.twosword': 'Spada a due mani rara',
  'map.tablet': 'Tavoletta rara'
}

/** Categoria trade in italiano, per l'intestazione del pannello ("Stivali rari"). */
export function itemClassLabel(itemClass: string): string {
  return CLASS_LABELS[itemClass] ?? 'Oggetto raro'
}

/** "Alt+Shift+D" -> ["Alt", "Shift", "D"] (un <kbd> per tasto). */
export function hotkeyParts(hotkey: string): string[] {
  return hotkey.split('+').map((p) => p.trim())
}

export interface KeyLike {
  /** KeyboardEvent.code, es. "KeyD", "Digit3", "F5" */
  code: string
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}

/** Nome del tasto come in UiohookKey (lettere, cifre, F1–F24); null per gli altri tasti. */
function keyName(code: string): string | null {
  let m = /^Key([A-Z])$/.exec(code)
  if (m) return m[1]
  m = /^Digit([0-9])$/.exec(code)
  if (m) return m[1]
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  return null
}

/**
 * Combinazione premuta nel formato delle impostazioni ("Alt+Shift+D"). null se è solo un
 * modificatore, un tasto non gestito, o una lettera/cifra senza modificatori (scatterebbe
 * mentre si gioca).
 */
export function hotkeyFromKeyEvent(e: KeyLike): string | null {
  const key = keyName(e.code)
  if (key === null) return null
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(
    (m): m is string => typeof m === 'string'
  )
  const isFunctionKey = /^F\d+$/.test(e.code)
  if (mods.length === 0 && !isFunctionKey) return null
  return [...mods, key].join('+')
}

/** Margine (in %) ai lati della barra della distribuzione. */
const DIST_PAD = 5

/**
 * Posizioni (in % della larghezza) dei prezzi del campione e dei marcatori p10/p25/p50 su scala
 * logaritmica fra il prezzo minimo e il massimo del campione, con un margine del 5% ai lati.
 * Con tutti i prezzi uguali (o un solo prezzo) tutto sta al centro.
 */
export function distributionLayout(
  sample: number[],
  marks: { p10: number; p25: number; p50: number }
): { dots: number[]; marks: { p10: number; p25: number; p50: number } } {
  const valid = sample.filter((x) => x > 0)
  if (valid.length === 0) return { dots: [], marks: { p10: 50, p25: 50, p50: 50 } }
  const lo = Math.log(Math.min(...valid))
  const hi = Math.log(Math.max(...valid))
  const pos = (x: number): number => {
    if (hi <= lo || x <= 0) return 50
    const t = (Math.log(x) - lo) / (hi - lo)
    return DIST_PAD + Math.min(1, Math.max(0, t)) * (100 - 2 * DIST_PAD)
  }
  return {
    dots: valid.map(pos),
    marks: { p10: pos(marks.p10), p25: pos(marks.p25), p50: pos(marks.p50) }
  }
}

/** Tooltip di un affisso escluso dalla ricerca (R34); undefined per gli altri stati. */
export function modStatusTitle(status: ModStatus): string | undefined {
  if (status === 'unweighted') return 'Non considerato: affisso di poco valore'
  if (status === 'relaxed') return 'Tolto dalla ricerca: pochi oggetti simili'
  return undefined
}
