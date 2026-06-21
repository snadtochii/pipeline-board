# Pipeline Board (prototype)

A local, read-only Kanban board for [feature-pipeline](https://) tickets. It scans the
`claudedocs/tickets/` folder of one or more project roots and shows each ticket as a card in
four columns that mirror the pipeline's real state folders — **Backlog → In Progress → Review →
Done** — with a per-card indicator of how far the pipeline has advanced.

The board is **read-only**: it observes the filesystem, it never modifies tickets or drives the
pipeline. There is **no database** — the filesystem is the single source of truth, re-scanned on a
short interval.

## Quick start

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>. On first run the board is empty — click **Manage projects → Add
project** and point it at any folder that contains a `claudedocs/tickets/` directory.

## Adding projects

A "project" is one filesystem root that contains `claudedocs/tickets/`. Three ways to register one:

1. **In the UI** — _Manage projects_ → enter an absolute path (and an optional display name).
2. **Environment seed** (first run only) — comma-separated absolute paths:
   ```bash
   PIPELINE_BOARD_PROJECTS="/path/to/repo-a,/path/to/repo-b" npm run dev
   ```
3. **Edit the config file** directly (see below).

The list of projects persists to **`~/.pipeline-board/projects.json`**:

```json
[
  { "name": "feature-pipeline", "path": "/Users/me/projects/feature-pipeline" },
  { "name": "symphony", "path": "/Users/me/projects/symphony" }
]
```

This is the board's _own_ config (app config) — it is not ticket data, and it lives in your home
directory so it stays out of any project tree. Override its location for testing with
`PIPELINE_BOARD_CONFIG_DIR`.

## What the board shows

- **Columns** map to the four physical state folders (`backlog/`, `in-progress/`, `review/`,
  `done/`). A ticket's column is its folder location.
- **Cards** show the ticket id, title, priority, complexity, a status badge (from frontmatter), and
  a derived pipeline-stage indicator (`spec → planned → implementing → reviewed → tested →
  summarized`, from which `02`–`06` artifacts exist).
- **Project filter** — show _All projects_ (columns aggregate across roots) or a single project.
- **Detail panel** — click a card to read its `01-spec.md` and any other artifact, rendered as
  markdown in-panel.
- **Auto-refresh** — the board re-scans every 5 seconds (paused when the tab is hidden) and on
  window focus; no manual action needed.

Epic folders (`prd.md` with `kind: epic`) are detected and skipped in this version; a dedicated
epic view is future work.

## Scripts

| Command            | What it does                                         |
| ------------------ | ---------------------------------------------------- |
| `npm run dev`      | Start the dev server on port 3000                    |
| `npm run build`    | Production build → `.output/` (client + Node server) |
| `npm start`        | Run the built Node server (`.output/server/index.mjs`) on port 3000 |
| `npm run typecheck`| `tsc --noEmit`                                       |
| `npm test`         | Run the Vitest unit suite                            |

### Production (local)

```bash
npm run build && npm start   # serves the built app on http://localhost:3000
```

The Nitro Node-server target (`nitro()` in `vite.config.ts`) makes the build emit a runnable
`.output/server/index.mjs`. This is still a local single-user tool; remote/cloud hosting is future
work.

## Architecture

TanStack Start app. All filesystem access lives in server functions (`src/server/`); the browser
only ever receives serialized ticket DTOs. The scanner sits behind a single `TicketSource`
interface, so a future database / git / hosted backend can replace the local-filesystem source
without touching the UI.
