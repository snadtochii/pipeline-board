import type { DerivedStage, TicketDTO } from '../server/types'

const STAGE_ORDER: readonly DerivedStage[] = [
  'spec',
  'plan',
  'implementation',
  'review',
  'tests',
  'summary',
]

const STAGE_LABEL: Record<DerivedStage, string> = {
  spec: 'spec',
  plan: 'planned',
  implementation: 'implementing',
  review: 'reviewed',
  tests: 'tested',
  summary: 'summarized',
}

export function TicketCard({
  ticket,
  showProject,
  onClick,
}: {
  ticket: TicketDTO
  showProject: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`card${ticket.metadataError ? ' card-degraded' : ''}`}
      onClick={onClick}
    >
      <div className="card-top">
        <span className="card-id">{ticket.id}</span>
        <span className="card-badges">
          {ticket.priority && (
            <span
              className={`pri pri-${ticket.priority}`}
              title={`priority: ${ticket.priority}`}
            />
          )}
          {ticket.complexity && <span className="cx" title="complexity">{ticket.complexity}</span>}
        </span>
      </div>

      <div className="card-title">{ticket.title}</div>

      <StageBar stage={ticket.derivedStage} />

      <div className="card-bottom">
        {ticket.status && (
          <span className={`status status-${ticket.status}`}>{ticket.status}</span>
        )}
        {ticket.parentEpicId && (
          <span className="epic-chip" title={`child of epic ${ticket.parentEpicId}`}>
            {ticket.parentEpicId}
          </span>
        )}
        {showProject && <span className="proj" title="project">{ticket.projectName}</span>}
        {ticket.staleFolder && (
          <span className="warn" title="physical folder differs from the status-derived column">
            ⚠ stale folder
          </span>
        )}
        {ticket.metadataError && (
          <span className="warn" title="frontmatter could not be parsed — degraded card">
            ⚠ metadata
          </span>
        )}
      </div>
    </button>
  )
}

function StageBar({ stage }: { stage: DerivedStage }) {
  const reached = STAGE_ORDER.indexOf(stage)
  return (
    <div className="stagebar" title={`pipeline stage: ${stage}`}>
      <span className="dots">
        {STAGE_ORDER.map((s, i) => (
          <span key={s} className={`dot${i <= reached ? ' dot-on' : ''}`} />
        ))}
      </span>
      <span className="stage-label">{STAGE_LABEL[stage]}</span>
    </div>
  )
}
