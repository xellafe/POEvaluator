import { clipboard } from 'electron'
import { UiohookKey, uIOhook } from 'uiohook-napi'
import { captureClipboard } from './input'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Copia l'oggetto sotto il mouse: salva gli appunti, invia Ctrl+Alt+C (testo avanzato) con
 * `keyTap` (pressione e rilascio atomici dei modificatori: nessun tasto resta premuto),
 * attende il testo nuovo (max 500 ms) e ripristina gli appunti precedenti. '' in caso di timeout.
 */
export function copyHoveredItem(): Promise<string> {
  return captureClipboard({
    read: () => clipboard.readText(),
    write: (text) => clipboard.writeText(text),
    sendCopy: () => uIOhook.keyTap(UiohookKey.C, [UiohookKey.Ctrl, UiohookKey.Alt]),
    sleep
  })
}
