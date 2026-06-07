import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deriveColumn,
  deriveStage,
  detectStaleFolder,
  expectedFolderForStatus,
  getArtifactFromRoot,
  isAllowedArtifactName,
  parseSpecFrontmatter,
  scanProjectRoot,
  stripFrontmatter,
} from './scanner'
import type { Project, ProjectScanResult, TicketDTO } from './types'

// ---- pure-function tests -------------------------------------------------

describe('deriveStage', () => {
  it('returns spec when only 01-spec is present', () => {
    expect(deriveStage(['01-spec.md'])).toBe('spec')
  })
  it('returns the furthest artifact reached', () => {
    expect(deriveStage(['01-spec.md', '02-plan.md', '03-implementation.md'])).toBe('implementation')
    expect(deriveStage(['01-spec.md', '02-plan.md', '06-summary.md'])).toBe('summary')
  })
})

describe('expectedFolderForStatus', () => {
  it('maps the three done-family statuses to the done folder', () => {
    expect(expectedFolderForStatus('done')).toBe('done')
    expect(expectedFolderForStatus('partial-completion')).toBe('done')
    expect(expectedFolderForStatus('cancelled')).toBe('done')
  })
})

describe('deriveColumn', () => {
  it('derives the column from status when present (solo or child)', () => {
    expect(deriveColumn('in-review', 'in-progress', false)).toBe('review')
    expect(deriveColumn('done', 'in-progress', true)).toBe('done')
  })
  it('falls back to the physical folder for a degraded solo', () => {
    expect(deriveColumn(null, 'in-progress', false)).toBe('in-progress')
  })
  it('falls back to Backlog for a degraded child', () => {
    expect(deriveColumn(null, 'review', true)).toBe('backlog')
  })
})

describe('detectStaleFolder', () => {
  it('flags a solo whose status points at a different folder', () => {
    expect(detectStaleFolder('done', 'in-progress', false)).toBe(true)
    expect(detectStaleFolder('in-review', 'review', false)).toBe(false)
  })
  it('never flags an epic child (folder is the epic’s by design)', () => {
    expect(detectStaleFolder('done', 'in-progress', true)).toBe(false)
  })
  it('never flags a null status (degraded card)', () => {
    expect(detectStaleFolder(null, 'backlog', false)).toBe(false)
  })
})

describe('parseSpecFrontmatter', () => {
  it('parses and validates known fields', () => {
    const meta = parseSpecFrontmatter(
      '---\ntitle: Hello\npriority: high\ncomplexity: L\nstatus: in-progress\ntags: [a, b]\n---\nbody',
    )
    expect(meta).toMatchObject({
      title: 'Hello',
      priority: 'high',
      complexity: 'L',
      status: 'in-progress',
      tags: ['a', 'b'],
      metadataError: false,
    })
  })
  it('drops unknown enum values to null', () => {
    const meta = parseSpecFrontmatter('---\ntitle: X\npriority: urgent\ncomplexity: XXL\nstatus: done\n---\n')
    expect(meta.priority).toBeNull()
    expect(meta.complexity).toBeNull()
    expect(meta.status).toBe('done')
  })
  it('flags metadataError when no title and no status', () => {
    expect(parseSpecFrontmatter('---\npriority: high\n---\n').metadataError).toBe(true)
  })
  it('flags metadataError on broken YAML', () => {
    expect(parseSpecFrontmatter('---\nstatus: [oops\n---\nbody').metadataError).toBe(true)
  })
})

describe('stripFrontmatter', () => {
  it('removes a YAML frontmatter block and leading blank lines', () => {
    const out = stripFrontmatter('---\ntitle: X\nstatus: done\n---\n\n## Body\ntext')
    expect(out.startsWith('## Body')).toBe(true)
    expect(out).not.toContain('title: X')
  })
  it('leaves content without frontmatter unchanged', () => {
    expect(stripFrontmatter('# Plan\n- step')).toBe('# Plan\n- step')
  })
})

describe('isAllowedArtifactName', () => {
  it('accepts known artifacts', () => {
    expect(isAllowedArtifactName('01-spec.md')).toBe(true)
    expect(isAllowedArtifactName('06-summary.md')).toBe(true)
    expect(isAllowedArtifactName('exploration.md')).toBe(true)
    expect(isAllowedArtifactName('prd.md')).toBe(true)
  })
  it('rejects traversal and arbitrary files', () => {
    expect(isAllowedArtifactName('../secret.md')).toBe(false)
    expect(isAllowedArtifactName('../../etc/passwd')).toBe(false)
    expect(isAllowedArtifactName('notes.txt')).toBe(false)
  })
})

// ---- filesystem scan tests ----------------------------------------------

function spec(fields: Record<string, string | undefined>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
  return `---\n${lines.join('\n')}\n---\n\n# body\n`
}

let root: string
let result: ProjectScanResult

async function writeTicket(state: string, id: string, files: Record<string, string>) {
  const dir = join(root, 'claudedocs', 'tickets', state, id)
  await fs.mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(join(dir, name), content, 'utf8')
  }
}

