import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/core/settings'
import { applyPatch, loadSettings, saveSettings } from '../../src/main/settings-file'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'poev-settings-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('settings-file', () => {
  it('file assente o JSON invalido → default', () => {
    const d = tmp()
    expect(loadSettings(join(d, 'settings.json'), () => {})).toEqual(DEFAULT_SETTINGS)
    writeFileSync(join(d, 'bad.json'), '{oops')
    const logs: string[] = []
    expect(loadSettings(join(d, 'bad.json'), (m) => logs.push(m))).toEqual(DEFAULT_SETTINGS)
    expect(logs).toHaveLength(1)
  })

  it('salva e rilegge', () => {
    const p = join(tmp(), 'settings.json')
    const s = { ...DEFAULT_SETTINGS, league: 'Dawn' }
    saveSettings(p, s)
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual(s)
    expect(loadSettings(p, () => {})).toEqual(s)
  })

  it('patch parziale su hotkeys/thresholds, valori invalidi tornano al default', () => {
    const s = applyPatch(DEFAULT_SETTINGS, {
      hotkeys: { quick: 'Alt+Q' },
      thresholds: { ottimo: -1 }
    })
    expect(s.hotkeys).toEqual({ quick: 'Alt+Q', deep: DEFAULT_SETTINGS.hotkeys.deep })
    expect(s.thresholds).toEqual(DEFAULT_SETTINGS.thresholds)
  })
})
