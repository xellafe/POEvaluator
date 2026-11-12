import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { SettingsPatch } from '../core/ipc'
import { mergeSettings, type Settings } from '../core/settings'

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
