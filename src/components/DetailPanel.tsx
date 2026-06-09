import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getArtifact } from '../server/functions'
import { queryKeys } from '../lib/query'
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
