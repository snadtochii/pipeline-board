import { promises as fs } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import matter from 'gray-matter'
import type {
  ArtifactResult,
  Column,
  Complexity,
  DerivedStage,
  Priority,
  Project,
  ProjectScanResult,
  ScanErrorKind,
  TicketDTO,
  TicketStatus,
} from './types'
import { STAGE_ARTIFACTS, STATE_FOLDERS } from './types'
import type { TicketSource } from './ticket-source'

const PRIORITIES: readonly Priority[] = ['low', 'medium', 'high', 'critical']
const COMPLEXITIES: readonly Complexity[] = ['S', 'M', 'L', 'XL']
const STATUSES: readonly TicketStatus[] = [
  'backlog',
  'in-progress',
  'in-review',
  'done',
  'partial-completion',
  'cancelled',
]

// ----------------------------------------------------------------------------
// Pure helpers — unit-tested directly, no filesystem.
// ----------------------------------------------------------------------------

/** The column a ticket belongs in for a given status — the single status→column map. */
export function expectedFolderForStatus(status: TicketStatus): Column {
  switch (status) {
    case 'backlog':
      return 'backlog'
    case 'in-progress':
      return 'in-progress'
    case 'in-review':
      return 'review'
    case 'done':
    case 'partial-completion':
    case 'cancelled':
      return 'done'
  }
}

/**
 * The status-derived display column for a ticket.
 * - status present → its expected column.
 * - degraded child (null status) → backlog (never silently dropped).
 * - degraded solo (null status) → its physical folder (its real on-disk state).
 */
export function deriveColumn(
  status: TicketStatus | null,
  physicalFolder: Column,
  isChild: boolean,
): Column {
  if (status !== null) return expectedFolderForStatus(status)
  return isChild ? 'backlog' : physicalFolder
}

/**
 * True when a ticket's physical folder ≠ its status-derived column (a stale
 * folder — the card shows in a different column than where it physically sits).
 * Suppressed for epic children (their folder is the shared epic's by design) and
 * for degraded cards (null status — don't double-flag).
 */
export function detectStaleFolder(
  status: TicketStatus | null,
  physicalFolder: Column,
  isChild: boolean,
): boolean {
  if (status === null || isChild) return false
  return expectedFolderForStatus(status) !== physicalFolder
}

/** Furthest pipeline stage reached, from the set of present artifact filenames. */
export function deriveStage(presentFiles: readonly string[]): DerivedStage {
  const present = new Set(presentFiles)
  let stage: DerivedStage = 'spec'
  for (const { stage: s, file } of STAGE_ARTIFACTS) {
    if (present.has(file)) stage = s
  }
  return stage
}

/** Markdown artifacts the detail panel may show: 01-spec…06-summary + exploration. */
export function isArtifactName(name: string): boolean {
  return /^0[1-6]-[a-z-]+\.md$/i.test(name) || name === 'exploration.md'
}

/** Whitelist for getArtifact — accepts the artifact set plus prd.md, rejects traversal. */
export function isAllowedArtifactName(name: string): boolean {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false
  return isArtifactName(name) || name === 'prd.md'
}

