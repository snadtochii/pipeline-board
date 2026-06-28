import { describe, expect, it } from 'vitest'
import type { Project } from '../server/types'
import {
  ALL_PROJECTS_LABEL,
  nextSelection,
  normalizeProjectParam,
  pruneUnknownProjects,
  selectionKey,
  selectionLabel,
} from './project-filter'

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

  it('wraps a legacy single value (PB-22 deep-link) into a one-element selection', () => {
    expect(normalizeProjectParam('pipeline-board')).toEqual({ project: ['pipeline-board'] })
  })

  it('preserves names with spaces and special characters', () => {
    expect(normalizeProjectParam('My Project (v2)')).toEqual({ project: ['My Project (v2)'] })
  })

  it('String-coerces a JSON-parsed numeric or boolean scalar', () => {
    // The router's default parser turns a bare ?project=123 into the number 123 and
    // ?project=true into the boolean true; both must survive as their string form so
    // the downstream `r.name === selected` compare still matches.
    expect(normalizeProjectParam(123)).toEqual({ project: ['123'] })
    expect(normalizeProjectParam(true)).toEqual({ project: ['true'] })
  })

  it('keeps an array of names (the multi-select form)', () => {
    expect(normalizeProjectParam(['alpha', 'beta'])).toEqual({ project: ['alpha', 'beta'] })
  })

  it('String-coerces each array element', () => {
    expect(normalizeProjectParam([123, true])).toEqual({ project: ['123', 'true'] })
  })

  it('drops empty/"all" sentinels and null elements inside the array', () => {
    expect(normalizeProjectParam(['alpha', '', 'all', null])).toEqual({ project: ['alpha'] })
  })

  it('de-duplicates while preserving first-seen order', () => {
    expect(normalizeProjectParam(['beta', 'alpha', 'beta'])).toEqual({
      project: ['beta', 'alpha'],
    })
  })

  it('collapses an empty or all-dropped array to no filter', () => {
    expect(normalizeProjectParam([])).toEqual({})
    expect(normalizeProjectParam(['', 'all'])).toEqual({})
  })
})

describe('pruneUnknownProjects', () => {
  const projects = [project('alpha'), project('beta')]

  it('keeps only names present in the loaded list, preserving order', () => {
    expect(pruneUnknownProjects(['beta', 'alpha'], projects)).toEqual(['beta', 'alpha'])
  })

  it('drops unknown names while keeping the valid ones', () => {
    expect(pruneUnknownProjects(['alpha', 'gamma'], projects)).toEqual(['alpha'])
  })

  it('returns an empty array when every selected name is unknown (falls back to All)', () => {
    expect(pruneUnknownProjects(['gamma', 'delta'], projects)).toEqual([])
  })

  it('returns an empty array when nothing is selected', () => {
    expect(pruneUnknownProjects([], projects)).toEqual([])
  })

  it('treats every name as unknown when the list is empty (not yet loaded)', () => {
    expect(pruneUnknownProjects(['alpha'], [])).toEqual([])
  })
})

describe('selectionLabel', () => {
  it('labels the empty selection as "All projects"', () => {
    expect(selectionLabel([])).toBe(ALL_PROJECTS_LABEL)
  })

  it('labels a single selection with the project name', () => {
    expect(selectionLabel(['alpha'])).toBe('alpha')
  })

  it('labels two or more with a count', () => {
    expect(selectionLabel(['alpha', 'beta'])).toBe('Projects (2)')
    expect(selectionLabel(['alpha', 'beta', 'gamma'])).toBe('Projects (3)')
  })
})

describe('selectionKey', () => {
  it('is order-independent', () => {
    expect(selectionKey(['alpha', 'beta'])).toBe(selectionKey(['beta', 'alpha']))
  })

  it('distinguishes different selection sets', () => {
    expect(selectionKey(['alpha'])).not.toBe(selectionKey(['alpha', 'beta']))
  })

  it('maps the empty selection to a stable empty key', () => {
    expect(selectionKey([])).toBe('')
  })
})

describe('nextSelection', () => {
  const all = ['alpha', 'beta', 'gamma']

  it('adds a name that is not yet selected', () => {
    expect(nextSelection(['alpha'], 'beta', all)).toEqual(['alpha', 'beta'])
  })

  it('removes a name that is already selected', () => {
    expect(nextSelection(['alpha', 'beta'], 'alpha', all)).toEqual(['beta'])
  })

  it('collapses to All when the toggle completes the full set', () => {
    expect(nextSelection(['alpha', 'beta'], 'gamma', all)).toEqual([])
  })

  it('collapses to All when selecting the only configured project', () => {
    expect(nextSelection([], 'alpha', ['alpha'])).toEqual([])
  })

  it('does not collapse when there are no configured projects to complete', () => {
    expect(nextSelection(['alpha'], 'beta', [])).toEqual(['alpha', 'beta'])
  })
})
