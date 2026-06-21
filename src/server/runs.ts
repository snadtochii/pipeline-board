import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { configDir } from './config.ts'
import { isSafeSegment } from './scanner.ts'
import { TICKET_ID_RE } from './types.ts'
import type { Project, TicketRunAction, TicketRunStatus } from './types.ts'

// Per-ticket flow runner (PB-12/PB-13/PB-15). SERVER-ONLY: imports node:fs/path and
// (PB-15) node:child_process. Reached only from functions.ts handler bodies (PB-13)
// and tests — never from a client component (PB-1 client-bundle boundary). It
// persists board-owned run state under ~/.pipeline-board/runs/; it never writes
// ticket files itself — only the spawned /feature:flow (PB-15, env-gated) does.
//
// Two-file model: one runs/<runId>.json per run (history accumulates — no retention
// in v1) plus an atomic runs/latest.json index mapping ticketRunKey → runId, so the
// latest run for a ticket resolves without scanning every run file. Mirrors sync.ts's
// atomic temp+rename writes, degrading reads, and stale→failed coercion, scoped to a
// single run (no workspaces[]): freshness is max(startedAt, updatedAt, finishedAt) —
// which is why the DTO carries updatedAt (sync leans on per-workspace stamps instead).

/** A `running` run with no activity newer than this reads as `failed` (so the control never locks).
 *  Sized generously for a long /feature:flow (plan+build+test) — ~3× sync's 15m. */
export const RUN_STALE_MS = 45 * 60_000

/** Per-spawn `claude` kill cap (SIGTERM). Sized for a full plan+build+test+PR flow — much larger
 *  than sync's mechanical 10m. Deliberately `< RUN_STALE_MS` so the spawn-level timeout fires
 *  *before* the staleness backstop: a genuinely-hung child is killed and classified `failed
 *  (timeout)` rather than left for coercion. (PB-15) */
export const RUN_TIMEOUT_MS = 40 * 60_000

/**
 * The runner's OWN least-privilege allowlist for the spawned `/feature:flow --pr`. Broader than
 * sync's (sync is mechanical) because flow runs plan + build: writes ticket artifacts, MOVES the
 * ticket folder between state dirs at each transition, runs the project's validation
 * (typecheck/test/build via npm), spawns reviewer/ui-tester subagents (Task), invokes plan/build
 * (Skill), and opens a PR (git/gh). Resolved against the current flow + build SKILL.md
 * `allowed-tools`, build/references/pr-creation.md, and flow/references/state-transitions.md (2026-06-21):
 *   - flow needs:  Read, Glob, Grep, TodoWrite, Skill
 *   - build needs: Read, Write, Edit, Glob, Grep, Bash, Task, TodoWrite
 *   - state transitions: Bash(mv:*) — every transition does a plain `mv` of the ticket folder
 *     between backlog/in-progress/review/done. Because `claudedocs/` is git-ignored in this repo
 *     (and typically in the consumer), `git mv` refuses the ignored path, so the move is plain `mv`.
 *     Sync grants `Bash(mv:*)` for the same reason. WITHOUT this, the first folder move under
 *     headless `claude -p` (no TTY, no `--dangerously-skip-permissions`) is denied and the run stalls.
 *   - pr-creation: Bash(git:*) (fetch/checkout/stash/commit/push), Bash(gh:*) (auth/pr create/view/list),
 *                  Bash(command:*) (`command -v gh`)
 *   - this repo's validation: npm run typecheck / npm test / npm run build → Bash(npm:*)
 * Bash is SCOPED (git/gh/npm/mv/command), never unscoped — least privilege on the riskiest surface.
 * `AskUserQuestion` is deliberately OMITTED: headless `-p` has no TTY, so a nested interactive branch
 * (e.g. pr-creation's detached-HEAD prompt) fails fast → `failed`, rather than hanging to the timeout.
 * NEVER emit `--dangerously-skip-permissions`.
 */
export const ALLOWED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'TodoWrite',
  'Task',
  'Skill',
  'Bash(git:*)',
  'Bash(gh:*)',
  'Bash(npm:*)',
  'Bash(mv:*)',
  'Bash(command:*)',
] as const

/** Default model for the spawned flow run. Unlike sync (mechanical → Sonnet), flow does design-heavy
 *  plan + build reasoning, so it defaults to a capable tier; `CLAUDE_MODEL` overrides it. (PB-15) */
