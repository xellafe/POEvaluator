import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { SettingsPatch } from '../core/ipc'
import { hotkeysError, mergeSettings, type Settings } from '../core/settings'
import { parseHotkey } from './input'

/** Legge settings.json; file assente o JSON invalido -> default (via mergeSettings). */
export function loadSettings(path: string, log: (msg: string) => void): Settings {
  let saved: unknown = undefined
  try {
    saved = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`settings.json illeggibile, uso i default: ${e instanceof Error ? e.message : e}`)
    }
  }
  return mergeSettings(saved)
}

/** Scrittura atomica (file temporaneo + rename). */
export function saveSettings(path: string, settings: Settings): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

/** Applica una patch (hotkeys e thresholds anche parziali) e rivalida tutto con mergeSettings. */
export function applyPatch(current: Settings, patch: SettingsPatch): Settings {
  return mergeSettings({
    ...current,
    ...patch,
    hotkeys: { ...current.hotkeys, ...patch.hotkeys },
    thresholds: { ...current.thresholds, ...patch.thresholds }
  })
}

/**
 * Controllo delle impostazioni prima del salvataggio (`settings:set`): hotkey riconosciute,
 * diverse tra loro e diverse da Ctrl+Alt+C. `keys` è la tabella dei tasti (es. `UiohookKey`).
 * Restituisce il messaggio d'errore, o null se sono valide.
 */
export function settingsError(s: Settings, keys: Readonly<Record<string, number>>): string | null {
  for (const spec of [s.hotkeys.quick, s.hotkeys.deep]) {
    if (!parseHotkey(spec, keys)) return `Hotkey non valida: "${spec}"`
  }
  return hotkeysError(s.hotkeys)
}
