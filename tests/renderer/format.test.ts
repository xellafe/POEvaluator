import { describe, expect, it } from 'vitest'
import {
  analysisAge,
  formatDelta,
  formatPrice,
  patientLine,
  priceParts,
  similarCount,
  formatRange,
  hotkeyFromKeyEvent,
  hotkeyParts,
  itemClassLabel,
  type KeyLike,
  verdictLabel
} from '../../src/renderer/format'

describe('formatPrice', () => {
  it('sotto 1 divine solo exalted', () => {
    expect(formatPrice(45, 250)).toBe('45 ex')
    expect(formatPrice(2.5, 250)).toBe('2.5 ex')
  })

  it('da 1 divine in su: divine e tra parentesi exalted', () => {
    expect(formatPrice(450, 250)).toBe('1.8 div (450 ex)')
    expect(formatPrice(250, 250)).toBe('1 div (250 ex)')
    expect(formatPrice(500, 250)).toBe('2 div (500 ex)')
  })

  it('senza tasso del divine solo exalted', () => {
    expect(formatPrice(450, null)).toBe('450 ex')
  })
})

describe('priceParts', () => {
  it('parte principale e unità', () => {
    expect(priceParts(18, 250)).toEqual({ main: '18', unit: 'ex' })
    expect(priceParts(450, 250)).toEqual({ main: '1.8 div', unit: '(450 ex)' })
  })
})

describe('similarCount', () => {
  it('singolare e plurale', () => {
    expect(similarCount(1)).toBe('1 oggetto simile')
    expect(similarCount(23)).toBe('23 oggetti simili')
  })
})

describe('formatRange', () => {
  it('in exalted se il minimo è sotto 1 divine', () => {
    expect(formatRange(12, 25, 250)).toBe('12–25 ex')
    expect(formatRange(220, 340, 250)).toBe('220–340 ex')
    expect(formatRange(1, 3, null)).toBe('1–3 ex')
  })

  it('in divine se anche il minimo arriva a 1 divine', () => {
    expect(formatRange(350, 600, 250)).toBe('1.4–2.4 div')
  })
})

describe('formatDelta', () => {
  it('segno esplicito, meno tipografico', () => {
    expect(formatDelta(118)).toBe('+118 ex')
    expect(formatDelta(-4)).toBe('−4 ex')
    expect(formatDelta(0)).toBe('0 ex')
  })
})

describe('verdictLabel', () => {
  it('etichette dei verdetti', () => {
    expect(verdictLabel('pessimo')).toBe('Pessimo')
    expect(verdictLabel('buono')).toBe('Buono')
    expect(verdictLabel('ottimo')).toBe('Ottimo')
    expect(verdictLabel('eccellente')).toBe('Eccellente')
  })

  it('nessun verdetto: "Dati insufficienti"', () => {
    expect(verdictLabel(null)).toBe('Dati insufficienti')
  })
})

describe('itemClassLabel', () => {
  it('categoria trade in italiano, con fallback', () => {
    expect(itemClassLabel('armour.boots')).toBe('Stivali rari')
    expect(itemClassLabel('accessory.ring')).toBe('Anello raro')
    expect(itemClassLabel('boh')).toBe('Oggetto raro')
  })
})

describe('hotkey', () => {
  it('divide la combinazione nei tasti', () => {
    expect(hotkeyParts('Alt+Shift+D')).toEqual(['Alt', 'Shift', 'D'])
  })

  const ev = (
    code: string,
    mods: Partial<Record<'alt' | 'ctrl' | 'shift', boolean>> = {}
  ): KeyLike => ({
    code,
    altKey: mods.alt ?? false,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false
  })

  it('dal tasto premuto alla stringa delle impostazioni', () => {
    expect(hotkeyFromKeyEvent(ev('KeyD', { alt: true }))).toBe('Alt+D')
    expect(hotkeyFromKeyEvent(ev('KeyD', { alt: true, shift: true }))).toBe('Alt+Shift+D')
    expect(hotkeyFromKeyEvent(ev('Digit3', { ctrl: true }))).toBe('Ctrl+3')
    expect(hotkeyFromKeyEvent(ev('F5'))).toBe('F5')
  })

  it('null per i soli modificatori, tasti non gestiti o lettere senza modificatori', () => {
    expect(hotkeyFromKeyEvent(ev('AltLeft', { alt: true }))).toBeNull()
    expect(hotkeyFromKeyEvent(ev('Semicolon', { alt: true }))).toBeNull()
    expect(hotkeyFromKeyEvent(ev('KeyD'))).toBeNull()
    expect(hotkeyFromKeyEvent(ev('KeyF'))).toBeNull()
  })
})

describe('analysisAge', () => {
  const now = new Date('2026-11-12T12:30:00.000Z')
  it('sotto un minuto: "Analisi di poco fa"', () => {
    expect(analysisAge('2026-11-12T12:29:01.000Z', now)).toBe('Analisi di poco fa')
    expect(analysisAge('2026-11-12T12:30:05.000Z', now)).toBe('Analisi di poco fa')
  })
  it('in minuti interi', () => {
    expect(analysisAge('2026-11-12T12:29:00.000Z', now)).toBe('Analisi di 1 min fa')
    expect(analysisAge('2026-11-12T12:01:30.000Z', now)).toBe('Analisi di 28 min fa')
  })
})

describe('patientLine (R32)', () => {
  it('"Se puoi aspettare" con il prezzo formattato come gli altri', () => {
    expect(patientLine(120, 250)).toBe('Se puoi aspettare: 120 ex')
    expect(patientLine(450, 250)).toBe('Se puoi aspettare: 1.8 div (450 ex)')
    expect(patientLine(450, null)).toBe('Se puoi aspettare: 450 ex')
  })
})
