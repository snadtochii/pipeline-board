import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadCollapsedColumns, saveCollapsedColumns } from './collapsed-columns'

const KEY = 'pipeline-board:collapsed-columns'

function makeStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string): string | null => map.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      map.set(k, v)
    },
    removeItem: (k: string): void => {
      map.delete(k)
    },
  }
}

// The helper only touches `window.localStorage`; in the node test env there is
// no window, so we stand up a minimal fake and tear it down per test.
const g = globalThis as { window?: { localStorage: ReturnType<typeof makeStorage> } }
let storage: ReturnType<typeof makeStorage>

beforeEach(() => {
  storage = makeStorage()
  g.window = { localStorage: storage }
})

afterEach(() => {
  delete g.window
})

describe('collapsed-columns', () => {
  it('returns [] when nothing is stored', () => {
    expect(loadCollapsedColumns()).toEqual([])
  })

  it('round-trips saved columns', () => {
    saveCollapsedColumns(['done', 'review'])
    expect(loadCollapsedColumns()).toEqual(['done', 'review'])
  })

  it('returns [] on corrupt JSON', () => {
    storage.setItem(KEY, '{not json')
    expect(loadCollapsedColumns()).toEqual([])
  })

  it('returns [] when the stored value is not an array', () => {
    storage.setItem(KEY, '"done"')
    expect(loadCollapsedColumns()).toEqual([])
  })

  it('drops unknown / stale column ids', () => {
    storage.setItem(KEY, JSON.stringify(['done', 'bogus', 'in-progress']))
    expect(loadCollapsedColumns()).toEqual(['done', 'in-progress'])
  })

  it('is server-safe: load returns [] and save is a no-op without window', () => {
    delete g.window
    expect(loadCollapsedColumns()).toEqual([])
    expect(() => saveCollapsedColumns(['done'])).not.toThrow()
  })
})
