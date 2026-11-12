import { RateLimiter } from './rate-limiter'

export type Priority = 'user' | 'stash' | 'background'
export interface SearchResult {
  id: string
  result: string[]
  total: number
}

type Kind = 'search' | 'fetch' | 'data'

const BASE = 'https://www.pathofexile.com'
const FETCH_CHUNK = 10
const MAX_429_RETRIES = 3
const REQUEST_TIMEOUT_MS = 20_000
const PRIORITY_ORDER: Record<Priority, number> = { user: 0, stash: 1, background: 2 }

/** Estrae gli id delle league PoE2 dalla risposta di `/api/trade2/data/leagues`. */
export function parseLeagues(json: unknown): string[] {
  const result = (json as { result?: unknown } | null)?.result
  if (!Array.isArray(result)) throw new Error('Risposta delle league non valida')
  const ids: string[] = []
  for (const l of result) {
    const r = l as { id?: unknown; realm?: unknown }
    if (typeof r?.id !== 'string' || r.id === '') continue
    if (r.realm !== undefined && r.realm !== 'poe2') continue
    if (!ids.includes(r.id)) ids.push(r.id)
  }
  return ids
}

export function tradeUrl(league: string, queryId: string): string {
  return `${BASE}/trade2/search/poe2/${encodeURIComponent(league)}/${encodeURIComponent(queryId)}`
}

interface Job {
  priority: Priority
  seq: number
  kind: Kind
  url: string
  init: { method: string; body?: string }
  /** Risposte 429 già ricevute per questo job. */
  attempts: number
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

/** Attesa minima dopo un 429 senza Retry-After (il limiter da solo potrebbe non bloccare). */
const MIN_429_WAIT_MS = 1000

const byPriority = (a: Job, b: Job): number =>
  PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.seq - b.seq

/**
 * Client trade2. Le richieste partono una alla volta da un'unica coda a priorità
 * (user > stash > background, FIFO a parità); ogni endpoint ha il proprio RateLimiter.
 * Nessuna attesa tiene occupata la coda: parte il job pronto (limiter libero) più importante,
 * così un job in attesa su un endpoint non blocca quelli diretti a un endpoint libero.
 */
export class TradeClient {
  private readonly userAgent: string
  private readonly fetchImpl: typeof fetch
  private readonly limiters: Record<Kind, RateLimiter>
  private queue: Job[] = []
  private inFlight: Job | null = null
  private pumping = false
  private seq = 0
  /** Risveglia il pump in attesa (nuovo job in coda); null se il pump non sta aspettando. */
  private wake: (() => void) | null = null
  private readonly onRateLimited?: (kind: Kind, attempt: number) => void

  constructor(opts: {
    userAgent: string
    fetchImpl?: typeof fetch
    limiters?: { search?: RateLimiter; fetch?: RateLimiter; data?: RateLimiter }
    /** Chiamato a ogni risposta 429 (diagnostica: in condizioni normali non deve accadere). */
    onRateLimited?: (kind: Kind, attempt: number) => void
  }) {
    this.onRateLimited = opts.onRateLimited
    this.userAgent = opts.userAgent
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
    this.limiters = {
      search: opts.limiters?.search ?? new RateLimiter(),
      fetch: opts.limiters?.fetch ?? new RateLimiter(),
      data: opts.limiters?.data ?? new RateLimiter()
    }
  }

  search(league: string, query: object, priority: Priority): Promise<SearchResult> {
    return this.enqueue(
      'search',
      `${BASE}/api/trade2/search/poe2/${encodeURIComponent(league)}`,
      { method: 'POST', body: JSON.stringify(query) },
      priority
    ) as Promise<SearchResult>
  }

  async fetchListings(ids: string[], queryId: string, priority: Priority): Promise<unknown[]> {
    const chunks: string[][] = []
    for (let i = 0; i < ids.length; i += FETCH_CHUNK) chunks.push(ids.slice(i, i + FETCH_CHUNK))
    // accodate tutte subito: restano consecutive a pari priorità
    const responses = await Promise.all(
      chunks.map(
        (c) =>
          this.enqueue(
            'fetch',
            `${BASE}/api/trade2/fetch/${c.join(',')}?query=${encodeURIComponent(queryId)}`,
            { method: 'GET' },
            priority
          ) as Promise<{ result?: unknown[] }>
      )
    )
    return responses.flatMap((r) => (Array.isArray(r?.result) ? r.result : []))
  }

