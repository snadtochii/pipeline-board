import { createFileRoute } from '@tanstack/react-router'
import { Board } from '../components/Board'
import { normalizeProjectParam } from '../lib/project-filter'

export const Route = createFileRoute('/')({
  // The selected project filter lives in the URL as ?project=<name> (PB-22).
  // validateSearch runs on both SSR and client during route matching, so the
  // filter is consistent on first paint (no hydration flash). It only does shape
  // coercion — verifying the project actually exists needs the async project
  // list, so that fallback stays a client concern in Board.
  validateSearch: (search: Record<string, unknown>) => normalizeProjectParam(search.project),
  component: Board,
})