const DEFAULT_FLOW_MODEL = 'opus'

/** Cap on captured stdout/stderr so a chatty flow can't balloon memory; the report tail is what matters. */
const MAX_CAPTURE = 64 * 1024
/** How much of a run's output to retain in logTail (parse-failure fallback + general visibility). */
const RAW_REPORT_TAIL = 2000

// TICKET_ID_RE (the strict id gate used in buildFlowArgs before interpolation) is the canonical copy
// imported from ./types.ts — declared once there so functions.ts, runs.ts, and the client share it.

function tail(text: string, n = RAW_REPORT_TAIL): string {
  return text.length > n ? text.slice(-n) : text
}

// ── Keys & timestamps ────────────────────────────────────────────────────────

/**
 * Logical key identifying a ticket's run lineage: `Project::PARENT::CHILD` (epic
 * child) or `Project::TICKET` (solo). Used only as a JSON object-key inside
 * latest.json — never as a filename. Each segment is percent-encoded before the
 * `::` join, so the separator can never occur *inside* a segment: a project
 * display-name containing `::` (names are user-supplied via addProject) can't make
 * a solo collide with a child. parentEpicId is included only when present.
 */
export function ticketRunKey(projectName: string, ticketId: string, parentEpicId?: string): string {
  return [projectName, parentEpicId, ticketId]
    .filter((s): s is string => Boolean(s))
    .map(encodeURIComponent)
    .join('::')
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * A unique run id used as the runs/<runId>.json filename. Timestamp for human
 * sortability PLUS a randomUUID slice for collision resistance: unlike sync's
 * single global sweep, two runs for *different* tickets can start in the same
 * millisecond, and a bare timestamp would make them overwrite each other in the
 * index (PB-12 carry-forward). The `:`/`.` of the ISO stamp are replaced so the
 * id is path-safe.
 */
export function makeRunId(): string {
  return `run-${nowIso().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
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
    (o.status === 'running' ||
      o.status === 'succeeded' ||
      o.status === 'failed' ||
      o.status === 'needs-human') &&
    typeof o.startedAt === 'string' &&
    typeof o.updatedAt === 'string' &&
    (o.finishedAt === null || typeof o.finishedAt === 'string') &&
    (o.prUrl === undefined || typeof o.prUrl === 'string') &&
    (o.logTail === undefined || typeof o.logTail === 'string') &&
    (o.error === undefined || typeof o.error === 'string')
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

/** Monotonic per-process counter: two concurrent writes to the SAME target file must get distinct
 *  temp paths — a pid-only suffix collides (both rename the same temp → one throws ENOENT). */
let tmpSeq = 0

/** Atomic write (temp + rename), mirroring sync.writeStatus / config.saveProjects, so a 5s poll
 *  never reads a torn file. The temp lives in the same dir as its target (so the rename is atomic)
 *  and carries a unique pid+seq suffix (so concurrent same-target writes can't collide). */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(runsDir(), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${tmpSeq++}`
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

// Serialize the latest.json read-modify-write so concurrent writers (different tickets) don't lose
// each other's entries to an interleaved RMW (A reads, B reads+writes, A writes stale → B dropped).
// A single persistent Node server makes an in-process promise-chain mutex sufficient.
let indexChain: Promise<unknown> = Promise.resolve()

function updateLatestIndex(key: string, runId: string): Promise<void> {
  const next = indexChain.then(async () => {
    const index = await readLatestIndex()
    index.byTicket[key] = runId
    await writeJsonAtomic(latestFile(), index)
  })
  // Keep the chain alive even if one update rejects, so a single failure can't wedge the mutex.
  indexChain = next.catch(() => {})
  return next
}

/**
 * Persist a run's status: write the per-run file (runs/<runId>.json) atomically,
 * then upsert the latest.json index so this run becomes the ticket's latest. Run
 * file first, then index — so the index never points at a not-yet-written run. The
 * index upsert is serialized (updateLatestIndex), so concurrent writers for
 * different tickets can't lose each other's entries or collide on the temp file.
 */
export async function writeTicketRunStatus(status: TicketRunStatus): Promise<void> {
  await writeJsonAtomic(runStatusFile(status.runId), status)
  await updateLatestIndex(
    ticketRunKey(status.projectName, status.ticketId, status.parentEpicId),
    status.runId,
  )
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

/**
 * Find an active *real* (live, non-dry, non-stale) flow run anywhere in a project — the substrate for
 * PB-15's per-project lock (before worktrees, two real flows in the same repo would race). The
 * per-ticket `latest.json` index is keyed `Project::PARENT::CHILD` with percent-encoded segments, so
 * the project name is the first `::`-segment: a key belongs to this project iff it starts with
 * `encodeURIComponent(projectName) + '::'` (the `::` separator can never occur inside an encoded
 * segment, so the prefix test is exact). Each candidate runId is resolved via readTicketRunStatus,
 * which coerces a stale `running` to `failed` for free — so a crashed run never wedges the project
 * lock. Only `running && dryRun === false` runs count (dry runs are instantaneous + side-effect-free,
 * so they take only the per-ticket guard). Returns the first such run, or null.
 *
 * Reads the compact index once + one status file per project ticket (latest-only, not full history),
 * and only on a live start — the default dry-run path never calls this, so it adds zero I/O over PB-13.
 */
async function findActiveRealRunForProject(projectName: string): Promise<TicketRunStatus | null> {
  const index = await readLatestIndex()
  const prefix = `${encodeURIComponent(projectName)}::`
  for (const [key, runId] of Object.entries(index.byTicket)) {
    if (!key.startsWith(prefix)) continue
    if (typeof runId !== 'string' || !runId) continue // corrupt-index degrade contract
    const status = await readTicketRunStatus(runId)
    if (isTicketRunRunning(status) && status?.dryRun === false) return status
  }
  return null
}

// ── Flow adapter (build args · report parse · spawn) ──────────────────────────
// SERVER-ONLY spawn machinery, cloned from sync.ts's buildSyncArgs/spawnSync/
// parseSyncReport. Reached only from startGuardedTicketRun (a handler-body export),
// never from the client bundle.

/**
 * Build the `claude -p` argument vector for a real `/feature:flow <id> [--pr] --no-ui-testing` run.
 * Pure + exported so the vector shape (allowlist, model, --pr, --no-ui-testing, no
 * `--dangerously-skip-permissions`) is unit-tested WITHOUT spawning. Mirrors sync.ts buildSyncArgs.
 *
 * `--no-ui-testing` (feature-pipeline FP-19) is passed UNCONDITIONALLY — not gated by `createPr` —
 * because a headless `claude -p` can never get the interactive browser-MCP permission the build's
 * ui-tester checkpoint needs, regardless of whether a PR is requested (PB-16 stalled ~10m at exactly
 * that gate). Flow forwards the flag to build, which skips only the browser/ui-tester portion of the
 * test checkpoint; typecheck/test still run and still gate the verdict. Browser-level
 * acceptance-criteria verification is deferred to a human at PR review. For a non-UI ticket the flag
 * is a no-op — build skips ui-tester anyway. It is a slash-command argument, NOT a tool grant, so it
 * goes in the command string and `ALLOWED_TOOLS` stays untouched (no browser MCP tools).
 *
 * `ticketId` is rejected (throws — no args produced) if it fails the safe-segment + strict
 * `TICKET_ID_RE` guard, BEFORE it can be interpolated into the slash command. This is
 * defense-in-depth on top of the startTicketRun server-fn validator's regex gate.
 * The model defaults to DEFAULT_FLOW_MODEL; a non-empty `options.model` (the caller passes
 * `process.env.CLAUDE_MODEL`) overrides it.
 */
export function buildFlowArgs(
  ticketId: string,
  options?: { createPr?: boolean; model?: string },
): string[] {
  if (!isSafeSegment(ticketId) || !TICKET_ID_RE.test(ticketId)) {
    throw new Error(`Unsafe or invalid ticketId for flow command: ${ticketId}`)
  }
  const createPr = options?.createPr ?? true
  const command = `/feature:flow ${ticketId}${createPr ? ' --pr' : ''} --no-ui-testing`
  const m = options?.model && options.model.trim() ? options.model.trim() : DEFAULT_FLOW_MODEL
  return ['-p', command, '--allowedTools', ...ALLOWED_TOOLS, '--model', m]
}

/**
 * Best-effort parse of a GitHub PR URL from flow/build's report (build's pr-creation.md prints
 * `✅ PR opened: <url>`). Returns the first match, or null when none is present (a `--pr` run that
 * degraded to a local commit is a legitimate no-URL success — the caller keeps the raw tail in
 * logTail as the fallback). Pure + exported, unit-tested. Mirrors sync.ts parseSyncReport's
 * null-on-no-match contract.
 */
export function parseFlowReport(text: string): string | null {
  if (!text) return null
  const m = text.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/)
  return m ? m[0] : null
}

/**
 * Classify a code-0 flow result. A `createPr` run that exited 0 but produced no parseable PR URL is
 * `needs-human`, NOT a false `succeeded` — exit 0 with no PR most often means the headless flow
 * stalled on an interactive gate (e.g. build's browser-verification prompt) and gave up. A parsed
 * URL is `succeeded` (+prUrl); a run that never requested a PR has no missing artifact, so no-URL is
 * a legitimate `succeeded`. Pure + exported so the classification is unit-testable without spawning
 * `claude` (runRealFlow's branch is unreachable in tests). The explanatory note rides `error` (the
 * DetailPanel tooltip surfaces it first); finish() keeps the raw captured tail in logTail.
 */
export function classifyCode0(
  prUrl: string | undefined,
  createPr: boolean,
): { status: 'succeeded' | 'needs-human'; prUrl?: string; error?: string } {
  if (prUrl) return { status: 'succeeded', prUrl }
  if (createPr) {
    return {
      status: 'needs-human',
      error: 'flow exited 0 but produced no PR — likely blocked on an interactive gate',
    }
  }
  return { status: 'succeeded' }
}

interface SpawnResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  spawnError?: Error
}

/**
 * Spawn `claude -p "/feature:flow <id> [--pr]"` in the project's cwd. Clone of sync.ts spawnSync:
 * ignores stdin, captures stdout/stderr with a MAX_CAPTURE tail cap, NEVER throws
 * (`child.on('error')` → `spawnError`, e.g. ENOENT when `claude` isn't on PATH), and the spawn-level
 * `timeout` SIGTERMs a hung run. Internal — only buildFlowArgs is unit-tested; the spawn itself is
 * exercised manually under PB-RUN-6. Inherits process.env so PATH resolves `claude` and the child
 * sees CLAUDE_MODEL / PIPELINE_BOARD_ENABLE_RUNS.
 */
function spawnFlow(project: Project, ticketId: string, createPr: boolean): Promise<SpawnResult> {
  const args = buildFlowArgs(ticketId, { createPr, model: process.env.CLAUDE_MODEL })

  return new Promise<SpawnResult>((resolve) => {
    const child = spawn('claude', args, {
      cwd: project.path,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: RUN_TIMEOUT_MS,
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
      // e.g. ENOENT when `claude` isn't on PATH — never throws, surfaces as a failed run.
      resolve({ code: null, signal: null, stdout, stderr, spawnError: err })
    })
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr })
    })
  })
}

