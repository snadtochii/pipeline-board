import type { Project } from '../server/types'

/**
 * Search params for the board route. An absent `project` means "All projects"; a
 * present `project` is a non-empty list of selected project `name`s. The URL is the
 * single source of truth for the filter (PB-22 single-select → PB-23 multi-select)
 * — see `src/routes/index.tsx` (validateSearch) and `Board.tsx` (read via getRouteApi).
 *
 * The param KEY stays `project` (not `projects`) even though it now carries an
 * array: the router's default serializer encodes the array as `?project=["a","b"]`,
 * and a legacy single value (`?project=foo`, the PB-22 form) still normalizes to a
 * one-element selection — so old deep-links keep working with no dual-key shim.
 */
export interface BoardSearch {
  project?: string[]
}

/** Label for the "All projects" state and option — single source of truth. */
export const ALL_PROJECTS_LABEL = 'All projects'

/**
 * Normalize a raw `?project=` value into the board's search shape.
 *
 * Input domain (per the router's default JSON serializer): `undefined | null |
 * string | number | boolean | unknown[]`, with scalar array elements. The array
 * form arrives already-parsed (`?project=["a","b"]` → `['a','b']`); a legacy single
 * value arrives as a bare scalar (`?project=foo` → `'foo'`, and bare `?project=123`
 * → the number `123`).
 *
 * Each element is `String()`-coerced — a project folder named like JSON (`123`,
 * `true`) would otherwise arrive off `string` and break the `name === selected`
 * compare downstream (the PB-22 edge guard, now applied per element). The empty
 * string and the `'all'` sentinel are dropped, duplicates removed (first-seen order
 * preserved), and an empty result collapses to "no filter" (`{}`, absent param ==
 * All) — keeping the default view a bare `/`.
 */
export function normalizeProjectParam(raw: unknown): BoardSearch {
  if (raw === undefined || raw === null) {
    return {}
  }
  const list = Array.isArray(raw) ? raw : [raw]
  const seen = new Set<string>()
  const projects: string[] = []
  for (const item of list) {
    if (item === undefined || item === null) {
      continue
    }
    const value = String(item)
    if (value === '' || value === 'all') {
      continue
    }
    if (!seen.has(value)) {
      seen.add(value)
      projects.push(value)
    }
  }
  return projects.length > 0 ? { project: projects } : {}
}

/**
 * Keep only the selected names that name a project in the loaded list — dropping
 * stale/unknown entries (a project removed via Manage projects, or a stale deep-link
 * `?project=["removed"]`). Order is preserved. An empty result means "fall back to
 * All", which the absent-param write already encodes.
 *
 * Pure and name-matching; the caller (Board's strip effect) gates the rewrite on the
 * project list having actually loaded, so a valid deep-link isn't pruned before the
 * projects arrive.
 */
export function pruneUnknownProjects(selected: string[], projects: Project[]): string[] {
  return selected.filter((name) => projects.some((p) => p.name === name))
}

/**
 * The filter trigger's label: the "All projects" sentinel when nothing specific is
 * selected, the single name when exactly one is, and a count ("Projects (N)") for
 * two or more.
 */
export function selectionLabel(selected: string[]): string {
  if (selected.length >= 2) {
    return `Projects (${selected.length})`
  }
  // length 0 → first is undefined → All; length 1 → the single name.
  const [first] = selected
  return first ?? ALL_PROJECTS_LABEL
}

/**
 * A stable, order-independent primitive key for a selection, for use as a React
 * effect dependency. The selection array is a fresh reference every render (derived
 * from `useSearch()`), so an array dep would re-fire effects (and re-clear the open
 * detail panel) on every 5s poll. Sorting makes toggle-order irrelevant; the NUL
 * separator can't occur in a folder name, so distinct sets never alias.
 */
export function selectionKey(selected: string[]): string {
  return [...selected].sort().join('\u0000')
}

/**
 * Toggle `name` in the selection — add if absent, remove if present. When the result
 * would cover every configured project, collapse to the empty selection (== "All
 * projects", a bare `/`) so a fully-checked board reads as All and a later-added
 * project still appears under a shared "All" link.
 */
export function nextSelection(selected: string[], name: string, allNames: string[]): string[] {
  const next = selected.includes(name)
    ? selected.filter((n) => n !== name)
    : [...selected, name]
  if (allNames.length > 0 && allNames.every((n) => next.includes(n))) {
    return []
  }
  return next
}
