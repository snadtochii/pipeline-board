import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getSyncStatus, startSync } from '../server/functions'
import { POLL_INTERVAL_MS, queryKeys } from '../lib/query'
import type { SyncRunStatus } from '../server/types'

// Header control (PB-6): triggers a board-wide /feature:sync sweep and shows live
// status. The button is the actuator; the chip is the (polled) progress/result.
// The chip is fixed-width so text swaps never reflow the topbar (PB-4 convention).

function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.round((now - then) / 1000))
  if (secs < 45) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

/** Count of workspaces that have reached a terminal state (for the "n/N" progress). */
function progressCount(status: SyncRunStatus): number {
  return status.workspaces.filter((w) => w.state === 'done' || w.state === 'failed').length
}

/** Full per-workspace breakdown for the chip's hover tooltip (the visible chip stays compact). */
function detailTitle(status: SyncRunStatus): string {
  if (status.workspaces.length === 0) return 'No workspaces configured.'
  return status.workspaces
    .map((w) => {
      if (w.outcome) {
        const o = w.outcome
        return `${w.name}: ${w.state} — ↑${o.promoted} promoted · ${o.open} open · ⚠${o.needsAttention} attention · ?${o.couldntCheck} unchecked`
      }
      return `${w.name}: ${w.state}${w.error ? ` — ${w.error}` : ''}`
    })
    .join('\n')
}

const TRIGGER_TITLE = 'Run /feature:sync across all configured workspaces'

export function SyncControl() {
  const qc = useQueryClient()
  // Local clock so the relative "synced 3m ago" advances without a server round-trip.
  const [now, setNow] = useState(() => Date.now())

  const statusQ = useQuery({
    queryKey: queryKeys.syncStatus,
    queryFn: () => getSyncStatus(),
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })

  const start = useMutation({
    mutationFn: () => startSync(),
    // Optimistic: the start fn seeds `running` synchronously, so refetching now
    // disables the button immediately instead of waiting up to 5s for the next poll.
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.syncStatus }),
  })

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const status = statusQ.data ?? null
  const running = status?.status === 'running'
  const failed = status?.status === 'failed'
  const busy = running || start.isPending

  let chip: string
  let title: string
  if (!status) {
    // Loading and never-synced both render the same neutral text (deterministic SSR/first paint).
    chip = statusQ.isLoading ? 'sync' : 'never synced'
    title = TRIGGER_TITLE
  } else if (running) {
    chip = `syncing ${progressCount(status)}/${status.workspaces.length}…`
    title = detailTitle(status)
  } else {
    const when = status.finishedAt ?? status.startedAt
    const rel = when ? relativeTime(when, now) : ''
    chip = failed ? `sync failed${rel ? ` · ${rel}` : ''}` : `synced ${rel}`.trim()
    title = detailTitle(status)
  }

  return (
    <div className="sync">
      <button
        type="button"
        className="sync-btn"
        onClick={() => start.mutate()}
        disabled={busy}
        aria-label="Sync all workspaces"
        aria-busy={busy}
        title={TRIGGER_TITLE}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="18" cy="18" r="3" />
          <circle cx="6" cy="6" r="3" />
          <path d="M6 21V9a9 9 0 0 0 9 9" />
        </svg>
      </button>
      <span
        className={`sync-chip${failed ? ' sync-chip-failed' : ''}`}
        title={title}
        aria-live="polite"
      >
        {chip}
      </span>
    </div>
  )
}
