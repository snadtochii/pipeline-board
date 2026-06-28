import { useEffect, useRef, useState } from 'react'
import type { Project } from '../server/types'
import { ALL_PROJECTS_LABEL, nextSelection, selectionLabel } from '../lib/project-filter'

/**
 * Multi-select project filter (PB-23). A button labeled by the current selection
 * opens a checkbox popover — an "All projects" toggle plus one checkbox per project.
 * The selection itself is URL-driven (passed in via `selected`, written back via
 * `onChange`); only the open/closed state is local. Interaction (Esc, outside-click,
 * focus restore) mirrors the DetailPanel idiom — the board's existing popover pattern.
 */
export function ProjectFilter({
  projects,
  selected,
  onChange,
}: {
  projects: Project[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const firstOptionRef = useRef<HTMLInputElement | null>(null)
  // The element to restore focus to on close — captured on open (the trigger).
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  // Close on Escape (only while open). Mirrors DetailPanel's keydown effect.
  useEffect(() => {
    if (!open) {
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // Close on a click outside the control. Capture phase, mirroring DetailPanel's
  // outside-click effect. rootRef wraps BOTH the trigger and the panel, so a click on
  // the trigger stays "inside" — the trigger's own onClick handles the toggle.
  useEffect(() => {
    if (!open) {
      return
    }
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (!target) {
        return
      }
      if (rootRef.current?.contains(target)) {
        return
      }
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  // Move focus into the panel on open; restore it to the trigger on close. Deps on
  // `open` only. restoreFocusRef starts null, so this never steals focus on mount —
  // only a genuine open→close restores. Guard with isConnected (DetailPanel pattern).
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = (document.activeElement as HTMLElement | null) ?? null
      firstOptionRef.current?.focus()
    } else if (restoreFocusRef.current) {
      const el = restoreFocusRef.current
      restoreFocusRef.current = null
      if (el.isConnected) {
        el.focus()
      }
    }
  }, [open])

  const allNames = projects.map((p) => p.name)

  return (
    <div className="filter project-filter" ref={rootRef}>
      <span className="filter-label">Project</span>
      <button
        type="button"
        ref={triggerRef}
        className="project-filter-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{selectionLabel(selected)}</span>
        <span className="project-filter-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="project-filter-panel" role="group" aria-label="Filter by project">
          <label className="project-filter-option">
            <input
              ref={firstOptionRef}
              type="checkbox"
              checked={selected.length === 0}
              onChange={() => onChange([])}
            />
            <span>{ALL_PROJECTS_LABEL}</span>
          </label>
          {projects.length > 0 && <div className="project-filter-divider" />}
          {projects.map((p) => (
            <label key={p.path} className="project-filter-option">
              <input
                type="checkbox"
                checked={selected.includes(p.name)}
                onChange={() => onChange(nextSelection(selected, p.name, allNames))}
              />
              <span>{p.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
