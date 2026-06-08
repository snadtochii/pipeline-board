import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { configDir, loadProjects } from './config.ts'
import type {
  Project,
  SyncOutcome,
  SyncRunStatus,
  SyncWorkspaceStatus,
} from './types.ts'

// Cross-workspace sync orchestrator (PB-6). SERVER-ONLY: imports node:child_process
// and node:fs. Reached only from functions.ts handler bodies and the thin CLI in
// scripts/sync-all.ts — never from a client component (PB-1 client-bundle boundary).
//
// It spawns the canonical `/feature:sync` skill headlessly in each configured
// workspace; it does NOT reimplement sync's reconciliation logic. The app's only
// write is its own ~/.pipeline-board/last-sync.json status file (atomic); the only
// thing that mutates ticket files is `claude` running /feature:sync.

/** Least-privilege allowlist — exactly what /feature:sync uses (validated 2026-06-08). */
export const ALLOWED_TOOLS = [
  'Bash(gh:*)',
  'Bash(git:*)',
  'Bash(mv:*)',
  'Bash(command:*)',
  'Edit',
  'Read',
  'Glob',
  'Grep',
  'TodoWrite',
] as const

/** A `running` status with no activity newer than this reads as `failed` (control never locks). */
export const SYNC_STALE_MS = 15 * 60_000
/** Per-workspace `claude` run cap; a hung run is killed so it can't wedge the sweep. (≤ staleness.) */
export const SYNC_RUN_TIMEOUT_MS = 10 * 60_000
/** How much of a run's output to retain as a parse-failure fallback. */
const RAW_REPORT_TAIL = 2000
/** Cap on live stdout/stderr capture so a pathologically chatty run can't balloon memory.
 *  The grouped report lives at the end, so we keep the tail. */
const MAX_CAPTURE = 64 * 1024

/** Optional progress sink — the CLI prints from it; the server fn omits it (polls the file instead). */
export interface SyncRunReporter {
  runStart?: (projectCount: number) => void
  workspaceStart?: (ws: SyncWorkspaceStatus, index: number, total: number) => void
  workspaceEnd?: (
    ws: SyncWorkspaceStatus,
    index: number,
    total: number,
    rawReport: string,
  ) => void
  runEnd?: (status: SyncRunStatus) => void
}

function statusFile(): string {
  return join(configDir(), 'last-sync.json')
}

function nowIso(): string {
  return new Date().toISOString()
}

function makeRunId(): string {
  return `sync-${nowIso().replace(/[:.]/g, '-')}`
}

function tail(text: string, n = RAW_REPORT_TAIL): string {
  return text.length > n ? text.slice(-n) : text
}

// ── Status file I/O ──────────────────────────────────────────────────────────

/** Atomic write (temp + rename), mirroring config.ts saveProjects so a 5s poll never reads a torn file. */
export async function writeStatus(status: SyncRunStatus): Promise<void> {
  const dir = configDir()
  await fs.mkdir(dir, { recursive: true })
  const tmp = join(dir, `last-sync.json.tmp-${process.pid}`)
  await fs.writeFile(tmp, JSON.stringify(status, null, 2), 'utf8')
  await fs.rename(tmp, statusFile()) // atomic replace
}

function isSyncRunStatus(x: unknown): x is SyncRunStatus {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return (
    typeof o.runId === 'string' &&
    typeof o.startedAt === 'string' &&
    (o.finishedAt === null || typeof o.finishedAt === 'string') &&
    (o.status === 'running' || o.status === 'done' || o.status === 'failed') &&
    Array.isArray(o.workspaces)
  )
}

/** Most recent activity across the run, used for staleness (NOT run.startedAt — a long single-workspace run is legitimate). */
function lastActivityMs(status: SyncRunStatus): number {
  const stamps = [status.startedAt]
  for (const w of status.workspaces) {
    if (w.startedAt) stamps.push(w.startedAt)
    if (w.finishedAt) stamps.push(w.finishedAt)
  }
  let max = 0
  for (const s of stamps) {
    const t = Date.parse(s)
    if (!Number.isNaN(t) && t > max) max = t
  }
  return max
}

function isStale(status: SyncRunStatus): boolean {
  return Date.now() - lastActivityMs(status) > SYNC_STALE_MS
}

/** A stale `running` run is presented as `failed` (and its unfinished workspaces too) so the UI never locks. */
function coerceStale(status: SyncRunStatus): SyncRunStatus {
  return {
    ...status,
    status: 'failed',
    workspaces: status.workspaces.map((w) =>
      w.state === 'pending' || w.state === 'running'
        ? { ...w, state: 'failed' as const, error: w.error ?? 'run did not complete (stale)' }
        : w,
    ),
  }
}

/** True while a run is genuinely active (operates on a read/coerced status). */
export function isSyncRunning(status: SyncRunStatus | null): boolean {
  return status?.status === 'running'
}

/**
 * Read last-sync.json. Degrades like config.ts loadProjects: missing → null
 * ("never synced"), corrupt/wrong-shape → null. A stale `running` is coerced to
 * `failed` before returning.
 */
