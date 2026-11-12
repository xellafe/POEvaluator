// Parte pura della cattura input (senza Electron né uiohook): hotkey e polling degli appunti.

export interface Hotkey {
  keycode: number
  alt: boolean
  ctrl: boolean
  shift: boolean
}

export interface KeyEventLike {
  keycode: number
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

const MODIFIERS: Record<string, 'alt' | 'ctrl' | 'shift'> = {
  alt: 'alt',
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift'
}

/**
 * Converte una stringa tipo "Alt+D" / "Alt+Shift+D" in keycode + modificatori, usando la
 * tabella `keys` (nome tasto -> keycode, es. `UiohookKey`). `null` se la stringa non è valida.
 */
export function parseHotkey(spec: string, keys: Readonly<Record<string, number>>): Hotkey | null {
  const parts = spec.split('+').map((p) => p.trim())
  if (parts.length === 0 || parts.some((p) => p === '')) return null
  const hk: Hotkey = { keycode: -1, alt: false, ctrl: false, shift: false }
  for (const [i, part] of parts.entries()) {
    const mod = MODIFIERS[part.toLowerCase()]
    const last = i === parts.length - 1
    if (mod && !last) {
      hk[mod] = true
      continue
    }
    if (!last || mod) return null // tasto non modificatore solo in fondo
    const name = Object.keys(keys).find((k) => k.toLowerCase() === part.toLowerCase())
    if (name === undefined) return null
    hk.keycode = keys[name]
  }
  return hk
}

/** Tasto uguale e stessi modificatori, né più né meno (Alt+D non scatta con Alt+Shift+D). */
export function matchesHotkey(e: KeyEventLike, hk: Hotkey): boolean {
  return (
    e.keycode === hk.keycode &&
    e.altKey === hk.alt &&
    e.ctrlKey === hk.ctrl &&
    e.shiftKey === hk.shift &&
    !e.metaKey
  )
}

/**
 * Ripetizione automatica del tasto: tenendo premuta una hotkey arrivano più keydown senza keyup.
 * `press` è true solo al primo keydown; `release` (al keyup) riabilita il tasto.
 */
export class KeyRepeatFilter {
  private readonly down = new Set<number>()

  press(keycode: number): boolean {
    if (this.down.has(keycode)) return false
    this.down.add(keycode)
    return true
  }

  release(keycode: number): void {
    this.down.delete(keycode)
  }
}

export const CLIPBOARD_POLL_MS = 20
export const CLIPBOARD_TIMEOUT_MS = 500

export interface ClipboardDeps {
  read: () => Promise<string>
  write: (text: string) => Promise<void>
  /** Invia al gioco la combinazione di copia (Ctrl+Alt+C). */
  sendCopy: () => void
  sleep: (ms: number) => Promise<void>
}

/**
 * Salva gli appunti, li svuota, invia la copia e attende testo nuovo (polling ogni 20 ms,
 * max 500 ms); poi ripristina sempre gli appunti precedenti. '' se non arriva niente.
 */
export async function captureClipboard(deps: ClipboardDeps): Promise<string> {
  const previous = await deps.read()
  await deps.write('')
  try {
    deps.sendCopy()
    for (let waited = 0; waited < CLIPBOARD_TIMEOUT_MS;) {
      await deps.sleep(CLIPBOARD_POLL_MS)
      waited += CLIPBOARD_POLL_MS
      const text = await deps.read()
      if (text !== '') return text
    }
    return ''
  } finally {
    await deps.write(previous)
  }
}
