// Shared domain types for the pipeline board. These DTOs are what the server
// sends to the client — no filesystem handles or absolute paths leak through
// (except Project.path, which the Add-project form needs to echo back).

export type Priority = 'low' | 'medium' | 'high' | 'critical'
export type Complexity = 'S' | 'M' | 'L' | 'XL'

/** Frontmatter `status` values (authoritative for the badge). */
export type TicketStatus =
  | 'backlog'
  | 'in-progress'
  | 'in-review'
  | 'done'
  | 'partial-completion'
  | 'cancelled'

/** The four physical state folders — these are the board columns. */
export type Column = 'backlog' | 'in-progress' | 'review' | 'done'

/** Furthest pipeline stage reached, derived from which artifacts exist. */
export type DerivedStage =
  | 'spec'
  | 'plan'
  | 'implementation'
  | 'review'
  | 'tests'
  | 'summary'

export const STATE_FOLDERS: readonly Column[] = [
  'backlog',
  'in-progress',
  'review',
  'done',
]

/** Ordered stage → artifact filename that proves the stage was reached. */
export const STAGE_ARTIFACTS: ReadonlyArray<{ stage: DerivedStage; file: string }> = [
  { stage: 'plan', file: '02-plan.md' },
  { stage: 'implementation', file: '03-implementation.md' },
  { stage: 'review', file: '04-review.md' },
  { stage: 'tests', file: '05-tests.md' },
  { stage: 'summary', file: '06-summary.md' },
]

export interface Project {
  name: string
  path: string
}

export type ScanErrorKind = 'missing' | 'unreadable' | 'malformed'

export interface ScanError {
  kind: ScanErrorKind
  message: string
}

export interface TicketDTO {
  id: string
  title: string
  priority: Priority | null
  complexity: Complexity | null
  /** Frontmatter status; null when unparseable. Drives the badge only. */
  status: TicketStatus | null
  /**
   * Status-derived column the card appears in (via expectedFolderForStatus).
   * The physical folder is informational; for an out-of-sync ticket the two
   * diverge and `staleFolder` is set. A degraded solo falls back to its physical
   * folder; a degraded child falls back to `backlog`.
   */
  column: Column
  derivedStage: DerivedStage
  projectName: string
  tags: string[]
  /**
   * For an epic child task, the parent epic's id (folder name). Absent for solo
   * tickets. Distinguishes a child card, namespaces its React key, and lets the
   * detail panel rebuild the nested artifact path.
   */
  parentEpicId?: string
  /** Artifact filenames present in the ticket folder, e.g. ['01-spec.md','02-plan.md']. */
  artifacts: string[]
  /**
   * Completion timestamp (ISO 8601), used to order the Done column newest-first.
   * Derived from `06-summary.md`'s mtime (the terminal pipeline artifact); when a
   * Done ticket has no summary (cancelled/partial-completion/degraded) it falls back
   * to the newest mtime among present artifacts. `null` for non-Done tickets and for
   * genuinely date-less/degraded folders (those sort last). Not a `Date` — JSON wire.
   */
  completedAt: string | null
  /**
   * True when the ticket's physical folder ≠ its status-derived column — i.e. the
   * card is shown somewhere other than the folder it physically sits in. Always
   * false for epic children (their folder is the epic's by design) and for
   * degraded cards (null status).
   */
  staleFolder: boolean
  /** True when frontmatter was missing/unparseable and this is a degraded card. */
  metadataError: boolean
}

export interface ProjectScanResult {
  name: string
  path: string
  /** Per-project error so one bad root never blanks the whole board. */
  error: ScanError | null
  tickets: TicketDTO[]
}

export interface ArtifactResult {
  found: boolean
  content: string | null
  error?: string
}

