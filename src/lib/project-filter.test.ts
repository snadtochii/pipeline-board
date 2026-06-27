import { describe, expect, it } from 'vitest'
import type { Project } from '../server/types'
import { isUnknownProjectFilter, normalizeProjectParam } from './project-filter'

function project(name: string): Project {
  return { name, path: `/abs/${name}` }
}

describe('normalizeProjectParam', () => {
  it('treats undefined and null as no filter (All projects)', () => {
    expect(normalizeProjectParam(undefined)).toEqual({})
    expect(normalizeProjectParam(null)).toEqual({})
  })

  it('treats the empty string and the "all" sentinel as no filter', () => {
    expect(normalizeProjectParam('')).toEqual({})
    expect(normalizeProjectParam('all')).toEqual({})
  })

  it('keeps a normal project name', () => {
    expect(normalizeProjectParam('pipeline-board')).toEqual({ project: 'pipeline-board' })
  })

  it('preserves names with spaces and special characters', () => {
    expect(normalizeProjectParam('My Project (v2)')).toEqual({ project: 'My Project (v2)' })
  })

  it('String-coerces JSON-parsed numeric and boolean folder names', () => {
    // The router's default parser turns ?project=123 into the number 123 and
    // ?project=true into the boolean true; both must survive as their string form
    // so the downstream `r.name === filter` compare still matches.
    expect(normalizeProjectParam(123)).toEqual({ project: '123' })
    expect(normalizeProjectParam(true)).toEqual({ project: 'true' })
  })
})

describe('isUnknownProjectFilter', () => {
  const projects = [project('alpha'), project('beta')]

  it('is never true for the "all" sentinel', () => {
    expect(isUnknownProjectFilter('all', projects)).toBe(false)
    expect(isUnknownProjectFilter('all', [])).toBe(false)
  })

  it('is false for a known project name', () => {
    expect(isUnknownProjectFilter('alpha', projects)).toBe(false)
    expect(isUnknownProjectFilter('beta', projects)).toBe(false)
  })

  it('is true for a name absent from the loaded list', () => {
    expect(isUnknownProjectFilter('gamma', projects)).toBe(true)
  })

  it('is true for any specific project when the list is empty (not yet loaded)', () => {
    expect(isUnknownProjectFilter('alpha', [])).toBe(true)
  })
})
