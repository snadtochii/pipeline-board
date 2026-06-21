import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALLOWED_TOOLS,
  RUN_STALE_MS,
  buildFlowArgs,
  isTicketRunAction,
  isTicketRunRunning,
  isTicketRunStatus,
  makeRunId,
  parseFlowReport,
  readLatestTicketRun,
  readTicketRunStatus,
  startGuardedTicketRun,
  ticketRunKey,
  writeTicketRunStatus,
} from './runs'
import type { Project, TicketRunStatus } from './types'

const project: Project = { name: 'Pipeline Board', path: '/tmp/does-not-matter' }

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'pb-runs-'))
  process.env.PIPELINE_BOARD_CONFIG_DIR = dir
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  delete process.env.PIPELINE_BOARD_CONFIG_DIR
  // PB-15 gate tests set this; clear it so it never leaks into a later test (which would arm a real spawn).
  delete process.env.PIPELINE_BOARD_ENABLE_RUNS
})

const runsDir = (): string => join(dir, 'runs')

function freshRunningRun(overrides: Partial<TicketRunStatus> = {}): TicketRunStatus {
  const now = new Date().toISOString()
  return {
    runId: 'run-test-1',
    projectName: 'Pipeline Board',
    ticketId: 'PB-12',
    action: 'flow',
    dryRun: true,
    createPr: true,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    ...overrides,
  }
}

