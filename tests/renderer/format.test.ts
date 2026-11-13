import { describe, expect, it } from 'vitest'
import {
  analysisAge,
  formatDelta,
  formatPrice,
  modStatusTitle,
  distributionLayout,
  priceParts,
  similarCount,
  formatRange,
  tierBand,
  tierTitle,
  foundPrices,
  shortPrice,
  uncertainText,
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

describe('stima incerta', () => {
  it('shortPrice: exalted o divine, senza parentesi', () => {
    expect(shortPrice(30, 640)).toBe('30 ex')
    expect(shortPrice(6400, 640)).toBe('10 div')
    expect(shortPrice(1166.72, 640)).toBe('1.8 div')
    expect(shortPrice(6400, null)).toBe('6400 ex')
  })

  it('foundPrices: tutti fino a 5, altrimenti dal più basso al più alto', () => {
    expect(foundPrices([640, 30, 6400], 640)).toBe('30 ex · 1 div · 10 div')
    expect(foundPrices([50, 330, 640, 640, 640, 1166.72, 3200], 640)).toBe('50 ex – 5 div')
    expect(foundPrices([], 640)).toBe('')
  })

  it('uncertainText: motivi uniti, prima lettera maiuscola', () => {
    expect(uncertainText(['solo 3 oggetti simili in vendita', 'confronto su 1 affisso su 4'])).toBe(
      'Solo 3 oggetti simili in vendita, confronto su 1 affisso su 4: il prezzo può variare molto'
    )
  })
})

describe('tierBand', () => {
  it('scala dal tier 1 (migliore) in giù', () => {
    expect(tierBand(1)).toBe('t1')
    expect(tierBand(2)).toBe('t2')
    expect(tierBand(3)).toBe('t3')
    expect(tierBand(4)).toBe('tmid')
    expect(tierBand(5)).toBe('tmid')
    expect(tierBand(6)).toBe('tlow')
    expect(tierBand(12)).toBe('tlow')
    expect(tierBand(undefined)).toBe('tnone')
  })

  it('relativa al numero di tier della famiglia', () => {
    // 4 tier: T1 oro, T2 verde, T3 azzurro, T4 spento
    expect([1, 2, 3, 4].map((t) => tierBand(t, 4))).toEqual(['t1', 't2', 't3', 'tlow'])
    // 8 tier
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((t) => tierBand(t, 8))).toEqual([
      't1',
      't2',
      't2',
      't3',
      't3',
      'tmid',
      'tlow',
      'tlow'
    ])
    // 13 tier: un T4 è ancora verde
    expect(tierBand(4, 13)).toBe('t2')
    expect(tierBand(8, 13)).toBe('tmid')
    // famiglia con un solo tier
    expect(tierBand(1, 1)).toBe('t1')
  })

  it('totale incoerente (minore del tier): torna alla scala assoluta', () => {
    expect(tierBand(5, 3)).toBe('tmid')
  })

  it('tierTitle', () => {
    expect(tierTitle(4, 8)).toBe('Tier 4 di 8')
    expect(tierTitle(4)).toBe('Tier 4')
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

describe('distributionLayout (R34)', () => {
  it('posizioni su scala log fra il prezzo minimo e il massimo, con margine', () => {
    const d = distributionLayout([10, 100, 1000], { p10: 10, p25: 100, p50: 1000 })
    // margine del 5% ai lati: 10 -> 5%, 100 -> 50%, 1000 -> 95%
    expect(d.dots.map((x) => Math.round(x))).toEqual([5, 50, 95])
    expect(Math.round(d.marks.p25)).toBe(50)
  })

  it('tutti i prezzi uguali: tutto al centro', () => {
    const d = distributionLayout([7, 7, 7], { p10: 7, p25: 7, p50: 7 })
    expect(d.dots).toEqual([50, 50, 50])
    expect(d.marks).toEqual({ p10: 50, p25: 50, p50: 50 })
  })

  it('campione vuoto: niente punti', () => {
    expect(distributionLayout([], { p10: 1, p25: 2, p50: 3 }).dots).toEqual([])
  })
})

describe('modStatusTitle (R34)', () => {
  it('motivo solo per gli affissi esclusi', () => {
    expect(modStatusTitle('unweighted')).toBe('Non considerato: affisso di poco valore')
    expect(modStatusTitle('relaxed')).toBe('Tolto dalla ricerca: pochi oggetti simili')
    expect(modStatusTitle('used')).toBeUndefined()
    expect(modStatusTitle('dps')).toBeUndefined()
  })
})
