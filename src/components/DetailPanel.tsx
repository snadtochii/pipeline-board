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

  // Pick the artifact tab to show. Keyed on `[content]`, which now refreshes every 5s
  // poll (PB-21: the panel tracks the live scan), so this must PRESERVE the user's open
  // tab across updates — only auto-select a default when nothing is selected yet or the
  // selection has vanished. Otherwise a run producing 02-plan.md…06-summary.md would yank
  // the view back to 01-spec.md every poll.
  useEffect(() => {
    if (!content) {
      setSelectedFile(null)
      return
    }
    setSelectedFile((current) => {
      // Keep the current tab if it's still present in the live artifact list.
      if (current && content.artifacts.includes(current)) {
        return current
      }
      // Nothing selected yet, or the selected file is gone — fall back to a default.
      return content.artifacts.includes('01-spec.md')
        ? '01-spec.md'
        : (content.artifacts[0] ?? null)
    })
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

          <RunFlowControl
            key={`${content.projectName}:${content.parentEpicId ?? ''}:${content.id}`}
            ticket={content}
          />

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
 * Map a refused-start `reason` (started:false) to a human-readable note for the chip tooltip.
 * Unknown reasons fall through to the raw string so a future reason never shows as blank.
 */
function refusalMessage(reason: string): string {
  switch (reason) {
    case 'already-running':
      return 'a run is already in progress for this ticket'
    case 'project-busy':
      return 'another live run is active in this project'
    case 'dirty-tree':
      return 'the project has uncommitted changes — commit or stash them first'
    case 'unknown-project':
      return 'this project is no longer configured'
    case 'ticket-not-found':
      return 'this ticket no longer exists on disk'
    default:
      return reason
  }
}

/**
 * Per-ticket "Run" control + status chip (PB-14, PB-21). The button reads "Run" but
 * triggers /feature:flow <id> --pr (a real agent that opens a PR) behind an inline
 * confirm gate (PB-21). Mirrors SyncControl's mutation + polled-status +
 * optimistic-invalidate pattern, scoped to one ticket.
 *
 * Always rendered with a non-null `ticket` (the panel's `content`), so its hooks
 * run unconditionally — no conditional-hook hazard. The parent gives it a
 * ticket-scoped React `key` (project + parentEpicId + leaf id), so switching the
 * open ticket REMOUNTS this control: the run mutation, refusal note, and local
 * clock all reset to a clean slate instead of carrying the previous ticket's
 * in-flight/optimistic state across the swap.
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

  // `reason` from a refused start (started:false — already-running / project-busy /
  // dirty-tree / unknown-project / ticket-not-found). Distinct from a failed RUN, so
  // it's a transient note in the chip title (via refusalMessage), never styled as
  // failed. Cleared on the next successful start.
  const [refusal, setRefusal] = useState<string | null>(null)

  // Confirm gate (PB-21): a real Run now spawns an agent and opens a PR, so clicking
  // "Run" first reveals an inline confirm/cancel pair naming the consequence — it does
  // NOT spawn until the user confirms. Cancel resets with no run started. The pending
  // state is reset on ticket swap for free: the parent's ticket-scoped `key` remounts
  // this whole component (so `confirming` reverts to false), per PB-14.
  const [confirming, setConfirming] = useState(false)

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
        // A real start returns the SEEDED `running` status — paint it immediately so the
        // chip flips to "running…" without waiting for the next poll; the 5s poll then
        // drives the terminal progression (succeeded / needs-human / failed).
        if (res.status) qc.setQueryData(key, res.status)
      } else {
        setRefusal(res.reason ?? 'could not start')
      }
    },
    // Mirror SyncControl: refetch so the chip reflects disk state regardless of the
    // optimistic setQueryData above — real runs are non-terminal, so the seeded `running`
    // status progresses on the 5s poll.
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  })

  // Confirm path: dismiss the inline prompt and fire the real run.
  const confirmRun = (): void => {
    setConfirming(false)
    run.mutate()
  }

  const status = statusQ.data ?? null
  // While the start RPC is in flight, treat the run as running so the button disables
  // immediately on confirm — before the seeded `running` status lands in the cache.
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
      : (refusal && !run.isPending ? `Couldn’t start: ${refusalMessage(refusal)}` : null) ??
        status?.error ??
        status?.logTail ??
        status?.prUrl ??
        'Run /feature:flow --pr for this ticket — spawns a real agent and opens a PR'

  // Show the inline confirm only while idle — never mid-run. (busy can't change under us
  // while confirming, but guard anyway so a race can't strand an actionable confirm.)
  const showConfirm = confirming && !busy

  return (
    <div className="run">
      {showConfirm ? (
        <div className="run-confirm" role="group" aria-label="Confirm running the flow">
          <span className="run-confirm-msg">
            Run <code>/feature:flow {ticket.id} --pr</code> for real? This spawns an agent and opens a
            PR.
          </span>
          <span className="run-confirm-actions">
            <button
              type="button"
              className="primary run-btn"
              onClick={confirmRun}
              autoFocus
              aria-label={`Confirm: run /feature:flow --pr for ${ticket.id} (spawns a real agent and opens a PR)`}
            >
              Run
            </button>
            <button
              type="button"
              className="run-btn"
              onClick={() => setConfirming(false)}
              aria-label="Cancel running the flow"
            >
              Cancel
            </button>
          </span>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="primary run-btn"
            onClick={() => setConfirming(true)}
            disabled={busy}
            aria-busy={running}
            aria-label={`Run /feature:flow --pr for ${ticket.id} (spawns a real agent and opens a PR)`}
            title={title}
          >
            Run
          </button>
          <span
            className={`run-chip run-chip-${chip.variant}${run.isError ? ' run-chip-fail' : ''}`}
            title={title}
            aria-live="polite"
          >
            {run.isError ? 'start failed' : chip.label}
          </span>
        </>
      )}
    </div>
  )
}
