// Shared domain types for the pipeline board. These DTOs are what the server
// sends to the client — no filesystem handles or absolute paths leak through
// (except Project.path, which the Add-project form needs to echo back).

export type Priority = 'low' | 'medium' | 'high' | 'critical'
export type Complexity = 'S' | 'M' | 'L' | 'XL'

/** Frontmatter `status` values (authoritative for the badge). */
export type TicketStatus =
  | 'backlog'
  | 'in-progress'
  | 'in-review'
  | 'done'
  | 'partial-completion'
  | 'cancelled'

/** The four physical state folders — these are the board columns. */
export type Column = 'backlog' | 'in-progress' | 'review' | 'done'

/** Furthest pipeline stage reached, derived from which artifacts exist. */
export type DerivedStage =
  | 'spec'
  | 'plan'
  | 'implementation'
  | 'review'
  | 'tests'
  | 'summary'

export const STATE_FOLDERS: readonly Column[] = [
  'backlog',
  'in-progress',
  'review',
  'done',
]

/** Ordered stage → artifact filename that proves the stage was reached. */
export const STAGE_ARTIFACTS: ReadonlyArray<{ stage: DerivedStage; file: string }> = [
  { stage: 'plan', file: '02-plan.md' },
  { stage: 'implementation', file: '03-implementation.md' },
  { stage: 'review', file: '04-review.md' },
  { stage: 'tests', file: '05-tests.md' },
  { stage: 'summary', file: '06-summary.md' },
]

export interface Project {
  name: string
  path: string
}

export type ScanErrorKind = 'missing' | 'unreadable' | 'malformed'

export interface ScanError {
  kind: ScanErrorKind
  message: string
}

export interface TicketDTO {
  id: string
  title: string
  priority: Priority | null
  complexity: Complexity | null
  /** Frontmatter status; null when unparseable. Drives the badge only. */
  status: TicketStatus | null
  /** Physical folder — determines the column the card appears in. */
  column: Column
  derivedStage: DerivedStage
  projectName: string
  tags: string[]
  /** Artifact filenames present in the ticket folder, e.g. ['01-spec.md','02-plan.md']. */
  artifacts: string[]
  /** True when frontmatter status maps to a different folder than where the ticket sits. */
  mismatch: boolean
  /** True when frontmatter was missing/unparseable and this is a degraded card. */
  metadataError: boolean
}

export interface ProjectScanResult {
  name: string
  path: string
  /** Per-project error so one bad root never blanks the whole board. */
  error: ScanError | null
  tickets: TicketDTO[]
}

export interface ArtifactResult {
  found: boolean
  content: string | null
  error?: string
}
