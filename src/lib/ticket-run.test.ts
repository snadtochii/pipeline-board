import { describe, expect, it } from 'vitest'
import { isTicketRunRunning, ticketRunChip } from './ticket-run'
import type { TicketRunStatus } from '../server/types'

const NOW = Date.parse('2026-06-21T12:00:00.000Z')

// Minimal TicketRunStatus factory — only the fields the chip reads matter.
function run(over: Partial<TicketRunStatus> & Pick<TicketRunStatus, 'status'>): TicketRunStatus {
  return {
    runId: over.runId ?? 'r1',
    projectName: over.projectName ?? 'proj',
    ticketId: over.ticketId ?? 'PB-14',
    action: 'flow',
    dryRun: over.dryRun ?? true,
    createPr: over.createPr ?? true,
    status: over.status,
    startedAt: over.startedAt ?? '2026-06-21T11:59:00.000Z',
    updatedAt: over.updatedAt ?? '2026-06-21T11:59:00.000Z',
    finishedAt: over.finishedAt ?? null,
    ...(over.prUrl !== undefined ? { prUrl: over.prUrl } : {}),
    ...(over.logTail !== undefined ? { logTail: over.logTail } : {}),
    ...(over.error !== undefined ? { error: over.error } : {}),
    ...(over.parentEpicId !== undefined ? { parentEpicId: over.parentEpicId } : {}),
  }
}

describe('isTicketRunRunning', () => {
  it('is true only for a running status', () => {
    expect(isTicketRunRunning(run({ status: 'running' }))).toBe(true)
  })

  it('is false for null and for terminal statuses', () => {
    expect(isTicketRunRunning(null)).toBe(false)
    expect(isTicketRunRunning(run({ status: 'succeeded' }))).toBe(false)
    expect(isTicketRunRunning(run({ status: 'failed' }))).toBe(false)
  })
})

describe('ticketRunChip', () => {
  it('shows "no runs yet" (idle) for a never-run ticket', () => {
    expect(ticketRunChip(null, NOW)).toEqual({ label: 'no runs yet', variant: 'idle' })
  })

  it('shows "running…" (running) while active', () => {
    expect(ticketRunChip(run({ status: 'running' }), NOW)).toEqual({
      label: 'running…',
      variant: 'running',
    })
  })

  it('shows "succeeded <rel>" (ok) using finishedAt', () => {
    const finishedAt = new Date(NOW - 3 * 60_000).toISOString()
    expect(ticketRunChip(run({ status: 'succeeded', finishedAt }), NOW)).toEqual({
      label: 'succeeded 3m ago',
      variant: 'ok',
    })
  })

  it('shows "failed <rel>" (fail)', () => {
    const finishedAt = new Date(NOW - 2 * 60 * 60_000).toISOString()
    expect(ticketRunChip(run({ status: 'failed', finishedAt }), NOW)).toEqual({
      label: 'failed 2h ago',
      variant: 'fail',
    })
  })

  it('shows "needs attention <rel>" (attention) for a needs-human run', () => {
    const finishedAt = new Date(NOW - 4 * 60_000).toISOString()
    expect(ticketRunChip(run({ status: 'needs-human', finishedAt }), NOW)).toEqual({
      label: 'needs attention 4m ago',
      variant: 'attention',
    })
  })

  it('falls back to startedAt when finishedAt is null', () => {
    const startedAt = new Date(NOW - 5 * 60_000).toISOString()
    expect(ticketRunChip(run({ status: 'succeeded', startedAt, finishedAt: null }), NOW)).toEqual({
      label: 'succeeded 5m ago',
      variant: 'ok',
    })
  })

  it('omits the relative suffix when now is null (pre-mount / SSR-safe)', () => {
    expect(ticketRunChip(run({ status: 'succeeded' }), null)).toEqual({
      label: 'succeeded',
      variant: 'ok',
    })
  })

  it('omits the relative suffix when the timestamp is unparseable', () => {
    expect(ticketRunChip(run({ status: 'failed', finishedAt: 'not-a-date' }), NOW)).toEqual({
      label: 'failed',
      variant: 'fail',
    })
  })
})
