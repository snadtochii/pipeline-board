import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { addProject, removeProject } from '../server/functions'
import type { Project } from '../server/types'

export function AddProjectDialog({
  open,
  onOpenChange,
  projects,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Project[]
  onChanged: () => void
}) {
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const add = useMutation({
    mutationFn: () =>
      addProject({ data: { path: path.trim(), name: name.trim() || undefined } }),
    onSuccess: (res) => {
      if (!res.ok) {
        setError(res.error ?? 'Could not add project')
        return
      }
      setError(null)
      setPath('')
      setName('')
      onChanged()
    },
    onError: (e) => setError(String(e)),
  })

  const remove = useMutation({
    mutationFn: (p: string) => removeProject({ data: { path: p } }),
    onSuccess: () => onChanged(),
  })

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={() => onOpenChange(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="modal-head">
          <h2>Projects</h2>
          <button type="button" className="icon" onClick={() => onOpenChange(false)} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          <ul className="project-list">
            {projects.length === 0 && <li className="muted">No projects configured.</li>}
            {projects.map((p) => (
              <li key={p.path}>
                <span className="project-name">{p.name}</span>
                <span className="project-path" title={p.path}>{p.path}</span>
                <button
                  type="button"
                  className="danger"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(p.path)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>

          <form
            className="add-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (path.trim()) add.mutate()
            }}
          >
            <label>
              Path
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/absolute/path/to/project"
                spellCheck={false}
                autoFocus
              />
            </label>
            <label>
              Name <span className="muted">(optional)</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="defaults to folder name"
              />
            </label>
            {error && <p className="form-error">{error}</p>}
            <button type="submit" className="primary" disabled={add.isPending || !path.trim()}>
              {add.isPending ? 'Adding…' : '+ Add project'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
