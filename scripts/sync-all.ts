#!/usr/bin/env node
//
// sync-all.ts — run feature-pipeline's /feature:sync across every workspace
// configured in the Pipeline Board, in a single pass, from the terminal.
//
// Thin CLI over the shared orchestrator core (src/server/sync.ts) — the same
// core the board's startSync server fn runs. It reads the board's own workspace
// list (~/.pipeline-board/projects.json), spawns one headless `claude -p
// "/feature:sync"` per workspace with a least-privilege allowlist, prints each
// repo's report, and writes ~/.pipeline-board/last-sync.json so the board
// reflects results on its next poll.
//
// Usage:   npm run sync       (or: node scripts/sync-all.ts)
// Env:     PIPELINE_BOARD_CONFIG_DIR  override the board config dir
//          CLAUDE_MODEL               model for the spawned sync runs (default: sonnet)
//
// Requires Node >= 24 (runs the TypeScript directly via type-stripping). If your
// Node is older, run with a TS loader, e.g. `node --import tsx scripts/sync-all.ts`.

import { isSyncRunning, readSyncStatus, runSyncAll } from '../src/server/sync.ts'

const RULE = '─'.repeat(62)
const DRULE = '═'.repeat(62)

async function main(): Promise<void> {
  const current = await readSyncStatus()
  if (isSyncRunning(current)) {
    console.error(
      `A cross-workspace sync is already in progress (started ${current?.startedAt}). Aborting.`,
    )
    process.exitCode = 1
    return
  }

  const final = await runSyncAll({
    reporter: {
      runStart(count) {
        if (count === 0) {
          console.log('No workspaces configured — nothing to sync.')
          return
        }
        console.log(`Pipeline Board · sync-all — ${count} workspace(s)\n`)
      },
      workspaceStart(ws, i, total) {
        console.log(RULE)
        console.log(`▶ ${ws.name}  (${ws.path})   [${i + 1}/${total}]`)
        console.log(RULE)
      },
      workspaceEnd(ws, _i, _total, rawReport) {
        const report = rawReport.trim()
        if (report) {
          console.log(report)
        } else if (ws.outcome) {
          const o = ws.outcome
          console.log(
            `done — ↑${o.promoted} promoted · ${o.open} open · ⚠${o.needsAttention} attention · ?${o.couldntCheck} unchecked`,
          )
        }
        if (ws.state === 'failed') console.log(`✗ ${ws.error ?? 'failed'}`)
        console.log('')
      },
    },
  })

  const ok = final.workspaces.filter((w) => w.state === 'done').length
  const problems = final.workspaces.filter((w) => w.state === 'failed').length
  console.log(DRULE)
  console.log(`Done — ${final.workspaces.length} workspace(s): ${ok} ok, ${problems} problem(s)`)
  console.log('The board reflects any promotions on its next poll (~5s).')
  if (problems > 0) process.exitCode = 1
}

main().catch((err: unknown) => {
  console.error('sync-all failed:', err)
  process.exitCode = 1
})
