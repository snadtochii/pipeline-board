import type { Column, TicketDTO } from '../server/types'
import { PRIORITY_RANK } from './query'

/**
 * Default column order (Backlog / In Progress / Review): priority descending,
 * then ticket id ascending. A null priority ranks last. Unchanged from the
 * comparator that previously lived inline in Board.tsx.
 */
export function sortTickets(a: TicketDTO, b: TicketDTO): number {
  const ra = a.priority ? PRIORITY_RANK[a.priority] : 0
  const rb = b.priority ? PRIORITY_RANK[b.priority] : 0
  if (ra !== rb) return rb - ra // higher priority first
  return a.id.localeCompare(b.id)
}

/**
 * Done column order: newest completion first, then ticket id as a stable
 * tiebreak. `completedAt` is an ISO 8601 string (or null) — ISO timestamps from
 * Date#toISOString() are fixed-width UTC, so a lexical string compare is also a
 * chronological compare. A null `completedAt` (no derivable finish date) sorts
 * after every dated ticket; two nulls fall through to the id tiebreak. This keeps
 * the order deterministic across the 5s poll.
 */
export function sortDoneTickets(a: TicketDTO, b: TicketDTO): number {
  if (a.completedAt !== b.completedAt) {
    if (a.completedAt === null) return 1 // a undated → sorts after b
    if (b.completedAt === null) return -1 // b undated → sorts after a
    if (a.completedAt > b.completedAt) return -1 // newer first
    if (a.completedAt < b.completedAt) return 1
  }
  return a.id.localeCompare(b.id)
}

/** The comparator for a given column — Done sorts by completion date, the rest by priority. */
export function comparatorFor(col: Column): (a: TicketDTO, b: TicketDTO) => number {
  return col === 'done' ? sortDoneTickets : sortTickets
}
