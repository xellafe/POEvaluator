// League PoE2 salvate su disco (userData/leagues.json): la finestra impostazioni le mostra subito,
// l'aggiornamento dal trade avviene in background quando il file ha più di 24 ore.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Priority } from '../core/trade/trade-client'

export const LEAGUES_MAX_AGE_MS = 24 * 60 * 60_000

interface LeagueFile {
  fetchedAt: string
  ids: string[]
}

export interface LeagueCacheDeps {
  path: string
  /** Scarica le league dal trade (TradeClient.leagues) con la priorità indicata. */
  fetchLeagues: (priority: Priority) => Promise<string[]>
  now: () => number
  /** Nuova lista scaricata e salvata (per aggiornare la finestra impostazioni aperta). */
  onUpdate: (ids: string[]) => void
  log: (msg: string) => void
}

export class LeagueCache {
  private refreshing: Promise<void> | null = null

  constructor(private readonly deps: LeagueCacheDeps) {}

  /** Lista salvata, subito; se vecchia o assente parte l'aggiornamento in background (user). */
  list(): string[] {
    const file = this.read()
    if (this.isStale(file)) void this.refresh('user')
    return file?.ids ?? []
  }

  /** Aggiorna dal trade solo se il file ha più di 24 ore o non esiste (usato all'avvio). */
  refreshIfStale(priority: Priority): Promise<void> {
    return this.isStale(this.read()) ? this.refresh(priority) : Promise.resolve()
  }

  /** Attende l'aggiornamento in corso, se c'è (test e arresto). */
  idle(): Promise<void> {
    return this.refreshing ?? Promise.resolve()
  }

  private isStale(file: LeagueFile | null): boolean {
    if (!file) return true
    const at = Date.parse(file.fetchedAt)
    return !Number.isFinite(at) || this.deps.now() - at > LEAGUES_MAX_AGE_MS
  }

  /** Un solo aggiornamento alla volta; non rigetta mai (in caso di errore resta la lista salvata). */
  private refresh(priority: Priority): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh(priority).finally(() => {
        this.refreshing = null
      })
    }
    return this.refreshing
  }

  private async doRefresh(priority: Priority): Promise<void> {
    try {
      const ids = await this.deps.fetchLeagues(priority)
      if (ids.length === 0) return
      this.write({ fetchedAt: new Date(this.deps.now()).toISOString(), ids })
      this.deps.log(`league disponibili: ${ids.join(', ')}`)
      this.deps.onUpdate(ids)
    } catch (e) {
      this.deps.log(`league non scaricate: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private read(): LeagueFile | null {
    try {
      const json = JSON.parse(readFileSync(this.deps.path, 'utf8')) as Partial<LeagueFile>
      if (typeof json?.fetchedAt !== 'string' || !Array.isArray(json.ids)) return null
      const ids = json.ids.filter((id): id is string => typeof id === 'string' && id !== '')
      return { fetchedAt: json.fetchedAt, ids }
    } catch {
      return null
    }
  }

  /** Scrittura atomica (file temporaneo + rename). */
  private write(file: LeagueFile): void {
    const tmp = `${this.deps.path}.tmp`
    writeFileSync(tmp, JSON.stringify(file) + '\n', 'utf8')
    renameSync(tmp, this.deps.path)
  }
}
