export function formatVersion(raw: string): string {
  const trimmed = raw.trim()
  return trimmed ? `v${trimmed}` : ''
}
