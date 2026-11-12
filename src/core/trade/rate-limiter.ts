export interface RateLimitRule {
  group: string
  maxHits: number
  periodSec: number
  restrictSec: number
}

export interface RateLimitState {
  group: string
  hits: number
  periodSec: number
  activeRestrictionSec: number
}

function parseTriples(raw: string | null): number[][] {
  if (!raw) return []
  const out: number[][] = []
  for (const part of raw.split(',')) {
    const nums = part.trim().split(':').map(Number)
    if (nums.length === 3 && nums.every((n) => Number.isFinite(n) && n >= 0)) out.push(nums)
  }
  return out
}

export function parseRateLimitHeaders(h: Headers): {
  rules: RateLimitRule[]
  state: RateLimitState[]
} {
  const rules: RateLimitRule[] = []
  const state: RateLimitState[] = []
  const names = (h.get('X-Rate-Limit-Rules') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const name of names) {
    for (const [maxHits, periodSec, restrictSec] of parseTriples(h.get(`X-Rate-Limit-${name}`))) {
      if (maxHits > 0 && periodSec > 0) rules.push({ group: name, maxHits, periodSec, restrictSec })
    }
    for (const [hits, periodSec, activeRestrictionSec] of parseTriples(
      h.get(`X-Rate-Limit-${name}-State`)
    )) {
      state.push({ group: name, hits, periodSec, activeRestrictionSec })
    }
  }
  return { rules, state }
}

export class RateLimiter {
  private rules: RateLimitRule[] = []
  /** Ultimo stato riportato dal server, per gruppo e periodo, con l'istante di lettura. */
  private serverHits = new Map<string, { hits: number; at: number }>()
  private requests: number[] = []
  private blockedUntil = 0

  constructor(private readonly now: () => number = Date.now) {}

  update(h: Headers): void {
    const t = this.now()
    const parsed = parseRateLimitHeaders(h)
    if (parsed.rules.length > 0) this.rules = parsed.rules
    for (const s of parsed.state) {
      this.serverHits.set(`${s.group}|${s.periodSec}`, { hits: s.hits, at: t })
      if (s.activeRestrictionSec > 0) {
        this.blockedUntil = Math.max(this.blockedUntil, t + s.activeRestrictionSec * 1000)
      }
    }
    const retry = Number(h.get('Retry-After'))
    if (h.get('Retry-After') !== null && Number.isFinite(retry) && retry > 0) {
      this.blockedUntil = Math.max(this.blockedUntil, t + retry * 1000)
    }
  }

  /** Blocca il limiter per almeno `ms` (attesa di sicurezza dopo un 429 senza Retry-After). */
  blockFor(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms)
  }

  recordRequest(): void {
    this.requests.push(this.now())
    this.prune()
  }

  delayMs(): number {
    const t = this.now()
    let wait = Math.max(0, this.blockedUntil - t)
    for (const rule of this.rules) {
      const ceiling = Math.max(1, rule.maxHits - 1)
      const periodMs = rule.periodSec * 1000
      const window = this.requests.filter((r) => t - r < periodMs)
      const server = this.serverHits.get(`${rule.group}|${rule.periodSec}`)
      const serverHits = server && t - server.at < periodMs ? server.hits : 0
      const hits = Math.max(window.length, serverHits)
      if (hits < ceiling) continue
      // Serve che scadano (hits - ceiling + 1) richieste per scendere sotto il tetto.
      const idx = hits - ceiling
      let freeAt: number
      if (idx < window.length && window.length >= serverHits) {
        freeAt = window[idx] + periodMs
      } else {
        // Hit consumati da un altro client: si conosce solo l'istante dello stato.
        freeAt = (server?.at ?? t) + periodMs
      }
      wait = Math.max(wait, freeAt - t)
    }
    return Math.max(0, Math.ceil(wait))
  }

  /** Millisecondi di blocco residui (restrizione del server o Retry-After); 0 se non bloccato. */
  blockedForMs(): number {
    return Math.max(0, this.blockedUntil - this.now())
  }

  /** Frazione del budget ancora libera (minimo tra le regole); 0 durante un blocco. */
  remainingRatio(): number {
    const t = this.now()
    if (t < this.blockedUntil) return 0
    let ratio = 1
    for (const rule of this.rules) {
      const periodMs = rule.periodSec * 1000
      const local = this.requests.filter((r) => t - r < periodMs).length
      const server = this.serverHits.get(`${rule.group}|${rule.periodSec}`)
      const serverHits = server && t - server.at < periodMs ? server.hits : 0
      const hits = Math.max(local, serverHits)
      ratio = Math.min(ratio, Math.max(0, (rule.maxHits - hits) / rule.maxHits))
    }
    return ratio
  }

  private prune(): void {
    const maxPeriodMs = Math.max(0, ...this.rules.map((r) => r.periodSec * 1000))
    const t = this.now()
    if (maxPeriodMs > 0) this.requests = this.requests.filter((r) => t - r < maxPeriodMs)
  }
}
