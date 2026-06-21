import type { TicketRunStatus } from '../server/types'
import { relativeTime } from './relative-time'

// Client-safe display logic for the per-ticket flow-run chip (PB-14). Pure —
// imports only a TYPE from the server module, never the runtime runs.ts (which
// pulls in node:fs and would leak into the client bundle). isTicketRunRunning
// mirrors the server-side predicate of the same name in runs.ts:86 — reimplemented
// here, not imported, for exactly that boundary reason.

/** True while a run is genuinely active. Mirrors runs.ts's server-side predicate. */
export function isTicketRunRunning(status: TicketRunStatus | null): boolean {
  return status?.status === 'running'
}

/** Visual variant for the chip, so styling stays out of the label string. */
export type TicketRunChipVariant = 'idle' | 'running' | 'ok' | 'fail'

export interface TicketRunChip {
  label: string
  variant: TicketRunChipVariant
}

/**
 * Map a (possibly null) run status to a compact chip label + variant. `now`
 * (epoch ms) is injected for the relative time so the function stays pure/testable.
 *
 * - null            → "no runs yet"        (idle)   — ticket never run
 * - running         → "running…"           (running)
 * - succeeded       → "succeeded <rel>"    (ok)     — rel omitted if unparseable
 * - failed          → "failed <rel>"       (fail)
 *
 * Relative time keys off finishedAt ?? startedAt (mirrors SyncControl's choice).
 * When `now` is null the caller hasn't mounted its clock yet (SSR/first paint,
 * PB-5 hydration-safe pattern) — emit the label with no wall-clock suffix.
 */
export function ticketRunChip(
  status: TicketRunStatus | null,
  now: number | null,
): TicketRunChip {
  if (!status) return { label: 'no runs yet', variant: 'idle' }
  if (status.status === 'running') return { label: 'running…', variant: 'running' }

  const stamp = status.finishedAt ?? status.startedAt
  const rel = now === null ? '' : relativeTime(stamp, now)
  const word = status.status === 'succeeded' ? 'succeeded' : 'failed'
  const variant: TicketRunChipVariant = status.status === 'succeeded' ? 'ok' : 'fail'
  return { label: rel ? `${word} ${rel}` : word, variant }
}
