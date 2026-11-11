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
    expect(result.thresholds.vendiSubito).toBe(300)
    expect(result.hotkeys).toEqual({ quick: 'Alt+D', deep: 'Alt+Shift+D' })
    expect(result.backgroundCollection).toBe(true)
    expect(result.maxListingAgeDays).toBe(7)
  })
})
