import type { ProjectScanResult } from '../server/types'

export function ProjectErrorChip({ result }: { result: ProjectScanResult }) {
  if (!result.error) return null
  return (
    <div className="error-chip" role="alert">
      <strong>{result.name}</strong>
      <span className="error-kind">{result.error.kind}</span>
      <span className="error-msg">{result.error.message}</span>
    </div>
  )
}
