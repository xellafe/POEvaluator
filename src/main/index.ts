import { app, ipcMain, type Tray } from 'electron'
import { join } from 'path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { UiohookKey, uIOhook } from 'uiohook-napi'
import icon from '../../resources/icon.png?asset'
import { BackgroundCollector } from '../core/collector/background-collector'
import { ListingStore } from '../core/db/listing-store'
import {
  IPC,
  type AnalyzingPayload,
  type EvalError,
  type ProgressPayload,
  type ResultPayload,
  type SettingsPatch,
  type StartedPayload
} from '../core/ipc'
import { initParserData } from '../core/parser/parse-item'
import { fetchRates } from '../core/pricing/currency'
import type { Settings } from '../core/settings'
import { TradeClient } from '../core/trade/trade-client'
import { DEFAULT_MAX_SEARCHES } from '../core/valuation/deep-analysis'
import { copyHoveredItem } from './capture'
import { EvaluatorService, type EvalResult } from './evaluator-service'
import { KeyRepeatFilter, matchesHotkey, parseHotkey, type Hotkey } from './input'
import { createTray, openSettingsWindow, Overlay } from './overlay'
import { DEEP_BUSY_MESSAGE, RequestGate } from './request-gate'
import { applyPatch, loadSettings, saveSettings, settingsError } from './settings-file'

const log = (msg: string): void => console.log(`[poevaluator] ${msg}`)
const errMsg = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e))

// Nessun crash per promise rifiutate non gestite (es. un tick del collector che rigetta fuori dal suo try).
process.on('unhandledRejection', (reason) => log(`unhandledRejection: ${errMsg(reason)}`))

let overlay: Overlay | null = null
/** Riferimento tenuto vivo: un Tray raccolto dal garbage collector sparisce. */
let tray: Tray | null = null
let settings: Settings
let settingsPath: string
let store: ListingStore | null = null
let service: EvaluatorService | null = null
let collector: BackgroundCollector | null = null
let tradeClient: TradeClient | null = null
/** League scaricate dal trade, tenute per 10 minuti (la finestra impostazioni le chiede a ogni apertura). */
let leaguesCache: { at: number; ids: string[] } | null = null
let statsTimer: ReturnType<typeof setInterval> | null = null
let hotkeys: { quick: Hotkey | null; deep: Hotkey | null } = { quick: null, deep: null }
let lastItemText = ''
const gate = new RequestGate()
/** Tenendo premuta una hotkey parte una sola valutazione (keydown ripetuti ignorati fino al keyup). */
const keyRepeat = new KeyRepeatFilter()
const KEYS = UiohookKey as unknown as Record<string, number>

/** Hotkey e overlay attivi solo con PoE2 in primo piano (focus/blur da electron-overlay-window). */
const isGameFocused = (): boolean => overlay?.gameFocused ?? false

type Payload = ResultPayload | ProgressPayload | StartedPayload | AnalyzingPayload

function send(channel: string, payload?: Payload): void {
  overlay?.send(channel, payload)
}

/** Exalted per 1 divine con i tassi correnti (null prima del primo download). */
const exaltedPerDivine = (): number | null => service?.toExalted(1, 'divine') ?? null

function sendResult(kind: ResultPayload['kind'], r: EvalResult, busy = false): void {
  log(`${kind}: ${JSON.stringify(r.ok ? r.valuation : r.message)}`)
  send(IPC.result, {
    kind,
    exaltedPerDivine: exaltedPerDivine(),
    ...r,
    ...(busy ? { busy: true as const } : {})
  })
}

/** Richiesta accettata: il renderer mostra il caricamento vicino al cursore. */
function sendStarted(kind: StartedPayload['kind']): void {
  send(IPC.started, { kind, anchor: overlay?.cursor() ?? null })
}

function registerHotkeys(): void {
  hotkeys = {
    quick: parseHotkey(settings.hotkeys.quick, KEYS),
    deep: parseHotkey(settings.hotkeys.deep, KEYS)
  }
  for (const k of ['quick', 'deep'] as const) {
    if (!hotkeys[k]) log(`hotkey ${k} non valida: "${settings.hotkeys[k]}"`)
  }
  log(`hotkey: rapida ${settings.hotkeys.quick}, approfondita ${settings.hotkeys.deep}`)
}

const FAILURE_MESSAGE: EvalError = {
  title: 'Impossibile valutare',
  message: 'Si è verificato un errore: riprova'
}

/**
 * Esegue una valutazione; un'eccezione imprevista diventa comunque una risposta al renderer.
 * Un'analisi annullata (task che restituisce null o `signal` annullato) non manda nulla.
 */
async function respond(
  kind: ResultPayload['kind'],
  task: () => Promise<EvalResult | null>,
  signal?: AbortSignal
): Promise<void> {
  let r: EvalResult | null
  try {
    r = await task()
  } catch (e) {
    log(`errore valutazione ${kind}: ${errMsg(e)}`)
    r = { ok: false, ...FAILURE_MESSAGE }
  }
  if (r === null || signal?.aborted) {
    log(`${kind}: annullata`)
    return
  }
  sendResult(kind, r)
}

