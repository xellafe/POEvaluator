export interface Settings {
  league: string
  hotkeys: { quick: string; deep: string }
  /** Soglie di valore, in exalted */
  thresholds: { buono: number; ottimo: number; vendiSubito: number }
  backgroundCollection: boolean
  maxListingAgeDays: number
}

export const DEFAULT_SETTINGS: Settings = {
  league: 'Standard',
  hotkeys: { quick: 'Alt+D', deep: 'Alt+Shift+D' },
  thresholds: { buono: 5, ottimo: 50, vendiSubito: 300 },
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
      vendiSubito: num(thresholds.vendiSubito, d.thresholds.vendiSubito)
    },
    backgroundCollection: bool(s.backgroundCollection, d.backgroundCollection),
    maxListingAgeDays: num(s.maxListingAgeDays, d.maxListingAgeDays)
  }
}
