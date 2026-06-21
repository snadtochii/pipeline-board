/**
 * Format an ISO timestamp as a short relative string ("just now", "3m ago",
 * "2h ago", "5d ago"). `now` is injected (epoch ms) so callers own the clock and
 * the function stays pure/testable. Returns '' on an unparseable timestamp.
 *
 * Extracted from SyncControl (PB-6) at PB-14 so both the sync chip and the
 * per-ticket run chip share one clock and one unit test.
 */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.round((now - then) / 1000))
  if (secs < 45) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}
