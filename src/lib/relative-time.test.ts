import { describe, expect, it } from 'vitest'
import { relativeTime } from './relative-time'

// A fixed clock so the buckets are deterministic without faking timers.
const NOW = Date.parse('2026-06-21T12:00:00.000Z')
const ago = (ms: number): string => new Date(NOW - ms).toISOString()

describe('relativeTime', () => {
  it("returns 'just now' under 45 seconds", () => {
    expect(relativeTime(ago(0), NOW)).toBe('just now')
    expect(relativeTime(ago(44_000), NOW)).toBe('just now')
  })

  it('rounds to minutes between 45s and 60m', () => {
    expect(relativeTime(ago(60_000), NOW)).toBe('1m ago')
    expect(relativeTime(ago(59 * 60_000), NOW)).toBe('59m ago')
  })

  it('rounds to hours between 1h and 24h', () => {
    expect(relativeTime(ago(60 * 60_000), NOW)).toBe('1h ago')
    expect(relativeTime(ago(23 * 60 * 60_000), NOW)).toBe('23h ago')
  })

  it('rounds to days at 24h and beyond', () => {
    expect(relativeTime(ago(24 * 60 * 60_000), NOW)).toBe('1d ago')
    expect(relativeTime(ago(3 * 24 * 60 * 60_000), NOW)).toBe('3d ago')
  })

  it('clamps a future timestamp to "just now" (never negative)', () => {
    expect(relativeTime(new Date(NOW + 10_000).toISOString(), NOW)).toBe('just now')
  })

  it('returns an empty string for an unparseable timestamp', () => {
    expect(relativeTime('not-a-date', NOW)).toBe('')
    expect(relativeTime('', NOW)).toBe('')
  })
})
