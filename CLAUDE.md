# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

Pipeline Board is a standalone local web app that provides a Kanban-style dashboard for the **feature-pipeline** Claude Code plugin. It visualizes tickets moving through pipeline stages (backlog → analyze → plan → implement → review → test → done), updates in real-time via filesystem watching, and can trigger pipeline stages by spawning Claude CLI sessions.

This is **not** part of the feature-pipeline plugin — it's a separate project that reads the plugin's file-based state as its single source of truth. There is no database; all state is derived from the filesystem.

## Tech Stack

- **TanStack Start v1.0** — full-stack React framework (server functions + file-based routing + TanStack Query)
- **TanStack Router** — file-based routing
- **TanStack Query** — server state management with cache invalidation from SSE events
- **Chokidar** — filesystem watcher (with `awaitWriteFinish` for editor atomic saves)
- **SSE (Server-Sent Events)** — one-way real-time push from server to browser via streaming `ReadableStream`
- **node:child_process.spawn** — spawns `claude` CLI sessions to trigger pipeline stages
- **gray-matter** — server-side YAML frontmatter parsing for ticket files
- **react-markdown** — client-side artifact rendering (trusted local content only)

## Architecture

```
Browser (React + TanStack Router/Query)
  │ EventSource (SSE)
  ▼
TanStack Start Server
  ├── Server Functions: listTickets, getArtifacts, triggerStage, etc.
  ├── SSE Stream: chokidar events → EventEmitter → ReadableStream
  └── CLI Spawner: spawn("claude", [...]) for stage triggers
         │ reads/writes
         ▼
Filesystem (source of truth)
  ├── .tickets/{backlog,in-progress,review,done}/<PREFIX>-<N>-<slug>.md
  ├── claudedocs/pipeline/<ticket-id>/00-exploration.md through 07-summary.md
  └── claudedocs/pipeline/<ticket-id>/.iterations.json
```

### State Derivation (no database)

- **Ticket column**: determined by `.tickets/` subfolder cross-referenced with artifact presence in `claudedocs/pipeline/<id>/`
- **Pipeline progress**: which numbered artifacts exist (00–07) maps to how far the pipeline advanced
- **Needs attention**: a new artifact appearing (via watcher) = stage completed, needs developer review
- **Running**: a child process is active for that ticket ID
- **Loop-back state**: `.iterations.json` counters (`review_implement_loops`, `test_implement_loops`, `test_plan_loops`)

### Pipeline Artifact Order

```
00-exploration.md   → discovery output
01-spec.md          → enriched spec
02-analysis.md      → analyze stage
03-plan.md          → plan stage
04-implementation.md → implement stage (live document, updated incrementally)
05-review.md        → review stage
06-tests.md         → test stage
07-summary.md       → pipeline complete
```

Progress detection checks artifacts in reverse order: presence of `07-summary.md` = complete, `05-review.md` = resume from test, `03-plan.md` = resume from implement, etc.

### Ticket Format

Tickets live in `.tickets/{backlog,in-progress,review,done}/` as markdown files with YAML frontmatter:

```yaml
---
id: PB-1
title: Pipeline Board UI
priority: high
complexity: XL
status: backlog
created: 2026-04-13
project: pipeline-board
tags: [ui, dashboard, kanban]
---
```

Ticket ID prefix is stored in `.tickets/.prefix` (plain text, e.g., "PB"). ID format: `<PREFIX>-<N>` (no leading zeros). Filename: `<PREFIX>-<N>-<slug>.md`.

### CLI Invocation Pattern

```bash
# Trigger a specific stage
claude -p "Run /feature-pipeline:analyze PB-1" --yes

# Trigger full pipeline from a stage
claude -p "Run /feature-pipeline:feature-flow PB-1 --from analyze" --yes
```

### Filesystem Watch Targets

- `.tickets/**/*.md` — ticket lifecycle (folder moves, frontmatter changes)
- `claudedocs/pipeline/**/*.md` — artifact creation/updates
- `claudedocs/pipeline/**/.iterations.json` — loop-back state changes

### Configuration

The app needs the project root where `.tickets/` and `claudedocs/` live:
- CLI argument: `npm run dev -- --project /path/to/project`
- Environment variable: `PIPELINE_PROJECT_ROOT=/path/to/project`
- Default: current working directory

## Key Constraints

- **No own database** — filesystem is the single source of truth
- **No drag-and-drop for stage transitions** — stages spawn CLI sessions (heavy operations), use buttons with confirmation
- **No ticket editing in UI** — tickets are created/modified via Claude Code
- **No embedded terminal** — CLI sessions open in external terminal (MVP)
- **Single user, local only** — no auth, no multi-user, no mobile-first
- **SSE not WebSocket** — simpler, auto-reconnect via EventSource, sufficient for one-way notifications

## Project Documentation

- **Ticket**: `.tickets/backlog/PB-1-pipeline-board-ui.md` — full requirements and acceptance criteria
- **Research**: `claudedocs/research_pipeline-board-ui_2026-04-13.md` — landscape analysis, UX patterns, technical recommendations
- **Exploration**: `claudedocs/pipeline/PB-1/00-exploration.md` — feature-pipeline plugin architecture analysis
