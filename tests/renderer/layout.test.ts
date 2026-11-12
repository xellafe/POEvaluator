import { describe, expect, it } from 'vitest'
import { movedAway, placeNear } from '../../src/renderer/layout'

const VIEW = { width: 1920, height: 1080 }
const BADGE = { width: 284, height: 120 }

describe('placeNear', () => {
  it('in basso a destra del cursore se c’è spazio', () => {
    expect(placeNear({ x: 500, y: 300 }, BADGE, VIEW)).toEqual({ x: 516, y: 316 })
  })

  it('vicino al bordo destro/inferiore passa dal lato opposto', () => {
    expect(placeNear({ x: 1800, y: 1050 }, BADGE, VIEW)).toEqual({
      x: 1800 - 16 - 284,
      y: 1050 - 16 - 120
    })
  })

  it('resta sempre dentro la finestra', () => {
    const p = placeNear({ x: 5, y: 5 }, { width: 2000, height: 50 }, VIEW)
    expect(p.x).toBe(8)
    expect(p.y).toBe(21)
  })

  it('senza cursore: in alto al centro', () => {
    expect(placeNear(null, BADGE, VIEW)).toEqual({ x: (1920 - 284) / 2, y: 64 })
  })
})

describe('movedAway', () => {
  it('oltre il limite in linea d’aria', () => {
    expect(movedAway({ x: 0, y: 0 }, { x: 90, y: 120 }, 150)).toBe(false)
    expect(movedAway({ x: 0, y: 0 }, { x: 91, y: 120 }, 150)).toBe(true)
  })
})
