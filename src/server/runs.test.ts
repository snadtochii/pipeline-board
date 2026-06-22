import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALLOWED_TOOLS,
  RUN_STALE_MS,
  buildFlowArgs,
  classifyCode0,
  currentRef,
  defaultBranch,
  isTicketRunAction,
  isTicketRunRunning,
  isTicketRunStatus,
  isTreeClean,
  makeRunId,
  parseFlowReport,
  preserveAndRestore,
  readLatestTicketRun,
  readTicketRunStatus,
  runBranchName,
  startGuardedTicketRun,
  ticketRunKey,
  writeTicketRunStatus,
} from './runs'
import type { Project, TicketRunStatus } from './types'

const project: Project = { name: 'Pipeline Board', path: '/tmp/does-not-matter' }

let dir: string

// ── Temp git-repo harness (PB-19) ─────────────────────────────────────────────
// The branch-isolation feature runs REAL git on project.path. These tests must never
// touch the real working tree — every git op targets an isolated `git init`'d temp dir
// created here and removed by the per-test cleanup. spawnSync keeps setup synchronous
// and deterministic (no spawn of `claude` — only plumbing git on a throwaway repo).

const tempRepos: string[] = []

/** Run a git command synchronously in `cwd`; throw on failure so a broken fixture fails loud. */
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.stdout}`)
  }
  return r.stdout.trim()
}

/**
 * Create an isolated git repo in a fresh temp dir with one initial commit on branch `main`, local
 * identity config (so commits work in CI), and `claudedocs/` gitignored (mirrors this repo). Tracked
 * by `tempRepos` for cleanup. Optionally seed extra files. Returns the absolute repo path.
 */
function initTempGitRepo(opts: { gitignoreClaudedocs?: boolean } = {}): string {
  const repo = mkdtempSync(join(tmpdir(), 'pb-gitrepo-'))
  tempRepos.push(repo)
  // -b main: deterministic default branch regardless of the host's init.defaultBranch.
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'PB Test')
  if (opts.gitignoreClaudedocs ?? true) {
    writeFileSync(join(repo, '.gitignore'), 'claudedocs/\nnode_modules/\n.env\n', 'utf8')
  }
  writeFileSync(join(repo, 'README.md'), '# fixture\n', 'utf8')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'initial')
  return repo
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'pb-runs-'))
  process.env.PIPELINE_BOARD_CONFIG_DIR = dir
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  delete process.env.PIPELINE_BOARD_CONFIG_DIR
  // PB-19: remove every temp git repo created this test (isolation — never the real tree).
  while (tempRepos.length > 0) {
    rmSync(tempRepos.pop() as string, { recursive: true, force: true })
  }
})

const runsDir = (): string => join(dir, 'runs')

function freshRunningRun(overrides: Partial<TicketRunStatus> = {}): TicketRunStatus {
  const now = new Date().toISOString()
  return {
    runId: 'run-test-1',
    projectName: 'Pipeline Board',
    ticketId: 'PB-12',
    action: 'flow',
    createPr: true,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    ...overrides,
  }
}

/**
 * Wait for a run's fire-and-forget continuation to write its terminal status, so its async file write
 * lands BEFORE afterEach removes the tmp dir (otherwise rmdir races the write → ENOTEMPTY). The
 * continuation never spawns `claude` in tests — `project.path` lacks `claudedocs/tickets/`, so
 * runRealFlow short-circuits at preflight and writes `failed` fast.
 */
async function awaitTerminal(runId: string | undefined): Promise<void> {
  if (!runId) return
  for (let i = 0; i < 200; i++) {
    const s = await readTicketRunStatus(runId)
    if (s && s.status !== 'running') return
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('ticketRunKey', () => {
  it('builds a solo key without a parent segment (segments percent-encoded)', () => {
    expect(ticketRunKey('Pipeline Board', 'PB-12')).toBe('Pipeline%20Board::PB-12')
  })

  it('includes the parent epic segment for a child', () => {
    expect(ticketRunKey('Pipeline Board', 'PB-12', 'PB-11')).toBe('Pipeline%20Board::PB-11::PB-12')
  })

  it('distinguishes a child from a same-leaf-id solo', () => {
    expect(ticketRunKey('P', 'PB-12', 'PB-11')).not.toBe(ticketRunKey('P', 'PB-12'))
  })

  it('does not collide when a project name contains the separator', () => {
    // 'A::B' + 'X' must not equal 'A' + parent 'B' + 'X' — encoding the segments
    // keeps the '::' separator unambiguous.
    expect(ticketRunKey('A::B', 'X')).not.toBe(ticketRunKey('A', 'X', 'B'))
  })
})

describe('isTicketRunAction', () => {
  it('accepts only "flow" in v1', () => {
    expect(isTicketRunAction('flow')).toBe(true)
    expect(isTicketRunAction('prepare')).toBe(false)
    expect(isTicketRunAction('review-pr')).toBe(false)
    expect(isTicketRunAction('')).toBe(false)
    expect(isTicketRunAction(undefined)).toBe(false)
  })
})

describe('isTicketRunStatus', () => {
  it('accepts a valid status', () => {
    expect(isTicketRunStatus(freshRunningRun())).toBe(true)
  })

  it('round-trips the needs-human terminal status', () => {
    expect(isTicketRunStatus(freshRunningRun({ status: 'needs-human' }))).toBe(true)
  })

  it('rejects non-objects and wrong shapes', () => {
    expect(isTicketRunStatus(null)).toBe(false)
    expect(isTicketRunStatus({ foo: 1 })).toBe(false)
    // bad status literal (sync's 'done' is not the runner's vocabulary)
    const badLiteral: Record<string, unknown> = { ...freshRunningRun(), status: 'done' }
    expect(isTicketRunStatus(badLiteral)).toBe(false)
    // missing updatedAt
    const missing: Record<string, unknown> = { ...freshRunningRun() }
    delete missing.updatedAt
    expect(isTicketRunStatus(missing)).toBe(false)
    // non-string optional field
    const badOptional: Record<string, unknown> = { ...freshRunningRun(), prUrl: 123 }
    expect(isTicketRunStatus(badOptional)).toBe(false)
  })
})

describe('isTicketRunRunning', () => {
  it('is false for null and terminal statuses', () => {
    expect(isTicketRunRunning(null)).toBe(false)
    expect(isTicketRunRunning(freshRunningRun({ status: 'succeeded' }))).toBe(false)
    expect(isTicketRunRunning(freshRunningRun({ status: 'failed' }))).toBe(false)
    expect(isTicketRunRunning(freshRunningRun({ status: 'needs-human' }))).toBe(false)
    expect(isTicketRunRunning(freshRunningRun())).toBe(true)
  })
})

describe('run-status persistence', () => {
  it('returns null when a ticket has no runs', async () => {
    expect(await readLatestTicketRun('Pipeline Board', 'PB-12')).toBeNull()
    expect(await readTicketRunStatus('run-missing')).toBeNull()
  })

  it('round-trips a written run by id and via the latest index', async () => {
    const status = freshRunningRun()
    await writeTicketRunStatus(status)
    expect(await readTicketRunStatus(status.runId)).toEqual(status)
    expect(
      await readLatestTicketRun(status.projectName, status.ticketId, status.parentEpicId),
    ).toEqual(status)
  })

  it('returns null on a corrupt run file', async () => {
    const status = freshRunningRun()
    await writeTicketRunStatus(status)
    await fs.writeFile(join(runsDir(), `${status.runId}.json`), '{ not json', 'utf8')
    expect(await readTicketRunStatus(status.runId)).toBeNull()
  })

  it('degrades a corrupt latest index to "no latest run" without losing the run file', async () => {
    const status = freshRunningRun()
    await writeTicketRunStatus(status)
    await fs.writeFile(join(runsDir(), 'latest.json'), '{ not json', 'utf8')
    expect(await readLatestTicketRun(status.projectName, status.ticketId)).toBeNull()
    // the per-run file is still directly readable
    expect(await readTicketRunStatus(status.runId)).toEqual(status)
  })

  it('returns null on wrong-shape run JSON', async () => {
    await writeTicketRunStatus(freshRunningRun({ runId: 'run-x' }))
    await fs.writeFile(join(runsDir(), 'run-x.json'), JSON.stringify({ foo: 1 }), 'utf8')
    expect(await readTicketRunStatus('run-x')).toBeNull()
  })

  it('atomic writes leave no temp files behind', async () => {
    await writeTicketRunStatus(freshRunningRun({ runId: 'run-atomic' }))
    const files = (await fs.readdir(runsDir())).sort()
    expect(files).toEqual(['latest.json', 'run-atomic.json'])
  })

  it('points the latest index at the newest run for a ticket', async () => {
    const a = freshRunningRun({
      runId: 'run-a',
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
    })
    const b = freshRunningRun({ runId: 'run-b' })
    await writeTicketRunStatus(a)
    await writeTicketRunStatus(b)
    expect(await readLatestTicketRun('Pipeline Board', 'PB-12')).toEqual(b)
  })

  it('keeps a fresh running run as running', async () => {
    await writeTicketRunStatus(freshRunningRun())
    const read = await readLatestTicketRun('Pipeline Board', 'PB-12')
    expect(read?.status).toBe('running')
    expect(isTicketRunRunning(read)).toBe(true)
  })

  it('coerces a stale running run to failed via both readers', async () => {
    const old = new Date(Date.now() - (RUN_STALE_MS + 60_000)).toISOString()
    const stale = freshRunningRun({ runId: 'run-stale', startedAt: old, updatedAt: old })
    await writeTicketRunStatus(stale)

    const viaId = await readTicketRunStatus('run-stale')
    expect(viaId?.status).toBe('failed')
    expect(isTicketRunRunning(viaId)).toBe(false)
    expect(viaId?.error).toMatch(/stale/i)

    const viaLatest = await readLatestTicketRun('Pipeline Board', 'PB-12')
    expect(viaLatest?.status).toBe('failed')
  })

  it('keeps a separate latest entry per distinct ticket', async () => {
    await writeTicketRunStatus(freshRunningRun({ runId: 'run-1', ticketId: 'PB-1' }))
    await writeTicketRunStatus(freshRunningRun({ runId: 'run-2', ticketId: 'PB-2' }))
    expect((await readLatestTicketRun('Pipeline Board', 'PB-1'))?.runId).toBe('run-1')
    expect((await readLatestTicketRun('Pipeline Board', 'PB-2'))?.runId).toBe('run-2')
  })

  it('survives concurrent writers for different tickets (no lost entry, no rename collision)', async () => {
    await Promise.all([
      writeTicketRunStatus(freshRunningRun({ runId: 'run-c1', ticketId: 'PB-1' })),
      writeTicketRunStatus(freshRunningRun({ runId: 'run-c2', ticketId: 'PB-2' })),
      writeTicketRunStatus(freshRunningRun({ runId: 'run-c3', ticketId: 'PB-3' })),
    ])
    expect((await readLatestTicketRun('Pipeline Board', 'PB-1'))?.runId).toBe('run-c1')
    expect((await readLatestTicketRun('Pipeline Board', 'PB-2'))?.runId).toBe('run-c2')
    expect((await readLatestTicketRun('Pipeline Board', 'PB-3'))?.runId).toBe('run-c3')
  })
})

describe('makeRunId', () => {
  it('produces distinct ids for same-millisecond calls (uuid suffix, not bare timestamp)', () => {
    const ids = new Set(Array.from({ length: 100 }, () => makeRunId()))
    expect(ids.size).toBe(100)
  })

  it('is path-safe and well-shaped (run-<stamp>-<8hex>, no : or .)', () => {
    const id = makeRunId()
    expect(id).toMatch(/^run-[0-9TZ-]+-[0-9a-f]{8}$/)
    expect(id).not.toContain(':')
    expect(id).not.toContain('.')
  })
})

describe('startGuardedTicketRun', () => {
  // Every start is REAL now (PB-21 removed the dry path). To exercise the start path WITHOUT
  // spawning `claude`, point project.path at a CLEAN git repo that LACKS claudedocs/tickets/ —
  // the clean-tree gate passes, the seed writes `running`, then runRealFlow short-circuits at its
  // claudedocs/tickets/ preflight and writes `failed` (no branch created, no `claude` spawned). The
  // synchronous start return is deterministic (`started` + the seeded `running` status); the
  // continuation is drained with awaitTerminal before teardown.

  it('seeds a running real run and updates latest.json (no spawn — preflight short-circuits)', async () => {
    const repo = initTempGitRepo()
    const liveProject: Project = { name: 'Pipeline Board', path: repo }
    const res = await startGuardedTicketRun(liveProject, 'PB-12')
    expect(res.started).toBe(true)
    expect(res.reason).toBeUndefined()
    expect(res.status?.status).toBe('running') // fire-and-forget: the start returns the seed
    expect(res.status?.createPr).toBe(true)
    expect(res.status?.finishedAt).toBeNull()
    expect('dryRun' in (res.status ?? {})).toBe(false) // no vestigial dryRun field

    // latest.json points at the seeded run (proves persistence + index update)
    const latest = await readLatestTicketRun('Pipeline Board', 'PB-12')
    expect(latest?.runId).toBe(res.status?.runId)

    await awaitTerminal(res.status?.runId)
    // The continuation wrote a terminal status (failed at the claudedocs/tickets/ preflight).
    const terminal = await readTicketRunStatus(res.status?.runId ?? '')
    expect(terminal?.status).toBe('failed')
    expect(terminal?.error).toMatch(/claudedocs\/tickets/)
  })

  it('refuses a second run while one is genuinely running (per-ticket lock)', async () => {
    // Seed an active run for this ticket (the lock the guard must observe). Checked before the
    // clean-tree gate, so the default non-repo project.path is fine here.
    await writeTicketRunStatus(freshRunningRun({ runId: 'run-active', ticketId: 'PB-12' }))
    const res = await startGuardedTicketRun(project, 'PB-12')
    expect(res.started).toBe(false)
    expect(res.reason).toBe('already-running')
    // latest is unchanged — the active run was not overwritten.
    expect((await readLatestTicketRun('Pipeline Board', 'PB-12'))?.runId).toBe('run-active')
  })

  it('is NOT blocked by a stale running run (coerced to failed on read)', async () => {
    const repo = initTempGitRepo()
    const liveProject: Project = { name: 'Pipeline Board', path: repo }
    const old = new Date(Date.now() - (RUN_STALE_MS + 60_000)).toISOString()
    await writeTicketRunStatus(
      freshRunningRun({ runId: 'run-stale', ticketId: 'PB-12', startedAt: old, updatedAt: old }),
    )
    const res = await startGuardedTicketRun(liveProject, 'PB-12')
    expect(res.started).toBe(true)
    expect(res.status?.status).toBe('running')
    expect(res.status?.runId).not.toBe('run-stale')
    await awaitTerminal(res.status?.runId)
  })

  it('defaults createPr to true and honors createPr: false', async () => {
    // Two DISTINCT projects so neither start trips the other's per-project lock.
    const def = await startGuardedTicketRun({ name: 'Proj A', path: initTempGitRepo() }, 'PB-1')
    expect(def.status?.createPr).toBe(true)
    const off = await startGuardedTicketRun(
      { name: 'Proj B', path: initTempGitRepo() },
      'PB-2',
      undefined,
      { createPr: false },
    )
    expect(off.status?.createPr).toBe(false)
    await awaitTerminal(def.status?.runId)
    await awaitTerminal(off.status?.runId)
  })

  it('keys an epic child separately from a same-leaf solo', async () => {
    // Both starts hit the per-project lock (the first seeds a running run in the project), so seed
    // each run directly to assert the KEYING, not the lock. The keying is what this test pins.
    const child = freshRunningRun({ runId: 'run-child', ticketId: 'PB-13', parentEpicId: 'PB-11' })
    const solo = freshRunningRun({ runId: 'run-solo', ticketId: 'PB-13' })
    await writeTicketRunStatus(child)
    await writeTicketRunStatus(solo)
    expect(child.parentEpicId).toBe('PB-11')
    expect(solo.parentEpicId).toBeUndefined()
    // Each resolves to its own latest entry — no collision.
    expect((await readLatestTicketRun('Pipeline Board', 'PB-13', 'PB-11'))?.runId).toBe('run-child')
    expect((await readLatestTicketRun('Pipeline Board', 'PB-13'))?.runId).toBe('run-solo')
  })
})

// ── PB-15: flow adapter (pure — no spawning) ──────────────────────────────────

describe('buildFlowArgs', () => {
  it('builds the /feature:flow <id> --pr --no-ui-testing vector with the runner allowlist and a capable default model', () => {
    const args = buildFlowArgs('PB-1', { createPr: true })
    expect(args.slice(0, 3)).toEqual([
      '-p',
      '/feature:flow PB-1 --pr --no-ui-testing',
      '--allowedTools',
    ])
    expect(args.slice(-2)).toEqual(['--model', 'opus'])
    // the runner's OWN broader allowlist (vs sync's narrow one)
    expect(args).toContain('Skill')
    expect(args).toContain('Task')
    expect(args).toContain('Write')
    expect(args).toContain('Edit')
    expect(args).toContain('Bash(git:*)')
    expect(args).toContain('Bash(gh:*)')
    expect(args).toContain('Bash(npm:*)')
    // Bash(mv:*) is load-bearing: every state transition does a plain `mv` of the (git-ignored)
    // ticket folder; git mv refuses ignored paths, so without this the first folder move stalls.
    expect(args).toContain('Bash(mv:*)')
  })

  it('defaults createPr to true (the v1 UI always requests a PR)', () => {
    expect(buildFlowArgs('PB-1')[1]).toBe('/feature:flow PB-1 --pr --no-ui-testing')
  })

  it('omits --pr when createPr is false', () => {
    expect(buildFlowArgs('PB-1', { createPr: false })[1]).toBe('/feature:flow PB-1 --no-ui-testing')
  })

  it('always passes --no-ui-testing (PB-18: headless runs can never browser-verify)', () => {
    // Unconditional — present whether or not a PR is requested.
    expect(buildFlowArgs('PB-1', { createPr: true })[1]).toContain('--no-ui-testing')
    expect(buildFlowArgs('PB-1', { createPr: false })[1]).toContain('--no-ui-testing')
  })

  it('NEVER emits --dangerously-skip-permissions', () => {
    expect(buildFlowArgs('PB-1')).not.toContain('--dangerously-skip-permissions')
  })

  it('uses Bash only in scoped form — no unscoped Bash (least privilege on the riskiest surface)', () => {
    const args = buildFlowArgs('PB-1')
    expect(args).not.toContain('Bash')
    // every Bash entry must be scoped Bash(...)
    for (const t of args) {
      if (t.startsWith('Bash')) expect(t).toMatch(/^Bash\([^)]+\)$/)
    }
  })

  it('honors an explicit model override and falls back to the default on blank', () => {
    expect(buildFlowArgs('PB-1', { model: 'haiku' }).slice(-2)).toEqual(['--model', 'haiku'])
    expect(buildFlowArgs('PB-1', { model: '   ' }).slice(-2)).toEqual(['--model', 'opus'])
    expect(buildFlowArgs('PB-1', { model: '' }).slice(-2)).toEqual(['--model', 'opus'])
  })

  it('rejects an unsafe ticketId BEFORE building any args (no interpolation)', () => {
    expect(() => buildFlowArgs('../etc/passwd')).toThrow()
    expect(() => buildFlowArgs('PB-1; rm -rf /')).toThrow()
    expect(() => buildFlowArgs('a/b')).toThrow()
  })

  it('rejects an id that fails the strict /^[A-Z][A-Z0-9]+-\\d+$/ shape', () => {
    expect(() => buildFlowArgs('pb-1')).toThrow() // lowercase
    expect(() => buildFlowArgs('PB1')).toThrow() // no dash
    expect(() => buildFlowArgs('PB-')).toThrow() // no number
    expect(() => buildFlowArgs('1PB-2')).toThrow() // leading digit
  })

  it('exposes a scoped, dangerous-flag-free allowlist constant', () => {
    expect(ALLOWED_TOOLS).not.toContain('Bash')
    expect(ALLOWED_TOOLS as readonly string[]).not.toContain('--dangerously-skip-permissions')
    expect(ALLOWED_TOOLS).toContain('Skill')
  })
})

describe('parseFlowReport', () => {
  it('extracts a GitHub PR URL from a report tail', () => {
    expect(parseFlowReport('… ✅ PR opened: https://github.com/acme/repo/pull/42 (branch …)')).toBe(
      'https://github.com/acme/repo/pull/42',
    )
  })

  it('returns null when no PR URL is present (a legitimate no-URL success)', () => {
    expect(parseFlowReport('committed to feature/x — finalized to done/.')).toBeNull()
    expect(parseFlowReport('')).toBeNull()
  })

  it('returns the first URL when several are present', () => {
    const text =
      'https://github.com/a/b/pull/1 then https://github.com/a/b/pull/2'
    expect(parseFlowReport(text)).toBe('https://github.com/a/b/pull/1')
  })
})

// ── PB-17: code-0 classification (a no-PR --pr run is needs-human, not a false success) ─

describe('classifyCode0', () => {
  it('classifies a createPr run with no PR URL as needs-human (not a false success)', () => {
    const r = classifyCode0(undefined, true)
    expect(r.status).toBe('needs-human')
    expect(r.error).toMatch(/no PR/i)
    expect(r.prUrl).toBeUndefined()
  })

  it('classifies a createPr run with a parsed PR URL as succeeded', () => {
    const r = classifyCode0('https://github.com/a/b/pull/1', true)
    expect(r.status).toBe('succeeded')
    expect(r.prUrl).toBe('https://github.com/a/b/pull/1')
    expect(r.error).toBeUndefined()
  })

  it('keeps a no-PR-requested run with no URL as a legitimate succeeded', () => {
    const r = classifyCode0(undefined, false)
    expect(r.status).toBe('succeeded')
    expect(r.error).toBeUndefined()
    expect(r.prUrl).toBeUndefined()
  })

  it('stays succeeded with the prUrl even when a PR was not requested', () => {
    const r = classifyCode0('https://github.com/a/b/pull/2', false)
    expect(r.status).toBe('succeeded')
    expect(r.prUrl).toBe('https://github.com/a/b/pull/2')
  })
})

// ── PB-15/PB-21: per-project lock (always-real; no spawning — preflight short-circuits) ─

describe('per-project real-flow lock', () => {
  // Every start is real now. project.path must be a CLEAN git repo to clear PB-19's clean-tree gate;
  // it deliberately lacks claudedocs/tickets/, so the continuation passes the clean-tree gate, then
  // short-circuits at runRealFlow's claudedocs/tickets/ preflight (which runs BEFORE branch creation)
  // → writes a terminal status WITHOUT creating a run branch and WITHOUT spawning `claude`. The
  // `project-busy` test refuses BEFORE the clean-tree gate, so it needs no repo. We assert the
  // synchronous guard return, which is deterministic.

  it('refuses a second flow in the same project (project-busy)', async () => {
    // Seed an active run for one ticket in the project. (project-busy is checked before the
    // clean-tree gate, so the default non-repo project.path is fine here.)
    await writeTicketRunStatus(freshRunningRun({ runId: 'run-real', ticketId: 'PB-1' }))
    const res = await startGuardedTicketRun(project, 'PB-2')
    expect(res.started).toBe(false)
    expect(res.reason).toBe('project-busy')
    // The active run was not overwritten.
    expect((await readLatestTicketRun('Pipeline Board', 'PB-1'))?.runId).toBe('run-real')
  })

  it('starts when no other run is active, carrying the skipped-UI honesty marker (PB-18)', async () => {
    const repo = initTempGitRepo()
    const liveProject: Project = { name: 'Pipeline Board', path: repo }
    const res = await startGuardedTicketRun(liveProject, 'PB-2')
    expect(res.started).toBe(true)
    expect(res.reason).toBeUndefined()
    expect(res.status?.status).toBe('running') // seed returns running (fire-and-forget)
    await awaitTerminal(res.status?.runId) // let the no-spawn continuation finish before teardown

    // PB-18 AC3: the terminal status carries the skipped-UI-testing honesty marker in logTail (here
    // via the claudedocs/tickets/ preflight-fail path — the repo has no tickets tree). Pins the
    // marker so a future edit to `armed` can't silently drop it.
    const terminal = await readTicketRunStatus(res.status?.runId ?? '')
    expect(terminal?.status).not.toBe('running')
    expect(terminal?.logTail).toMatch(/--no-ui-testing/)
    expect(terminal?.logTail).toMatch(/deferred to human PR review/i)
    // PB-19: the original branch is restored — the preflight failed before branch creation, so the
    // repo is left exactly on `main`, never on a `pb-run/*` branch.
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  })

  it('does NOT count a STALE run toward the project lock (coerced to failed)', async () => {
    const repo = initTempGitRepo()
    const liveProject: Project = { name: 'Pipeline Board', path: repo }
    const old = new Date(Date.now() - (RUN_STALE_MS + 60_000)).toISOString()
    await writeTicketRunStatus(
      freshRunningRun({
        runId: 'run-stale-real',
        ticketId: 'PB-1',
        startedAt: old,
        updatedAt: old,
      }),
    )
    const res = await startGuardedTicketRun(liveProject, 'PB-2')
    expect(res.started).toBe(true)
    expect(res.reason).toBeUndefined()
    await awaitTerminal(res.status?.runId) // let the no-spawn continuation finish before teardown
  })
})

// ── PB-19: git isolation helpers (against isolated temp repos — never the real tree) ─

describe('runBranchName', () => {
  it('namespaces the run branch under pb-run/ using the (unique) runId', () => {
    expect(runBranchName('run-2026-06-21-abc123')).toBe('pb-run/run-2026-06-21-abc123')
  })
})

describe('defaultBranch', () => {
  it('falls back to main when origin/HEAD is not configured (local-only repo)', async () => {
    const repo = initTempGitRepo()
    // No remote → symbolic-ref refs/remotes/origin/HEAD fails → fallback.
    expect(await defaultBranch(repo)).toBe('main')
  })

  it('resolves and strips the origin/ prefix when origin/HEAD points at a branch', async () => {
    const repo = initTempGitRepo()
    // Simulate a configured remote default without a network: point origin/HEAD at the local branch.
    git(repo, 'remote', 'add', 'origin', repo)
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    expect(await defaultBranch(repo)).toBe('main')
  })

  it('returns main for a non-git directory (graceful fallback, no throw)', async () => {
    expect(await defaultBranch('/tmp')).toBe('main')
  })
})

describe('currentRef', () => {
  it('returns the current branch name', async () => {
    const repo = initTempGitRepo()
    expect(await currentRef(repo)).toBe('main')
  })

  it('returns the commit SHA when HEAD is detached', async () => {
    const repo = initTempGitRepo()
    const sha = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '--detach', 'HEAD')
    expect(await currentRef(repo)).toBe(sha)
  })

  it('returns null for a non-git directory', async () => {
    expect(await currentRef('/tmp')).toBeNull()
  })
})

describe('isTreeClean', () => {
  it('is true for a freshly-committed repo', async () => {
    const repo = initTempGitRepo()
    expect(await isTreeClean(repo)).toBe(true)
  })

  it('is false when a tracked file has uncommitted changes', async () => {
    const repo = initTempGitRepo()
    writeFileSync(join(repo, 'README.md'), '# fixture changed\n', 'utf8')
    expect(await isTreeClean(repo)).toBe(false)
  })

  it('is false when an untracked (non-ignored) file is present', async () => {
    const repo = initTempGitRepo()
    writeFileSync(join(repo, 'new-file.txt'), 'x\n', 'utf8')
    expect(await isTreeClean(repo)).toBe(false)
  })

  it('stays clean when only gitignored paths change (AC1+AC4 are compatible)', async () => {
    const repo = initTempGitRepo() // .gitignore lists claudedocs/ + node_modules/ + .env
    writeFileSync(join(repo, '.env'), 'SECRET=1\n', 'utf8')
    // Simulate the ticket folder living under gitignored claudedocs/ — it must not dirty the tree.
    const claudedocs = join(repo, 'claudedocs', 'tickets', 'in-progress', 'PB-19')
    mkdirSync(claudedocs, { recursive: true })
    writeFileSync(join(claudedocs, '01-spec.md'), '---\nid: PB-19\n---\n', 'utf8')
    expect(await isTreeClean(repo)).toBe(true)
  })

  it('reports a non-git directory as NOT clean (so a live run there is refused)', async () => {
    expect(await isTreeClean('/tmp')).toBe(false)
  })
})

// ── PB-19: clean-tree precondition at the start boundary ───────────────────────

describe('clean-tree start precondition', () => {
  it('refuses a start on a dirty tree with reason dirty-tree (no run recorded)', async () => {
    const repo = initTempGitRepo()
    writeFileSync(join(repo, 'README.md'), '# dirty\n', 'utf8') // uncommitted tracked change
    const liveProject: Project = { name: 'Pipeline Board', path: repo }

    const res = await startGuardedTicketRun(liveProject, 'PB-1')
    expect(res.started).toBe(false)
    expect(res.reason).toBe('dirty-tree')
    expect(res.status).toBeUndefined()
    // No `running` run was recorded for the refused start.
    expect(await readLatestTicketRun('Pipeline Board', 'PB-1')).toBeNull()
    // The dirty tree was not touched (still on main, still dirty).
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(await isTreeClean(repo)).toBe(false)
  })

  it('allows a start on a clean tree (gitignored-only changes do not block)', async () => {
    const repo = initTempGitRepo()
    writeFileSync(join(repo, '.env'), 'SECRET=1\n', 'utf8') // gitignored — tree stays clean
    const liveProject: Project = { name: 'Pipeline Board', path: repo }

    const res = await startGuardedTicketRun(liveProject, 'PB-1')
    expect(res.started).toBe(true)
    expect(res.reason).toBeUndefined()
    expect(res.status?.status).toBe('running')
    await awaitTerminal(res.status?.runId) // drain the no-spawn continuation before teardown
  })
})

// ── PB-19: branch isolation + restore around the (non-spawned) continuation ────

describe('branch isolation preflight (live continuation, spawn-free)', () => {
  // project.path is a CLEAN git repo WITHOUT claudedocs/tickets/, so runRealFlow passes the
  // clean-tree gate, then short-circuits at the claudedocs/tickets/ preflight — which runs BEFORE
  // branch creation, so NO pb-run/ branch is created and `claude` is never spawned. This pins the
  // "preflight-fail restores nothing" contract. (The full branch-create+restore integration requires
  // a real `claude` spawn and is manually verified per PB-RUN-6; preserveAndRestore — the restore
  // core — is unit-tested directly in the suite below.)

  it('short-circuits at the preflight BEFORE branch creation (no pb-run branch, HEAD unmoved)', async () => {
    const repo = initTempGitRepo()
    const liveProject: Project = { name: 'Pipeline Board', path: repo }

    const res = await startGuardedTicketRun(liveProject, 'PB-1')
    expect(res.started).toBe(true)
    await awaitTerminal(res.status?.runId)

    // HEAD never left main and no pb-run/ branch exists — branch creation runs only AFTER the
    // claudedocs/tickets/ preflight, which fails here.
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(git(repo, 'branch', '--list', 'pb-run/*')).toBe('')
    const terminal = await readTicketRunStatus(res.status?.runId ?? '')
    expect(terminal?.status).toBe('failed')
    expect(terminal?.error).toMatch(/claudedocs\/tickets/)
  })
})

// ── PB-19: preserveAndRestore (the failure/cleanup path, tested directly) ───────
// The live spawn can't produce real file changes in tests (no `claude` work), so the partial-work
// preservation contract is exercised by calling preserveAndRestore against a temp repo where we
// simulate "the run made changes on the run branch" by hand. This is the AC3/AC4 core.

describe('preserveAndRestore', () => {
  it('commits partial work to the run branch and restores the original branch clean (AC3)', async () => {
    const repo = initTempGitRepo()
    const original = 'main'
    // Simulate the runner having forked the run branch, then flow leaving partial tracked changes.
    git(repo, 'checkout', '-b', 'pb-run/run-x')
    writeFileSync(join(repo, 'src.txt'), 'partial work\n', 'utf8')

    const note = await preserveAndRestore(repo, original)
    expect(note).toBeNull() // clean restore

    // Back on the original branch with a clean tree — no stranded uncommitted edits.
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(await isTreeClean(repo)).toBe(true)
    // main never saw the partial file (it lives only on the run branch).
    expect(spawnSync('git', ['cat-file', '-e', 'HEAD:src.txt'], { cwd: repo }).status).not.toBe(0)
    // The partial work IS committed on the run branch.
    expect(git(repo, 'cat-file', '-e', 'pb-run/run-x:src.txt')).toBe('')
  })

  it('never commits gitignored files (.env / node_modules stay present + untracked) (AC4)', async () => {
    const repo = initTempGitRepo() // .gitignore has .env + node_modules/ + claudedocs/
    git(repo, 'checkout', '-b', 'pb-run/run-y')
    writeFileSync(join(repo, 'tracked.txt'), 'real change\n', 'utf8')
    writeFileSync(join(repo, '.env'), 'SECRET=top\n', 'utf8') // gitignored — must NOT be committed

    await preserveAndRestore(repo, 'main')

    // The gitignored file is still present in the working tree after restore (AC4).
    expect(await fs.readFile(join(repo, '.env'), 'utf8')).toBe('SECRET=top\n')
    // It is not tracked on the run branch (git add -A excludes gitignored paths).
    expect(spawnSync('git', ['cat-file', '-e', 'pb-run/run-y:.env'], { cwd: repo }).status).not.toBe(0)
    // The real tracked change WAS committed to the run branch.
    expect(git(repo, 'cat-file', '-e', 'pb-run/run-y:tracked.txt')).toBe('')
  })

  it('is a no-op-safe restore when there is nothing to commit', async () => {
    const repo = initTempGitRepo()
    git(repo, 'checkout', '-b', 'pb-run/run-z') // clean run branch, no changes
    const note = await preserveAndRestore(repo, 'main')
    expect(note).toBeNull()
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(await isTreeClean(repo)).toBe(true)
  })

  it('returns a note (does not throw) when the original ref cannot be checked out', async () => {
    const repo = initTempGitRepo()
    git(repo, 'checkout', '-b', 'pb-run/run-w')
    writeFileSync(join(repo, 'src.txt'), 'work\n', 'utf8')
    // Restore target does not exist → checkout fails; work must stay safe on the run branch.
    const note = await preserveAndRestore(repo, 'no-such-branch')
    expect(note).toMatch(/could not restore/i)
    // Still on the run branch (work preserved), not stranded/lost.
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('pb-run/run-w')
    expect(git(repo, 'cat-file', '-e', 'pb-run/run-w:src.txt')).toBe('')
  })

  it('does NOT checkout (leaving a dirty restored branch) when the partial-work commit fails', async () => {
    // Independent-review minor: if the commit fails for a real reason (not "nothing to commit") but
    // the checkout then succeeds, staged changes would ride onto the restored branch (AC3 violation).
    // Force a genuine commit failure (staging still succeeds): require gpg-signing with a bogus gpg
    // program, so `git add` works but `git commit --no-verify` exits non-zero. Assert we stay on the
    // run branch (no carry-over onto main).
    const repo = initTempGitRepo()
    git(repo, 'checkout', '-b', 'pb-run/run-cf')
    git(repo, 'config', 'commit.gpgsign', 'true')
    git(repo, 'config', 'gpg.program', '/bin/false') // signing always fails → commit fails
    writeFileSync(join(repo, 'src.txt'), 'work\n', 'utf8')

    const note = await preserveAndRestore(repo, 'main')

    expect(note).toMatch(/could not commit partial work/i)
    // Crucially: we did NOT checkout main — so main was never made dirty by carried-over staged work.
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('pb-run/run-cf')
    // The staged change is preserved on the run branch (still staged, not lost).
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('src.txt')
    // Disable signing, then confirm main never received the change.
    git(repo, 'config', 'commit.gpgsign', 'false')
    git(repo, 'stash') // park the staged change so we can switch branches to inspect main
    git(repo, 'checkout', 'main')
    expect(await isTreeClean(repo)).toBe(true)
    expect(spawnSync('git', ['cat-file', '-e', 'main:src.txt'], { cwd: repo }).status).not.toBe(0)
  })

  it('restores a non-main original branch (user was on a feature branch) clean (AC3)', async () => {
    const repo = initTempGitRepo()
    // The user started on a feature branch; the runner forked the run branch off it. Restore must
    // return to feature/my-work, not main — this is the genuine non-main restore path.
    git(repo, 'checkout', '-b', 'feature/my-work')
    git(repo, 'checkout', '-b', 'pb-run/run-feat')
    writeFileSync(join(repo, 'src.txt'), 'partial work\n', 'utf8')

    const note = await preserveAndRestore(repo, 'feature/my-work')
    expect(note).toBeNull()
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/my-work')
    expect(await isTreeClean(repo)).toBe(true)
    // feature/my-work never saw the partial file; it lives only on the run branch.
    expect(spawnSync('git', ['cat-file', '-e', 'feature/my-work:src.txt'], { cwd: repo }).status).not.toBe(0)
    expect(git(repo, 'cat-file', '-e', 'pb-run/run-feat:src.txt')).toBe('')
  })

  it('excludes a TRACKED claudedocs/ tree from the partial-work commit', async () => {
    // A consumer repo that does NOT gitignore claudedocs/ — the runner must still keep ticket
    // bookkeeping out of the run commit (the tracked-claudedocs `git reset` branch).
    const repo = initTempGitRepo({ gitignoreClaudedocs: false })
    mkdirSync(join(repo, 'claudedocs'), { recursive: true })
    writeFileSync(join(repo, 'claudedocs', 'notes.md'), 'bookkeeping\n', 'utf8')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'track claudedocs')
    git(repo, 'checkout', '-b', 'pb-run/run-cd')
    writeFileSync(join(repo, 'src.txt'), 'real change\n', 'utf8')
    writeFileSync(join(repo, 'claudedocs', 'notes.md'), 'CHANGED bookkeeping\n', 'utf8')

    await preserveAndRestore(repo, 'main')

    // The real change was committed to the run branch; the tracked claudedocs change was NOT.
    expect(git(repo, 'cat-file', '-e', 'pb-run/run-cd:src.txt')).toBe('')
    expect(git(repo, 'show', 'pb-run/run-cd:claudedocs/notes.md')).toBe('bookkeeping')
  })
})
