// Arbitraggio delle richieste di valutazione (senza Electron): catture degli appunti in serie,
// una sola analisi approfondita alla volta, rapide indipendenti dall'approfondita.

import type { EvalError } from '../core/ipc'

export const DEEP_BUSY_MESSAGE: EvalError = {
  title: 'Analisi già in corso',
  message: 'Attendi che finisca prima di valutare un altro oggetto'
}

export class RequestGate {
  private captureTail: Promise<unknown> = Promise.resolve()
  private quickRunning = false
  /** Analisi approfondita in corso (null se nessuna): il suo controller di annullamento. */
  private deep: AbortController | null = null

  /** Mutex sulla cattura: le catture (rapide o approfondite) non si sovrappongono mai. */
  capture<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.captureTail.then(fn)
    this.captureTail = run.catch(() => undefined)
    return run
  }

  /**
   * Valutazione rapida: parte anche con un'approfondita in corso. Se ne è già in corso un'altra
   * (ripetizione del tasto tenuto premuto) viene saltata: risponde quella in corso.
   */
  async runQuick(task: () => Promise<void>): Promise<'ran' | 'skipped'> {
    if (this.quickRunning) return 'skipped'
    this.quickRunning = true
    try {
      await task()
      return 'ran'
    } finally {
      this.quickRunning = false
    }
  }

  /**
   * Analisi approfondita: con un'altra in corso restituisce 'busy' (il chiamante risponde con
   * DEEP_BUSY_MESSAGE). Il task riceve il signal annullato da `cancelDeep`.
   */
  async runDeep(task: (signal: AbortSignal) => Promise<void>): Promise<'ran' | 'busy'> {
    if (this.deep) return 'busy'
    const ac = new AbortController()
    this.deep = ac
    try {
      await task(ac.signal)
      return 'ran'
    } finally {
      // un'analisi annullata che finisce dopo non libera il gate di quella successiva
      if (this.deep === ac) this.deep = null
    }
  }

  /**
   * Annulla l'analisi approfondita in corso (pannello chiuso) e libera subito il gate: una nuova
   * analisi può partire mentre quella annullata si chiude. false se non ce n'era una.
   */
  cancelDeep(): boolean {
    if (!this.deep) return false
    this.deep.abort()
    this.deep = null
    return true
  }
}
