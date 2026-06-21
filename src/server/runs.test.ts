import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RUN_STALE_MS,
  isTicketRunAction,
  isTicketRunRunning,
  isTicketRunStatus,
  readLatestTicketRun,
  readTicketRunStatus,
  ticketRunKey,
  writeTicketRunStatus,
} from './runs'
import type { TicketRunStatus } from './types'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'pb-runs-'))
  process.env.PIPELINE_BOARD_CONFIG_DIR = dir
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  delete process.env.PIPELINE_BOARD_CONFIG_DIR
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
