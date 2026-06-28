import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { listProjects, scanAll } from '../server/functions'
import { POLL_INTERVAL_MS, queryKeys } from '../lib/query'
import { comparatorFor } from '../lib/sort'
import { formatVersion } from '../lib/version'
import { loadCollapsedColumns, saveCollapsedColumns } from '../lib/collapsed-columns'
import { pruneUnknownProjects, selectionKey } from '../lib/project-filter'
import { STATE_FOLDERS } from '../server/types'
import type { Column as Col, ProjectScanResult, TicketDTO } from '../server/types'
import { Column } from './Column'
import { ProjectFilter } from './ProjectFilter'
import { SyncControl } from './SyncControl'
import { AddProjectDialog } from './AddProjectDialog'
import { DetailPanel } from './DetailPanel'
import { ProjectErrorChip } from './ProjectErrorChip'
import { EmptyState } from './EmptyState'

/** Stable identity of the open ticket (mirrors the dismissal effect's match trio).
 *  The panel resolves the live DTO from this each render, so it never freezes to an
 *  open-time snapshot. */
interface TicketIdentity {
  projectName: string
  id: string
  parentEpicId?: string
}

/** Resolve a ticket's identity from a scanned DTO (what a card click captures). */
function identityOf(t: TicketDTO): TicketIdentity {
  return { projectName: t.projectName, id: t.id, parentEpicId: t.parentEpicId }
}

/** Find the live DTO for an identity in the latest scan, or null when it's gone. */
function resolveSelected(
  key: TicketIdentity | null,
  results: ProjectScanResult[],
): TicketDTO | null {
  if (!key) {
    return null
  }
  const project = results.find((r) => r.name === key.projectName)
  if (!project) {
    return null
  }
  return (
    project.tickets.find(
      (t) => t.id === key.id && t.parentEpicId === key.parentEpicId,
    ) ?? null
  )
}

// Bound to the index route ('/'); used to read/write the ?project= filter param.
// getRouteApi avoids importing Route from routes/index.tsx, which imports Board
// (the cycle that would otherwise form).
const routeApi = getRouteApi('/')

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

  // The selected project filter lives in the URL as the single source of truth
  // (PB-22 single-select → PB-23 multi-select): survives refresh, is shareable, and
  // SSR-consistent (validateSearch runs on server + client, so no flash of "All").
  // The `project` param now carries a list of selected names (`?project=["a","b"]`);
  // an absent param == the empty selection == All projects. Read via getRouteApi to
  // dodge the routes/index → Board import cycle.
  const { project } = routeApi.useSearch()
  const navigate = routeApi.useNavigate()
  const selectedProjects = project ?? [] // [] == All projects; else the selected names
  // A poll-stable primitive key for the selection: the array is a fresh reference
  // every render, so effects keyed on it directly would re-fire (and re-clear the
  // open panel) every 5s poll. selKey only changes when the selected SET changes.
  const selKey = selectionKey(selectedProjects)
  // The open ticket is tracked by IDENTITY (projectName + id + parentEpicId), not by a
  // frozen DTO snapshot — so the panel re-resolves to the freshly-scanned object every
  // 5s poll and tracks the live scan (artifacts appearing, status/column advancing).
  // Holding the DTO value instead would freeze the panel to its open-time snapshot (PB-21).
  const [selectedKey, setSelectedKey] = useState<TicketIdentity | null>(null)
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

  // Resolve the open ticket from the LIVE scan each render (PB-21). This is what makes
  // the panel track the running flow — its artifact list and metadata block come from
  // the freshly-scanned DTO, not a snapshot captured at click time. Reuses the existing
  // 5s scan poll; no second query. React Query's structural sharing keeps this reference
  // stable between polls and re-points it only when the scanned ticket actually changes,
  // so the panel re-renders on real changes, not on every poll.
  const selected = resolveSelected(selectedKey, results)

  // Prune any selected projects that are unknown — removed via Manage projects, or a
  // stale ?project= deep-link — so the board falls back to the valid subset (or All
  // if none remain) instead of a false "no tickets" state. Only UNKNOWN names are
  // dropped; valid selections are kept. Gated on projectsQ.isSuccess so a VALID
  // deep-link isn't clobbered before the project list loads (projects is [] until
  // then). Pruning only ever shrinks the set, so once it's all-known the lengths
  // match and it stops — no loop. The panel-clear is handled by the [selKey] effect
  // below, which also covers the resulting selection change.
  useEffect(() => {
    if (!projectsQ.isSuccess) {
      return
    }
    const pruned = pruneUnknownProjects(selectedProjects, projects)
    if (pruned.length !== selectedProjects.length) {
      navigate({
        search: (prev) => ({ ...prev, project: pruned.length ? pruned : undefined }),
        replace: true,
      })
    }
  }, [projectsQ.isSuccess, projects, selKey, navigate])

  // Dismiss the open detail panel whenever the selection changes — including via
  // browser Back/Forward, which a URL-driven filter makes a real "selection change"
  // that never goes through the dropdown's onChange. On mount selectedKey is null,
  // so this is a no-op until a genuine change. The dep is the primitive selKey
  // (stable across the 5s poll), NOT the selection array — an array dep is a fresh
  // reference every render and would re-clear the panel on every poll.
  useEffect(() => {
    setSelectedKey(null)
  }, [selKey])

  // Dismiss the detail panel if its ticket is gone (project removed, ticket deleted):
  // when the identity no longer resolves in the live scan, clear the key so the panel
  // closes. Same identity match as resolveSelected — a solo and an epic child sharing a
  // leaf id (or two children of different epics) are never confused.
  useEffect(() => {
    if (selectedKey && !resolveSelected(selectedKey, results)) {
      setSelectedKey(null)
    }
  }, [results, selectedKey])

  const visible =
    selectedProjects.length === 0
      ? results
      : results.filter((r) => selectedProjects.includes(r.name))
  const errors = visible.filter((r) => r.error)
  // Show the per-card project badge whenever the visible set spans >1 project — any
  // multi-project view, not just the pure "All" view (PB-23). An empty selection ==
  // All, so its breadth is the full configured project count.
  const showProject =
    (selectedProjects.length === 0 ? projects.length : selectedProjects.length) > 1

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

  // Write the selection to the URL. An empty selection drops the param, keeping the
  // default view a bare '/'; replace: true so selection toggles don't pile up
  // browser-history entries (Back doesn't cycle past every toggle). Clear the panel
  // synchronously here too so a dropdown-driven change closes it in the same commit
  // (no one-frame flash of a ticket from a just-deselected project, since `selected`
  // resolves from the full unfiltered scan). The [selKey] effect above still covers
  // the Back/Forward and prune paths, which don't go through this handler.
  const refreshFilter = (next: string[]) => {
    navigate({
      search: (prev) => ({ ...prev, project: next.length ? next : undefined }),
      replace: true,
    })
    setSelectedKey(null)
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-brand">
          <h1>Pipeline Board</h1>
          <span className="app-version">{formatVersion(__APP_VERSION__)}</span>
        </div>
        <div className="actions">
          <ProjectFilter projects={projects} selected={selectedProjects} onChange={refreshFilter} />
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
                onSelect={(t) => setSelectedKey(identityOf(t))}
                collapsed={collapsed.has(col)}
                onToggleCollapse={toggleCollapse}
              />
            ))}
          </div>
        )}
      </main>

      <DetailPanel ticket={selected} onClose={() => setSelectedKey(null)} />

      <AddProjectDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        projects={projects}
        onChanged={onChanged}
      />
    </div>
  )
}
