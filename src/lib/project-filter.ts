import type { Project } from '../server/types'

/**
 * Search params for the board route. An absent `project` means "All projects";
 * a present `project` is a single project's `name`. The URL is the single source
 * of truth for the filter (PB-22) — see `src/routes/index.tsx` (validateSearch)
 * and `Board.tsx` (read via getRouteApi).
 */
export interface BoardSearch {
  project?: string
}

/**
 * Normalize a raw `?project=` value into the board's search shape.
 *
 * TanStack Router's default search parser JSON-parses each value, so a normal
 * name round-trips as a string but a project whose folder name looks like JSON
 * — `123`, `true`, `null` — arrives coerced off `string`, which would break the
 * `name === filter` compare downstream. So coerce with `String()` and treat the
 * empty string and the `'all'` sentinel as "no filter" (absent param == All),
 * keeping the default view a bare `/`.
 */
export function normalizeProjectParam(raw: unknown): BoardSearch {
  if (raw === undefined || raw === null) {
    return {}
  }
  const value = String(raw)
  if (value === '' || value === 'all') {
    return {}
  }
  return { project: value }
}

/**
 * True when `filter` names a specific project that isn't in the loaded list —
 * i.e. a stale or unknown deep-link (`?project=removed-project`) whose param the
 * board should strip, falling back to "All". The `'all'` sentinel is never
 * unknown.
 *
 * This is the pure, name-matching half of the unknown-project fallback; the
 * caller gates the strip on the project list having actually loaded, so a valid
 * deep-link isn't clobbered before the projects arrive.
 */
export function isUnknownProjectFilter(filter: string, projects: Project[]): boolean {
  return filter !== 'all' && !projects.some((p) => p.name === filter)
}