const byId = (r: ProjectScanResult, id: string): TicketDTO | undefined =>
  r.tickets.find((t) => t.id === id)

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'pb-scan-'))

  await writeTicket('backlog', 'PB-10', { '01-spec.md': spec({ title: 'Ten', status: 'backlog', priority: 'high', complexity: 'M' }) })
  await writeTicket('in-progress', 'PB-11', {
    '01-spec.md': spec({ title: 'Eleven', status: 'in-progress' }),
    '02-plan.md': '# plan',
    '03-implementation.md': '# impl',
  })
  await writeTicket('review', 'PB-12', {
    '01-spec.md': spec({ title: 'Twelve', status: 'in-review' }),
    '02-plan.md': '# p',
    '03-implementation.md': '# i',
    '04-review.md': '# r',
    '05-tests.md': '# t',
    '06-summary.md': '# s',
  })
  await writeTicket('done', 'PB-13', { '01-spec.md': spec({ title: 'Thirteen', status: 'done' }) })
  await writeTicket('done', 'PB-14', { '01-spec.md': spec({ title: 'Fourteen', status: 'partial-completion' }) })
  // stale folder (solo): status done but sitting in in-progress → shows in Done
  await writeTicket('in-progress', 'PB-15', { '01-spec.md': spec({ title: 'Fifteen', status: 'done' }) })
  // broken frontmatter → degraded card
  await writeTicket('in-progress', 'PB-16', { '01-spec.md': '---\nstatus: [oops\n---\nbody' })
  // epic in backlog/ whose children carry differing statuses — all physically in
  // backlog/EPIC-1/tasks/ but each lands in its status-derived column.
  await writeTicket('backlog', 'EPIC-1', { 'prd.md': spec({ title: 'Epic', kind: 'epic', status: 'backlog' }) })
  await writeTicket('backlog', join('EPIC-1', 'tasks', 'PB-20'), { '01-spec.md': spec({ title: 'Child A', status: 'backlog' }) })
  await writeTicket('backlog', join('EPIC-1', 'tasks', 'PB-21'), { '01-spec.md': spec({ title: 'Child B', status: 'in-progress' }) })
  await writeTicket('backlog', join('EPIC-1', 'tasks', 'PB-22'), {
    '01-spec.md': spec({ title: 'Child C', status: 'done' }),
    '02-plan.md': '# p',
  })
  // degraded child (broken frontmatter) → Backlog, metadata-error, never dropped
  await writeTicket('backlog', join('EPIC-1', 'tasks', 'PB-23'), { '01-spec.md': '---\nstatus: [oops\n---\nbody' })
  // nested epic / child without 01-spec.md → skipped, not recursed
  await writeTicket('backlog', join('EPIC-1', 'tasks', 'PB-24'), { 'prd.md': spec({ title: 'Nested', kind: 'epic', status: 'backlog' }) })
  // malformed epic: no tasks/ at all → no children, no crash
  await writeTicket('in-progress', 'EPIC-EMPTY', { 'prd.md': spec({ title: 'Empty epic', kind: 'epic', status: 'in-progress' }) })
  // unknown dir (no spec, no prd) → skipped
  await fs.mkdir(join(root, 'claudedocs', 'tickets', 'backlog', 'PB-99'), { recursive: true })
  // hidden dir → skipped
  await writeTicket('backlog', '.hidden', { '01-spec.md': spec({ title: 'Hidden', status: 'backlog' }) })

  const project: Project = { name: 'fix', path: root }
  result = await scanProjectRoot(project)
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('scanProjectRoot', () => {
  it('surfaces the solo tickets and epic children (skips epics/no-spec/unknown/hidden)', () => {
    expect(result.error).toBeNull()
    expect(result.tickets.map((t) => t.id).sort()).toEqual([
      // 7 solos
      'PB-10', 'PB-11', 'PB-12', 'PB-13', 'PB-14', 'PB-15', 'PB-16',
      // 4 epic children that carry a spec (PB-24 has no 01-spec.md → skipped;
      // EPIC-1 / EPIC-EMPTY are epics → never rendered as cards)
      'PB-20', 'PB-21', 'PB-22', 'PB-23',
    ])
  })

  it('places each solo ticket in its status-derived column', () => {
    expect(byId(result, 'PB-10')?.column).toBe('backlog')
    expect(byId(result, 'PB-11')?.column).toBe('in-progress')
    expect(byId(result, 'PB-12')?.column).toBe('review')
    expect(byId(result, 'PB-13')?.column).toBe('done')
    // status-derived: PB-15 is status:done parked in in-progress/ → shows in Done
    expect(byId(result, 'PB-15')?.column).toBe('done')
  })

  it('places epic children in status-derived columns and tags the parent epic', () => {
    // All three live physically in backlog/EPIC-1/tasks/ but land per status.
    expect(byId(result, 'PB-20')?.column).toBe('backlog')
    expect(byId(result, 'PB-21')?.column).toBe('in-progress')
    expect(byId(result, 'PB-22')?.column).toBe('done')
    expect(byId(result, 'PB-20')?.parentEpicId).toBe('EPIC-1')
    expect(byId(result, 'PB-22')?.parentEpicId).toBe('EPIC-1')
    // child stage still derives from its own artifacts
    expect(byId(result, 'PB-22')?.derivedStage).toBe('plan')
  })

  it('degrades a child with unparseable frontmatter into Backlog, never dropping it', () => {
    const degraded = byId(result, 'PB-23')
    expect(degraded?.metadataError).toBe(true)
    expect(degraded?.status).toBeNull()
    expect(degraded?.column).toBe('backlog')
    expect(degraded?.parentEpicId).toBe('EPIC-1')
    expect(degraded?.staleFolder).toBe(false)
  })

  it('does not surface a child without 01-spec.md, a nested epic, or the epics themselves', () => {
    expect(byId(result, 'PB-24')).toBeUndefined() // nested epic / no spec
    expect(byId(result, 'EPIC-1')).toBeUndefined()
    expect(byId(result, 'EPIC-EMPTY')).toBeUndefined() // malformed epic (no tasks/) — no crash
  })

  it('derives the pipeline stage from artifacts present', () => {
    expect(byId(result, 'PB-11')?.derivedStage).toBe('implementation')
    expect(byId(result, 'PB-12')?.derivedStage).toBe('summary')
    expect(byId(result, 'PB-10')?.derivedStage).toBe('spec')
  })

  it('flags a stale folder on a solo, and suppresses it for epic children', () => {
    expect(byId(result, 'PB-15')?.staleFolder).toBe(true) // status done, parked in in-progress/
    expect(byId(result, 'PB-11')?.staleFolder).toBe(false)
    // PB-22 is status:done physically in backlog/EPIC-1/tasks/ — divergence is by
    // design for a child, so the stale-folder flag is suppressed.
    expect(byId(result, 'PB-22')?.staleFolder).toBe(false)
  })

  it('renders a degraded solo at its physical folder with the folder name as id', () => {
    const degraded = byId(result, 'PB-16')
    expect(degraded?.metadataError).toBe(true)
    expect(degraded?.title).toBe('PB-16')
    expect(degraded?.column).toBe('in-progress') // degraded solo falls back to its real folder
    expect(degraded?.parentEpicId).toBeUndefined()
  })

  it('lists artifacts present (incl. 01-spec) sorted', () => {
    expect(byId(result, 'PB-12')?.artifacts).toEqual([
      '01-spec.md', '02-plan.md', '03-implementation.md', '04-review.md', '05-tests.md', '06-summary.md',
    ])
  })

  it('returns a missing error for a root without claudedocs/tickets', async () => {
    const missing = await scanProjectRoot({ name: 'gone', path: join(tmpdir(), 'pb-does-not-exist-xyz') })
    expect(missing.error?.kind).toBe('missing')
    expect(missing.tickets).toEqual([])
  })
})

