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
  collapsed,
  onToggleCollapse,
}: {
  column: Col
  tickets: TicketDTO[]
  showProject: boolean
  onSelect: (t: TicketDTO) => void
  collapsed: boolean
  onToggleCollapse: (col: Col) => void
}) {
  const title = COLUMN_TITLES[column]
  const bodyId = `col-body-${column}`
  return (
    <section className={`column${collapsed ? ' collapsed' : ''}`} aria-label={title}>
      <header className="col-head">
        <button
          type="button"
          className="col-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title} column`}
          onClick={() => onToggleCollapse(column)}
        >
          <span className="col-title">{title}</span>
          <span className="col-count">{tickets.length}</span>
          <span className="col-chevron" aria-hidden="true">
            {collapsed ? '▸' : '▾'}
          </span>
        </button>
      </header>
      <div className="col-body" id={bodyId} hidden={collapsed}>
        {tickets.length === 0 ? (
          <p className="col-empty">No tickets</p>
        ) : (
          tickets.map((t) => (
            <TicketCard
              key={`${t.projectName}:${t.parentEpicId ?? ''}:${t.id}`}
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
