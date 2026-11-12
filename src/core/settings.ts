export interface Settings {
  league: string
  hotkeys: { quick: string; deep: string }
  /** Soglie di valore, in exalted */
  thresholds: { buono: number; ottimo: number; eccellente: number }
  backgroundCollection: boolean
  maxListingAgeDays: number
}

export const DEFAULT_SETTINGS: Settings = {
  league: 'Standard',
  hotkeys: { quick: 'Alt+D', deep: 'Alt+Shift+D' },
  thresholds: { buono: 5, ottimo: 50, eccellente: 300 },
  backgroundCollection: true,
  maxListingAgeDays: 7
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v.trim() !== '' ? v : fallback

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

/** Unisce le impostazioni salvate ai default: valori mancanti o invalidi tornano al default. */
export function mergeSettings(saved: unknown): Settings {
  const s = isRecord(saved) ? saved : {}
  const hotkeys = isRecord(s.hotkeys) ? s.hotkeys : {}
  const thresholds = isRecord(s.thresholds) ? s.thresholds : {}
  const d = DEFAULT_SETTINGS
  return {
    league: str(s.league, d.league),
    hotkeys: {
      quick: str(hotkeys.quick, d.hotkeys.quick),
      deep: str(hotkeys.deep, d.hotkeys.deep)
    },
    thresholds: {
      buono: num(thresholds.buono, d.thresholds.buono),
      ottimo: num(thresholds.ottimo, d.thresholds.ottimo),
      // "vendiSubito" è il nome precedente della soglia (settings.json salvati prima della rinomina)
      eccellente: num(thresholds.eccellente, num(thresholds.vendiSubito, d.thresholds.eccellente))
    },
    backgroundCollection: bool(s.backgroundCollection, d.backgroundCollection),
    maxListingAgeDays: num(s.maxListingAgeDays, d.maxListingAgeDays)
  }
}

/** Combinazione inviata al gioco per copiare l'oggetto: l'hook la vede, non può essere una hotkey. */
const COPY_COMBO = 'alt+ctrl+c'

const MODIFIER_ALIASES: Record<string, string> = { control: 'ctrl' }

/** Forma canonica di una hotkey: minuscole, modificatori in ordine alfabetico, tasto in fondo. */
function normalizeHotkey(spec: string): string {
  const parts = spec.split('+').map((p) => p.trim().toLowerCase())
  const key = parts.pop() ?? ''
  const mods = parts.map((p) => MODIFIER_ALIASES[p] ?? p).sort()
  return [...mods, key].join('+')
}

/** Errore delle hotkey (Ctrl+Alt+C riservata, hotkey uguali); null se vanno bene. */
export function hotkeysError(hotkeys: Settings['hotkeys']): string | null {
  const quick = normalizeHotkey(hotkeys.quick)
  const deep = normalizeHotkey(hotkeys.deep)
  if (quick === COPY_COMBO || deep === COPY_COMBO) {
    return "Combinazione riservata alla copia dell'oggetto"
  }
  if (quick === deep) return 'Le due hotkey devono essere diverse'
  return null
}
