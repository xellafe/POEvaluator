// Arbitraggio delle richieste di valutazione (senza Electron): catture degli appunti in serie,
// una sola analisi approfondita alla volta, rapide indipendenti dall'approfondita.

export const DEEP_BUSY_MESSAGE = 'Analisi già in corso'

export class RequestGate {
  private captureTail: Promise<unknown> = Promise.resolve()
  private quickRunning = false
  private deepRunning = false

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

  /** Analisi approfondita: con un'altra in corso restituisce 'busy' (il chiamante risponde con DEEP_BUSY_MESSAGE). */
  async runDeep(task: () => Promise<void>): Promise<'ran' | 'busy'> {
    if (this.deepRunning) return 'busy'
    this.deepRunning = true
    try {
      await task()
      return 'ran'
    } finally {
      this.deepRunning = false
    }
  }
}
