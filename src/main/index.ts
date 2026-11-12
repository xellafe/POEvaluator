import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { UiohookKey, uIOhook } from 'uiohook-napi'
import { BackgroundCollector } from '../core/collector/background-collector'
import { ListingStore } from '../core/db/listing-store'
import { IPC, type ProgressPayload, type ResultPayload, type SettingsPatch } from '../core/ipc'
import { initParserData } from '../core/parser/parse-item'
import { fetchRates } from '../core/pricing/currency'
import type { Settings } from '../core/settings'
import { TradeClient } from '../core/trade/trade-client'
import { copyHoveredItem } from './capture'
import { EvaluatorService, type EvalResult } from './evaluator-service'
import { matchesHotkey, parseHotkey, type Hotkey } from './input'
import { DEEP_BUSY_MESSAGE, RequestGate } from './request-gate'
import { applyPatch, loadSettings, saveSettings } from './settings-file'

const log = (msg: string): void => console.log(`[poevaluator] ${msg}`)
const errMsg = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e))

// Nessun crash per promise rifiutate non gestite (es. un tick del collector che rigetta fuori dal suo try).
process.on('unhandledRejection', (reason) => log(`unhandledRejection: ${errMsg(reason)}`))

/**
 * Hook per limitare le hotkey a PoE2 in primo piano. Per ora sempre vero: il controllo della
 * finestra attiva arriva con l'overlay (Task 13).
 */
const isGameFocused = (): boolean => true

let mainWindow: BrowserWindow | null = null
let settings: Settings
let settingsPath: string
let store: ListingStore | null = null
let service: EvaluatorService | null = null
let collector: BackgroundCollector | null = null
let hotkeys: { quick: Hotkey | null; deep: Hotkey | null } = { quick: null, deep: null }
let lastItemText = ''
const gate = new RequestGate()

function createWindow(): void {
  // Finestra provvisoria del template: l'overlay arriva con il Task 13.
  mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function send(channel: string, payload: ResultPayload | ProgressPayload): void {
  mainWindow?.webContents.send(channel, payload)
}

function sendResult(kind: ResultPayload['kind'], r: EvalResult): void {
  log(`${kind}: ${JSON.stringify(r.ok ? r.valuation : r.message)}`)
  send(IPC.result, { kind, ...r })
}

function registerHotkeys(): void {
  const keys = UiohookKey as unknown as Record<string, number>
  hotkeys = {
    quick: parseHotkey(settings.hotkeys.quick, keys),
    deep: parseHotkey(settings.hotkeys.deep, keys)
  }
  for (const k of ['quick', 'deep'] as const) {
    if (!hotkeys[k]) log(`hotkey ${k} non valida: "${settings.hotkeys[k]}"`)
  }
  log(`hotkey: rapida ${settings.hotkeys.quick}, approfondita ${settings.hotkeys.deep}`)
}

const FAILURE_MESSAGE = 'Valutazione non riuscita: riprova'

/** Esegue una valutazione; un'eccezione imprevista diventa comunque una risposta al renderer. */
async function respond(
  kind: ResultPayload['kind'],
  task: () => Promise<EvalResult>
): Promise<void> {
  let r: EvalResult
  try {
    r = await task()
  } catch (e) {
    log(`errore valutazione ${kind}: ${errMsg(e)}`)
    r = { ok: false, message: FAILURE_MESSAGE }
  }
  sendResult(kind, r)
}

/** Analisi approfondita; con un'altra in corso risponde subito "Analisi già in corso". */
async function requestDeep(getText: () => Promise<string>): Promise<void> {
  const svc = service
  if (!svc) return
  const outcome = await gate.runDeep(() =>
    respond('deep', async () => {
      const text = await getText()
      lastItemText = text
      return svc.deep(text, (done, total) => send(IPC.progress, { done, total }))
    })
  )
  if (outcome === 'busy') sendResult('deep', { ok: false, message: DEEP_BUSY_MESSAGE })
}

const captureItem = (): Promise<string> => gate.capture(copyHoveredItem)

function onKeydown(e: Parameters<typeof matchesHotkey>[0]): void {
  if (!service || !isGameFocused()) return
  const svc = service
  if (hotkeys.quick && matchesHotkey(e, hotkeys.quick)) {
    // la rapida è locale: parte anche durante un'approfondita (solo la cattura è in serie)
    void gate.runQuick(() =>
      respond('quick', async () => {
        const text = await captureItem()
        lastItemText = text
        return svc.quick(text)
      })
    )
  } else if (hotkeys.deep && matchesHotkey(e, hotkeys.deep)) {
    void requestDeep(captureItem)
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.getSettings, () => settings)
  ipcMain.handle(IPC.setSettings, (_e, patch: SettingsPatch) => {
    const prev = settings
    settings = applyPatch(settings, patch ?? {})
    saveSettings(settingsPath, settings)
    if (
      prev.hotkeys.quick !== settings.hotkeys.quick ||
      prev.hotkeys.deep !== settings.hotkeys.deep
    ) {
      registerHotkeys()
    }
    if (prev.league !== settings.league) void service?.reloadRates()
    return settings
  })
  // "Analizza" sul badge: analisi approfondita dell'ultimo oggetto catturato.
  ipcMain.on(IPC.deep, () => {
    const text = lastItemText
    void requestDeep(async () => text)
  })
}

async function startServices(): Promise<void> {
  const userData = app.getPath('userData')
  settingsPath = join(userData, 'settings.json')
  settings = loadSettings(settingsPath, log)
  log(`impostazioni: ${settingsPath} (league ${settings.league})`)

  const dataDir = app.isPackaged
    ? join(process.resourcesPath, 'data')
    : join(app.getAppPath(), 'data')
  await initParserData(join(dataDir, 'en'))
  log(`dati parser caricati da ${dataDir}`)

  const dbPath = join(userData, 'poevaluator.db')
  store = new ListingStore(dbPath)
  log(`database aperto: ${dbPath}`)

  const userAgent = `POEvaluator/${app.getVersion()} (+https://github.com/xellafe/POEvaluator)`
  const client = new TradeClient({ userAgent })
  service = new EvaluatorService({
    client,
    store,
    settings: () => settings,
    fetchRates: (signal) =>
      fetchRates(settings.league, (input, init) => fetch(input, { ...init, signal }), userAgent),
    now: () => new Date(),
    log
  })
  await service.init()

  collector = new BackgroundCollector({
    client,
    store,
    toExalted: service.toExalted, // legge il converter corrente a ogni chiamata
    settings: () => settings,
    now: () => new Date(),
    log
  })
  collector.start()

  registerIpc()
  registerHotkeys()
  uIOhook.on('keydown', onKeydown)
  uIOhook.start()
  log('hook tastiera avviato')
}

function shutdown(): void {
  try {
    uIOhook.stop()
  } catch (e) {
    log(`arresto hook: ${errMsg(e)}`)
  }
  collector?.stop()
  service?.stop()
  store?.close()
  store = null
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.poevaluator')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  try {
    await startServices()
  } catch (e) {
    log(`avvio fallito: ${errMsg(e)}`)
  }

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', shutdown)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
