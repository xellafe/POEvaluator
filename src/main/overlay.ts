// Finestre dell'interfaccia: overlay trasparente agganciato a PoE2, finestra impostazioni, icona nel tray.
import { join } from 'path'
import { BrowserWindow, Menu, Tray, nativeImage, screen, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { OVERLAY_WINDOW_OPTS, OverlayController } from 'electron-overlay-window'
import type { Point } from '../core/ipc'

/** Titolo della finestra di gioco a cui agganciare l'overlay. */
export const GAME_WINDOW_TITLE = 'Path of Exile 2'

/** Solo i link alla ricerca sul trade si aprono nel browser. */
const TRADE_PREFIX = 'https://www.pathofexile.com/'

type View = 'overlay' | 'settings'

const preloadPath = (): string => join(__dirname, '../preload/index.js')

function loadView(win: BrowserWindow, view: View): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${view}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: view })
  }
}

type Log = (msg: string) => void

/**
 * Prepara e carica una vista: niente navigazione dentro le finestre (i link al trade con
 * target=_blank vanno al browser) ed errori del renderer riportati nel log del main.
 */
function setupView(win: BrowserWindow, view: View, log: Log): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(TRADE_PREFIX)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error' || level === 'warning') log(`renderer ${view} (${level}): ${message}`)
  })
  win.webContents.on('did-fail-load', (_e, code, desc) => log(`renderer ${view}: ${code} ${desc}`))
  win.webContents.on('render-process-gone', (_e, d) => log(`renderer ${view} chiuso: ${d.reason}`))
  loadView(win, view)
}

/**
 * Overlay trasparente sopra la finestra di PoE2 (electron-overlay-window ne segue posizione e
 * dimensioni). Non prende mai il focus; è trasparente ai click tranne sopra badge e pannello
 * (il renderer lo segnala con `setInteractive`). La libreria la nasconde quando il gioco perde
 * il primo piano e la rimostra quando lo riprende.
 */
export class Overlay {
  readonly window: BrowserWindow

  constructor(log: Log) {
    this.window = new BrowserWindow({
      ...OVERLAY_WINDOW_OPTS,
      focusable: false,
      webPreferences: { preload: preloadPath(), sandbox: true }
    })
    setupView(this.window, 'overlay', log)
    this.passThrough()

    // La libreria su attach/focus imposta i click passanti senza inoltro del mouse: lo ripristiniamo
    // (serve al renderer per sapere quando il cursore è sopra il badge e quanto si è allontanato).
    OverlayController.events.on('attach', () => {
      log('overlay agganciato alla finestra di PoE2')
      this.passThrough()
    })
    OverlayController.events.on('focus', () => this.passThrough())
    OverlayController.events.on('detach', () => log('finestra di PoE2 chiusa'))
    OverlayController.attachByTitle(this.window, GAME_WINDOW_TITLE)
  }

  /** PoE2 in primo piano: solo allora hotkey e overlay sono attivi. */
  get gameFocused(): boolean {
    return OverlayController.targetHasFocus
  }

  setInteractive(on: boolean): void {
    if (on) this.window.setIgnoreMouseEvents(false)
    else this.passThrough()
  }

  /** Cursore in coordinate dell'overlay (pixel CSS); null se l'overlay non è visibile. */
  cursor(): Point | null {
    if (!this.window.isVisible()) return null
    const c = screen.getCursorScreenPoint()
    const b = this.window.getBounds()
    return { x: c.x - b.x, y: c.y - b.y }
  }

  send(channel: string, payload?: unknown): void {
    if (!this.window.isDestroyed()) this.window.webContents.send(channel, payload)
  }

  private passThrough(): void {
    this.window.setIgnoreMouseEvents(true, { forward: true })
  }
}

let settingsWindow: BrowserWindow | null = null

/** Finestra impostazioni: normale (prende il focus), senza cornice di sistema come nel mockup. */
/** Invia un messaggio alla finestra impostazioni, se è aperta. */
export function sendToSettings(channel: string, payload: unknown): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(channel, payload)
  }
}

export function openSettingsWindow(icon: string, log: Log): void {
  if (settingsWindow) {
    if (settingsWindow.isMinimized()) settingsWindow.restore()
    settingsWindow.show()
    settingsWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 470,
    height: 740,
    useContentSize: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'POEvaluator · Impostazioni',
    backgroundColor: '#15110d',
    icon,
    webPreferences: { preload: preloadPath(), sandbox: true }
  })
  settingsWindow = win
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    settingsWindow = null
  })
  setupView(win, 'settings', log)
}

/** Icona nel tray con il menu: impostazioni e uscita. */
export function createTray(icon: string, onSettings: () => void, onQuit: () => void): Tray {
  const tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }))
  tray.setToolTip('POEvaluator')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Impostazioni', click: onSettings },
      { type: 'separator' },
      { label: 'Esci', click: onQuit }
    ])
  )
  tray.on('click', onSettings)
  return tray
}
