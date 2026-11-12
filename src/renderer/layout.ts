// Posizionamento di badge e pannello vicino al cursore (puro, testato in Vitest).
import type { Point } from '../core/ipc'

export interface Size {
  width: number
  height: number
}

/** Distanza dal cursore e margine minimo dai bordi dell'overlay. */
export const CURSOR_OFFSET = 16
export const EDGE_MARGIN = 8

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi))

/**
 * Angolo in alto a sinistra di un elemento `size` accanto al cursore: in basso a destra se c'è
 * spazio, altrimenti dal lato opposto, sempre dentro `viewport`. Senza cursore: in alto al centro.
 */
export function placeNear(anchor: Point | null, size: Size, viewport: Size): Point {
  const maxX = Math.max(EDGE_MARGIN, viewport.width - size.width - EDGE_MARGIN)
  const maxY = Math.max(EDGE_MARGIN, viewport.height - size.height - EDGE_MARGIN)
  if (anchor === null) {
    return { x: clamp((viewport.width - size.width) / 2, EDGE_MARGIN, maxX), y: EDGE_MARGIN * 8 }
  }
  let x = anchor.x + CURSOR_OFFSET
  if (x > maxX) x = anchor.x - CURSOR_OFFSET - size.width
  let y = anchor.y + CURSOR_OFFSET
  if (y > maxY) y = anchor.y - CURSOR_OFFSET - size.height
  return { x: clamp(x, EDGE_MARGIN, maxX), y: clamp(y, EDGE_MARGIN, maxY) }
}

/** Il cursore si è allontanato dal punto della richiesta oltre `limit` pixel. */
export function movedAway(anchor: Point, cursor: Point, limit: number): boolean {
  return Math.hypot(cursor.x - anchor.x, cursor.y - anchor.y) > limit
}
