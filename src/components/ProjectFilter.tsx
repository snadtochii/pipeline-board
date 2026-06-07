import type { Project } from '../server/types'

export function ProjectFilter({
  projects,
  value,
  onChange,
}: {
  projects: Project[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="filter">
      <span className="filter-label">Project</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="all">All projects</option>
        {projects.map((p) => (
          <option key={p.path} value={p.name}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  )
}
