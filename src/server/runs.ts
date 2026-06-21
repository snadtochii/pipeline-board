import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { configDir } from './config.ts'
import type { TicketRunAction, TicketRunStatus } from './types.ts'

// Per-ticket flow runner (PB-12). SERVER-ONLY: imports node:fs/path. Reached only
// from functions.ts handler bodies (PB-13) and tests — never from a client
// component (PB-1 client-bundle boundary). It persists board-owned run state under
// ~/.pipeline-board/runs/; it never writes ticket files (only a spawned flow does,
// from PB-15).
//
// Two-file model: one runs/<runId>.json per run (history accumulates — no retention
// in v1) plus an atomic runs/latest.json index mapping ticketRunKey → runId, so the
// latest run for a ticket resolves without scanning every run file. Mirrors sync.ts's
// atomic temp+rename writes, degrading reads, and stale→failed coercion, scoped to a
// single run (no workspaces[]): freshness is max(startedAt, updatedAt, finishedAt) —
// which is why the DTO carries updatedAt (sync leans on per-workspace stamps instead).

/** A `running` run with no activity newer than this reads as `failed` (so the control never locks).
 *  Sized generously for a long /feature:flow (plan+build+test) — ~3× sync's 15m; PB-15 confirms/tunes. */
export const RUN_STALE_MS = 45 * 60_000

// ── Keys & timestamps ────────────────────────────────────────────────────────

/**
 * Logical key identifying a ticket's run lineage: `Project::PARENT::CHILD` (epic
 * child) or `Project::TICKET` (solo). Used only as a JSON object-key inside
 * latest.json — never as a filename — so a project display-name containing odd
 * characters is harmless (no sanitization needed). parentEpicId is included only
 * when present, so a child and a same-leaf-id solo never share an index entry.
 */
export function ticketRunKey(projectName: string, ticketId: string, parentEpicId?: string): string {
  return [projectName, parentEpicId, ticketId].filter((s): s is string => Boolean(s)).join('::')
}

function nowIso(): string {
  return new Date().toISOString()
}

// ── Predicates ───────────────────────────────────────────────────────────────

export function isTicketRunAction(v: unknown): v is TicketRunAction {
  return v === 'flow'
}

/** Shape guard mirroring sync's isSyncRunStatus — note the terminal vocabulary is `succeeded`, not `done`. */
export function isTicketRunStatus(x: unknown): x is TicketRunStatus {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return (
    typeof o.runId === 'string' &&
    typeof o.projectName === 'string' &&
    typeof o.ticketId === 'string' &&
    (o.parentEpicId === undefined || typeof o.parentEpicId === 'string') &&
    isTicketRunAction(o.action) &&
    typeof o.dryRun === 'boolean' &&
    typeof o.createPr === 'boolean' &&
    (o.status === 'running' || o.status === 'succeeded' || o.status === 'failed') &&
    typeof o.startedAt === 'string' &&
    typeof o.updatedAt === 'string' &&
    (o.finishedAt === null || typeof o.finishedAt === 'string')
  )
}

/** True while a run is genuinely active (operates on a read/coerced status). */
export function isTicketRunRunning(status: TicketRunStatus | null): boolean {
  return status?.status === 'running'
}

// ── Staleness ────────────────────────────────────────────────────────────────

/** Most recent activity across the run — NOT startedAt alone, since a long run is legitimate
 *  (the orchestrator bumps updatedAt on progress). */
function lastActivityMs(status: TicketRunStatus): number {
  let max = 0
  for (const s of [status.startedAt, status.updatedAt, status.finishedAt]) {
    if (!s) continue
    const t = Date.parse(s)
    if (!Number.isNaN(t) && t > max) max = t
  }
  return max
}

function isStale(status: TicketRunStatus): boolean {
  return Date.now() - lastActivityMs(status) > RUN_STALE_MS
}

/** A stale `running` run is presented as `failed` so the UI/start-guard never locks. */
function coerceStale(status: TicketRunStatus): TicketRunStatus {
  return {
    ...status,
    status: 'failed',
    finishedAt: status.finishedAt ?? nowIso(),
    error: status.error ?? 'run did not complete (stale)',
  }
}

// ── Paths & atomic writes ────────────────────────────────────────────────────

function runsDir(): string {
  return join(configDir(), 'runs')
}

function runStatusFile(runId: string): string {
  return join(runsDir(), `${runId}.json`)
}

function latestFile(): string {
  return join(runsDir(), 'latest.json')
}

interface LatestIndex {
  byTicket: Record<string, string>
}

/** Atomic write (temp + rename), mirroring sync.writeStatus / config.saveProjects, so a 5s poll
 *  never reads a torn file. The temp lives in the same dir as its target, so the rename is atomic. */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(runsDir(), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, file) // atomic replace
}

/** Read the latest.json index, degrading a missing/corrupt/wrong-shape file to an empty index
 *  (the index is a derived pointer — losing it just means "no latest run", never a crash). */
async function readLatestIndex(): Promise<LatestIndex> {
  let text: string
  try {
    text = await fs.readFile(latestFile(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { byTicket: {} }
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { byTicket: {} } // corrupt index → degrade to empty
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as Record<string, unknown>).byTicket === 'object' &&
    (parsed as Record<string, unknown>).byTicket !== null
  ) {
    return parsed as LatestIndex
  }
  return { byTicket: {} }
}

/**
 * Persist a run's status: write the per-run file (runs/<runId>.json) atomically,
 * then upsert the latest.json index so this run becomes the ticket's latest. Run
 * file first, then index — so the index never points at a not-yet-written run.
 */
export async function writeTicketRunStatus(status: TicketRunStatus): Promise<void> {
  await writeJsonAtomic(runStatusFile(status.runId), status)
  const index = await readLatestIndex()
  index.byTicket[ticketRunKey(status.projectName, status.ticketId, status.parentEpicId)] = status.runId
  await writeJsonAtomic(latestFile(), index)
}

/**
 * Read one run's status by runId. Degrades like sync.readSyncStatus: missing
 * (ENOENT) → null, corrupt → null, wrong-shape → null; a stale `running` is
 * coerced to `failed` before returning. Single degrade+coerce path (readLatest
 * delegates here).
 */
export async function readTicketRunStatus(runId: string): Promise<TicketRunStatus | null> {
  let text: string
  try {
    text = await fs.readFile(runStatusFile(runId), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null // corrupt — treat as no status rather than crash the poll
  }
  if (!isTicketRunStatus(parsed)) return null
  if (parsed.status === 'running' && isStale(parsed)) return coerceStale(parsed)
  return parsed
}

/**
 * Resolve a ticket's latest run via the index (key → runId → run file). Returns
 * null when the ticket has no runs, or when the index/run file is missing/corrupt.
 * Inherits readTicketRunStatus's degrade + stale-coercion.
 */
export async function readLatestTicketRun(
  projectName: string,
  ticketId: string,
  parentEpicId?: string,
): Promise<TicketRunStatus | null> {
  const index = await readLatestIndex()
  const runId = index.byTicket[ticketRunKey(projectName, ticketId, parentEpicId)]
  // Guard non-string too: readLatestIndex only shape-checks `byTicket` is an object,
  // so a corrupt index could hold a non-string value — keep the degrade contract airtight.
  if (typeof runId !== 'string' || !runId) return null
  return readTicketRunStatus(runId)
}