function isSafeSegment(seg: string): boolean {
  return (
    seg.length > 0 &&
    !seg.includes('/') &&
    !seg.includes('\\') &&
    !seg.includes('..') &&
    !isAbsolute(seg)
  )
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : null
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

export interface ParsedSpecMeta {
  title: string | null
  priority: Priority | null
  complexity: Complexity | null
  status: TicketStatus | null
  tags: string[]
  metadataError: boolean
}

/** Parse `01-spec.md` frontmatter into a normalized, validated shape. */
export function parseSpecFrontmatter(raw: string): ParsedSpecMeta {
  let data: Record<string, unknown>
  try {
    data = matter(raw).data as Record<string, unknown>
  } catch {
    return { title: null, priority: null, complexity: null, status: null, tags: [], metadataError: true }
  }
  const title = typeof data?.title === 'string' ? data.title : null
  const status = asEnum(data?.status, STATUSES)
  return {
    title,
    priority: asEnum(data?.priority, PRIORITIES),
    complexity: asEnum(data?.complexity, COMPLEXITIES),
    status,
    tags: asStringArray(data?.tags),
    // No usable identity/state at all → render as a degraded card.
    metadataError: title === null && status === null,
  }
}

/** Strip leading YAML frontmatter so the detail panel shows the body, not the metadata block. */
export function stripFrontmatter(raw: string): string {
  try {
    return matter(raw).content.replace(/^\n+/, '')
  } catch {
    return raw
  }
}

// ----------------------------------------------------------------------------
// Filesystem layer.
// ----------------------------------------------------------------------------

export type DirKind = 'solo' | 'epic' | 'unknown'

/**
 * Classify a `<state>/<dir>/` folder from its pre-read file listing.
 * Epic = prd.md whose frontmatter `kind: epic`. Takes the already-read `names`
 * so the caller's single readdir is reused (no redundant stat round-trips).
 */
export async function classifyDir(dirPath: string, names: readonly string[]): Promise<DirKind> {
  if (names.includes('prd.md')) {
    try {
      const fmRaw = await fs.readFile(join(dirPath, 'prd.md'), 'utf8')
      if (matter(fmRaw).data?.kind === 'epic') return 'epic'
    } catch {
      // unreadable prd → fall through to spec check
    }
  }
  if (names.includes('01-spec.md')) return 'solo'
  return 'unknown'
}

async function buildTicket(
  dir: string,
  dirName: string,
  folder: Column,
  projectName: string,
  names: readonly string[],
  parentEpicId?: string,
): Promise<TicketDTO> {
  const artifacts = names.filter(isArtifactName).sort()
  const isChild = parentEpicId !== undefined

  let meta: ParsedSpecMeta
  try {
    meta = parseSpecFrontmatter(await fs.readFile(join(dir, '01-spec.md'), 'utf8'))
  } catch {
    meta = { title: null, priority: null, complexity: null, status: null, tags: [], metadataError: true }
  }

  return {
    id: dirName, // folder name IS the ticket id (data contract)
    title: meta.title ?? dirName,
    priority: meta.priority,
    complexity: meta.complexity,
    status: meta.status,
    column: deriveColumn(meta.status, folder, isChild), // status-derived; folder is informational
    derivedStage: deriveStage(names),
    projectName,
    tags: meta.tags,
    ...(parentEpicId !== undefined ? { parentEpicId } : {}),
    artifacts,
    staleFolder: detectStaleFolder(meta.status, folder, isChild),
    metadataError: meta.metadataError,
  }
}

/**
 * Read an epic's `tasks/<child>/` subtree one level deep. Each child dir with an
 * `01-spec.md` becomes a child ticket (status-derived column + parent epic id).
 * Never throws — a missing/empty/unreadable `tasks/` yields no children, and a
 * child without `01-spec.md` (incl. a nested epic with only `prd.md`) is skipped.
 * Does NOT recurse into a child's own `tasks/` (exactly one extra level).
 */
async function scanEpicChildren(
  epicDir: string,
  epicName: string,
  folder: Column,
  projectName: string,
): Promise<TicketDTO[]> {
  const tasksDir = join(epicDir, 'tasks')
  let entries
  try {
    entries = await fs.readdir(tasksDir, { withFileTypes: true })
  } catch {
    return [] // no tasks/ (or unreadable) → no children, no crash
  }
  const children: TicketDTO[] = []
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue
    const childDir = join(tasksDir, ent.name)
    let names: string[]
    try {
      const dirEntries = await fs.readdir(childDir, { withFileTypes: true })
      names = dirEntries.filter((e) => e.isFile()).map((e) => e.name)
    } catch {
      continue // unreadable child dir → skip
    }
    // A renderable child must carry its own spec; no spec (or a nested epic with
    // only prd.md) is skipped. Degraded-but-present specs still build (→ backlog).
    if (!names.includes('01-spec.md')) continue
    children.push(await buildTicket(childDir, ent.name, folder, projectName, names, epicName))
  }
  return children
}

function projError(
  project: Project,
  kind: ScanErrorKind,
  message: string,
): ProjectScanResult {
  return { name: project.name, path: project.path, error: { kind, message }, tickets: [] }
}

