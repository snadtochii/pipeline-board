import type { Column as Col, TicketDTO } from '../server/types'
import { TicketCard } from './TicketCard'

const COLUMN_TITLES: Record<Col, string> = {
  backlog: 'Backlog',
  'in-progress': 'In Progress',
  review: 'Review',
  done: 'Done',
}

export function Column({
  column,
  tickets,
  showProject,
  onSelect,
}: {
  column: Col
  tickets: TicketDTO[]
  showProject: boolean
  onSelect: (t: TicketDTO) => void
}) {
  return (
    <section className="column" aria-label={COLUMN_TITLES[column]}>
      <header className="col-head">
        <span className="col-title">{COLUMN_TITLES[column]}</span>
        <span className="col-count">{tickets.length}</span>
      </header>
      <div className="col-body">
        {tickets.length === 0 ? (
          <p className="col-empty">No tickets</p>
        ) : (
          tickets.map((t) => (
            <TicketCard
              key={`${t.projectName}:${t.id}`}
              ticket={t}
              showProject={showProject}
              onClick={() => onSelect(t)}
            />
          ))
        )}
      </div>
    </section>
  )
}
