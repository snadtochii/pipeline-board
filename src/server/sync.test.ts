import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SYNC_STALE_MS,
  buildSyncArgs,
  isSyncRunning,
  parseSyncReport,
  readSyncStatus,
  writeStatus,
} from './sync'
import type { SyncRunStatus } from './types'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'pb-sync-'))
  process.env.PIPELINE_BOARD_CONFIG_DIR = dir
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  delete process.env.PIPELINE_BOARD_CONFIG_DIR
})

// Verbatim shapes from the validated 2026-06-08 prototype run.
const REPORT_PROMOTED_AND_OPEN = `PB-4 finalized to \`done/\`. Here's the report.

## Sync — 2 in-review ticket(s) checked

**✓ Promoted to done/ (1):**
- **PB-4** — PR #5 merged → moved \`review/ → done/\`

**… Still open (1):**
- **PB-5** — PR still open, left as-is

No tickets needed attention and nothing was uncheckable.`

const REPORT_OPEN_ONLY = `## Sync — 1 in-review ticket checked

**… Still open (1):**
- **BL-43** — PR open`

const REPORT_NO_IN_REVIEW = `No ticket has \`status: in-review\`.

**No in-review tickets.**

Sync checked all 14 tickets; none carry \`status: in-review\`, so there are no PRs to reconcile.`

const REPORT_ATTENTION_AND_CHECK = `## Sync

**✓ Promoted to done/ (2):**
**⚠ Needs attention (3):**
**? Couldn't check (1):**`

describe('parseSyncReport', () => {
  it('parses promoted + open counts', () => {
    expect(parseSyncReport(REPORT_PROMOTED_AND_OPEN)).toEqual({
      promoted: 1,
      open: 1,
      needsAttention: 0,
      couldntCheck: 0,
    })
  })

  it('parses an open-only report', () => {
    expect(parseSyncReport(REPORT_OPEN_ONLY)).toEqual({
      promoted: 0,
      open: 1,
      needsAttention: 0,
      couldntCheck: 0,
    })
  })

  it('treats a "no in-review" report as all-zero (valid, not a parse failure)', () => {
    expect(parseSyncReport(REPORT_NO_IN_REVIEW)).toEqual({
      promoted: 0,
      open: 0,
      needsAttention: 0,
      couldntCheck: 0,
    })
  })

  it('parses needs-attention and couldn’t-check counts', () => {
    expect(parseSyncReport(REPORT_ATTENTION_AND_CHECK)).toEqual({
      promoted: 2,
      open: 0,
      needsAttention: 3,
      couldntCheck: 1,
    })
  })

  it('returns null for empty text', () => {
    expect(parseSyncReport('')).toBeNull()
    expect(parseSyncReport('   \n  ')).toBeNull()
  })

  it('returns null for text that is not a sync report', () => {
    expect(parseSyncReport('Fatal error: command not found')).toBeNull()
  })
})

function freshRunning(): SyncRunStatus {
  const now = new Date().toISOString()
  return {
    runId: 'sync-test',
    startedAt: now,
    finishedAt: null,
    status: 'running',
    workspaces: [
      { name: 'alpha', path: '/repos/alpha', state: 'running', startedAt: now, finishedAt: null, outcome: null },
      { name: 'beta', path: '/repos/beta', state: 'pending', startedAt: null, finishedAt: null, outcome: null },
    ],
  }
}

describe('readSyncStatus', () => {
  it('returns null when no status file exists ("never synced")', async () => {
    expect(await readSyncStatus()).toBeNull()
  })

  it('returns null on corrupt JSON rather than throwing', async () => {
    await fs.writeFile(join(dir, 'last-sync.json'), '{ not json', 'utf8')
    expect(await readSyncStatus()).toBeNull()
  })

  it('returns null on wrong-shape JSON', async () => {
    await fs.writeFile(join(dir, 'last-sync.json'), JSON.stringify({ foo: 1 }), 'utf8')
    expect(await readSyncStatus()).toBeNull()
  })

  it('round-trips a written status', async () => {
    const status = freshRunning()
    await writeStatus(status)
    expect(await readSyncStatus()).toEqual(status)
  })

  it('atomic write leaves no temp file behind', async () => {
    await writeStatus(freshRunning())
    const files = await fs.readdir(dir)
    expect(files).toEqual(['last-sync.json'])
  })

  it('keeps a fresh running status as running', async () => {
    await writeStatus(freshRunning())
    const read = await readSyncStatus()
    expect(read?.status).toBe('running')
    expect(isSyncRunning(read)).toBe(true)
  })

  it('coerces a stale running status (and its unfinished workspaces) to failed', async () => {
    const old = new Date(Date.now() - (SYNC_STALE_MS + 60_000)).toISOString()
    const stale: SyncRunStatus = {
      runId: 'sync-stale',
      startedAt: old,
      finishedAt: null,
      status: 'running',
      workspaces: [
        { name: 'alpha', path: '/repos/alpha', state: 'done', startedAt: old, finishedAt: old, outcome: { promoted: 0, open: 0, needsAttention: 0, couldntCheck: 0 } },
        { name: 'beta', path: '/repos/beta', state: 'running', startedAt: old, finishedAt: null, outcome: null },
      ],
    }
    await writeStatus(stale)
    const read = await readSyncStatus()
    expect(read?.status).toBe('failed')
    expect(isSyncRunning(read)).toBe(false)
    expect(read?.workspaces[1]?.state).toBe('failed')
    expect(read?.workspaces[1]?.error).toMatch(/stale/i)
    // A workspace that already finished is left untouched.
    expect(read?.workspaces[0]?.state).toBe('done')
  })
})

describe('buildSyncArgs', () => {
  it('defaults to sonnet when no model is given', () => {
    const args = buildSyncArgs(undefined)
    expect(args.slice(0, 3)).toEqual(['-p', '/feature:sync', '--allowedTools'])
    expect(args.slice(-2)).toEqual(['--model', 'sonnet'])
    // least-privilege allowlist is present, no bypassPermissions
    expect(args).toContain('Bash(gh:*)')
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  it('honors an explicit CLAUDE_MODEL override', () => {
    expect(buildSyncArgs('haiku').slice(-2)).toEqual(['--model', 'haiku'])
    expect(buildSyncArgs('claude-haiku-4-5-20251001').slice(-2)).toEqual([
      '--model',
      'claude-haiku-4-5-20251001',
    ])
  })

  it('falls back to the default on blank/whitespace model', () => {
    expect(buildSyncArgs('   ').slice(-2)).toEqual(['--model', 'sonnet'])
    expect(buildSyncArgs('').slice(-2)).toEqual(['--model', 'sonnet'])
  })
})

describe('isSyncRunning', () => {
  it('is false for null and for terminal statuses', () => {
    expect(isSyncRunning(null)).toBe(false)
    const s = freshRunning()
    expect(isSyncRunning({ ...s, status: 'done' })).toBe(false)
    expect(isSyncRunning({ ...s, status: 'failed' })).toBe(false)
    expect(isSyncRunning(s)).toBe(true)
  })
})
