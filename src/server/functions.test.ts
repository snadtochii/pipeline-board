import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateProjectPath } from './scanner'

let root: string

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
