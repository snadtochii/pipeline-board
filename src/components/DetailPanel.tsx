import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getArtifact, getTicketRunStatus, startTicketRun, TICKET_ID_RE } from '../server/functions'
import { POLL_INTERVAL_MS, queryKeys } from '../lib/query'
import { isTicketRunRunning, ticketRunChip } from '../lib/ticket-run'
import type { TicketDTO } from '../server/types'
import { MarkdownView } from './MarkdownView'

export function DetailPanel({
  ticket,
  onClose,
}: {
  ticket: TicketDTO | null
  onClose: () => void
}) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null)

  // `content` is the ticket actually rendered. It tracks `ticket` immediately on
  // open/swap (render-phase derived-state update, so the panel's content — and
  // the ✕ button the focus effect targets — exist on the same render the panel
  // opens), but lags behind on close: when `ticket` goes null we keep showing the
  // last ticket so the panel can slide out, then clear it after the transition.
  const [content, setContent] = useState<TicketDTO | null>(ticket)
  if (ticket && ticket !== content) {
    setContent(ticket)
  }
  const open = ticket != null

  const panelRef = useRef<HTMLElement | null>(null)
  const closeBtnRef = useRef<HTMLButtonElement | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)

  // On close, keep the last content mounted briefly so the slide-out animates,
  // then clear it. Re-opening before the timer fires cancels the clear.
  useEffect(() => {
    if (ticket) return
    const t = setTimeout(() => setContent(null), 200)
    return () => clearTimeout(t)
  }, [ticket])

  // Default to 01-spec.md (or the first artifact) whenever the shown ticket changes.
  useEffect(() => {
    if (!content) {
      setSelectedFile(null)
      return
    }
    setSelectedFile(
      content.artifacts.includes('01-spec.md')
        ? '01-spec.md'
        : (content.artifacts[0] ?? null),
    )
  }, [content])

  // Close on Escape (only while open).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Close on a click outside the panel that isn't a ticket card. Capture phase so
  // it runs before the card's own onClick; a click on a card is ignored here so
  // its onSelect can swap the panel content instead of closing. The modal dialog
  // (.modal-backdrop) is excluded so the panel coexists with Manage-projects.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (!target) return
      if (panelRef.current?.contains(target)) return
      if (target.closest('.card')) return
      if (target.closest('.modal-backdrop')) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open, onClose])

  // Move focus into the panel on open; restore it to the triggering element on
  // close. Deps on `open` only, so swapping tickets (open stays true) never
  // re-focuses. Cards are recreated on each 5s poll, so guard the restore with
  // isConnected and fall back to the document body.
  useEffect(() => {
    if (open) {
      triggerRef.current = (document.activeElement as HTMLElement | null) ?? null
      closeBtnRef.current?.focus()
    } else if (triggerRef.current) {
      const trigger = triggerRef.current
      triggerRef.current = null
      if (trigger.isConnected) {
        trigger.focus()
      } else {
        document.body.focus()
      }
    }
  }, [open])

  const artifactQ = useQuery({
    queryKey:
      content && selectedFile
        ? queryKeys.artifact(content.projectName, content.id, selectedFile, content.parentEpicId)
        : ['artifact', 'none'],
    queryFn: () =>
      getArtifact({
        data: {
          projectName: content!.projectName,
          ticketId: content!.id,
          filename: selectedFile!,
          parentEpicId: content!.parentEpicId,
        },
      }),
    enabled: Boolean(content && selectedFile),
  })

  return (
    <aside
      ref={panelRef}
      className={`detail${open ? ' open' : ''}`}
      aria-label={content ? `Ticket ${content.id}` : undefined}
      aria-hidden={!open}
      inert={!open}
    >
      {content && (
        <>
          <header className="detail-head">
            <div>
              <div className="detail-id">{content.id}</div>
              <h2 className="detail-title">{content.title}</h2>
            </div>
            <button
              ref={closeBtnRef}
              type="button"
              className="icon"
              onClick={onClose}
              aria-label="Close panel"
            >
              ✕
            </button>
          </header>

          <div className="detail-meta">
            {content.status && <span className={`status status-${content.status}`}>{content.status}</span>}
            {content.priority && <span className="meta-chip">priority: {content.priority}</span>}
            {content.complexity && <span className="meta-chip">complexity: {content.complexity}</span>}
            {content.parentEpicId && <span className="meta-chip">epic: {content.parentEpicId}</span>}
            <span className="meta-chip">project: {content.projectName}</span>
            <span className="meta-chip">column: {content.column}</span>
            {content.staleFolder && <span className="warn">⚠ stale folder</span>}
          </div>

          <RunFlowControl ticket={content} />

          {content.tags.length > 0 && (
            <div className="detail-tags">
              {content.tags.map((t) => (
                <span key={t} className="tag">{t}</span>
              ))}
            </div>
          )}

          <nav className="artifact-tabs">
            {content.artifacts.length === 0 && <span className="muted">No artifacts</span>}
            {content.artifacts.map((a) => (
              <button
                key={a}
                type="button"
                className={`artifact-tab${a === selectedFile ? ' active' : ''}`}
                onClick={() => setSelectedFile(a)}
              >
                {a}
              </button>
            ))}
          </nav>

          <div className="artifact-body">
            {!selectedFile && <p className="muted">Select an artifact to view it.</p>}
            {selectedFile && artifactQ.isLoading && <p className="muted">Loading {selectedFile}…</p>}
            {selectedFile && artifactQ.data && (
              artifactQ.data.found && artifactQ.data.content !== null ? (
                <MarkdownView content={artifactQ.data.content} />
              ) : (
                <p className="form-error">
                  Could not load {selectedFile}: {artifactQ.data.error ?? 'not found'}
                </p>
              )
            )}
          </div>
        </>
      )}
    </aside>
  )
}

