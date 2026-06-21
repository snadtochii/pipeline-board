export function EmptyState({
  variant,
  onAddProject,
}: {
  variant: 'no-projects' | 'no-tickets'
  onAddProject: () => void
}) {
  if (variant === 'no-projects') {
    return (
      <div className="empty">
        <h2>No projects yet</h2>
        <p>
          Add a project folder that contains a <code>claudedocs/tickets/</code> directory to see
          its feature-pipeline tickets on the board.
        </p>
        <button type="button" className="primary" onClick={onAddProject}>
          + Add project
        </button>
      </div>
    )
  }
  return (
    <div className="empty">
      <h2>No tickets to show</h2>
      <p>
        Your configured projects have no tickets in this view. Create one with{' '}
        <code>/feature:discover</code> in Claude Code — it'll appear here automatically.
      </p>
    </div>
  )
}
