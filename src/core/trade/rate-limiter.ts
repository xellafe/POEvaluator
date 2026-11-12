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

/** Vero se uno degli `-State` riporta una restrizione attiva (terzo numero > 0). */
export function hasActiveRestriction(h: Headers): boolean {
  return parseRateLimitHeaders(h).state.some((s) => s.activeRestrictionSec > 0)
}

/**
 * Header del rate limit in una riga, per la diagnostica dei 429 e delle restrizioni:
 * policy, regole, ogni `X-Rate-Limit-<regola>` e `-State`, Retry-After ("-" se assente).
 */
export function describeRateLimitHeaders(h: Headers): string {
  const rules = h.get('X-Rate-Limit-Rules')
  const parts = [`policy=${h.get('X-Rate-Limit-Policy') ?? '-'}`, `rules=${rules ?? '-'}`]
  for (const name of (rules ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    parts.push(`${name}=${h.get(`X-Rate-Limit-${name}`) ?? '-'}`)
    parts.push(`${name}-State=${h.get(`X-Rate-Limit-${name}-State`) ?? '-'}`)
  }
  parts.push(`Retry-After=${h.get('Retry-After') ?? '-'}`)
  return parts.join(' ')
}

/** Ultimo stato del server per una regola (gruppo + periodo), con l'istante di lettura. */
export interface ServerHits {
  group: string
  periodSec: number
  hits: number
  at: number
}

/** Stato serializzabile di un RateLimiter (userData/rate-limits.json). */
export interface RateLimiterJSON {
  rules: RateLimitRule[]
  /** Istanti (ms epoch) delle richieste ancora dentro la finestra più lunga. */
  requests: number[]
  serverHits: ServerHits[]
  /** Fine dell'ultimo blocco (ms epoch, 0 se mai bloccato); resta anche dopo la scadenza. */
  blockedUntil: number
}

/** Quota di ogni regola che le richieste background possono usare. */
export const BACKGROUND_SHARE = 0.5

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v !== ''
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export class RateLimiter {
  private rules: RateLimitRule[] = []
  /** Ultimo stato riportato dal server, per gruppo e periodo, con l'istante di lettura. */
  private serverHits = new Map<string, ServerHits>()
  private requests: number[] = []
  private blockedUntil = 0

  constructor(private readonly now: () => number = Date.now) {}

  update(h: Headers): void {
    const t = this.now()
    const parsed = parseRateLimitHeaders(h)
    if (parsed.rules.length > 0) this.rules = parsed.rules
    for (const s of parsed.state) {
      this.serverHits.set(`${s.group}|${s.periodSec}`, {
        group: s.group,
        periodSec: s.periodSec,
        hits: s.hits,
        at: t
      })
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

  /**
   * Attesa prima della prossima richiesta. Le richieste normali usano ogni regola fino a
   * maxHits - 1; quelle `background` si fermano al 50%: partono solo se, contandole, gli hit
   * della finestra non superano metà di maxHits (almeno 1).
   */
  delayMs(background = false): number {
    const t = this.now()
    let wait = Math.max(0, this.blockedUntil - t)
    for (const rule of this.rules) {
      const ceiling = background
        ? Math.max(1, Math.floor(rule.maxHits * BACKGROUND_SHARE))
        : Math.max(1, rule.maxHits - 1)
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

  /**
   * Millisecondi trascorsi dalla fine dell'ultimo blocco (negativo durante il blocco);
   * Infinity se il limiter non è mai stato bloccato.
   */
  blockEndedAgoMs(): number {
    return this.blockedUntil === 0 ? Infinity : this.now() - this.blockedUntil
  }

  /** Stato da salvare: solo le richieste e gli stati del server ancora dentro la finestra più lunga. */
  toJSON(): RateLimiterJSON {
    const t = this.now()
    const maxPeriodMs = this.maxPeriodMs()
    return {
      rules: this.rules.map((r) => ({ ...r })),
      requests: this.requests.filter((r) => t - r < maxPeriodMs),
      serverHits: [...this.serverHits.values()]
        .filter((s) => t - s.at < s.periodSec * 1000)
        .map((s) => ({ ...s })),
      blockedUntil: this.blockedUntil
    }
  }

  /**
   * Limiter ricostruito da `toJSON()` (anche di una sessione precedente): voci malformate e
   * scadute scartate; input non valido → limiter vuoto.
   */
  static fromJSON(json: unknown, now: () => number = Date.now): RateLimiter {
    const l = new RateLimiter(now)
    const o = (json !== null && typeof json === 'object' ? json : {}) as Record<string, unknown>
    for (const v of arr(o.rules)) {
      const r = (v ?? {}) as Record<string, unknown>
      if (
        isStr(r.group) &&
        isNum(r.maxHits) &&
        r.maxHits > 0 &&
        isNum(r.periodSec) &&
        r.periodSec > 0 &&
        isNum(r.restrictSec) &&
        r.restrictSec >= 0
      ) {
        l.rules.push({
          group: r.group,
          maxHits: r.maxHits,
          periodSec: r.periodSec,
          restrictSec: r.restrictSec
        })
      }
    }
    const t = now()
    const maxPeriodMs = l.maxPeriodMs()
    l.requests = arr(o.requests)
      .filter((r): r is number => isNum(r) && r >= 0 && t - r < maxPeriodMs)
      .sort((a, b) => a - b)
    for (const v of arr(o.serverHits)) {
      const s = (v ?? {}) as Record<string, unknown>
      if (
        isStr(s.group) &&
        isNum(s.periodSec) &&
        s.periodSec > 0 &&
        isNum(s.hits) &&
        s.hits >= 0 &&
        isNum(s.at) &&
        t - s.at < s.periodSec * 1000
      ) {
        l.serverHits.set(`${s.group}|${s.periodSec}`, {
          group: s.group,
          periodSec: s.periodSec,
          hits: s.hits,
          at: s.at
        })
      }
    }
    if (isNum(o.blockedUntil) && o.blockedUntil > 0) l.blockedUntil = o.blockedUntil
    return l
  }

  private maxPeriodMs(): number {
    return Math.max(0, ...this.rules.map((r) => r.periodSec * 1000))
  }

  private prune(): void {
    const maxPeriodMs = this.maxPeriodMs()
    const t = this.now()
    if (maxPeriodMs > 0) this.requests = this.requests.filter((r) => t - r < maxPeriodMs)
  }
}
