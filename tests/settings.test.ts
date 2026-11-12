import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '../src/core/settings'

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
