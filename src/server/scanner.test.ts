import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deriveStage,
  detectMismatch,
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

describe('mismatch detection', () => {
  it('maps the three done-family statuses to the done folder', () => {
    expect(expectedFolderForStatus('done')).toBe('done')
    expect(expectedFolderForStatus('partial-completion')).toBe('done')
    expect(expectedFolderForStatus('cancelled')).toBe('done')
  })
  it('flags a status that points at a different folder', () => {
    expect(detectMismatch('done', 'in-progress')).toBe(true)
    expect(detectMismatch('in-review', 'review')).toBe(false)
  })
  it('never flags a null status (degraded card)', () => {
    expect(detectMismatch(null, 'backlog')).toBe(false)
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
  // status/folder mismatch: status done but sitting in in-progress
  await writeTicket('in-progress', 'PB-15', { '01-spec.md': spec({ title: 'Fifteen', status: 'done' }) })
  // broken frontmatter → degraded card
  await writeTicket('in-progress', 'PB-16', { '01-spec.md': '---\nstatus: [oops\n---\nbody' })
  // epic → skipped, child must NOT surface
  await writeTicket('backlog', 'EPIC-1', { 'prd.md': spec({ title: 'Epic', kind: 'epic', status: 'backlog' }) })
  await writeTicket('backlog', join('EPIC-1', 'tasks', 'PB-20'), { '01-spec.md': spec({ title: 'Child', status: 'backlog' }) })
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
  it('surfaces exactly the seven solo tickets (skips epic/child/unknown/hidden)', () => {
    expect(result.error).toBeNull()
    expect(result.tickets.map((t) => t.id).sort()).toEqual([
      'PB-10', 'PB-11', 'PB-12', 'PB-13', 'PB-14', 'PB-15', 'PB-16',
    ])
  })

  it('places each ticket in its folder column', () => {
    expect(byId(result, 'PB-10')?.column).toBe('backlog')
    expect(byId(result, 'PB-11')?.column).toBe('in-progress')
    expect(byId(result, 'PB-12')?.column).toBe('review')
    expect(byId(result, 'PB-13')?.column).toBe('done')
  })

  it('derives the pipeline stage from artifacts present', () => {
    expect(byId(result, 'PB-11')?.derivedStage).toBe('implementation')
    expect(byId(result, 'PB-12')?.derivedStage).toBe('summary')
    expect(byId(result, 'PB-10')?.derivedStage).toBe('spec')
  })

  it('flags a status/folder mismatch', () => {
    expect(byId(result, 'PB-15')?.mismatch).toBe(true)
    expect(byId(result, 'PB-11')?.mismatch).toBe(false)
  })

  it('renders a degraded card with the folder name as id', () => {
    const degraded = byId(result, 'PB-16')
    expect(degraded?.metadataError).toBe(true)
    expect(degraded?.title).toBe('PB-16')
    expect(degraded?.column).toBe('in-progress')
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
  it('rejects a disallowed / traversal filename', async () => {
    const res = await getArtifactFromRoot({ name: 'fix', path: root }, 'PB-10', '../../../etc/passwd')
    expect(res.found).toBe(false)
    expect(res.error).toMatch(/Invalid/)
  })
})