// ── Git isolation (PB-19) ─────────────────────────────────────────────────────
// SERVER-ONLY plain-git machinery, cloned from spawnFlow's never-throw spawn shape.
// Reached only from startGuardedTicketRun (clean-tree gate) and runRealFlow (branch
// isolate/restore) — both handler-body exports, never the client bundle. The board's
// OWN git invocations (vs the `claude` allowlist, which governs the spawned flow): a
// live run forks a dedicated `pb-run/<runId>` branch off the default branch before
// spawning flow, so its work never lands on main/the user's branch (PB-16 stranding),
// and on every terminal path the original branch + a clean tree are restored, with
// partial work committed to the run branch — never left uncommitted on the user's branch.

/** Per-git-command kill cap. Git plumbing is fast; sized generously so a slow disk/large
 *  repo can't trip it, yet bounded so a wedged git can never hang the runner. */
const GIT_TIMEOUT_MS = 60_000

interface GitResult {
  code: number | null
  stdout: string
  stderr: string
  spawnError?: Error
}

/**
 * Run one `git` command in `cwd` and capture exit code + trimmed stdout/stderr. Clone of spawnFlow's
 * never-throw shape: ignores stdin, resolves on `close`/`error` (ENOENT → `spawnError`, e.g. `git`
 * not on PATH), and a `timeout` SIGTERMs a wedged command. Args are passed as an array (no shell),
 * so no untrusted string is ever interpolated into a command line — there is no injection surface.
 * Internal — the higher-level helpers built on it are what tests exercise (against temp repos).
 */
