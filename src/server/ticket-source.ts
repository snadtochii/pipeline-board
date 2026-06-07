import type { ArtifactResult, Project, ProjectScanResult } from './types'

/**
 * The single data-access seam. Today there is one implementation
 * (FilesystemTicketSource) that reads each project's `claudedocs/tickets/`
 * tree. A future DB-, git-, or server-backed source implements this same
 * interface without the UI or server-function layer changing.
 */
export interface TicketSource {
  /** Scan one project root and return its tickets (never throws — errors land in result.error). */
  scanProject(project: Project): Promise<ProjectScanResult>

  /** Read a single artifact's markdown for a ticket in a project. */
  getArtifact(
    project: Project,
    ticketId: string,
    filename: string,
  ): Promise<ArtifactResult>
}
