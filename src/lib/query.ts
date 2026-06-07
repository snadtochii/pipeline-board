import type { Priority } from '../server/types'

/** Periodic re-scan interval. Single local user — 5s feels live without hammering disk. */
export const POLL_INTERVAL_MS = 5000

export const queryKeys = {
  scan: ['scan'] as const,
  projects: ['projects'] as const,
  artifact: (project: string, ticket: string, file: string) =>
    ['artifact', project, ticket, file] as const,
}

/** Higher rank sorts first within a column. */
export const PRIORITY_RANK: Record<Priority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
}
