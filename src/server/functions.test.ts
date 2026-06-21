import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TICKET_ID_RE } from './functions'
import { ticketExists, validateProjectPath } from './scanner'
import type { Project } from './types'

let root: string

/** Lay down a ticket folder with an `01-spec.md`, mirroring scanner.test.ts's writeTicket. */
async function writeTicket(state: string, id: string, files: Record<string, string> = {}): Promise<void> {
  const dir = join(root, 'claudedocs', 'tickets', state, id)
  await fs.mkdir(dir, { recursive: true })
  const all = { '01-spec.md': '---\nid: x\n---\nbody\n', ...files }
  for (const [name, content] of Object.entries(all)) {
    await fs.writeFile(join(dir, name), content, 'utf8')
  }
}

const proj = (): Project => ({ name: 'Fixture', path: root })

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'pb-fn-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('validateProjectPath', () => {
  it('rejects a non-existent path', async () => {
    const res = await validateProjectPath(join(root, 'nope'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/does not exist/)
  })

  it('rejects a file (not a directory)', async () => {
    const file = join(root, 'afile')
    await fs.writeFile(file, 'x', 'utf8')
    const res = await validateProjectPath(file)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Not a directory/)
  })

  it('rejects a directory without claudedocs/tickets', async () => {
    const res = await validateProjectPath(root)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/feature-pipeline project/)
  })

  it('accepts a directory containing claudedocs/tickets (even if empty of tickets)', async () => {
    await fs.mkdir(join(root, 'claudedocs', 'tickets'), { recursive: true })
    const res = await validateProjectPath(root)
    expect(res.ok).toBe(true)
  })
})

describe('ticketExists', () => {
  it('finds a solo ticket in backlog/', async () => {
    await writeTicket('backlog', 'PB-1')
    expect(await ticketExists(proj(), 'PB-1')).toBe(true)
  })

  it('finds a ticket in any state folder (e.g. review/)', async () => {
    await writeTicket('review', 'PB-2')
    expect(await ticketExists(proj(), 'PB-2')).toBe(true)
  })

  it('finds an epic child via parentEpicId', async () => {
    await writeTicket('review', join('PB-11', 'tasks', 'PB-13'))
    expect(await ticketExists(proj(), 'PB-13', 'PB-11')).toBe(true)
    // Same leaf id without the parent does NOT resolve to the child.
    expect(await ticketExists(proj(), 'PB-13')).toBe(false)
  })

  it('returns false for a missing ticket', async () => {
    await fs.mkdir(join(root, 'claudedocs', 'tickets'), { recursive: true })
    expect(await ticketExists(proj(), 'PB-404')).toBe(false)
  })

  it('returns false (never escapes the tree) for an unsafe/traversal id', async () => {
    await writeTicket('backlog', 'PB-1')
    expect(await ticketExists(proj(), '../../../../etc')).toBe(false)
    expect(await ticketExists(proj(), 'PB-1', '../..')).toBe(false)
  })

  it('does not match a same-named file (existence is folder-level)', async () => {
    await fs.mkdir(join(root, 'claudedocs', 'tickets', 'backlog'), { recursive: true })
    await fs.writeFile(join(root, 'claudedocs', 'tickets', 'backlog', 'PB-1'), 'x', 'utf8')
    expect(await ticketExists(proj(), 'PB-1')).toBe(false)
  })
})

describe('TICKET_ID_RE (boundary gate)', () => {
  // This regex is the real validation barrier for startTicketRun/getTicketRunStatus
  // and the defense-in-depth gate for PB-15's command interpolation. Lock its
  // accept/reject behavior directly so it can't silently drift.
  it('accepts well-formed ids', () => {
    for (const id of ['PB-13', 'PB-1', 'ABC-123', 'A1-9', 'XY9Z-42']) {
      expect(TICKET_ID_RE.test(id)).toBe(true)
    }
  })

  it('rejects malformed / unsafe ids (lowercase, no hyphen, traversal, separators, empty)', () => {
    for (const id of [
      'pb-13', // lowercase prefix
      'PB13', // no hyphen
      'PB-', // no number
      '-13', // no prefix
      '1PB-3', // must start with a letter
      'PB-13/x', // embedded slash (path separator)
      'PB-13\\x', // embedded backslash
      '../PB-13', // traversal
      'PB-13 ', // trailing space
      'PB-1.3', // dot
      '', // empty
    ]) {
      expect(TICKET_ID_RE.test(id)).toBe(false)
    }
  })
})
