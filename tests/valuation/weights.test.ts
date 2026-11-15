import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_WEIGHTS, setLearnedWeights, weightsFor } from '../../src/core/valuation/weights'

describe('weightsFor con pesi appresi', () => {
  afterEach(() => setLearnedWeights(null))

  it('senza pesi installati restituisce la tabella', () => {
    expect(weightsFor('armour.boots')).toBe(DEFAULT_WEIGHTS['armour.boots'])
    expect(weightsFor('classe.inesistente')).toBeUndefined()
  })

  it('con pesi installati usa quelli della classe, la tabella per le altre', () => {
    const learned = { 'explicit.stat_1': 0.7 }
    setLearnedWeights({ 'armour.boots': learned })
    expect(weightsFor('armour.boots')).toBe(learned)
    expect(weightsFor('armour.gloves')).toBe(DEFAULT_WEIGHTS['armour.gloves'])
  })

  it('una classe assente dalla tabella può avere pesi appresi', () => {
    setLearnedWeights({ 'classe.nuova': { 'explicit.stat_1': 0.4 } })
    expect(weightsFor('classe.nuova')).toEqual({ 'explicit.stat_1': 0.4 })
  })

  it('null torna alla sola tabella', () => {
    setLearnedWeights({ 'armour.boots': {} })
    setLearnedWeights(null)
    expect(weightsFor('armour.boots')).toBe(DEFAULT_WEIGHTS['armour.boots'])
  })
})
