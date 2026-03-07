# worca-ui Design

Pipeline monitoring UI for worca-cc. Lives inside `.claude/worca-ui/`, invoked via `worca-ui start`.

## Tech Stack

- **Frontend:** lit-html, vanilla JS (ES2022), CSS variables, esbuild
- **Backend:** Express, WebSocket (ws), Node.js
- **Pattern:** Push-only state via WebSocket (same architecture as beads-ui)
- **Data source:** File watcher on `.worca/status.json` + log file tailing

## Layout

Vertical sidebar (left, ~240px) with collapsible sections. Main content area (right).

```
+--[ WORCA ]--+-------------------------------------------+
| Pipeline    |                                           |
|  > Active   |         Main Content Area                 |
|  > History  |                                           |
|  > Batch    |   (selected run detail, or dashboard)     |
|             |                                           |
| ----------- |                                           |
| (future:    |                                           |
|  Beads,     |                                           |
|  Config)    |                                           |
|             |                                           |
| [v] Dark    |                                           |
+-------------+-------------------------------------------+
```

- Sidebar sections are expandable groups (Pipeline first; Beads etc. added later)
- Subsections: Active (live runs), History (completed/failed), Batch (multi-issue runs)
- Bottom: dark/light theme toggle, WebSocket connection status
- Theme preference persisted to `~/.worca/preferences.json`

## Run Detail View

### Header
- Work request title/prompt, status badge, branch name, started_at, duration, PR link

### Stage Timeline (horizontal)
```
[PLAN]──>[COORDINATE]──>[IMPLEMENT]──>[TEST]──>[REVIEW]──>[PR]
  ✓          ✓             ●            ○         ○        ○
```
- Stages derived from `status.json` `stages` keys (never hardcoded)
- States: pending (○), in_progress (●/spinning), completed (✓), error (✗)
- Click stage to scroll to its detail panel
- Loop arrows for stages that can iterate (test→implement, review→implement)
- Milestone gates shown where `worca.milestones` is configured

### Stage Detail Panels
Each stage shows:
- Status, timestamps, duration
- Iteration count with max (e.g. "Iteration 2/10")
- Agent name and model (from settings.json)
- Task progress for implement ("3/5 tasks")
- Review/test results when available

### Log Viewer (bottom, resizable)
- Real-time log tail streamed via WebSocket
- Stage filter: show only selected stage's log or all
- Auto-scroll with pause
- Search within logs

## Generic Stage System

1. **Stage list derived from data.** UI reads `status.json` `stages` keys and renders whatever it finds.
2. **Optional display hints** in `settings.json`:
   ```json
   "worca": {
     "ui": {
       "stages": {
         "plan": { "label": "Planning", "icon": "clipboard" },
         "deploy": { "label": "Deploy", "icon": "rocket" }
       }
     }
   }
   ```
   Falls back to title-casing the stage name.
3. **Stage ordering** follows insertion order in `status.json` `stages` object.
4. **Loop detection** automatic — iteration count > 1 shows loop indicators. Limits from `worca.loops`.
5. **Universal states:** `pending`, `in_progress`, `completed`, `error` — each mapped to color/icon.
6. **Custom stages** appear automatically when added to the pipeline and status.json.

## Data Architecture

### Server
- Express serves static frontend + WebSocket
- File watcher on `.worca/status.json` — pushes full status on change
- File watcher on `.worca/results/` — discovers completed runs
- Log tailer using `fs.createReadStream` + `fs.watch` — streams new lines via WebSocket
- Settings reader — reads `.claude/settings.json` at startup
- Preferences — reads/writes `~/.worca/preferences.json`

### WebSocket Protocol

```
Client → Server:
  subscribe-run        { runId }              start receiving updates
  unsubscribe-run      { runId }              stop updates
  subscribe-log        { runId, stage? }      start streaming log lines
  unsubscribe-log      { runId }              stop log stream
  list-runs            { filter? }            request run list
  get-preferences                             read theme
  set-preferences      { theme }              write theme

Server → Client:
  run-snapshot         { run }                full run status
  run-update           { runId, changes }     delta update
  runs-list            { runs[] }             list of all runs
  log-line             { runId, line, stage } single log line
  log-bulk             { runId, lines[] }     initial log backfill
  preferences          { theme }              current preferences
```

### Client State
- `runs` — Map of runId → run status
- `activeRunId` — currently selected run
- `logLines` — array for active run (capped ~5000)
- `preferences` — theme, sidebar state

### Run Discovery
- Active: `.worca/status.json` exists and stage is not terminal
- Completed: `.worca/results/*.json`
- Run ID: derived from `started_at` + work request hash

## Monitorable Parameters