export async function readSyncStatus(): Promise<SyncRunStatus | null> {
  let text: string
  try {
    text = await fs.readFile(statusFile(), 'utf8')
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
  if (!isSyncRunStatus(parsed)) return null
  if (parsed.status === 'running' && isStale(parsed)) return coerceStale(parsed)
  return parsed
}

// ── Report parsing ───────────────────────────────────────────────────────────

function matchCount(text: string, re: RegExp): number | null {
  const m = text.match(re)
  if (!m || m[1] === undefined) return null
  const n = Number.parseInt(m[1], 10)
  return Number.isNaN(n) ? null : n
}

/**
 * Best-effort parse of /feature:sync's grouped report
 * (`✓ Promoted … (n)`, `… Still open (n)`, `⚠ … needs attention (n)`, `? couldn't check (n)`).
 * Missing group → 0. Returns null only when the text doesn't look like a sync report at all
 * (caller keeps the raw tail + exit code as the fallback).
 */
export function parseSyncReport(text: string): SyncOutcome | null {
  if (!text || !text.trim()) return null
  const promoted = matchCount(text, /promoted[^\n(]*\((\d+)\)/i)
  const open = matchCount(text, /still open[^\n(]*\((\d+)\)/i)
  const needsAttention = matchCount(text, /needs?\s+attention[^\n(]*\((\d+)\)/i)
  const couldntCheck = matchCount(text, /(?:couldn['’]t|could\s+not)\s+check[^\n(]*\((\d+)\)/i)
  const anyGroup =
    promoted !== null || open !== null || needsAttention !== null || couldntCheck !== null
  const looksLikeReport = anyGroup || /in[-\s]review/i.test(text) || /\bsync\b/i.test(text)
  if (!looksLikeReport) return null
  return {
    promoted: promoted ?? 0,
    open: open ?? 0,
    needsAttention: needsAttention ?? 0,
    couldntCheck: couldntCheck ?? 0,
  }
}

// ── Spawning claude ──────────────────────────────────────────────────────────

interface SpawnResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  spawnError?: Error
}

function spawnSync(project: Project): Promise<SpawnResult> {
  const args = ['-p', '/feature:sync', '--allowedTools', ...ALLOWED_TOOLS]
  const model = process.env.CLAUDE_MODEL
  if (model && model.trim()) args.push('--model', model.trim())

  return new Promise<SpawnResult>((resolve) => {
    const child = spawn('claude', args, {
      cwd: project.path,
      stdio: ['ignore', 'pipe', 'pipe'], // ignore stdin (= </dev/null); capture stdout/stderr
      timeout: SYNC_RUN_TIMEOUT_MS,
      killSignal: 'SIGTERM',
      // env defaults to process.env so PATH is inherited and `claude` resolves.
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
      if (stdout.length > MAX_CAPTURE) stdout = stdout.slice(-MAX_CAPTURE)
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > MAX_CAPTURE) stderr = stderr.slice(-MAX_CAPTURE)
    })
    child.on('error', (err) => {
      // e.g. ENOENT when `claude` isn't on PATH — never throws, surfaces as a failed workspace.
      resolve({ code: null, signal: null, stdout, stderr, spawnError: err })
    })
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr })
    })
  })
}

/** Run /feature:sync in one workspace and classify the result onto the workspace status. */
async function runWorkspace(
  base: SyncWorkspaceStatus,
): Promise<{ ws: SyncWorkspaceStatus; rawReport: string }> {
  const startedAt = nowIso()
  // Pre-flight: directory + feature-pipeline shape. Recorded as failed, not silently skipped.
  try {
    const dirStat = await fs.stat(base.path)
    if (!dirStat.isDirectory()) {
      return fail(base, startedAt, 'path is not a directory')
    }
  } catch {
    return fail(base, startedAt, 'directory not found')
  }
  try {
    await fs.stat(join(base.path, 'claudedocs', 'tickets'))
  } catch {
    return fail(base, startedAt, 'no claudedocs/tickets/ (not a feature-pipeline workspace)')
  }

  const r = await spawnSync({ name: base.name, path: base.path })
  const finishedAt = nowIso()
  const raw = tail(r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : ''))

  if (r.spawnError) {
    const why =
      (r.spawnError as NodeJS.ErrnoException).code === 'ENOENT'
        ? "'claude' CLI not found on PATH"
        : `spawn failed: ${r.spawnError.message}`
    return finalize(base, startedAt, finishedAt, 'failed', null, raw, why)
  }
  if (r.code === 0) {
    const outcome = parseSyncReport(r.stdout)
    return finalize(base, startedAt, finishedAt, 'done', outcome, raw)
  }
  if (r.code === null && r.signal) {
    return finalize(
      base,
      startedAt,
      finishedAt,
      'failed',
      null,
      raw,
      `killed (${r.signal}) — likely timed out after ${Math.round(SYNC_RUN_TIMEOUT_MS / 60_000)}m`,
    )
  }
  return finalize(base, startedAt, finishedAt, 'failed', null, raw, `sync exited with code ${r.code}`)
}

