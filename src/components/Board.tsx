import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listProjects, scanAll } from '../server/functions'
import { POLL_INTERVAL_MS, queryKeys } from '../lib/query'
import { comparatorFor } from '../lib/sort'
import { formatVersion } from '../lib/version'
import { loadCollapsedColumns, saveCollapsedColumns } from '../lib/collapsed-columns'
import { STATE_FOLDERS } from '../server/types'
import type { Column as Col, ProjectScanResult, TicketDTO } from '../server/types'
import { Column } from './Column'
import { ProjectFilter } from './ProjectFilter'
import { SyncControl } from './SyncControl'
import { AddProjectDialog } from './AddProjectDialog'
import { DetailPanel } from './DetailPanel'
import { ProjectErrorChip } from './ProjectErrorChip'
import { EmptyState } from './EmptyState'

export function Board() {
  const scan = useQuery({
    queryKey: queryKeys.scan,
    queryFn: () => scanAll(),
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })
  const projectsQ = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => listProjects(),
  })

  const [filter, setFilter] = useState<string>('all') // 'all' | project name
  const [selected, setSelected] = useState<TicketDTO | null>(null)
  const [manageOpen, setManageOpen] = useState(false)
  // Collapsed columns. Starts empty (all expanded) so the first render matches
  // the server — the persisted set is read in a mount effect, never during
  // render, to avoid an SSR hydration mismatch.
  const [collapsed, setCollapsed] = useState<Set<Col>>(() => new Set())

  // Hydrate collapse state from localStorage after mount (client-only).
  useEffect(() => {
    const stored = loadCollapsedColumns()
    if (stored.length > 0) {
      setCollapsed(new Set(stored))
    }
  }, [])

  // Toggle a column and write through to localStorage. Persisting here (not in a
  // useEffect on `collapsed`) avoids clobbering the stored value with the empty
  // initial set before the mount hydration runs.
  const toggleCollapse = useCallback((col: Col) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(col)) {
        next.delete(col)
      } else {
        next.add(col)
      }
      saveCollapsedColumns([...next])
      return next
    })
  }, [])

  const results: ProjectScanResult[] = scan.data ?? []
  const projects = projectsQ.data ?? []

  // If the actively-filtered project disappears (e.g. removed via Manage projects),
  // fall back to "All" so the board doesn't render a false "no tickets" state.
  useEffect(() => {
    if (filter !== 'all' && !projects.some((p) => p.name === filter)) {
      setFilter('all')
      setSelected(null)
    }
  }, [projects, filter])

  // Dismiss the detail panel if its ticket is gone (project removed, ticket deleted).
  // Match on (id, parentEpicId) so a solo and an epic child sharing a leaf id —
  // or two children of different epics — are never confused.
  useEffect(() => {
    if (
      selected &&
      !results.some(
        (r) =>
          r.name === selected.projectName &&
          r.tickets.some(
            (t) => t.id === selected.id && t.parentEpicId === selected.parentEpicId,
          ),
      )
    ) {
      setSelected(null)
    }
  }, [results, selected])

  const visible = filter === 'all' ? results : results.filter((r) => r.name === filter)
  const errors = visible.filter((r) => r.error)
  const showProject = filter === 'all' && projects.length > 1

  const byColumn = useMemo(() => {
    const map: Record<Col, TicketDTO[]> = {
      backlog: [],
      'in-progress': [],
      review: [],
      done: [],
    }
    for (const r of visible) {
      for (const t of r.tickets) map[t.column].push(t)
    }
    for (const col of STATE_FOLDERS) map[col].sort(comparatorFor(col))
    return map
  }, [visible])

  const totalTickets = STATE_FOLDERS.reduce((n, c) => n + byColumn[c].length, 0)

  const onChanged = () => {
    void scan.refetch()
    void projectsQ.refetch()
  }

  const firstLoading = scan.isLoading || projectsQ.isLoading

  const refreshFilter = (next: string) => {
    setFilter(next)
    setSelected(null)
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-brand">
          <h1>Pipeline Board</h1>
          <span className="app-version">{formatVersion(__APP_VERSION__)}</span>
        </div>
        <div className="actions">
          <ProjectFilter projects={projects} value={filter} onChange={refreshFilter} />
          <button type="button" onClick={() => setManageOpen(true)}>
            Manage projects
          </button>
          <SyncControl />
        </div>
      </header>

      {errors.length > 0 && (
        <div className="error-row">
          {errors.map((e) => (
            <ProjectErrorChip key={e.path} result={e} />
          ))}
        </div>
      )}

      <main className="content">
        {firstLoading ? (
          <p className="loading">Scanning projects…</p>
        ) : projects.length === 0 ? (
          <EmptyState variant="no-projects" onAddProject={() => setManageOpen(true)} />
        ) : totalTickets === 0 && errors.length === 0 ? (
          <EmptyState variant="no-tickets" onAddProject={() => setManageOpen(true)} />
        ) : (
          <div className="board">
            {STATE_FOLDERS.map((col) => (
              <Column
                key={col}
                column={col}
                tickets={byColumn[col]}
                showProject={showProject}
                onSelect={setSelected}
                collapsed={collapsed.has(col)}
                onToggleCollapse={toggleCollapse}
              />
            ))}
          </div>
        )}
      </main>

      <DetailPanel ticket={selected} onClose={() => setSelected(null)} />

      <AddProjectDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        projects={projects}
        onChanged={onChanged}
      />
    </div>
  )
}