// ── Cross-workspace sync (PB-6) ──────────────────────────────────────────────
// Status of a board-triggered `/feature:sync` sweep across every configured
// workspace. Persisted (atomically) to ~/.pipeline-board/last-sync.json by the
// orchestrator and read back by the getSyncStatus server fn — it is app status,
// not ticket data, so it never travels through the TicketSource seam.

/** Overall run state. `running` older than the staleness threshold reads as `failed`. */
export type SyncRunState = 'running' | 'done' | 'failed'

/** Per-workspace state as the sweep advances (boundary-written, one at a time). */
export type SyncWorkspaceState = 'pending' | 'running' | 'done' | 'failed'

/** Counts parsed (best-effort) from one workspace's grouped sync report. */
export interface SyncOutcome {
  promoted: number
  open: number
  needsAttention: number
  couldntCheck: number
}

export interface SyncWorkspaceStatus {
  /** Mirrors Project{name,path} so the UI correlates with scanAll without a join. */
  name: string
  path: string
  state: SyncWorkspaceState
  /** ISO timestamps; null until the workspace starts / finishes. */
  startedAt: string | null
  finishedAt: string | null
  /** Parsed counts, or null when the report couldn't be parsed / run didn't finish. */
  outcome: SyncOutcome | null
  /** Failure reason when state is `failed` (missing dir, spawn error, non-zero exit, timeout). */
  error?: string
  /** Raw report tail kept as a fallback when parsing fails. */
  rawReport?: string
}

export interface SyncRunStatus {
  runId: string
  startedAt: string
  finishedAt: string | null
  status: SyncRunState
  workspaces: SyncWorkspaceStatus[]
}

// ── Per-ticket flow runner (PB-12) ───────────────────────────────────────────
// Status of a board-triggered `/feature:flow <id> --pr` run for a single ticket.
// Persisted (atomically) under ~/.pipeline-board/runs/<runId>.json by runs.ts and
// resolved via a latest.json index — app state, not ticket data, so (like the
// Sync* block) it never travels through the TicketSource seam. Mirrors the Sync*
// shapes but scoped to one ticket: a per-run record keyed by runId, a `succeeded`
// (not `done`) terminal vocabulary, and an `updatedAt` stamp the orchestrator
// bumps on progress (a single run has no per-workspace stamps to derive freshness
// from).

/** The pipeline action a run drives. Single-valued in v1; widens when Prepare/Review-PR land. */
export type TicketRunAction = 'flow'

/**
 * Strict ticket/epic id shape (e.g. `PB-15`). Canonical single source — `functions.ts` uses it as the
 * server-fn validator's id gate, `runs.ts` as the defense-in-depth gate before interpolating an id into
 * the spawned `/feature:flow <id>` command, and the client (PB-14) to gate the run control off for
 * degraded cards. Lives here (a Node-builtin-free module both server and client safely import) so the
 * regex is declared once — no runs↔functions import cycle and no byte-identical clone to drift. */
export const TICKET_ID_RE = /^[A-Z][A-Z0-9]+-\d+$/

/** Overall run state. A `running` older than the staleness threshold reads as `failed`. */
export type TicketRunState = 'running' | 'succeeded' | 'failed'

export interface TicketRunStatus {
  runId: string
  /** Ticket identity (mirrors TicketDTO) — the trio that keys the run on disk. */
  projectName: string
  ticketId: string
  parentEpicId?: string
  action: TicketRunAction
  /** True when no agent was spawned (the default until the server is env-armed for live runs). */
  dryRun: boolean
  /** Whether the run requests a PR (`--pr`); always true in v1. */
  createPr: boolean
  status: TicketRunState
  /** ISO timestamps. `updatedAt` is bumped on progress so a legitimately long run stays "fresh". */
  startedAt: string
  updatedAt: string
  finishedAt: string | null
  /** PR URL parsed from a successful flow report, when present. */
  prUrl?: string
  /** Tail of run output, or a note (e.g. "dry run — no agent spawned"). */
  logTail?: string
  /** Failure reason when state is `failed`. */
  error?: string
}
