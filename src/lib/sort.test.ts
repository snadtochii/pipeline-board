import { describe, expect, it } from 'vitest'
import { comparatorFor, sortDoneTickets, sortTickets } from './sort'
import type { Priority, TicketDTO } from '../server/types'

// Minimal TicketDTO factory — only the fields the comparators read matter; the
// rest get harmless defaults so each test states just what it exercises.
function ticket(over: Partial<TicketDTO> & Pick<TicketDTO, 'id'>): TicketDTO {
  return {
    id: over.id,
    title: over.title ?? over.id,
    priority: over.priority ?? null,
    complexity: over.complexity ?? null,
    status: over.status ?? null,
    column: over.column ?? 'done',
    derivedStage: over.derivedStage ?? 'spec',
    projectName: over.projectName ?? 'proj',
    tags: over.tags ?? [],
    artifacts: over.artifacts ?? [],
    completedAt: over.completedAt ?? null,
    staleFolder: over.staleFolder ?? false,
    metadataError: over.metadataError ?? false,
    ...(over.parentEpicId !== undefined ? { parentEpicId: over.parentEpicId } : {}),
  }
}

const ids = (ts: TicketDTO[]): string[] => ts.map((t) => t.id)

describe('sortTickets (Backlog / In Progress / Review)', () => {
  const prio = (id: string, priority: Priority | null): TicketDTO => ticket({ id, priority })

  it('orders by priority descending, then id ascending', () => {
    const input = [
      prio('PB-2', 'low'),
      prio('PB-3', 'critical'),
      prio('PB-1', 'critical'),
      prio('PB-4', 'medium'),
    ]
    expect(ids([...input].sort(sortTickets))).toEqual(['PB-1', 'PB-3', 'PB-4', 'PB-2'])
  })

  it('ranks a null priority last', () => {
    const input = [prio('PB-2', null), prio('PB-1', 'low')]
    expect(ids([...input].sort(sortTickets))).toEqual(['PB-1', 'PB-2'])
  })
})

describe('sortDoneTickets (Done column)', () => {
  const done = (id: string, completedAt: string | null): TicketDTO => ticket({ id, completedAt })

  it('orders newest completion first', () => {
    const input = [
      done('PB-1', '2026-06-07T10:00:00.000Z'),
      done('PB-3', '2026-06-11T10:00:00.000Z'),
      done('PB-2', '2026-06-08T10:00:00.000Z'),
    ]
    expect(ids([...input].sort(sortDoneTickets))).toEqual(['PB-3', 'PB-2', 'PB-1'])
  })

  it('sorts undated (null) tickets after every dated one', () => {
    const input = [
      done('PB-2', null),
      done('PB-1', '2026-06-08T10:00:00.000Z'),
      done('PB-3', null),
    ]
    // PB-1 (dated) first; the two nulls follow, ordered by the id tiebreak.
    expect(ids([...input].sort(sortDoneTickets))).toEqual(['PB-1', 'PB-2', 'PB-3'])
  })

  it('breaks equal timestamps by id ascending (stable across polls)', () => {
    const stamp = '2026-06-08T10:00:00.000Z'
    const input = [done('PB-3', stamp), done('PB-1', stamp), done('PB-2', stamp)]
    expect(ids([...input].sort(sortDoneTickets))).toEqual(['PB-1', 'PB-2', 'PB-3'])
  })

  it('breaks two undated tickets by id ascending', () => {
    const input = [done('PB-2', null), done('PB-1', null)]
    expect(ids([...input].sort(sortDoneTickets))).toEqual(['PB-1', 'PB-2'])
  })
})

describe('comparatorFor', () => {
  it('returns the Done comparator only for the done column', () => {
    expect(comparatorFor('done')).toBe(sortDoneTickets)
    expect(comparatorFor('backlog')).toBe(sortTickets)
    expect(comparatorFor('in-progress')).toBe(sortTickets)
    expect(comparatorFor('review')).toBe(sortTickets)
  })
})
