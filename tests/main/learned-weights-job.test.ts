import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Listing } from '../../src/core/types'
import type { Weights } from '../../src/core/valuation/weights'
import { LEARN_INTERVAL_MS, LearnedWeightsJob } from '../../src/main/learned-weights-job'

function boots(n: number, league = 'L'): Listing[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${league}${i}`,
    league,
    itemClass: 'armour.boots',
    baseType: 'B',
    itemLevel: 80,
    mods: i % 2 ? [{ statId: 'explicit.stat_up', value: 10 }] : [],
    openPrefixes: 0,
    openSuffixes: 0,
    priceAmount: 1,
    priceCurrency: 'exalted',
    priceExalted: i % 2 ? 4 : 2,
    indexedAt: '2026-11-10T00:00:00.000Z',
    seenAt: '2026-11-10T00:00:00.000Z'
  }))
}

describe('LearnedWeightsJob', () => {
  let league: string
  let installed: Record<string, Weights> | null | undefined
  let reports: string[]
  let logs: string[]
  let calls: string[]
  let job: LearnedWeightsJob

  beforeEach(() => {
    vi.useFakeTimers()
    league = 'L'
    installed = undefined
    reports = []
    logs = []
    calls = []
    job = new LearnedWeightsJob({
      store: {
        listingsOfLeague: (l: string) => {
          calls.push(l)
          return l === 'L' ? boots(200) : boots(10, l)
        }
      },
      league: () => league,
      install: (m) => {
        installed = m
      },
      writeReport: (json) => reports.push(json),
      now: () => new Date('2026-11-15T00:00:00.000Z'),
      log: (m) => logs.push(m)
    })
  })
  afterEach(() => {
    job.stop()
    vi.useRealTimers()
  })

  it('run installa i pesi della league corrente, scrive il report e logga una riga', () => {
    job.run()
    expect(calls).toEqual(['L'])
    expect(Object.keys(installed ?? {})).toEqual(['armour.boots'])
    expect(installed?.['armour.boots']['explicit.stat_up']).toBeGreaterThan(0)
    const report = JSON.parse(reports[0]) as {
      league: string
      classes: Record<string, { listings: number; report: { statId: string }[] }>
    }
    expect(report.league).toBe('L')
    expect(report.classes['armour.boots'].listings).toBe(200)
    expect(report.classes['armour.boots'].report[0].statId).toBe('explicit.stat_up')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/^pesi appresi: \{"armour.boots":200\} \(\d+ ms\)$/)
  })

  it('start non calcola subito ma al prossimo giro, poi ogni 6 ore', () => {
    job.start()
    expect(calls).toEqual([])
    vi.advanceTimersByTime(0)
    expect(calls).toHaveLength(1)
    vi.advanceTimersByTime(LEARN_INTERVAL_MS)
    expect(calls).toHaveLength(2)
  })

  it('al cambio di league toglie subito i pesi della precedente e ricalcola', () => {
    job.run()
    league = 'M'
    job.leagueChanged()
    expect(installed).toBeNull()
    vi.advanceTimersByTime(0)
    expect(calls).toEqual(['L', 'M'])
    // pochi dati nella nuova league: nessuna classe, resta la tabella
    expect(installed).toEqual({})
  })

  it('un errore viene loggato e i pesi installati restano', () => {
    job.run()
    const before = installed
    const failing = new LearnedWeightsJob({
      store: {
        listingsOfLeague: () => {
          throw new Error('db chiuso')
        }
      },
      league: () => league,
      install: (m) => {
        installed = m
      },
      writeReport: () => {},
      now: () => new Date(),
      log: (m) => logs.push(m)
    })
    failing.run()
    expect(installed).toBe(before)
    expect(logs.at(-1)).toMatch(/pesi appresi non calcolati: db chiuso/)
  })

  it('un errore di scrittura del report non impedisce di installare i pesi', () => {
    const j = new LearnedWeightsJob({
      store: { listingsOfLeague: () => boots(200) },
      league: () => 'L',
      install: (m) => {
        installed = m
      },
      writeReport: () => {
        throw new Error('disco pieno')
      },
      now: () => new Date(),
      log: (m) => logs.push(m)
    })
    j.run()
    expect(Object.keys(installed ?? {})).toEqual(['armour.boots'])
    expect(logs.some((l) => l.includes('disco pieno'))).toBe(true)
  })
})
