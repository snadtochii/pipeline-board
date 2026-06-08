import { STATE_FOLDERS } from '../server/types'
import type { Column } from '../server/types'

/** localStorage key for the board-global set of collapsed columns. */
const STORAGE_KEY = 'pipeline-board:collapsed-columns'

/**
 * Read the persisted set of collapsed columns. Client-only and defensive:
 * returns [] on the server, when storage is unavailable, or when the stored
 * value is missing/corrupt. Unknown column ids (e.g. a future-renamed column)
 * are dropped so a stale value can never resurrect a column that no longer
 * exists. Never throws — persistence is a convenience, not core function.
 */
export function loadCollapsedColumns(): Column[] {
  if (typeof window === 'undefined') {
    return []
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    const valid = STATE_FOLDERS as readonly string[]
    return parsed.filter((c): c is Column => typeof c === 'string' && valid.includes(c))
  } catch {
    return []
  }
}

/**
 * Persist the set of collapsed columns. No-op on the server or when a write
 * throws (private mode, quota exceeded). A failed write must never surface to
 * the user.
 */
export function saveCollapsedColumns(columns: Column[]): void {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(columns))
  } catch {
    // ignore — storage unavailable or full
  }
}