describe('getArtifactFromRoot', () => {
  it('reads an existing artifact', async () => {
    const res = await getArtifactFromRoot({ name: 'fix', path: root }, 'PB-12', '04-review.md')
    expect(res.found).toBe(true)
    expect(res.content).toContain('# r')
  })
  it('strips frontmatter from a spec artifact', async () => {
    const res = await getArtifactFromRoot({ name: 'fix', path: root }, 'PB-10', '01-spec.md')
    expect(res.found).toBe(true)
    expect(res.content).not.toContain('title: Ten')
    expect(res.content).toContain('# body')
  })
  it('returns not-found for a missing artifact', async () => {
    const res = await getArtifactFromRoot({ name: 'fix', path: root }, 'PB-10', '06-summary.md')
    expect(res.found).toBe(false)
  })
  it('reads a nested epic child artifact via parentEpicId', async () => {
    const res = await getArtifactFromRoot({ name: 'fix', path: root }, 'PB-22', '02-plan.md', 'EPIC-1')
    expect(res.found).toBe(true)
    expect(res.content).toContain('# p')
  })
  it('does not find a child artifact without parentEpicId (flat lookup misses the nested path)', async () => {
    const res = await getArtifactFromRoot({ name: 'fix', path: root }, 'PB-22', '02-plan.md')
    expect(res.found).toBe(false)
  })
  it('rejects a traversal parentEpicId', async () => {
    const res = await getArtifactFromRoot({ name: 'fix', path: root }, 'PB-22', '02-plan.md', '../../etc')
    expect(res.found).toBe(false)
    expect(res.error).toMatch(/Invalid/)
  })
  it('rejects a disallowed / traversal filename', async () => {
    const res = await getArtifactFromRoot({ name: 'fix', path: root }, 'PB-10', '../../../etc/passwd')
    expect(res.found).toBe(false)
    expect(res.error).toMatch(/Invalid/)
  })
})