/**
 * Wait for a live (env-armed) run's fire-and-forget continuation to write its terminal status, so its
 * async file write lands BEFORE afterEach removes the tmp dir (otherwise rmdir races the write →
 * ENOTEMPTY). The continuation never spawns `claude` in tests — `project.path` lacks
 * `claudedocs/tickets/`, so runRealFlow short-circuits at preflight and writes `failed` fast.
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
  it('records a dry run: succeeded, dryRun, log note, and updates latest.json', async () => {
    const res = await startGuardedTicketRun(project, 'PB-12')
    expect(res.started).toBe(true)
    expect(res.reason).toBeUndefined()
    expect(res.status?.status).toBe('succeeded')
    expect(res.status?.dryRun).toBe(true)
    expect(res.status?.createPr).toBe(true)
    expect(res.status?.finishedAt).not.toBeNull()
    expect(res.status?.logTail).toMatch(/dry run/i)

    // latest.json points at the terminal status (proves persistence + index update)
    const latest = await readLatestTicketRun('Pipeline Board', 'PB-12')
    expect(latest?.status).toBe('succeeded')
    expect(latest?.runId).toBe(res.status?.runId)
  })

  it('refuses a second run while one is genuinely running (per-ticket lock)', async () => {
    // Seed an active run for this ticket (the lock the guard must observe).
    await writeTicketRunStatus(freshRunningRun({ runId: 'run-active', ticketId: 'PB-12' }))
    const res = await startGuardedTicketRun(project, 'PB-12')
    expect(res.started).toBe(false)
    expect(res.reason).toBe('already-running')
    // latest is unchanged — the active run was not overwritten.
    expect((await readLatestTicketRun('Pipeline Board', 'PB-12'))?.runId).toBe('run-active')
  })

  it('is NOT blocked by a stale running run (coerced to failed on read)', async () => {
    const old = new Date(Date.now() - (RUN_STALE_MS + 60_000)).toISOString()
    await writeTicketRunStatus(
      freshRunningRun({ runId: 'run-stale', ticketId: 'PB-12', startedAt: old, updatedAt: old }),
    )
    const res = await startGuardedTicketRun(project, 'PB-12')
    expect(res.started).toBe(true)
    expect(res.status?.status).toBe('succeeded')
    expect(res.status?.runId).not.toBe('run-stale')
  })

  it('defaults createPr to true and honors createPr: false', async () => {
    const def = await startGuardedTicketRun(project, 'PB-1')
    expect(def.status?.createPr).toBe(true)
    const off = await startGuardedTicketRun(project, 'PB-2', undefined, { createPr: false })
    expect(off.status?.createPr).toBe(false)
  })

  it('keys an epic child separately from a same-leaf solo', async () => {
    const child = await startGuardedTicketRun(project, 'PB-13', 'PB-11')
    const solo = await startGuardedTicketRun(project, 'PB-13')
    expect(child.status?.parentEpicId).toBe('PB-11')
    expect(solo.status?.parentEpicId).toBeUndefined()
    // Each resolves to its own latest entry — no collision.
    expect((await readLatestTicketRun('Pipeline Board', 'PB-13', 'PB-11'))?.runId).toBe(
      child.status?.runId,
    )
    expect((await readLatestTicketRun('Pipeline Board', 'PB-13'))?.runId).toBe(solo.status?.runId)
  })
})

// ── PB-15: flow adapter (pure — no spawning) ──────────────────────────────────

describe('buildFlowArgs', () => {
  it('builds the /feature:flow <id> --pr vector with the runner allowlist and a capable default model', () => {
    const args = buildFlowArgs('PB-1', { createPr: true })
    expect(args.slice(0, 3)).toEqual(['-p', '/feature:flow PB-1 --pr', '--allowedTools'])
    expect(args.slice(-2)).toEqual(['--model', 'opus'])
    // the runner's OWN broader allowlist (vs sync's narrow one)
    expect(args).toContain('Skill')
    expect(args).toContain('Task')
    expect(args).toContain('Write')
    expect(args).toContain('Edit')
    expect(args).toContain('Bash(git:*)')
    expect(args).toContain('Bash(gh:*)')
    expect(args).toContain('Bash(npm:*)')
  })

  it('defaults createPr to true (the v1 UI always requests a PR)', () => {
    expect(buildFlowArgs('PB-1')[1]).toBe('/feature:flow PB-1 --pr')
  })

  it('omits --pr when createPr is false', () => {
    expect(buildFlowArgs('PB-1', { createPr: false })[1]).toBe('/feature:flow PB-1')
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

// ── PB-15: env gate + per-project lock (no spawning — gate stays at dry/preflight-fail) ─

describe('env gate (PIPELINE_BOARD_ENABLE_RUNS)', () => {
  it('with the flag unset, takes the dry-run branch (dryRun, succeeded, no spawn)', async () => {
    // flag unset by default (afterEach clears it)
    const res = await startGuardedTicketRun(project, 'PB-1')
    expect(res.started).toBe(true)
    expect(res.status?.dryRun).toBe(true)
    expect(res.status?.status).toBe('succeeded')
    expect(res.status?.finishedAt).not.toBeNull()
    expect(res.status?.logTail).toMatch(/dry run/i)
  })

  it('with the flag set to a non-"1" value, still dry-runs (strict exact match, fail-safe)', async () => {
    process.env.PIPELINE_BOARD_ENABLE_RUNS = '0'
    expect((await startGuardedTicketRun(project, 'PB-1')).status?.dryRun).toBe(true)
    process.env.PIPELINE_BOARD_ENABLE_RUNS = 'true'
    expect((await startGuardedTicketRun(project, 'PB-2')).status?.dryRun).toBe(true)
    process.env.PIPELINE_BOARD_ENABLE_RUNS = ' 1 '
    expect((await startGuardedTicketRun(project, 'PB-3')).status?.dryRun).toBe(true)
  })
})

describe('per-project real-flow lock', () => {
  // `project.path` ('/tmp/does-not-matter') has no claudedocs/tickets/, so any live continuation
  // short-circuits at runRealFlow's preflight → it writes a `failed` terminal status WITHOUT ever
  // spawning `claude`. We assert only the synchronous guard return, which is deterministic.

  it('refuses a second REAL flow in the same project (project-busy)', async () => {
    process.env.PIPELINE_BOARD_ENABLE_RUNS = '1'
    // Seed an active REAL run for one ticket in the project.
    await writeTicketRunStatus(
      freshRunningRun({ runId: 'run-real', ticketId: 'PB-1', dryRun: false }),
    )
    const res = await startGuardedTicketRun(project, 'PB-2')
    expect(res.started).toBe(false)
    expect(res.reason).toBe('project-busy')
    // The active run was not overwritten.
    expect((await readLatestTicketRun('Pipeline Board', 'PB-1'))?.runId).toBe('run-real')
  })

  it('does NOT count a DRY running run toward the project lock', async () => {
    process.env.PIPELINE_BOARD_ENABLE_RUNS = '1'
    // A dry running run (dryRun: true) must not block a real start.
    await writeTicketRunStatus(
      freshRunningRun({ runId: 'run-dry', ticketId: 'PB-1', dryRun: true }),
    )
    const res = await startGuardedTicketRun(project, 'PB-2')
    expect(res.started).toBe(true)
    expect(res.reason).toBeUndefined()
    expect(res.status?.dryRun).toBe(false) // armed: a real seed
    expect(res.status?.status).toBe('running') // live seed returns running (fire-and-forget)
    await awaitTerminal(res.status?.runId) // let the no-spawn continuation finish before teardown
  })

  it('does NOT count a STALE real run toward the project lock (coerced to failed)', async () => {
    process.env.PIPELINE_BOARD_ENABLE_RUNS = '1'
    const old = new Date(Date.now() - (RUN_STALE_MS + 60_000)).toISOString()
    await writeTicketRunStatus(
      freshRunningRun({
        runId: 'run-stale-real',
        ticketId: 'PB-1',
        dryRun: false,
        startedAt: old,
        updatedAt: old,
      }),
    )
    const res = await startGuardedTicketRun(project, 'PB-2')
    expect(res.started).toBe(true)
    expect(res.reason).toBeUndefined()
    await awaitTerminal(res.status?.runId) // let the no-spawn continuation finish before teardown
  })

  it('does not apply the project lock to a DRY (gate-off) start', async () => {
    // Gate off → no per-project lock at all; a real run elsewhere is irrelevant to a dry start.
    await writeTicketRunStatus(
      freshRunningRun({ runId: 'run-real-2', ticketId: 'PB-1', dryRun: false }),
    )
    const res = await startGuardedTicketRun(project, 'PB-2')
    expect(res.started).toBe(true)
    expect(res.status?.dryRun).toBe(true)
  })
})
