import { describe, expect, it } from 'vitest'
import { DEEP_BUSY_MESSAGE, RequestGate } from '../../src/main/request-gate'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('RequestGate', () => {
  it('una valutazione rapida parte anche durante un’analisi approfondita', async () => {
    const gate = new RequestGate()
    const d = deferred()
    const deep = gate.runDeep(() => d.promise)
    let quickRan = false
    expect(
      await gate.runQuick(async () => {
        quickRan = true
      })
    ).toBe('ran')
    expect(quickRan).toBe(true)
    d.resolve()
    expect(await deep).toBe('ran')
  })

  it('una seconda analisi approfondita durante la prima viene rifiutata', async () => {
    const gate = new RequestGate()
    const d = deferred()
    const first = gate.runDeep(() => d.promise)
    let secondRan = false
    expect(
      await gate.runDeep(async () => {
        secondRan = true
      })
    ).toBe('busy')
    expect(secondRan).toBe(false)
    expect(DEEP_BUSY_MESSAGE).toEqual({
      title: 'Analisi già in corso',
      message: 'Attendi che finisca prima di valutare un altro oggetto'
    })
    d.resolve()
    expect(await first).toBe('ran')
    // finita la prima, la successiva passa
    expect(await gate.runDeep(async () => {})).toBe('ran')
  })

  it('due rapide ravvicinate non sovrappongono le catture', async () => {
    const gate = new RequestGate()
    let active = 0
    let maxActive = 0
    let captures = 0
    const capture = (): Promise<string> =>
      gate.capture(async () => {
        active++
        captures++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 10))
        active--
        return 'testo'
      })
    const a = gate.runQuick(async () => void (await capture()))
    const b = gate.runQuick(async () => void (await capture()))
    expect(await b).toBe('skipped') // ripetizione del tasto: risponde la prima
    expect(await a).toBe('ran')
    expect(maxActive).toBe(1)
    expect(captures).toBe(1)
  })

  it('le catture di rapida e approfondita sono serializzate', async () => {
    const gate = new RequestGate()
    let active = 0
    let maxActive = 0
    const capture = (): Promise<void> =>
      gate.capture(async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 10))
        active--
      })
    await Promise.all([gate.runDeep(capture), gate.runQuick(capture)])
    expect(maxActive).toBe(1)
  })

  it('un errore nel task libera il gate', async () => {
    const gate = new RequestGate()
    await expect(
      gate.runDeep(async () => {
        throw new Error('x')
      })
    ).rejects.toThrow('x')
    await expect(gate.capture(async () => Promise.reject(new Error('y')))).rejects.toThrow('y')
    expect(await gate.runDeep(async () => {})).toBe('ran')
    expect(await gate.capture(async () => 1)).toBe(1)
  })
})
