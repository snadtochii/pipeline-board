import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Project } from './types'

// The board's OWN config (the list of project roots to show). This is app
// config, not ticket data — it lives in the user's home dir so it stays out of
// any project tree (and out of the git-ignored claudedocs/). All ticket state
// is still derived from the filesystem; nothing about tickets is persisted here.

export function configDir(): string {
  return process.env.PIPELINE_BOARD_CONFIG_DIR ?? join(homedir(), '.pipeline-board')
}

function configFile(): string {
  return join(configDir(), 'projects.json')
}

function normalizeProject(p: { path: string; name?: string }): Project {
  const name = p.name?.trim()
  return { path: p.path, name: name && name.length > 0 ? name : basename(p.path) }
}

function isProjectish(x: unknown): x is { path: string; name?: string } {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { path?: unknown }).path === 'string'
  )
}

function dedupe(projects: Project[]): Project[] {
  const seen = new Set<string>()
  const out: Project[] = []
  for (const p of projects) {
    if (seen.has(p.path)) continue
    seen.add(p.path)
    out.push(p)
  }
  return out
}

/** First-run seed: PIPELINE_BOARD_PROJECTS = comma-separated absolute paths. */
function seedFromEnv(): Project[] {
  const raw = process.env.PIPELINE_BOARD_PROJECTS
  if (!raw) return []
  return dedupe(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((path) => normalizeProject({ path })),
  )
}

async function backupCorrupt(text: string): Promise<void> {
  try {
    await fs.mkdir(configDir(), { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await fs.writeFile(join(configDir(), `projects.corrupt-${stamp}.json`), text, 'utf8')
  } catch {
    // best effort — never throw from a backup attempt
  }
}

export async function loadProjects(): Promise<Project[]> {
  let text: string
  try {
    text = await fs.readFile(configFile(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No config yet — seed from env on first run, persist if non-empty.
      const seeded = seedFromEnv()
      if (seeded.length > 0) await saveProjects(seeded)
      return seeded
    }
    throw err
  }

  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return dedupe(parsed.filter(isProjectish).map(normalizeProject))
  } catch {
    // Corrupt JSON: preserve it for the user, start clean rather than crash.
    await backupCorrupt(text)
    return []
  }
}

export async function saveProjects(projects: Project[]): Promise<void> {
  const dir = configDir()
  await fs.mkdir(dir, { recursive: true })
  const tmp = join(dir, `projects.json.tmp-${process.pid}`)
  await fs.writeFile(tmp, JSON.stringify(dedupe(projects), null, 2), 'utf8')
  await fs.rename(tmp, configFile()) // atomic replace
}

export async function addProject(p: { path: string; name?: string }): Promise<Project[]> {
  const projects = await loadProjects()
  const next = normalizeProject(p)
  if (projects.some((x) => x.path === next.path)) return projects // dedup no-op
  const updated = [...projects, next]
  await saveProjects(updated)
  return updated
}

export async function removeProject(path: string): Promise<Project[]> {
  const projects = await loadProjects()
  const updated = projects.filter((x) => x.path !== path)
  await saveProjects(updated)
  return updated
}
