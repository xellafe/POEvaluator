import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, hotkeysError, mergeSettings } from '../src/core/settings'

describe('hotkeysError', () => {
  it('default validi', () => {
    expect(hotkeysError(DEFAULT_SETTINGS.hotkeys)).toBeNull()
  })

  it('rifiuta Ctrl+Alt+C (in qualsiasi ordine e maiuscole)', () => {
    const msg = "Combinazione riservata alla copia dell'oggetto"
    expect(hotkeysError({ quick: 'Ctrl+Alt+C', deep: 'Alt+Shift+D' })).toBe(msg)
    expect(hotkeysError({ quick: 'Alt+D', deep: 'alt+control+c' })).toBe(msg)
    expect(hotkeysError({ quick: 'Ctrl+Alt+Shift+C', deep: 'Alt+D' })).toBeNull()
  })

  it('rifiuta due hotkey uguali (anche con i modificatori in ordine diverso)', () => {
    const msg = 'Le due hotkey devono essere diverse'
    expect(hotkeysError({ quick: 'Alt+D', deep: 'Alt+D' })).toBe(msg)
    expect(hotkeysError({ quick: 'Shift+Alt+D', deep: 'alt+shift+d' })).toBe(msg)
  })
})

describe('mergeSettings', () => {
  it('restituisce i default se non ci sono impostazioni salvate', () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
  })

  it('applica i valori validi e ripristina i default per quelli invalidi', () => {
    const result = mergeSettings({ league: 'Dawn', thresholds: { buono: 'x' } })
    expect(result.league).toBe('Dawn')
    expect(result.thresholds.buono).toBe(5)
    expect(result.thresholds.ottimo).toBe(50)
    expect(result.thresholds.eccellente).toBe(300)
    expect(result.hotkeys).toEqual({ quick: 'Alt+D', deep: 'Alt+Shift+D' })
    expect(result.backgroundCollection).toBe(true)
    expect(result.maxListingAgeDays).toBe(7)
  })

  it('migra la vecchia chiave thresholds.vendiSubito in eccellente', () => {
    expect(mergeSettings({ thresholds: { vendiSubito: 400 } }).thresholds.eccellente).toBe(400)
    // con entrambe vince la chiave nuova
    expect(
      mergeSettings({ thresholds: { vendiSubito: 400, eccellente: 500 } }).thresholds.eccellente
    ).toBe(500)
    expect(mergeSettings({ thresholds: { vendiSubito: 400 } }).thresholds).not.toHaveProperty(
      'vendiSubito'
    )
  })
})
