// Contenuto della finestra overlay: badge accanto al cursore e pannello dell'analisi approfondita.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode
} from 'react'
import type { EvalError, Point, PoeApi, ResultPayload } from '../core/ipc'
import type { Settings } from '../core/settings'
import { ItemPanel, type PanelState } from './components/ItemPanel'
import { VerdictBadge, type BadgeState } from './components/VerdictBadge'
import { movedAway, placeNear } from './layout'

/** Il badge sparisce dopo 4 s o quando il mouse si allontana oltre 150 px dal punto della richiesta. */
export const BADGE_TIMEOUT_MS = 4000
export const DISMISS_DISTANCE_PX = 150

interface Placed<T> {
  state: T
  anchor: Point | null
}

/**
 * Elemento posizionato accanto al cursore. Sopra di esso l'overlay riceve i click (setInteractive);
 * fuori, i click passano al gioco. Se sparisce mentre il mouse è sopra, ripristina i click passanti.
 */
function Floating({
  api,
  anchor,
  onHover,
  children
}: {
  api: PoeApi
  anchor: Point | null
  onHover?: (on: boolean) => void
  children: ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const hovered = useRef(false)
  const [pos, setPos] = useState<Point | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPos(
      placeNear(
        anchor,
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight }
      )
    )
  }, [anchor, children])

  useEffect(
    () => () => {
      if (hovered.current) {
        api.setInteractive(false)
        onHover?.(false)
      }
    },
    [api, onHover]
  )

  const hover = (on: boolean): void => {
    hovered.current = on
    api.setInteractive(on)
    onHover?.(on)
  }

  return (
    <div
      ref={ref}
      className="floating"
      style={pos ? { left: pos.x, top: pos.y } : { left: 0, top: 0, visibility: 'hidden' }}
      onMouseEnter={() => hover(true)}
      onMouseLeave={() => hover(false)}
    >
      {children}
    </div>
  )
}

const errorBadge = (e: EvalError, busy = false): BadgeState => ({
  type: 'error',
  title: e.title,
  message: e.message,
  busy
})

export function OverlayApp({ api }: { api: PoeApi }): JSX.Element {
  const [badge, setBadge] = useState<Placed<BadgeState> | null>(null)
  const [panel, setPanel] = useState<Placed<PanelState> | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [badgeHovered, setBadgeHovered] = useState(false)

  const quickAnchor = useRef<Point | null>(null)
  /**
   * Analisi approfondita corrente: punto della richiesta, chiusura da parte dell'utente e se è
   * ancora in corso (chiudendo il pannello prima della fine si annulla).
   */
  const deep = useRef<{ anchor: Point | null; closed: boolean; running: boolean }>({
    anchor: null,
    closed: false,
    running: false
  })
  const mouse = useRef<Point | null>(null)

  const refreshSettings = useCallback(() => {
    api.getSettings().then(setSettings, () => {})
  }, [api])

  /** Pannello chiuso (X o Esc): con l'analisi ancora in corso il main la annulla. */
  const closeDeep = useCallback(() => {
    deep.current.closed = true
    if (deep.current.running) {
      deep.current.running = false
      api.cancelDeep()
    }
  }, [api])

  const onResult = useCallback((r: ResultPayload) => {
    if (r.kind === 'quick') {
      const state: BadgeState = r.ok
        ? {
            type: 'result',
            item: r.item,
            valuation: r.valuation,
            exaltedPerDivine: r.exaltedPerDivine
          }
        : errorBadge(r)
      setBadge({ state, anchor: quickAnchor.current })
      return
    }
    if (!r.ok && r.busy) {
      // un'altra analisi è in corso: il pannello resta com'è
      setBadge({ state: errorBadge(r, true), anchor: mouse.current })
      return
    }
    deep.current.running = false
    if (deep.current.closed) return // pannello chiuso dall'utente: risultato ignorato
    if (r.ok) {
      setPanel((cur) =>
        cur
          ? {
              ...cur,
              state: { ...cur.state, result: r.valuation, exaltedPerDivine: r.exaltedPerDivine }
            }
          : cur
      )
    } else {
      setPanel(null)
      setBadge({ state: errorBadge(r), anchor: deep.current.anchor })
    }
  }, [])

  useEffect(() => {
    refreshSettings()
    const offs = [
      api.onStarted((p) => {
        refreshSettings() // hotkey e lega aggiornate se cambiate nelle impostazioni
        if (p.kind === 'quick') quickAnchor.current = p.anchor
        else deep.current = { anchor: p.anchor, closed: false, running: true }
        setBadge({ state: { type: 'loading' }, anchor: p.anchor })
      }),
      api.onAnalyzing((p) => {
        setBadge((b) => (b?.state.type === 'loading' ? null : b))
        if (deep.current.closed) return
        setPanel({
          anchor: deep.current.anchor,
          state: {
            item: p.item,
            quick: p.quick,
            exaltedPerDivine: p.exaltedPerDivine,
            progress: { done: 0, total: p.totalSearches },
            result: null
          }
        })
      }),
      api.onProgress((p) =>
        setPanel((cur) =>
          cur && !cur.state.result ? { ...cur, state: { ...cur.state, progress: p } } : cur
        )
      ),
      api.onResult(onResult),
      api.onDismiss(() => {
        setBadge(null)
        setPanel(null)
        closeDeep()
      })
    ]
    return () => offs.forEach((off) => off())
  }, [api, refreshSettings, onResult, closeDeep])

  // Scadenza del badge (sospesa mentre il mouse è sopra).
  useEffect(() => {
    if (!badge || badge.state.type === 'loading' || badgeHovered) return
    const t = setTimeout(() => setBadge(null), BADGE_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [badge, badgeHovered])

  // Movimento del mouse (inoltrato dal main anche con i click passanti).
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      mouse.current = { x: e.clientX, y: e.clientY }
      if (
        badge?.anchor &&
        badge.state.type !== 'loading' &&
        !badgeHovered &&
        movedAway(badge.anchor, mouse.current, DISMISS_DISTANCE_PX)
      ) {
        setBadge(null)
      }
    }
    document.addEventListener('mousemove', onMove)
    return () => document.removeEventListener('mousemove', onMove)
  }, [badge, badgeHovered])

  const closePanel = useCallback(() => {
    setPanel(null)
    closeDeep()
  }, [closeDeep])

  return (
    <>
      {panel && (
        <Floating api={api} anchor={panel.anchor}>
          <ItemPanel state={panel.state} league={settings?.league ?? ''} onClose={closePanel} />
        </Floating>
      )}
      {badge && (
        <Floating api={api} anchor={badge.anchor} onHover={setBadgeHovered}>
          <VerdictBadge
            state={badge.state}
            deepHotkey={settings?.hotkeys.deep ?? 'Alt+Shift+D'}
            onDeep={() => api.requestDeep()}
          />
        </Floating>
      )}
    </>
  )
}
