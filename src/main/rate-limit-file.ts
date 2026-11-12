// Stato dei rate limiter del trade salvato su disco (userData/rate-limits.json): all'avvio
// l'app sa quali richieste della sessione precedente sono ancora nella finestra del server,
// quali regole valgono e se una restrizione è in corso (H1 del fix rate limit).
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { RateLimiter } from '../core/trade/rate-limiter'
import type { Kind } from '../core/trade/trade-client'

/** Scrittura 2 s dopo l'ultima risposta del trade. */
export const RATE_LIMITS_SAVE_DELAY_MS = 2000

const KINDS: Kind[] = ['search', 'fetch', 'data']

/**
 * Un limiter per endpoint dal file salvato, con le voci scadute scartate. File assente o
 * corrotto: limiter vuoti (la prima richiesta di ogni endpoint parte da sola e la sua risposta
 * porta le regole: la coda ha una sola richiesta in volo).
 */
export function loadRateLimiters(
  path: string,
  now: () => number,
  log: (msg: string) => void
): Record<Kind, RateLimiter> {
  let json: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object') json = parsed as Record<string, unknown>
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException)?.code === 'ENOENT'
    if (!missing) log(`stato dei rate limit illeggibile, si riparte da zero: ${String(e)}`)
  }
  const out = {} as Record<Kind, RateLimiter>
  for (const k of KINDS) out[k] = RateLimiter.fromJSON(json[k], now)
  return out
}

/** Salvataggio con debounce (dopo ogni risposta) e immediato alla chiusura dell'app. */
export class RateLimitFile {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly deps: {
      path: string
      /** Stato corrente da salvare (TradeClient.snapshot). */
      snapshot: () => unknown
      log: (msg: string) => void
      delayMs?: number
    }
  ) {}

  /** Programma la scrittura; ogni chiamata sposta la scadenza (debounce). */
  schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.deps.delayMs ?? RATE_LIMITS_SAVE_DELAY_MS)
  }

  /** Scrive subito (scrittura atomica: file temporaneo + rename); non lancia mai. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    try {
      const tmp = `${this.deps.path}.tmp`
      writeFileSync(tmp, JSON.stringify(this.deps.snapshot()) + '\n', 'utf8')
      renameSync(tmp, this.deps.path)
    } catch (e) {
      this.deps.log(`stato dei rate limit non salvato: ${e instanceof Error ? e.message : e}`)
    }
  }
}
