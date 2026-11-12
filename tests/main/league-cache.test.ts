import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Priority } from '../../src/core/trade/trade-client'
import { LEAGUES_MAX_AGE_MS, LeagueCache } from '../../src/main/league-cache'

const T0 = Date.parse('2026-11-12T12:00:00.000Z')

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'poe-leagues-'))
  path = join(dir, 'leagues.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function setup(opts: { now?: number; fetch?: (p: Priority) => Promise<string[]> } = {}): {
  cache: LeagueCache
  calls: Priority[]
  updates: string[][]
} {
  const calls: Priority[] = []
  const updates: string[][] = []
  const cache = new LeagueCache({
    path,
    fetchLeagues: (p) => {
      calls.push(p)
      return opts.fetch ? opts.fetch(p) : Promise.resolve(['Dawn', 'Standard'])
    },
    now: () => opts.now ?? T0,
    onUpdate: (ids) => updates.push(ids),
    log: () => {}
  })
  return { cache, calls, updates }
}

const writeFile = (fetchedAt: number, ids: string[]): void =>
  writeFileSync(path, JSON.stringify({ fetchedAt: new Date(fetchedAt).toISOString(), ids }))

describe('LeagueCache', () => {
  it('file recente: risponde subito con la lista salvata, nessuna richiesta', async () => {
    writeFile(T0 - LEAGUES_MAX_AGE_MS + 1000, ['Runes', 'Standard'])
    const { cache, calls } = setup()
    expect(cache.list()).toEqual(['Runes', 'Standard'])
    await cache.idle()
    expect(calls).toEqual([])
  })

  it('file più vecchio di 24 ore: lista salvata subito, aggiornamento user, file riscritto e notifica', async () => {
    writeFile(T0 - LEAGUES_MAX_AGE_MS - 1, ['Old'])
    const { cache, calls, updates } = setup()
    expect(cache.list()).toEqual(['Old'])
    await cache.idle()
    expect(calls).toEqual(['user'])
    expect(updates).toEqual([['Dawn', 'Standard']])
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      fetchedAt: new Date(T0).toISOString(),
      ids: ['Dawn', 'Standard']
    })
    expect(cache.list()).toEqual(['Dawn', 'Standard'])
  })

  it('senza file e senza rete: lista vuota, nessun file, nessuna notifica', async () => {
    const { cache, calls, updates } = setup({ fetch: () => Promise.reject(new Error('offline')) })
    expect(cache.list()).toEqual([])
    await cache.idle()
    expect(calls).toEqual(['user'])
    expect(updates).toEqual([])
    expect(existsSync(path)).toBe(false)
  })

  it('file illeggibile: trattato come assente', async () => {
    writeFileSync(path, '{non json')
    const { cache, calls } = setup()
    expect(cache.list()).toEqual([])
    await cache.idle()
    expect(calls).toEqual(['user'])
  })

  it('un solo aggiornamento alla volta', async () => {
    let resolve!: (ids: string[]) => void
    const { cache, calls } = setup({ fetch: () => new Promise((r) => (resolve = r)) })
    cache.list()
    cache.list()
    void cache.refreshIfStale('background')
    expect(calls).toEqual(['user'])
    resolve(['Dawn'])
    await cache.idle()
    expect(cache.list()).toEqual(['Dawn'])
  })

  it("all'avvio aggiorna in background solo se il file è vecchio o assente", async () => {
    writeFile(T0 - 1000, ['Fresh'])
    const fresh = setup()
    await fresh.cache.refreshIfStale('background')
    expect(fresh.calls).toEqual([])

    writeFile(T0 - LEAGUES_MAX_AGE_MS - 1, ['Old'])
    const old = setup()
    await old.cache.refreshIfStale('background')
    expect(old.calls).toEqual(['background'])
  })
})
