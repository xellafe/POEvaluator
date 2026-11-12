import { describe, expect, it } from 'vitest'
import {
  captureClipboard,
  KeyRepeatFilter,
  matchesHotkey,
  parseHotkey,
  type ClipboardDeps,
  type KeyEventLike
} from '../../src/main/input'

const KEYS = { D: 32, C: 46, F5: 63 }
const ev = (
  keycode: number,
  mods: { alt?: boolean; ctrl?: boolean; shift?: boolean } = {}
): KeyEventLike => ({
  keycode,
  altKey: mods.alt ?? false,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
  metaKey: false
})

describe('KeyRepeatFilter', () => {
  it('ignora i keydown ripetuti dello stesso tasto fino al keyup', () => {
    const f = new KeyRepeatFilter()
    expect(f.press(32)).toBe(true)
    expect(f.press(32)).toBe(false)
    expect(f.press(32)).toBe(false)
    f.release(32)
    expect(f.press(32)).toBe(true)
  })

  it('tasti diversi sono indipendenti', () => {
    const f = new KeyRepeatFilter()
    expect(f.press(32)).toBe(true)
    expect(f.press(46)).toBe(true)
    f.release(46)
    expect(f.press(32)).toBe(false)
  })
})

describe('parseHotkey', () => {
  it('legge tasto e modificatori', () => {
    expect(parseHotkey('Alt+D', KEYS)).toEqual({
      keycode: 32,
      alt: true,
      ctrl: false,
      shift: false
    })
    expect(parseHotkey('alt + shift + d', KEYS)).toEqual({
      keycode: 32,
      alt: true,
      ctrl: false,
      shift: true
    })
    expect(parseHotkey('Ctrl+F5', KEYS)).toEqual({
      keycode: 63,
      alt: false,
      ctrl: true,
      shift: false
    })
  })

  it('stringhe invalide → null', () => {
    expect(parseHotkey('', KEYS)).toBeNull()
    expect(parseHotkey('Alt+', KEYS)).toBeNull()
    expect(parseHotkey('Alt+Shift', KEYS)).toBeNull()
    expect(parseHotkey('Alt+Q', KEYS)).toBeNull()
    expect(parseHotkey('D+C', KEYS)).toBeNull()
  })
})

describe('matchesHotkey', () => {
  it('richiede esattamente gli stessi modificatori', () => {
    const quick = parseHotkey('Alt+D', KEYS)!
    const deep = parseHotkey('Alt+Shift+D', KEYS)!
    expect(matchesHotkey(ev(32, { alt: true }), quick)).toBe(true)
    expect(matchesHotkey(ev(32, { alt: true, shift: true }), quick)).toBe(false)
    expect(matchesHotkey(ev(32, { alt: true, shift: true }), deep)).toBe(true)
    expect(matchesHotkey(ev(32), quick)).toBe(false)
    expect(matchesHotkey(ev(46, { alt: true }), quick)).toBe(false)
  })
})

function fakeClipboard(
  initial: string,
  afterCopy: string | null,
  delayMs: number
): { writes: string[]; deps: ClipboardDeps } {
  let text = initial
  let t = 0
  let copiedAt: number | null = null
  let restored = false
  const writes: string[] = []
  return {
    writes,
    deps: {
      read: async () =>
        copiedAt !== null && !restored && afterCopy !== null && t >= copiedAt + delayMs
          ? afterCopy
          : text,
      write: async (s: string) => {
        writes.push(s)
        text = s
        if (copiedAt !== null) restored = true
      },
      sendCopy: () => {
        copiedAt = t
      },
      sleep: async (ms: number) => {
        t += ms
      }
    }
  }
}

describe('captureClipboard', () => {
  it('restituisce il testo copiato e ripristina gli appunti precedenti', async () => {
    const c = fakeClipboard('vecchio', 'Rarity: Rare', 60)
    const text = await captureClipboard(c.deps)
    expect(text).toBe('Rarity: Rare')
    expect(c.writes).toEqual(['', 'vecchio'])
  })

  it('timeout dopo 500 ms: stringa vuota, appunti ripristinati', async () => {
    const c = fakeClipboard('vecchio', null, 0)
    let sleeps = 0
    const deps = {
      ...c.deps,
      sleep: async (ms: number) => {
        sleeps += ms
        await c.deps.sleep(ms)
      }
    }
    expect(await captureClipboard(deps)).toBe('')
    expect(sleeps).toBe(500)
    expect(c.writes).toEqual(['', 'vecchio'])
  })

  it('se l’invio dei tasti fallisce ripristina comunque gli appunti', async () => {
    const c = fakeClipboard('vecchio', null, 0)
    const deps = {
      ...c.deps,
      sendCopy: () => {
        throw new Error('hook')
      }
    }
    await expect(captureClipboard(deps)).rejects.toThrow('hook')
    expect(c.writes).toEqual(['', 'vecchio'])
  })
})