/**
 * Per-ticket "Run Flow --pr" control + status chip (PB-14). Mirrors SyncControl's
 * mutation + polled-status + optimistic-invalidate pattern, scoped to one ticket.
 *
 * Always rendered with a non-null `ticket` (the panel's `content`), so its hooks
 * run unconditionally — no conditional-hook hazard. The query/mutation key off the
 * passed ticket; on a panel swap React keeps this same component instance but the
 * query key changes (project + parentEpicId + leaf id), so the chip auto-reflects
 * the newly-keyed ticket's run (or "no runs yet") with no manual reset.
 *
 * Imports only RPC stubs from functions.ts and pure helpers from src/lib — no
 * runs.ts/scanner.ts import, so no node:* leaks into the client bundle.
 */
function RunFlowControl({ ticket }: { ticket: TicketDTO }) {
  const qc = useQueryClient()

  // Hydration-safe clock (PB-5): null on first paint/SSR so no wall-clock string
  // is emitted before mount; set on mount, then advance every 30s so the relative
  // "succeeded 3m ago" ticks without a server round-trip.
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  // A degraded card (unparseable frontmatter → folder-name id) can carry an id the
  // server validator's TICKET_ID_RE would reject, throwing on the RPC. Gate the
  // control off for those: no query, button disabled.
  const runnable = !ticket.metadataError && TICKET_ID_RE.test(ticket.id)
  const key = queryKeys.ticketRun(ticket.projectName, ticket.id, ticket.parentEpicId)

  const statusQ = useQuery({
    queryKey: key,
    queryFn: () =>
      getTicketRunStatus({
        data: {
          projectName: ticket.projectName,
          ticketId: ticket.id,
          parentEpicId: ticket.parentEpicId,
        },
      }),
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    enabled: runnable,
  })

  // `reason` from a refused start (started:false — already-running / unknown-project
  // / ticket-not-found). Distinct from a failed RUN, so it's a transient note in the
  // chip title, never styled as failed. Cleared on the next successful start.
  const [refusal, setRefusal] = useState<string | null>(null)

  const run = useMutation({
    mutationFn: () =>
      startTicketRun({
        data: {
          projectName: ticket.projectName,
          ticketId: ticket.id,
          parentEpicId: ticket.parentEpicId,
          // createPr omitted → server defaults it to true (the "--pr" behavior).
        },
      }),
    onSuccess: (res) => {
      if (res.started) {
        setRefusal(null)
        // startGuardedTicketRun is terminal-on-return in dry-run, so res.status is
        // the final status — paint it immediately, no second poll needed.
        if (res.status) qc.setQueryData(key, res.status)
      } else {
        setRefusal(res.reason ?? 'could not start')
      }
    },
    // Mirror SyncControl: refetch so the chip reflects disk state regardless of the
    // optimistic setQueryData above (and once PB-15's real runs are non-terminal).
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  })

  const status = statusQ.data ?? null
  // While the start RPC is in flight, treat the run as running — in dry-run this is
  // the only genuine client-side "running" window (the server writes running then
  // succeeded before returning), giving AC8 a real running indication.
  const running = isTicketRunRunning(status) || run.isPending
  const busy = running || !runnable

  const chip = run.isPending
    ? { label: 'running…', variant: 'running' as const }
    : runnable
      ? ticketRunChip(status, now)
      : { label: 'run n/a', variant: 'idle' as const }

  // Tooltip surfaces the most useful detail without bloating the chip text.
  const title = !runnable
    ? 'This ticket can’t be run (degraded metadata or invalid id).'
    : run.isError
      ? 'Could not reach the server to start the run.'
      : (refusal && !run.isPending ? `Couldn’t start: ${refusal}` : null) ??
        status?.error ??
        status?.logTail ??
        status?.prUrl ??
        'Run /feature:flow --pr for this ticket'

  return (
    <div className="run">
      <button
        type="button"
        className="primary run-btn"
        onClick={() => run.mutate()}
        disabled={busy}
        aria-busy={running}
        aria-label={`Run Flow --pr for ${ticket.id}`}
        title={title}
      >
        Run Flow --pr
      </button>
      <span
        className={`run-chip run-chip-${chip.variant}${run.isError ? ' run-chip-fail' : ''}`}
        title={title}
        aria-live="polite"
      >
        {run.isError ? 'start failed' : chip.label}
      </span>
    </div>
  )
}
