import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { Listing } from '../types'
import type { CurrencyRates } from '../pricing/currency'

const SCHEMA_VERSION = 1

interface ListingRow {
  id: string
  league: string
  itemClass: string
  baseType: string
  itemLevel: number
  mods: string
  openPrefixes: number
  openSuffixes: number
  priceAmount: number
  priceCurrency: string
  priceExalted: number
  indexedAt: string
  seenAt: string
}

/** Archivio locale delle inserzioni trade e dei tassi di cambio (SQLite via node:sqlite). */
export class ListingStore {
  private readonly db: DatabaseSync
  private readonly upsertStmt: StatementSync
  private readonly comparablesStmt: StatementSync
  private readonly countStmt: StatementSync
  private readonly saveRatesStmt: StatementSync
  private readonly latestRatesStmt: StatementSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY,
        league TEXT NOT NULL,
        itemClass TEXT NOT NULL,
        baseType TEXT NOT NULL,
        itemLevel INTEGER NOT NULL,
        mods TEXT NOT NULL,
        openPrefixes INTEGER NOT NULL,
        openSuffixes INTEGER NOT NULL,
        priceAmount REAL NOT NULL,
        priceCurrency TEXT NOT NULL,
        priceExalted REAL NOT NULL,
        indexedAt TEXT NOT NULL,
        seenAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_listings_lookup ON listings (league, itemClass, indexedAt);
      CREATE TABLE IF NOT EXISTS rates (
        league TEXT PRIMARY KEY,
        fetchedAt TEXT NOT NULL,
        exaltedPer TEXT NOT NULL
      );
      PRAGMA user_version = ${SCHEMA_VERSION};
    `)
    this.upsertStmt = this.db.prepare(`
      INSERT INTO listings (id, league, itemClass, baseType, itemLevel, mods, openPrefixes, openSuffixes,
                            priceAmount, priceCurrency, priceExalted, indexedAt, seenAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        league = excluded.league, itemClass = excluded.itemClass, baseType = excluded.baseType,
        itemLevel = excluded.itemLevel, mods = excluded.mods,
        openPrefixes = excluded.openPrefixes, openSuffixes = excluded.openSuffixes,
        priceAmount = excluded.priceAmount, priceCurrency = excluded.priceCurrency,
        priceExalted = excluded.priceExalted, indexedAt = excluded.indexedAt, seenAt = excluded.seenAt
    `)
    this.comparablesStmt = this.db.prepare(
      `SELECT * FROM listings WHERE league = ? AND itemClass = ? AND indexedAt >= ? ORDER BY priceExalted ASC`
    )
    this.countStmt = this.db.prepare(
      `SELECT itemClass, COUNT(*) AS n FROM listings WHERE league = ? GROUP BY itemClass`
    )
    this.saveRatesStmt = this.db.prepare(`
      INSERT INTO rates (league, fetchedAt, exaltedPer) VALUES (?, ?, ?)
      ON CONFLICT(league) DO UPDATE SET fetchedAt = excluded.fetchedAt, exaltedPer = excluded.exaltedPer
    `)
    this.latestRatesStmt = this.db.prepare(
      `SELECT league, fetchedAt, exaltedPer FROM rates WHERE league = ?`
    )
  }

  /** Inserisce o aggiorna (chiave: id) in un'unica transazione. */
  upsert(listings: Listing[]): void {
    this.db.exec('BEGIN')
    try {
      for (const l of listings) {
        this.upsertStmt.run(
          l.id,
          l.league,
          l.itemClass,
          l.baseType,
          l.itemLevel,
          JSON.stringify(l.mods.map((m) => ({ statId: m.statId, value: m.value }))),
          l.openPrefixes,
          l.openSuffixes,
          l.priceAmount,
          l.priceCurrency,
          l.priceExalted,
          l.indexedAt,
          l.seenAt
        )
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** Inserzioni della stessa league e classe indicizzate negli ultimi `maxAgeDays`, dalla più economica. */
  comparables(f: { league: string; itemClass: string; maxAgeDays: number; now: Date }): Listing[] {
    const cutoff = new Date(f.now.getTime() - f.maxAgeDays * 86_400_000).toISOString()
    const rows = this.comparablesStmt.all(f.league, f.itemClass, cutoff) as unknown as ListingRow[]
    return rows.map((r) => ({ ...r, mods: JSON.parse(r.mods) as Listing['mods'] }))
  }

  countByClass(league: string): Record<string, number> {
    const rows = this.countStmt.all(league) as unknown as { itemClass: string; n: number }[]
    const out: Record<string, number> = {}
    for (const r of rows) out[r.itemClass] = r.n
    return out
  }

  /** Tiene solo gli ultimi tassi per league. */
  saveRates(r: CurrencyRates): void {
    this.saveRatesStmt.run(r.league, r.fetchedAt, JSON.stringify(r.exaltedPer))
  }

  latestRates(league: string): CurrencyRates | null {
    const row = this.latestRatesStmt.get(league) as unknown as
      { league: string; fetchedAt: string; exaltedPer: string } | undefined
    if (!row) return null
    return {
      league: row.league,
      fetchedAt: row.fetchedAt,
      exaltedPer: JSON.parse(row.exaltedPer) as Record<string, number>
    }
  }

  close(): void {
    this.db.close()
  }
}
