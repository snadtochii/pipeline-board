import { createServerFn } from '@tanstack/react-start'
import {
  addProject as addProjectConfig,
  loadProjects,
  removeProject as removeProjectConfig,
} from './config'
import { filesystemTicketSource, validateProjectPath } from './scanner'
import { readSyncStatus, startGuardedRun } from './sync'
import type { ArtifactResult, Project, ProjectScanResult, SyncRunStatus } from './types'

// NOTE: keep this module free of top-level Node-builtin imports (node:fs/os/path)
// and free of plain (non-createServerFn) exports that use them. Client components
// import this module for the server-fn RPC stubs; anything outside a `.handler()`
// body stays in the client bundle and would crash on hydration. All filesystem
// work lives in ./scanner and ./config, reached only inside handler bodies.

export interface AddProjectResult {
  ok: boolean
  error?: string
  projects: Project[]
}

export const listProjects = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Project[]> => loadProjects(),
)

/** Scan every configured project. Per-root errors are isolated — one bad root never blanks the board. */
export const scanAll = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ProjectScanResult[]> => {
    const projects = await loadProjects()
    return Promise.all(
      projects.map(async (p) => {
        try {
          return await filesystemTicketSource.scanProject(p)
        } catch (err) {
          return {
            name: p.name,
            path: p.path,
            error: { kind: 'unreadable' as const, message: String(err) },
            tickets: [],
          }
        }
      }),
    )
  },
)

export const addProject = createServerFn({ method: 'POST' })
  .validator((input: { path: string; name?: string }) => {
    if (!input || typeof input.path !== 'string' || input.path.trim() === '') {
      throw new Error('A project path is required')
    }
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    return { path: input.path.trim(), name: name.length > 0 ? name : undefined }
  })
  .handler(async ({ data }): Promise<AddProjectResult> => {
    const validation = await validateProjectPath(data.path)
    if (!validation.ok) {
      return { ok: false, error: validation.error, projects: await loadProjects() }
    }
    const projects = await addProjectConfig({ path: data.path, name: data.name })
    return { ok: true, projects }
  })

export const removeProject = createServerFn({ method: 'POST' })
  .validator((input: { path: string }) => {
    if (!input || typeof input.path !== 'string' || input.path.trim() === '') {
      throw new Error('A project path is required')
    }
    return { path: input.path }
  })
  .handler(async ({ data }): Promise<Project[]> => removeProjectConfig(data.path))

export const getArtifact = createServerFn({ method: 'GET' })
  .validator(
    (input: {
      projectName: string
      ticketId: string
      filename: string
      parentEpicId?: string
    }) => {
      if (
        !input ||
        typeof input.projectName !== 'string' ||
        typeof input.ticketId !== 'string' ||
        typeof input.filename !== 'string'
      ) {
        throw new Error('projectName, ticketId and filename are required')
      }
      if (input.parentEpicId !== undefined && typeof input.parentEpicId !== 'string') {
        throw new Error('parentEpicId must be a string when provided')
      }
      return input
    },
  )
  .handler(async ({ data }): Promise<ArtifactResult> => {
    const projects = await loadProjects()
    // Resolve by display name (the key the client holds). Names are expected unique;
    // first match wins on the rare collision.
    const project = projects.find((p) => p.name === data.projectName)
    if (!project) return { found: false, content: null, error: 'Unknown project' }
    return filesystemTicketSource.getArtifact(
      project,
      data.ticketId,
      data.filename,
      data.parentEpicId,
    )
  })

// ── Cross-workspace sync (PB-6) ──────────────────────────────────────────────
// Standalone server fns (siblings to listProjects) — NEVER nested or wrapped
// around another server fn (TanStack/router #7213). All node:fs/child_process
// work lives in ./sync, reached only inside these handler bodies.

/** Read the last/active cross-workspace sync run's status (null = never synced). */
export const getSyncStatus = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SyncRunStatus | null> => readSyncStatus(),
)

/**
 * Start a cross-workspace sync run. Non-blocking: guards against an active run,
 * seeds the `running` status synchronously, then fires the (minutes-long) sweep
 * without awaiting it. Progress flows only through last-sync.json, polled by the UI.
 */
export const startSync = createServerFn({ method: 'POST' }).handler(
  async (): Promise<{ started: boolean; reason?: string }> => startGuardedRun(),
)
