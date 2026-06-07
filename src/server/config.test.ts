import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addProject, loadProjects, removeProject, saveProjects } from './config'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'pb-cfg-'))
  process.env.PIPELINE_BOARD_CONFIG_DIR = dir
  delete process.env.PIPELINE_BOARD_PROJECTS
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  delete process.env.PIPELINE_BOARD_CONFIG_DIR
  delete process.env.PIPELINE_BOARD_PROJECTS
})

describe('config', () => {
  it('returns an empty list when no config exists', async () => {
    expect(await loadProjects()).toEqual([])
  })

  it('adds a project and persists it across loads', async () => {
    await addProject({ path: '/repos/alpha', name: 'Alpha' })
    expect(await loadProjects()).toEqual([{ path: '/repos/alpha', name: 'Alpha' }])
  })

  it('defaults the name to the path basename', async () => {
    await addProject({ path: '/repos/big-leaves' })
    const [p] = await loadProjects()
    expect(p).toEqual({ path: '/repos/big-leaves', name: 'big-leaves' })
  })

  it('dedupes adds of the same path (no-op)', async () => {
    await addProject({ path: '/repos/alpha', name: 'Alpha' })
    await addProject({ path: '/repos/alpha', name: 'Renamed' })
    const projects = await loadProjects()
    expect(projects).toHaveLength(1)
    expect(projects[0]?.name).toBe('Alpha') // first add wins
  })

  it('removes a project by path', async () => {
    await addProject({ path: '/repos/alpha' })
    await addProject({ path: '/repos/beta' })
    const after = await removeProject('/repos/alpha')
    expect(after.map((p) => p.path)).toEqual(['/repos/beta'])
    expect((await loadProjects()).map((p) => p.path)).toEqual(['/repos/beta'])
  })

  it('recovers from corrupt JSON by backing it up and starting empty', async () => {
    await fs.writeFile(join(dir, 'projects.json'), '{ not json', 'utf8')
    expect(await loadProjects()).toEqual([])
    const files = await fs.readdir(dir)
    expect(files.some((f) => f.startsWith('projects.corrupt-'))).toBe(true)
  })

  it('ignores non-array / malformed entries gracefully', async () => {
    await saveProjects([{ path: '/repos/alpha', name: 'Alpha' }])
    // hand-write a file mixing a valid and an invalid entry
    await fs.writeFile(
      join(dir, 'projects.json'),
      JSON.stringify([{ path: '/repos/alpha', name: 'Alpha' }, { nope: true }, 42]),
      'utf8',
    )
    expect(await loadProjects()).toEqual([{ path: '/repos/alpha', name: 'Alpha' }])
  })

  it('seeds from PIPELINE_BOARD_PROJECTS on first run and persists it', async () => {
    process.env.PIPELINE_BOARD_PROJECTS = '/repos/alpha, /repos/beta'
    const seeded = await loadProjects()
    expect(seeded.map((p) => p.path)).toEqual(['/repos/alpha', '/repos/beta'])
    // persisted, so a second load (without the env in effect) still returns them
    delete process.env.PIPELINE_BOARD_PROJECTS
    expect((await loadProjects()).map((p) => p.path)).toEqual([
      '/repos/alpha',
      '/repos/beta',
    ])
  })
})
