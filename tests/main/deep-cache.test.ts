import { describe, expect, it } from 'vitest'
import type { Valuation } from '../../src/core/types'
import {
  DEEP_CACHE_MAX_ENTRIES,
  DEEP_CACHE_TTL_MS,
  DeepCache,
  normalizeItemText
} from '../../src/main/deep-cache'

const v = (n: number): Valuation => ({
  verdict: 'buono',
  confidence: 'media',
  comparablesCount: n,
  warnings: []
})

const T0 = new Date('2026-11-12T12:00:00.000Z')
const at = (ms: number): Date => new Date(T0.getTime() + ms)

describe('normalizeItemText', () => {
  it('righe trimmate, CRLF uniformato, senza righe vuote in fondo', () => {
    expect(normalizeItemText('  Item Class: Boots \r\nRarity: Rare\r\n\r\n  \n')).toBe(
      'Item Class: Boots\nRarity: Rare'
    )
  })
})

describe('DeepCache', () => {
  it('restituisce il risultato salvato con il suo istante, entro 30 minuti', () => {
    const c = new DeepCache()
    c.set('Standard', 'testo', v(1), T0)
    expect(c.get('Standard', 'testo', at(DEEP_CACHE_TTL_MS - 1))).toEqual({
      valuation: v(1),
      at: T0
    })
  })

  it('scade dopo 30 minuti', () => {
    const c = new DeepCache()
    c.set('Standard', 'testo', v(1), T0)
    expect(c.get('Standard', 'testo', at(DEEP_CACHE_TTL_MS))).toBeNull()
  })

  it('la chiave è league + testo normalizzato', () => {
    const c = new DeepCache()
    c.set('Standard', 'riga 1\r\n  riga 2  \r\n\r\n', v(1), T0)
    expect(c.get('Standard', 'riga 1\nriga 2', T0)?.valuation).toEqual(v(1))
    expect(c.get('Dawn', 'riga 1\nriga 2', T0)).toBeNull()
    expect(c.get('Standard', 'riga 1\nriga 3', T0)).toBeNull()
  })

  it('al massimo 50 voci: le più vecchie escono', () => {
    expect(DEEP_CACHE_MAX_ENTRIES).toBe(50)
    const c = new DeepCache()
    for (let i = 0; i < 51; i++) c.set('Standard', `item ${i}`, v(i), at(i))
    expect(c.size).toBe(50)
    expect(c.get('Standard', 'item 0', at(100))).toBeNull()
    expect(c.get('Standard', 'item 1', at(100))?.valuation).toEqual(v(1))
    expect(c.get('Standard', 'item 50', at(100))?.valuation).toEqual(v(50))
  })

  it('salvare di nuovo lo stesso oggetto lo rende il più recente', () => {
    const c = new DeepCache()
    for (let i = 0; i < 50; i++) c.set('Standard', `item ${i}`, v(i), at(i))
    c.set('Standard', 'item 0', v(100), at(60))
    c.set('Standard', 'item 50', v(50), at(61))
    expect(c.get('Standard', 'item 0', at(62))?.valuation).toEqual(v(100))
    expect(c.get('Standard', 'item 1', at(62))).toBeNull()
  })
})