/** Analisi approfondita; con un'altra in corso risponde subito "Analisi già in corso". */
async function requestDeep(getText: () => Promise<string>): Promise<void> {
  const svc = service
  if (!svc) return
  const outcome = await gate.runDeep((signal) => {
    sendStarted('deep')
    return respond(
      'deep',
      async () => {
        const text = await getText()
        lastItemText = text
        if (signal.aborted) return null
        // la stima rapida (locale) apre subito il pannello; errori di lettura escono qui
        const quick = svc.quick(text)
        if (!quick.ok) return quick
        // tassi mancanti o trade in pausa: errore subito, senza aprire il pannello
        const unavailable = svc.deepUnavailable()
        if (unavailable) return { ok: false, ...unavailable }
        send(IPC.analyzing, {
          item: quick.item,
          quick: quick.valuation,
          exaltedPerDivine: exaltedPerDivine(),
          totalSearches: DEFAULT_MAX_SEARCHES
        })
        return svc.deep(
          text,
          (done, total) => {
            if (!signal.aborted) send(IPC.progress, { done, total })
          },
          signal
        )
      },
      signal
    )
  })
  if (outcome === 'busy') sendResult('deep', { ok: false, ...DEEP_BUSY_MESSAGE }, true)
}

const captureItem = (): Promise<string> => gate.capture(copyHoveredItem)

function onKeydown(e: Parameters<typeof matchesHotkey>[0]): void {
  if (!isGameFocused()) return
  if (e.keycode === UiohookKey.Escape) {
    send(IPC.dismiss)
    return
  }
  if (!service) return
  const svc = service
  const isQuick = hotkeys.quick !== null && matchesHotkey(e, hotkeys.quick)
  const isDeep = hotkeys.deep !== null && matchesHotkey(e, hotkeys.deep)
  if (!isQuick && !isDeep) return
  if (!keyRepeat.press(e.keycode)) return // ripetizione automatica del tasto tenuto premuto
  if (isQuick) {
    // la rapida è locale: parte anche durante un'approfondita (solo la cattura è in serie)
    void gate.runQuick(() => {
      sendStarted('quick')
      return respond('quick', async () => {
        const text = await captureItem()
        lastItemText = text
        return svc.quick(text)
      })
    })
  } else {
    void requestDeep(captureItem)
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.getSettings, () => settings)
  ipcMain.handle(IPC.setSettings, (_e, patch: SettingsPatch) => {
    const prev = settings
    const next = applyPatch(settings, patch ?? {})
    // il modulo valida già le hotkey; qui la difesa per patch arrivate da altre strade
    const invalid = settingsError(next, KEYS)
    if (invalid) throw new Error(invalid)
    saveSettings(settingsPath, next)
    settings = next // in memoria solo dopo il salvataggio riuscito
    if (
      prev.hotkeys.quick !== settings.hotkeys.quick ||
      prev.hotkeys.deep !== settings.hotkeys.deep
    ) {
      registerHotkeys()
    }
    if (prev.league !== settings.league) void service?.reloadRates()
    return settings
  })
  ipcMain.handle(IPC.leagues, async () => {
    if (leaguesCache && Date.now() - leaguesCache.at < 10 * 60_000) return leaguesCache.ids
    if (!tradeClient) return []
    try {
      const ids = await tradeClient.leagues('user')
      leaguesCache = { at: Date.now(), ids }
      log(`league disponibili: ${ids.join(', ')}`)
      return ids
    } catch (e) {
      log(`league non scaricate: ${errMsg(e)}`)
      return []
    }
  })
  // Click sul badge: analisi approfondita dell'ultimo oggetto catturato.
  ipcMain.on(IPC.deep, () => {
    const text = lastItemText
    void requestDeep(async () => text)
  })
  // Pannello chiuso durante l'analisi: annullata, il gate si libera subito.
  ipcMain.on(IPC.cancel, () => {
    if (gate.cancelDeep()) log('analisi approfondita annullata dal pannello')
  })
  ipcMain.on(IPC.interactive, (_e, on: unknown) => overlay?.setInteractive(on === true))
}

async function startServices(): Promise<void> {
  const dataDir = app.isPackaged
    ? join(process.resourcesPath, 'data')
    : join(app.getAppPath(), 'data')
  await initParserData(join(dataDir, 'en'))
  log(`dati parser caricati da ${dataDir}`)

  const userData = app.getPath('userData')
  const dbPath = join(userData, 'poevaluator.db')
  store = new ListingStore(dbPath)
  log(`database aperto: ${dbPath}`)

  const userAgent = `POEvaluator/${app.getVersion()} (+https://github.com/xellafe/POEvaluator)`
  const client = (tradeClient = new TradeClient({
    userAgent,
    onRateLimited: (kind, attempt) => log(`429 dal trade (${kind}, tentativo ${attempt})`)
  }))
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
  // Diagnostica per la verifica M1: inserzioni raccolte per categoria, ogni 5 minuti.
  statsTimer = setInterval(() => {
    if (store) log(`inserzioni in archivio: ${JSON.stringify(store.countByClass(settings.league))}`)
  }, 5 * 60_000)

  registerHotkeys()
  uIOhook.on('keydown', onKeydown)
  uIOhook.on('keyup', (e) => keyRepeat.release(e.keycode))
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
  if (statsTimer) clearInterval(statsTimer)
  service?.stop()
  store?.close()
  store = null
  tray?.destroy()
  tray = null
}

const showSettings = (): void => openSettingsWindow(icon, log)

// Una sola istanza: due hook di tastiera risponderebbero due volte alla stessa hotkey.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showSettings)

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.poevaluator')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // Le impostazioni servono anche se l'avvio dei servizi fallisce (es. per correggere la lega).
    settingsPath = join(app.getPath('userData'), 'settings.json')
    settings = loadSettings(settingsPath, log)
    log(`impostazioni: ${settingsPath} (league ${settings.league})`)
    registerIpc()

    overlay = new Overlay(log)
    tray = createTray(icon, showSettings, () => app.quit())

    try {
      await startServices()
    } catch (e) {
      log(`avvio fallito: ${errMsg(e)}`)
    }
  })
}

app.on('will-quit', shutdown)

// L'app vive nel tray: chiudere la finestra impostazioni non la termina (l'overlay resta aperto).
app.on('window-all-closed', () => {})
