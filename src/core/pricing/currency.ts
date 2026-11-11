export interface CurrencyRates {
  league: string
  fetchedAt: string
  /** Quanti Exalted vale 1 unità della valuta (es. divine → 250, exalted → 1). */
  exaltedPer: Record<string, number>
}

const NINJA_BASE = 'https://poe.ninja/poe2/api/economy/exchange/current/overview'

/**
 * Endpoint poe.ninja (PoE2) con i valori delle currency. Gli id delle righe coincidono
 * con gli id della valuta usati dal trade (`listing.price.currency`): "divine", "exalted", "chaos"…
 */
export function ninjaRatesUrl(league: string): string {
  return `${NINJA_BASE}?league=${encodeURIComponent(league)}&type=Currency`
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isPositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

/** Converte un importo in Exalted; `null` se i tassi mancano, la valuta è ignota o l'importo non è valido. */
export function makeConverter(
  rates: CurrencyRates | null
): (amount: number, currency: string) => number | null {
  return (amount, currency) => {
    if (rates === null) return null
    if (!Number.isFinite(amount) || amount <= 0) return null
    if (!Object.prototype.hasOwnProperty.call(rates.exaltedPer, currency)) return null
    const rate = rates.exaltedPer[currency]
    return isPositive(rate) ? amount * rate : null
  }
}

function parseNinja(json: unknown): Record<string, number> {
  const fail = (why: string): never => {
    throw new Error(`Risposta poe.ninja non valida: ${why}`)
  }
  if (!isObj(json) || !isObj(json.core) || !isObj(json.core.rates) || !Array.isArray(json.lines)) {
    return fail('struttura inattesa')
  }
  // I valori delle righe sono espressi nella valuta primaria (divine); `rates.exalted` = exalted per 1 primaria.
  if (json.core.primary !== undefined && json.core.primary !== 'divine') {
    return fail(`valuta primaria inattesa (${String(json.core.primary)})`)
  }
  const exaltedPerPrimary = json.core.rates.exalted
  if (!isPositive(exaltedPerPrimary)) return fail('tasso exalted mancante')

  const out: Record<string, number> = {}
  for (const line of json.lines) {
    if (!isObj(line) || typeof line.id !== 'string' || !isPositive(line.primaryValue)) continue
    const v = line.primaryValue * exaltedPerPrimary
    if (isPositive(v)) out[line.id] = v
  }
  out.divine = exaltedPerPrimary
  out.exalted = 1
  return out
}

export async function fetchRates(
  league: string,
  fetchImpl: typeof fetch,
  userAgent: string
): Promise<CurrencyRates> {
  const res = await fetchImpl(ninjaRatesUrl(league), {
    method: 'GET',
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
    credentials: 'omit'
  })
  if (!res.ok) throw new Error(`poe.ninja: HTTP ${res.status}`)
  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new Error('Risposta poe.ninja non valida: JSON non leggibile')
  }
  return { league, fetchedAt: new Date().toISOString(), exaltedPer: parseNinja(json) }
}