/** Scan one project's claudedocs/tickets tree. Never throws — failures land in `error`. */
export async function scanProjectRoot(project: Project): Promise<ProjectScanResult> {
  const ticketsRoot = join(project.path, 'claudedocs', 'tickets')

  try {
    const st = await fs.stat(ticketsRoot)
    if (!st.isDirectory()) {
      return projError(project, 'missing', `Not a directory: ${ticketsRoot}`)
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return projError(project, 'missing', `No claudedocs/tickets/ found at ${project.path}`)
    }
    if (code === 'EACCES') {
      return projError(project, 'unreadable', `Permission denied reading ${ticketsRoot}`)
    }
    return projError(project, 'unreadable', `Cannot read ${ticketsRoot}: ${String(err)}`)
  }

  const tickets: TicketDTO[] = []
  for (const folder of STATE_FOLDERS) {
    const stateDir = join(ticketsRoot, folder)
    let entries
    try {
      entries = await fs.readdir(stateDir, { withFileTypes: true })
    } catch {
      // review/ and done/ are frequently absent; an unreadable state folder is
      // skipped rather than failing the whole project.
      continue
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue
      const dir = join(stateDir, ent.name)
      // Read the ticket dir listing ONCE; classification + artifact list both derive from it.
      let names: string[]
      try {
        const dirEntries = await fs.readdir(dir, { withFileTypes: true })
        names = dirEntries.filter((e) => e.isFile()).map((e) => e.name)
      } catch {
        continue // unreadable ticket dir → skip
      }
      const kind = await classifyDir(dir, names)
      if (kind === 'solo') {
        tickets.push(await buildTicket(dir, ent.name, folder, project.name, names))
      } else if (kind === 'epic') {
        // Surface the epic's child tasks with status-derived columns; the epic
        // itself is never rendered as a card. Descends exactly one extra level.
        tickets.push(...(await scanEpicChildren(dir, ent.name, folder, project.name)))
      }
      // 'unknown' → skip (not a renderable ticket)
    }
  }

  return { name: project.name, path: project.path, error: null, tickets }
}

/**
 * Read one artifact's markdown, with whitelist + path-traversal guards.
 * Solo ticket: `<state>/<ticketId>/<filename>`. Epic child (parentEpicId given):
 * `<state>/<parentEpicId>/tasks/<ticketId>/<filename>`. Either way the four state
 * folders are tried in turn (the physical folder isn't on the wire), so a
 * stale-folder ticket resolves wherever it actually sits.
 */
export async function getArtifactFromRoot(
  project: Project,
  ticketId: string,
  filename: string,
  parentEpicId?: string,
): Promise<ArtifactResult> {
  if (
    !isSafeSegment(ticketId) ||
    !isAllowedArtifactName(filename) ||
    (parentEpicId !== undefined && !isSafeSegment(parentEpicId))
  ) {
    return { found: false, content: null, error: 'Invalid ticket id or artifact name' }
  }
  const ticketsRoot = join(project.path, 'claudedocs', 'tickets')
  for (const folder of STATE_FOLDERS) {
    const ticketDir =
      parentEpicId !== undefined
        ? join(ticketsRoot, folder, parentEpicId, 'tasks', ticketId)
        : join(ticketsRoot, folder, ticketId)
    const candidate = join(ticketDir, filename)
    if (!isInside(ticketsRoot, candidate)) continue // defense-in-depth
    try {
      const raw = await fs.readFile(candidate, 'utf8')
      return { found: true, content: stripFrontmatter(raw) }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      return { found: false, content: null, error: String(err) }
    }
  }
  return { found: false, content: null, error: 'Artifact not found' }
}

/**
 * Validate a candidate project root. Lives here (a server-only module) rather
 * than in functions.ts so that the node:fs usage never reaches a client-imported
 * module — functions.ts uses it only inside a server-fn handler body, which the
 * TanStack Start compiler strips from the client bundle.
 * Exported so it can be unit-tested without the Start runtime.
 */
export async function validateProjectPath(
  path: string,
): Promise<{ ok: boolean; error?: string }> {
  let st
  try {
    st = await fs.stat(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, error: `Path does not exist: ${path}` }
    if (code === 'EACCES') return { ok: false, error: `Path is not readable: ${path}` }
    return { ok: false, error: `Cannot access path: ${String(err)}` }
  }
  if (!st.isDirectory()) return { ok: false, error: `Not a directory: ${path}` }
  try {
    const ticketsStat = await fs.stat(join(path, 'claudedocs', 'tickets'))
    if (!ticketsStat.isDirectory()) {
      return { ok: false, error: `No claudedocs/tickets/ directory in ${path}` }
    }
  } catch {
    return {
      ok: false,
      error: `No claudedocs/tickets/ in ${path} — is this a feature-pipeline project?`,
    }
  }
  return { ok: true }
}

/** The one concrete TicketSource today. Swap this for a DB/git/hosted source later. */
export const filesystemTicketSource: TicketSource = {
  scanProject: scanProjectRoot,
  getArtifact: getArtifactFromRoot,
}