  /** League di PoE2 disponibili sul trade (id usati nelle ricerche), nell'ordine del sito. */
  async leagues(priority: Priority): Promise<string[]> {
    const json = await this.enqueue(
      'data',
      `${BASE}/api/trade2/data/leagues`,
      { method: 'GET' },
      priority
    )
    return parseLeagues(json)
  }

  /** Nessuna richiesta user/stash in coda o in volo. */
  isIdle(): boolean {
    const busy = (j: Job): boolean => j.priority !== 'background'
    return !this.queue.some(busy) && !(this.inFlight && busy(this.inFlight))
  }

  remainingRatio(): number {
    return Math.min(this.limiters.search.remainingRatio(), this.limiters.fetch.remainingRatio())
  }

  /** Millisecondi di blocco residui imposti dal sito del trade (il più lungo tra search e fetch). */
  blockedForMs(): number {
    return Math.max(
      this.limiters.search.blockedForMs(),
      this.limiters.fetch.blockedForMs(),
      this.limiters.data.blockedForMs()
    )
  }

  private enqueue(
    kind: Kind,
    url: string,
    init: { method: string; body?: string },
    priority: Priority
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.queue.push({ priority, seq: this.seq++, kind, url, init, attempts: 0, resolve, reject })
      // avvio asincrono: le richieste accodate nello stesso tick competono per priorità
      void Promise.resolve().then(() => this.pump())
      this.wake?.()
    })
  }

  /**
   * Il job pronto più importante (priorità, poi FIFO), tolto dalla coda. Un job non parte se un
   * job più importante attende lo stesso limiter: non gli consuma il budget.
   */
  private next(): Job | undefined {
    const waiting = new Set<Kind>()
    for (const job of [...this.queue].sort(byPriority)) {
      if (waiting.has(job.kind)) continue
      if (this.limiters[job.kind].delayMs() > 0) {
        waiting.add(job.kind)
        continue
      }
      this.queue.splice(this.queue.indexOf(job), 1)
      return job
    }
    return undefined
  }

  /** Attende `ms` o il prossimo enqueue, il primo dei due. */
  private sleepOrWake(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined = undefined
      const done = (): void => {
        clearTimeout(timer)
        this.wake = null
        resolve()
      }
      timer = setTimeout(done, ms)
      this.wake = done
    })
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length > 0) {
        const job = this.next()
        if (!job) {
          // nessun job pronto: si attende il limiter che si libera per primo (o un nuovo job)
          const wait = Math.min(...this.queue.map((j) => this.limiters[j.kind].delayMs()))
          await this.sleepOrWake(Math.max(1, wait))
          continue
        }
        this.inFlight = job
        try {
          const outcome = await this.run(job)
          if (outcome.retry)
            this.queue.push(job) // stesso seq e priorità: riprende il suo posto
          else job.resolve(outcome.value)
        } catch (e) {
          job.reject(e instanceof Error ? e : new Error(String(e)))
        }
        this.inFlight = null
      }
    } finally {
      this.pumping = false
    }
  }

  /** Una sola richiesta HTTP; su 429 chiede di rimettere il job in coda (fino a 3 ripetizioni). */
  private async run(job: Job): Promise<{ retry: true } | { retry: false; value: unknown }> {
    const limiter = this.limiters[job.kind]
    limiter.recordRequest()
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: 'application/json'
    }
    if (job.init.body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await this.withTimeout((signal) =>
      this.fetchImpl(job.url, { ...job.init, headers, signal })
    )
    limiter.update(res.headers)
    if (res.status === 429) {
      const attempt = job.attempts++
      this.onRateLimited?.(job.kind, attempt + 1)
      if (attempt >= MAX_429_RETRIES) {
        throw new Error(`Trade API: troppe risposte 429 (rate limit) dopo ${attempt + 1} tentativi`)
      }
      // senza Retry-After il limiter potrebbe non bloccare: attesa minima di sicurezza
      if (limiter.delayMs() === 0) limiter.blockFor(MIN_429_WAIT_MS)
      return { retry: true }
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200)
      throw new Error(`Trade API: HTTP ${res.status} ${body}`.trim())
    }
    return { retry: false, value: await this.withTimeout(() => res.json()) }
  }

  /** Timeout per richiesta (setTimeout, non AbortSignal.timeout, per i fake timer): errore chiaro. */
  private async withTimeout<T>(op: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error(`Trade API: timeout dopo ${REQUEST_TIMEOUT_MS / 1000} s`))
      }, REQUEST_TIMEOUT_MS)
    })
    try {
      return await Promise.race([op(controller.signal), timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}