function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise<GitResult>((resolve) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    })
    // Cap capture like spawnFlow — git plumbing output is tiny, but a pathological repo (huge
    // status) shouldn't balloon memory; the trailing tail is what callers ever read.
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
      resolve({ code: null, stdout, stderr, spawnError: err })
    })
    child.on('close', (code) => {
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

/**
 * The short default-branch name to fork a run branch from. Mirrors feature-pipeline's own
 * pr-creation.md §1 base detection (`git symbolic-ref --short refs/remotes/origin/HEAD` → strip the
 * `origin/` prefix), so the runner's fork point aligns with the base flow opens its PR against.
 * Falls back to `'main'` when `origin/HEAD` isn't configured (local-only repo) — matching flow's
 * `|| echo main`. No `git fetch` first: the fork point only needs the local default ref; flow itself
 * fetches at PR time.
 */
export async function defaultBranch(cwd: string): Promise<string> {
  const r = await runGit(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (r.code === 0 && r.stdout) {
    return r.stdout.replace(/^origin\//, '')
  }
  return 'main'
}

/**
 * The ref to restore HEAD to after a run: the current branch name, or — when HEAD is detached —
 * the commit SHA, so a run that started in detached HEAD is still restored to exactly where it was.
 * Returns null only when git can't be queried at all (not a repo / `git` missing), letting callers
 * fail legibly rather than checkout an empty ref.
 */
export async function currentRef(cwd: string): Promise<string | null> {
  const branch = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch.code !== 0) return null
  if (branch.stdout && branch.stdout !== 'HEAD') return branch.stdout
  // Detached HEAD — restore by SHA so we land back on the exact commit.
  const sha = await runGit(cwd, ['rev-parse', 'HEAD'])
  if (sha.code === 0 && sha.stdout) return sha.stdout
  return null
}

/**
 * True iff the working tree is clean — `git status --porcelain` exits 0 with empty output.
 * `--porcelain` omits gitignored paths by default, so the ticket folder under gitignored
 * `claudedocs/` never counts as dirty and flow's mid-run folder moves never dirty the tree (AC1+AC4
 * are compatible only because of this). A non-repo / unqueryable tree is reported NOT clean, so a
 * live run there refuses to start with a clear reason rather than forking into a non-repo.
 */
export async function isTreeClean(cwd: string): Promise<boolean> {
  const r = await runGit(cwd, ['status', '--porcelain'])
  return r.code === 0 && r.stdout === ''
}

/**
 * The dedicated per-run branch name. Derived from the (server-generated, path-safe, unique) runId,
 * so two runs can never collide on the branch name (`git checkout -b` would fail on a dup). The
 * `pb-run/` prefix namespaces it away from user/flow branches.
 */
export function runBranchName(runId: string): string {
  return `pb-run/${runId}`
}

/**
 * Stage + commit any partial work onto the CURRENT branch (the run branch, or flow's own feature
 * branch if it forked further), then restore HEAD to `originalRef`. Best-effort and never throws:
 *  - `git add -A` provably excludes gitignored files, so `.env`/`node_modules`/`claudedocs/` are
 *    never committed (AC4 — they stay present + untouched in the tree). When `claudedocs/` is
 *    *tracked* (a consumer that doesn't gitignore it), exclude it explicitly so internal ticket
 *    bookkeeping isn't swept into the run commit (mirrors pr-creation.md §3).
 *  - "nothing to commit" is benign (a clean run / flow already committed) — skipped, not an error.
 *  - the restoring `git checkout <originalRef>` always runs; if it fails after a commit, the work is
 *    safe on the run branch — the caller surfaces the failure in the terminal status rather than
 *    silently leaving the user on the run branch.
 * Returns a human-readable note when something noteworthy happened (a failed restore), else null.
 * Exported for unit testing against an isolated temp repo (the live spawn path is manually verified).
 */
export async function preserveAndRestore(cwd: string, originalRef: string): Promise<string | null> {
  // Stage everything except gitignored paths; additionally drop a *tracked* claudedocs/ tree.
  const ignored = await runGit(cwd, ['check-ignore', '-q', 'claudedocs'])
  await runGit(cwd, ['add', '-A'])
  if (ignored.code !== 0) {
    // claudedocs/ is NOT gitignored (tracked in this repo) → unstage it so run commits stay clean.
    await runGit(cwd, ['reset', '-q', '--', 'claudedocs'])
  }
  // Commit partial work; "nothing to commit" exits non-zero and is benign. `--no-verify` so a
  // consumer repo's pre-commit hook can't block this mechanical preservation commit (which would
  // strand the work uncommitted before restore).
  await runGit(cwd, [
    'commit',
    '--no-verify',
    '-m',
    `pipeline-board run: partial work (${originalRef})`,
  ])
  // `--` end-of-options separator: defense-in-depth so an originalRef can never be parsed as a flag
  // (git already forbids leading-dash branch names, and the SHA path can't start with `-`).
  const restore = await runGit(cwd, ['checkout', originalRef, '--'])
  if (restore.code !== 0) {
    return `could not restore original branch ${originalRef}: ${restore.stderr || 'git checkout failed'} — partial work is preserved on the run branch`
  }
  return null
}

// ── Guarded start (orchestration) ─────────────────────────────────────────────

export interface StartTicketRunOptions {
  /** Whether the run requests a PR (`--pr`). Defaults to true (v1 always opens a PR). */
  createPr?: boolean
}

export interface StartTicketRunResult {
  started: boolean
  /**
   * Why a start was refused; absent on success. This helper emits `already-running`,
   * `project-busy` (live, a concurrent real flow in the repo), and `dirty-tree` (live,
   * the working tree has uncommitted changes — PB-19); the startTicketRun server fn adds
   * `unknown-project` and `ticket-not-found` from its boundary checks (shared single contract).
   */
  reason?: string
  /** The persisted status on a successful start (PB-14 renders it without a second poll). */
  status?: TicketRunStatus
}

/**
 * True only when the server was launched with `PIPELINE_BOARD_ENABLE_RUNS=1`. STRICT exact match —
 * any other value (unset, `'0'`, `'true'`, `'TRUE'`, `' 1 '`) reads as OFF, so accidental arming is
 * impossible and any ambiguity fails safe to a dry run (per the spec's default-off requirement).
 */
function realRunsEnabled(): boolean {
  return process.env.PIPELINE_BOARD_ENABLE_RUNS === '1'
}

/**
 * Guarded, per-ticket start used by the startTicketRun server fn.
 *
 * DEFAULT (env gate OFF — `PIPELINE_BOARD_ENABLE_RUNS` ≠ '1'): a DRY RUN exactly as in PB-13 — no
 * `claude` is spawned. Seed `running` (dryRun) synchronously → write `succeeded` with a log note →
 * both writes complete before returning (terminal-on-return).
 *
 * LIVE (env gate ON — PB-15): seed `running` (dryRun: false) synchronously, then fire `spawnFlow`
 * FIRE-AND-FORGET (a real flow is up to 40m — it must not be awaited; mirrors sync's startGuardedRun)
 * and return the seeded `running` status immediately. A `runRealFlow` continuation writes the terminal
 * status (succeeded + prUrl / failed + error) when the child closes; the board's 5s poll observes the
 * transition. `StartTicketRunResult` shape is identical in both branches.
 *
 * Locks (both fs-backed guards, not input validation — they live here, not at the server-fn boundary):
 *  - Per-ticket: refuse `already-running` if this ticket's latest run is still `running`.
 *  - Per-project (LIVE only): refuse `project-busy` if any OTHER real flow is active in this project
 *    (before worktrees, two real flows in one repo would race). Dry runs skip this — they're instant.
 *
 * KNOWN LIMITATION (carried from PB-13): the read-then-seed guard has a small TOCTOU window; the
 * per-project check widens it slightly (project-scope vs ticket-scope). Acceptable for a single-user,
 * local, user-initiated runner.
 *
 * Validation (input shape, ticket-id regex, safe-segment, project/ticket existence) belongs to the
 * server-fn boundary, NOT here — this helper stays unit-testable without the Start runtime.
 */
export async function startGuardedTicketRun(
  project: Project,
  ticketId: string,
  parentEpicId?: string,
  options?: StartTicketRunOptions,
): Promise<StartTicketRunResult> {
  const current = await readLatestTicketRun(project.name, ticketId, parentEpicId)
  if (isTicketRunRunning(current)) return { started: false, reason: 'already-running' }

  const live = realRunsEnabled()
  if (live) {
    // Per-project lock applies to REAL runs only — a concurrent real flow in the same repo would race.
    const busy = await findActiveRealRunForProject(project.name)
    if (busy) return { started: false, reason: 'project-busy' }
    // Clean-tree precondition (PB-19, live only): refuse to start unless the working tree is clean,
    // so a run never mixes with or strands the user's in-flight edits. It's process/fs state (same
    // category as the per-project lock), not input validation — so it lives here, not at the
    // server-fn validator, and refuses BEFORE the seed (no `running` run is recorded for a dirty
    // tree). Dry runs skip it entirely: they spawn nothing and touch no git state.
    if (!(await isTreeClean(project.path))) {
      return { started: false, reason: 'dirty-tree' }
    }
  }

  const startedAt = nowIso()
  const seed: TicketRunStatus = {
    runId: makeRunId(),
    projectName: project.name,
    // Include parentEpicId only when present, so the on-disk status mirrors
    // ticketRunKey's conditional-segment contract (a child and a same-leaf solo
    // never collide in the index).
    ...(parentEpicId !== undefined ? { parentEpicId } : {}),
    ticketId,
    action: 'flow' as TicketRunAction,
    dryRun: !live, // env gate owns real/dry; the seed's flag is truthful from the first write the poll sees
    createPr: options?.createPr ?? true,
    status: 'running',
    startedAt,
    updatedAt: startedAt,
    finishedAt: null,
  }
  await writeTicketRunStatus(seed) // synchronous lock: 'running' on disk before we return

  if (!live) {
    // DRY RUN (default) — finish terminally before returning, exactly as PB-13.
    const finished: TicketRunStatus = {
      ...seed,
      status: 'succeeded',
      updatedAt: nowIso(),
      finishedAt: nowIso(),
      logTail: 'env gate off — dry run; no agent spawned',
    }
    await writeTicketRunStatus(finished)
    return { started: true, status: finished }
  }

  // LIVE — fire the long-running flow without awaiting; runRealFlow persists the terminal status.
  void runRealFlow(seed, project).catch(() => {
    /* runRealFlow writes its own terminal status; the staleness backstop covers a lost write */
  })
  return { started: true, status: seed }
}

/**
 * Continuation for a LIVE run: pre-flight the project dir, spawn `/feature:flow`, classify the result
 * into a terminal status, and persist it. Fire-and-forget from startGuardedTicketRun — it NEVER throws
 * out (the terminal write is try/caught; a lost write is covered by the 45m staleness backstop). The
 * classification mirrors sync.ts runWorkspace: spawnError → failed; code 0 → succeeded (+ parsed
 * prUrl); code null + signal → failed (timeout/kill); else failed with the exit code.
 */
async function runRealFlow(seed: TicketRunStatus, project: Project): Promise<void> {
  // The note rides logTail on EVERY terminal status (succeeded/needs-human/failed all route through
  // finish). The second line is the honesty marker (PB-18): the headless runner always spawns flow
  // with --no-ui-testing, so a UI ticket's `succeeded` must not be read as "browser-verified" —
  // browser checks are deferred to human PR review.
  const armed =
    'real run armed (PIPELINE_BOARD_ENABLE_RUNS=1)\n' +
    'browser/UI verification skipped (spawned with --no-ui-testing) — deferred to human PR review'

  // A terminal status is a patch + a note; the branch-restore step can append to both (e.g. a
  // restore failure), so we build the patch first and write once, after restore has run.
  type TerminalPatch = Partial<TicketRunStatus> & {
    status: 'succeeded' | 'failed' | 'needs-human'
  }

  // Captured during the spawn try-block, read after the finally restore — the terminal write folds
  // both in. Declared here so the finally and the post-finally compose can see them.
  let rawTail = ''
  let restoreNote: string | null = null

  const finish = async (patch: TerminalPatch, note: string): Promise<void> => {
    const terminal: TicketRunStatus = {
      ...seed,
      updatedAt: nowIso(),
      finishedAt: nowIso(),
      logTail: note,
      ...patch,
    }
    try {
      await writeTicketRunStatus(terminal)
    } catch {
      // best effort — the staleness guard coerces the orphaned `running` seed to failed.
    }
  }

  // Pre-flight: the dir + feature-pipeline shape could have vanished between the boundary's
  // ticketExists check and now — surface a legible `failed` rather than an opaque child error.
  // These run BEFORE any branch is created, so a preflight failure restores nothing (HEAD unmoved)
  // and tests pointing project.path at a non-workspace dir still short-circuit without git/spawn.
  try {
    const dirStat = await fs.stat(project.path)
    if (!dirStat.isDirectory()) {
      await finish({ status: 'failed', error: 'project path is not a directory' }, armed)
      return
    }
  } catch {
    await finish({ status: 'failed', error: 'project directory not found' }, armed)
    return
  }
  try {
    await fs.stat(join(project.path, 'claudedocs', 'tickets'))
  } catch {
    await finish(
      { status: 'failed', error: 'no claudedocs/tickets/ (not a feature-pipeline workspace)' },
      armed,
    )
    return
  }

  // ── Branch isolation (PB-19) ────────────────────────────────────────────────
  // Record the user's current ref, then fork a dedicated `pb-run/<runId>` branch off the default
  // branch BEFORE spawning flow, so the run's edits never accumulate on main/the user's branch.
  // On EVERY terminal path (success, failure, timeout, or a thrown error) the finally restores the
  // original ref and preserves partial work on the run branch (commit-then-checkout, never discard).
  const original = await currentRef(project.path)
  if (!original) {
    await finish(
      { status: 'failed', error: 'could not read current git branch (not a git repo?)' },
      armed,
    )
    return
  }
  const base = await defaultBranch(project.path)
  const branch = runBranchName(seed.runId)
  const created = await runGit(project.path, ['checkout', '-b', branch, base])
  if (created.code !== 0) {
    // Branch create failed — HEAD is unmoved, so nothing to restore. Surface a legible failure.
    // A spawnError (e.g. ENOENT) means `git` isn't on PATH — say so rather than show an empty stderr.
    const why = created.spawnError
      ? ((created.spawnError as NodeJS.ErrnoException).code === 'ENOENT'
          ? "'git' not found on PATH"
          : `git spawn failed: ${created.spawnError.message}`)
      : created.stderr || 'git checkout -b failed'
    await finish(
      { status: 'failed', error: `could not create run branch ${branch} off ${base}: ${why}` },
      armed,
    )
    return
  }

  let patch: TerminalPatch
  try {
    const r = await spawnFlow(project, seed.ticketId, seed.createPr)
    const raw = tail(r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : ''))
    // Stash the captured output so the (post-restore) write carries it on logTail.
    rawTail = raw
    if (r.spawnError) {
      const why =
        (r.spawnError as NodeJS.ErrnoException).code === 'ENOENT'
          ? "'claude' CLI not found on PATH"
          : `spawn failed: ${r.spawnError.message}`
      patch = { status: 'failed', error: why }
    } else if (r.code === 0) {
      patch = classifyCode0(parseFlowReport(r.stdout) ?? undefined, seed.createPr)
    } else if (r.code === null && r.signal) {
      patch = {
        status: 'failed',
        error: `killed (${r.signal}) — likely timed out after ${Math.round(RUN_TIMEOUT_MS / 60_000)}m`,
      }
    } else {
      patch = { status: 'failed', error: `flow exited with code ${r.code}` }
    }
  } catch (err) {
    // Defensive: spawnFlow never throws, but a future change might — classify rather than strand.
    patch = { status: 'failed', error: `run error: ${(err as Error).message}` }
  } finally {
    // ALWAYS preserve partial work onto the run branch and restore the user's original ref.
    restoreNote = await preserveAndRestore(project.path, original)
  }

  // Compose the final logTail: armed preamble + restore note (if any) + captured output tail.
  const parts = [armed]
  if (restoreNote) parts.push(restoreNote)
  if (rawTail) parts.push(rawTail)
  const note = parts.join('\n')
  // A restore failure left the tree on the run branch — fold it into `error` so it isn't read as a
  // clean success (the work is safe on the run branch, but the user wasn't returned to their branch).
  if (restoreNote && patch.status === 'succeeded') {
    patch = { ...patch, status: 'needs-human', error: restoreNote }
  } else if (restoreNote && !patch.error) {
    patch = { ...patch, error: restoreNote }
  }
  await finish(patch, note)
}
