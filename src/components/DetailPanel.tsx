import { useEffect, useState } from 'react'
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

  // Default to 01-spec.md (or the first artifact) whenever the ticket changes.
  useEffect(() => {
    if (!ticket) {
      setSelectedFile(null)
      return
    }
    setSelectedFile(
      ticket.artifacts.includes('01-spec.md')
        ? '01-spec.md'
        : (ticket.artifacts[0] ?? null),
    )
  }, [ticket])

  // Close on Escape.
  useEffect(() => {
    if (!ticket) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ticket, onClose])

  const artifactQ = useQuery({
    queryKey:
      ticket && selectedFile
        ? queryKeys.artifact(ticket.projectName, ticket.id, selectedFile)
        : ['artifact', 'none'],
    queryFn: () =>
      getArtifact({
        data: {
          projectName: ticket!.projectName,
          ticketId: ticket!.id,
          filename: selectedFile!,
        },
      }),
    enabled: Boolean(ticket && selectedFile),
  })

  if (!ticket) return null

  return (
    <aside className="detail" aria-label={`Ticket ${ticket.id}`}>
      <header className="detail-head">
        <div>
          <div className="detail-id">{ticket.id}</div>
          <h2 className="detail-title">{ticket.title}</h2>
        </div>
        <button type="button" className="icon" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </header>

      <div className="detail-meta">
        {ticket.status && <span className={`status status-${ticket.status}`}>{ticket.status}</span>}
        {ticket.priority && <span className="meta-chip">priority: {ticket.priority}</span>}
        {ticket.complexity && <span className="meta-chip">complexity: {ticket.complexity}</span>}
        <span className="meta-chip">project: {ticket.projectName}</span>
        <span className="meta-chip">column: {ticket.column}</span>
        {ticket.mismatch && <span className="warn">⚠ folder/status mismatch</span>}
      </div>

      {ticket.tags.length > 0 && (
        <div className="detail-tags">
          {ticket.tags.map((t) => (
            <span key={t} className="tag">{t}</span>
          ))}
        </div>
      )}

      <nav className="artifact-tabs">
        {ticket.artifacts.length === 0 && <span className="muted">No artifacts</span>}
        {ticket.artifacts.map((a) => (
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
    </aside>
  )
}