function fail(
  base: SyncWorkspaceStatus,
  startedAt: string,
  error: string,
): { ws: SyncWorkspaceStatus; rawReport: string } {
  return {
    ws: { ...base, state: 'failed', startedAt, finishedAt: nowIso(), outcome: null, error },
    rawReport: '',
  }
}

function finalize(
  base: SyncWorkspaceStatus,
  startedAt: string,
  finishedAt: string,
  state: 'done' | 'failed',
  outcome: SyncOutcome | null,
  fullRaw: string,
  error?: string,
): { ws: SyncWorkspaceStatus; rawReport: string } {
  const ws: SyncWorkspaceStatus = { ...base, state, startedAt, finishedAt, outcome }
  if (error) ws.error = error
  // Persist raw text in the status file only when it adds info (a failure, or a
  // success we couldn't parse). The reporter always receives the full text.
  if ((state === 'failed' || !outcome) && fullRaw) ws.rawReport = fullRaw
  return { ws, rawReport: fullRaw }
}

// ── Orchestration ──────────────────────────────────────────────────────────

function seedStatus(projects: Project[]): SyncRunStatus {
  return {
    runId: makeRunId(),
    startedAt: nowIso(),
    finishedAt: null,
    status: 'running',
    workspaces: projects.map((p) => ({
      name: p.name,
      path: p.path,
      state: 'pending',
      startedAt: null,
      finishedAt: null,
      outcome: null,
    })),
  }
}

/**
 * Run /feature:sync across every configured workspace, sequentially, writing
 * last-sync.json at each boundary (seed pending → running → done/failed) so the
 * board's 5s poll shows truthful progress. Always writes a terminal status, even
 * on an unexpected throw. Per-workspace failures are isolated — one never aborts
 * the rest.
 *
 * `options.seeded` lets the server fn pre-seed the status synchronously (for the
 * concurrency guard) and hand the same run in; the CLI omits it and self-seeds.
 */
export async function runSyncAll(options?: {
  reporter?: SyncRunReporter
  seeded?: SyncRunStatus
}): Promise<SyncRunStatus> {
  const reporter = options?.reporter
  let status: SyncRunStatus
  if (options?.seeded) {
    status = options.seeded
  } else {
    const projects = await loadProjects()
    status = seedStatus(projects)
    await writeStatus(status)
  }
  reporter?.runStart?.(status.workspaces.length)

  try {
    const total = status.workspaces.length
    for (let i = 0; i < total; i++) {
      const base = status.workspaces[i]
      if (!base) continue
      // → running
      const runningWs: SyncWorkspaceStatus = { ...base, state: 'running', startedAt: nowIso() }
      status = { ...status, workspaces: replaceAt(status.workspaces, i, runningWs) }
      await writeStatus(status)
      reporter?.workspaceStart?.(runningWs, i, total)

      // run
      const { ws, rawReport } = await runWorkspace(runningWs)
      status = { ...status, workspaces: replaceAt(status.workspaces, i, ws) }
      await writeStatus(status)
      reporter?.workspaceEnd?.(ws, i, total, rawReport)
    }
    status = { ...status, status: 'done', finishedAt: nowIso() }
    await writeStatus(status)
  } catch (err) {
    // Defensive: never leave the run — or an in-flight workspace — wedged at `running`.
    status = {
      ...status,
      status: 'failed',
      finishedAt: nowIso(),
      workspaces: status.workspaces.map((w): SyncWorkspaceStatus =>
        w.state === 'pending' || w.state === 'running'
          ? {
              ...w,
              state: 'failed',
              finishedAt: w.finishedAt ?? nowIso(),
              error: w.error ?? 'run aborted unexpectedly',
            }
          : w,
      ),
    }
    try {
      await writeStatus(status)
    } catch {
      // best effort — staleness guard is the backstop
    }
    void err
  }

  reporter?.runEnd?.(status)
  return status
}

function replaceAt<T>(arr: T[], i: number, value: T): T[] {
  const next = arr.slice()
  next[i] = value
  return next
}

/**
 * Guarded, non-blocking start used by the startSync server fn. Rejects a second
 * run while one is active; otherwise seeds `running` synchronously (so an
 * immediate re-poll sees the lock) and fires the sweep without awaiting it.
 */
export async function startGuardedRun(): Promise<{ started: boolean; reason?: string }> {
  const current = await readSyncStatus()
  if (isSyncRunning(current)) return { started: false, reason: 'already-running' }

  const projects = await loadProjects()
  const seeded = seedStatus(projects)
  await writeStatus(seeded) // synchronous guard: status === 'running' on disk before we return
  // Fire-and-forget: runs on the persistent node-server process; writes its own terminal status.
  void runSyncAll({ seeded }).catch(() => {
    /* runSyncAll already persists a terminal status on throw */
  })
  return { started: true }
}