### Per-Run
| Parameter | Source | Live |
|-----------|--------|------|
| Work request | status.json `work_request` | No |
| Overall state | status.json `stage` | Yes |
| Branch | status.json `branch` | No |
| Worktree path | status.json `worktree` | No |
| Started at / duration | status.json `started_at` | Yes |
| PR number | status.json PR stage output | Yes |
| Milestone approvals | status.json `milestones` | Yes |

### Per-Stage
| Parameter | Source | Live |
|-----------|--------|------|
| Status | status.json `stages.<name>.status` | Yes |
| Timestamps | status.json `stages.<name>` | Yes |
| Duration | Computed | Yes |
| Iteration count | status.json `stages.<name>.iteration` | Yes |
| Max iterations | settings.json `worca.loops` | No |
| Agent + model | settings.json `worca.agents` | No |
| Task progress | status.json `stages.implement.task_progress` | Yes |

### Quality Data
| Parameter | Source | Live |
|-----------|--------|------|
| Review result | status.json stage output | Yes |
| Test counts | status.json stage output | Yes |
| PR review outcome | status.json `pr_review_outcome` | Yes |

### Logs
| Parameter | Source | Live |
|-----------|--------|------|
| Combined log | `.worca/logs/orchestrator.log` | Yes, streamed |
| Per-stage log | `.worca/logs/<stage>.log` | Yes, streamed |

## CLI

```bash
worca-ui start [--port 3400] [--open] [--host 0.0.0.0]
worca-ui stop
worca-ui restart [--port 3400] [--open]
worca-ui status
```

- `bin/worca-ui.js` with `#!/usr/bin/env node` shebang
- `package.json`: `"bin": { "worca-ui": "./bin/worca-ui.js" }`
- PID file at `~/.worca/worca-ui.pid` (stores `{ pid, port, started_at }`)
- `start` — spawns detached background process, writes PID file
- `stop` — reads PID, sends SIGTERM, removes PID file
- `restart` — stop then start
- `status` — reads PID file, checks if process alive

## Project Structure

```
.claude/
  worca-ui/
    app/
      index.html
      main.js
      styles.css
      ws.js
      state.js
      router.js
      protocol.js
      views/
        sidebar.js
        dashboard.js
        run-detail.js
        run-list.js
        log-viewer.js
        stage-timeline.js
      utils/
        status-badge.js
        duration.js
        theme.js
        logging.js
    server/
      index.js
      app.js
      ws.js
      watcher.js
      log-tailer.js
      preferences.js
      settings-reader.js
    bin/
      worca-ui.js
    package.json
    scripts/
      build-frontend.js
```

## Dependencies

- `express` — HTTP server
- `ws` — WebSocket
- `lit-html` — Template rendering
- `esbuild` (dev) — Bundling
- `marked` — Markdown rendering in logs

## Testing Strategy

### Unit Tests (Vitest)
- **Protocol module** — message creation, type guards, encoding/decoding
- **State store** — subscriptions, shallow compare, patch merging
- **Duration/badge utils** — formatting, edge cases
- **Settings reader** — parsing, fallback defaults, missing file handling
- **Preferences** — read/write/create directory, malformed JSON
- **Log tailer** — line splitting, backfill, cleanup
- **Watcher** — debouncing, run discovery, status diffing
- **Router** — hash parsing, route matching, query params

### Integration Tests (Vitest + WebSocket)
- **WebSocket server** — client connects, subscribes, receives push updates
- **File watcher → WebSocket push** — write status.json, verify client receives update
- **Log streaming** — append to log file, verify log-line events arrive
- **Run discovery** — create/remove result files, verify runs-list updates
- **CLI commands** — start/stop/restart/status with PID file verification

### Visual/E2E Tests (Playwright via MCP)
Use the Playwright browser MCP tools for visual inspection and functional testing:
- **Sidebar navigation** — verify sections render, expand/collapse, active states
- **Theme toggle** — switch dark/light, verify CSS variables applied, persistence
- **Dashboard** — verify active runs displayed with correct status badges
- **Stage timeline** — verify stages render from status.json data, correct icons/colors
- **Run detail** — click a run, verify header, stage panels, all parameters displayed
- **Log viewer** — verify log lines appear, auto-scroll, stage filter works
- **Live updates** — modify status.json on disk, verify UI updates without refresh
- **Connection status** — stop/start server, verify reconnect indicator
- **Empty states** — no runs, no logs, no active pipeline
- **Generic stages** — add custom stage to test status.json, verify it renders

### Test Data
- Fixture status.json files (pending, in_progress, completed, error states)
- Fixture settings.json with custom stage UI config
- Mock log files for streaming tests

## Future Sections (not in scope now)

- **Beads** — integrate beads-ui issue tracking views
- **Config** — edit settings.json, agents from the UI
