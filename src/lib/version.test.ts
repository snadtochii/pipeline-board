import { describe, expect, it } from 'vitest'
import { formatVersion } from './version'

describe('formatVersion', () => {
  it('prefixes v on a valid version string', () => {
    expect(formatVersion('0.1.0')).toBe('v0.1.0')
  })

  it('returns empty string for empty input', () => {
    expect(formatVersion('')).toBe('')
  })

  it('returns empty string for whitespace-only input', () => {
    expect(formatVersion('  ')).toBe('')
  })
})
