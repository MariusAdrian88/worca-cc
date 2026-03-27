# W-032: Global Multi-Project worca-ui

**Status:** Draft
**Priority:** P2
**Dependencies:** W-017 (multi-project support), W-030 (parallel pipeline execution)
**Type:** Feature / Architecture

---

## Context

Currently, each worca-cc project runs its own worca-ui server + browser tab. With multiple projects on a developer's machine, each potentially running parallel pipelines (W-030), this becomes an MxN problem. The goal is a **single global worca-ui instance** monitoring all projects and all their pipelines from one browser tab.

Two existing plans cover significant ground:
- **W-017** (`W-017-multi-project-support.md`) — multi-project file-watching via `~/.worca/projects.json`, project-scoped WebSocket protocol, sidebar project picker, aggregated dashboard. 14 tasks, fully designed.
- **W-030** (`W-030-parallel-pipeline-execution.md`) — parallel pipelines within a single project via git worktrees, `.worca/multi/registry.json`, multi-pipeline dashboard. 17 tasks, fully designed.

This plan covers what's **not yet designed**: the integration approach, global installation, W-017+W-030 interaction, and complications.

---

## 1. Integration Approach: File-Watching Primary + Webhook Supplementary

The global server watches multiple `.worca/` directories discovered from `~/.worca/projects.json`. Webhooks supplement file-watching as a fast-path hint channel.

### File-Watching (Primary)

File-watching is the source of truth for all data: logs, run state, beads, settings.

- **Complete data access** — logs, events, beads, settings, agent prompts, costs. No gaps.
- **Zero pipeline changes** — Python code writes files as always. Server reads them. Clean separation.
- **Zero per-project configuration** — no webhook URLs, no secrets, no ports. Just register the path.
- **Already designed** — W-017 provides 14 implementation tasks with full code sketches.
- **Proven** — the per-project server already uses this exact mechanism successfully.

### Webhooks (Supplementary)

Webhooks act as **hints** — when a webhook arrives, the server immediately refreshes the corresponding project's state instead of waiting for the next 75ms debounce cycle. If the webhook channel is down, file watchers provide complete coverage with only a slight latency increase. Projects that don't configure webhooks work fully via file-watching alone.

- **Faster status updates** — webhook push is ~1-5ms vs 75ms debounce. Near-instant UI updates for stage transitions and pipeline lifecycle events.
- **Future remote monitoring** — webhooks are network-transport-agnostic. When remote monitoring is needed later, the webhook path is already in place.
- **Leverage existing infrastructure** — the pipeline already has full webhook delivery (`worca/events/emitter.py`) with HMAC signing, retries, and 20+ event types. No new Python code needed.
- **Event enrichment** — webhook payloads carry structured data (token usage, error details, bead state) that may not be immediately available from status.json when the file watcher fires.

### Webhook Auto-Injection

When a project is registered with the global server, it automatically writes a webhook entry to that project's `.claude/settings.local.json` — **unless the project already has `worca.webhooks` configured**, in which case the existing user-defined configuration takes precedence:

```json
{
  "worca": {
    "webhooks": [{
      "url": "http://localhost:3400/api/projects/inbox",
      "events": ["pipeline.*"],
      "project_id": "my-api"
    }]
  }
}
```

### Pipeline Self-Registration

When `run_pipeline.py` starts, it checks `~/.worca/projects.json` and appends the current project if not listed. This closes the discovery gap without manual registration.

```
Pipeline starts in /dev/my-api
  -> Checks ~/.worca/projects.json
  -> /dev/my-api not listed
  -> Appends { name: "my-api", path: "/dev/my-api" }
  -> Global server picks up change via fs.watch on ~/.worca/projects.json
  -> Sets up watchers for /dev/my-api/.worca/
```

---

## 2. Global Installation

W-017 assumes the server is started from within a project directory. For a truly global instance, we need:

### 2.1 `--global` Flag on `bin/worca-ui.js`

```bash
# Per-project mode (existing, unchanged)
cd /dev/my-project && worca-ui start

# Global mode (new)
worca-ui start --global [--port 3400]
```

In global mode:
- Skip `findProjectRoot()` cwd walk-up
- Read projects from `~/.worca/projects.json` instead
- PID file at `~/.worca/worca-ui-global.pid` (not project-local)
- If `projects.json` doesn't exist, create it empty and show "Add Project" prompt in UI

Later (Phase 6), extract to a standalone `worca-ui-global` npm package with its own release cycle.

### 2.2 Project Management CLI

```bash
worca-ui projects add /path/to/project    # Register a project
worca-ui projects remove my-project       # Unregister by name
worca-ui projects list                    # Show all registered projects
```

These write to `~/.worca/projects.json` and, if the global server is running, it picks up changes via file watching.

### 2.3 Dynamic Project Registration

The global server watches `~/.worca/projects.json` itself. When projects are added/removed (via CLI, REST API, or pipeline self-registration), the server dynamically creates/destroys watcher sets without restart.

```
~/.worca/projects.json changes
  -> fs.watch triggers
  -> Diff old vs new project list
  -> teardownProjectWatchers(removed)
  -> setupProjectWatchers(added)
  -> Broadcast 'projects-updated' to all WS clients
```

### 2.4 Port Strategy

The global server claims port 3400. If port 3400 is already in use, the global server **fails to start** with a clear error message indicating what's occupying the port. Per-project servers continue using `findAvailablePort()` to auto-select the next available port, as they already do today. This keeps the global server at a predictable, bookmarkable URL.

### 2.5 Project Limit

Default limit of 20 projects, configurable via `~/.worca/config.json` (`{ "maxProjects": 20 }`). The limit guards against runaway inotify watchers on Linux.

---

## 3. W-030 Integration: Three-Level Hierarchy

W-030 adds parallel pipelines within a project via git worktrees. Combined with multi-project, this creates:

```
Global Server
  ├─ Project "worca-cc" (watches /dev/worca-cc/.worca/)
  │    ├─ Main run (if any)
  │    ├─ Worktree pipeline 1 (watches /dev/worca-cc/.worktrees/pipeline-abc/.worca/)
  │    └─ Worktree pipeline 2 (watches /dev/worca-cc/.worktrees/pipeline-def/.worca/)
  ├─ Project "my-api" (watches /dev/my-api/.worca/)
  │    └─ Main run only
  └─ Project "frontend" (watches /dev/frontend/.worca/)
       ├─ Worktree pipeline 1
       └─ Worktree pipeline 2
```

**Integration mechanism:**
1. Per-project watcher watches `.worca/multi/registry.json` (W-030's registry)
2. When a worktree pipeline registers, create sub-watchers for `{worktreePath}/.worca/`
3. All worktree runs are tagged with the parent project name in WS messages
4. UI groups worktree runs under their parent project

**WebSocket address:** `{ project: "worca-cc", runId: "20260323-143052-847-a1b2" }` — run ID alone is unique (W-030 adds ms + random suffix), so project + runId is sufficient to identify any pipeline anywhere.

---

## 4. Implementation Details

### 4.1 Log Streaming Across Arbitrary Directories

`fs.watch()` works across the filesystem when the process has read access. On macOS (FSEvents), this is straightforward. On Linux (inotify), there's a per-user watch limit (default 8192). With N projects x M runs x K log files, this could be hit.

**Mitigation:** Warn at startup if watch count approaches the limit. Document `sysctl fs.inotify.max_user_watches=65536`.

### 4.2 Pipeline Control Across Projects

Pause/stop/resume writes to `{worcaDir}/runs/{runId}/control.json` and sends SIGTERM via PID from `{worcaDir}/pipeline.pid`. For the global server:
- Resolve the correct project's `worcaDir` from the registry before writing
- Remove the `pgrep -f run_pipeline.py` fallback in `stopPipeline()` — it could match a pipeline from the wrong project. **Use PID-file-only resolution.**

### 4.3 Full Control Center

The global UI supports starting, stopping, pausing, and resuming pipelines in any registered project.

**Starting pipelines:** `POST /api/runs?project=X` spawns `python run_pipeline.py` with `cwd` set to that project's root. The `startPipeline()` function already accepts `projectRoot` — resolve it from the project registry.

**Stopping/pausing/resuming:** Write `control.json` + SIGTERM via PID file. The global server resolves the target project's `worcaDir` from the registry.

**W-030 parallel launches:** `POST /api/multi-pipeline?project=X` spawns `python run_multi.py` in the target project's directory.

**Process manager refactor:** Refactor `process-manager.js` from module-level state to a `Map<projectName, ProcessState>` to track one process state per project (or per project+worktree for W-030).

### 4.4 Beads Isolation

Each project has its own `.beads/beads.db`. The global server opens separate SQLite connections per project. The existing `beads-reader.js` takes `beadsDbPath` as a parameter, so it already works per-project.

With W-030 worktrees, each worktree gets its own beads DB. The global server does not read worktree beads — those are internal pipeline coordination state. Only the parent project's beads matter for the UI's beads panel.

### 4.5 Settings Per-Project

Different projects have different stage configs, agent models, governance rules. The global server serves settings per-project via `GET /api/settings?project=X`. The settings editor must be scoped to the active project.

### 4.6 Stale Projects

A registered project might be moved or deleted. Handle gracefully:
- `discoverRuns()` on non-existent `worcaDir` returns empty array (already does)
- File watchers on missing paths fail to start — catch and skip
- UI shows "Project not found" indicator
- A "Validate" button in project management checks all paths

### 4.7 Version Compatibility

If the global server is newer than a project's worca-cc, status.json formats might differ. The server already tolerates unknown fields (spreads data with `...`) and handles missing fields (uses `?.` chains). Add a `schema_version` field to status.json to future-proof.

### 4.8 Security

The global server has read/write access to all registered project directories. The user explicitly registers paths. The server binds to `127.0.0.1` (not network-exposed). No new attack surface compared to per-project mode.

---

## 5. Backwards Compatibility

| Scenario | Behavior |
|----------|----------|
| No `~/.worca/projects.json` + `worca-ui start` (per-project mode) | Unchanged. Server walks up from cwd, monitors single project. |
| `~/.worca/projects.json` exists + `worca-ui start` (per-project mode) | Still works. The per-project server ignores `projects.json` and monitors its own project only. |
| `worca-ui start --global` with no `projects.json` | Creates empty `projects.json`, shows "Add Project" in UI. |
| `worca-ui start --global` with `projects.json` | Monitors all registered projects. |
| Legacy URLs (`#/active`, `#/history`) | Resolve to first project. No redirect loop. |
| WS messages without `project` field | Default to first project (projects[0]). |
| `run_pipeline.py` unchanged | Writes to `.worca/` as always. Global server discovers via file watching. |

---

## 6. Implementation Sequence

### Phase 1: W-017 Multi-Project (Server + Client)
Implement W-017 as designed (14 tasks):
- `~/.worca/projects.json` registry
- Multi-project file watchers
- Project-scoped WebSocket protocol
- Sidebar project picker + aggregated dashboard

### Phase 2: Global Installation + Full Control Center
On top of W-017:
- `--global` flag on `bin/worca-ui.js`
- `worca-ui projects add/remove/list` CLI
- Dynamic project registration (watch `projects.json`)
- Pipeline self-registration in `runner.py`
- Multi-project process manager (`Map<project, ProcessState>`)
- Full control: start/stop/pause/resume pipelines in any project from the global UI
- PID file at `~/.worca/worca-ui-global.pid`

### Phase 3: Webhook Supplementary Channel
Add webhook integration alongside file-watching:
- `POST /api/projects/inbox` endpoint for receiving pipeline webhooks
- Auto-inject webhook config into project's `settings.local.json` on registration (skip if project already has `worca.webhooks` defined)
- Webhook events trigger immediate status refresh (bypass 75ms debounce)
- Project identification via `X-Worca-Project` header or `project_id` in payload
- Graceful degradation: if webhooks aren't configured, file-watching covers everything

### Phase 4: W-030 Parallel Pipelines
Implement W-030 as designed (17 tasks):
- Git worktree isolation
- `.worca/multi/registry.json`
- Multi-pipeline dashboard within a project

### Phase 5: W-017 + W-030 Integration
Connect the two:
- Global server watches each project's `multi/registry.json`
- Dynamic sub-watchers for worktree pipelines
- Three-level UI hierarchy (projects → pipelines → stages)
- `POST /api/multi-pipeline?project=X` for launching parallel runs from any project

### Phase 6 (Later): Extract to Standalone Package
- Publish `worca-ui-global` as separate npm package
- `npm install -g worca-ui-global && worca-ui-global start`
- Separate release cycle from worca-cc

---

## 7. Key Files to Modify

| File | Phase | Change |
|------|-------|--------|
| `server/project-registry.js` | 1 | New — read/write `~/.worca/projects.json` |
| `server/ws.js` | 1,3,5 | Multi-project watchers, webhook hint integration, worktree sub-watchers |
| `server/index.js` | 1,2 | Project registry loading, `--global` mode |
| `server/app.js` | 1,2,3 | `/api/projects` endpoints, project-scoped pipeline control, webhook inbox |
| `server/process-manager.js` | 2,4 | Multi-project process map (`Map<project, ProcessState>`), remove `pgrep` fallback |
| `app/state.js` | 1 | Two-level `projectRuns` state shape |
| `app/router.js` | 1 | `#/project/{slug}/{section}` routing |
| `app/main.js` | 1,5 | Project switching, scoped subscriptions, three-level rendering |
| `app/views/sidebar.js` | 1 | Project picker |
| `app/views/dashboard.js` | 1,5 | Aggregated project cards, parallel pipeline cards |
| `bin/worca-ui.js` | 2 | `--global` flag, `projects` subcommand |
| `.claude/worca/orchestrator/runner.py` | 2 | `_auto_register_project()` |

---

## 8. Decisions

1. **Maximum project count:** Default 20, configurable via `~/.worca/config.json` (`{ "maxProjects": 20 }`). Guards against runaway inotify watchers on Linux.
2. **Webhook auto-injection:** Auto-inject on project registration. Existing `worca.webhooks` config takes precedence.
3. **Remote monitoring:** Deferred. The webhook channel enables it later; auth/TLS/network binding are out of scope now.
4. **Port strategy:** Global server uses 3400 exclusively; fails to start if occupied. Per-project servers auto-find available ports.
5. **Packaging:** Phased — `--global` flag first (Phase 2), standalone npm package later (Phase 6).

---

## 9. Design Amendments

The following amendments resolve design deficiencies identified during review. They supersede or extend the corresponding sections in the original plan.

### 9.1 ws.js Decomposition (Amends Section 7)

Before implementing multi-project watchers, decompose `server/ws.js` (1,385 lines, 12 concerns) into 7 focused modules:

| New Module | Responsibility | Extracted From |
|-----------|---------------|----------------|
| `server/ws-client-manager.js` | Client subscriptions, heartbeat, WeakMap tracking | Lines ~100-160 |
| `server/ws-broadcaster.js` | Message broadcasting, subscription-filtered delivery | Scattered broadcast functions |
| `server/ws-status-watcher.js` | Status/active-run file watching, debounced refresh | Lines ~320-400 |
| `server/ws-log-watcher.js` | Log file/stage/iteration watching, line counting | Lines ~420-560 |
| `server/ws-beads-watcher.js` | Beads DB watching, debounced refresh | Lines ~570-600 |
| `server/ws-event-watcher.js` | events.jsonl subscription management | Lines ~160-180, 1300+ |
| `server/ws-message-router.js` | Message dispatch (23 handlers) | Lines ~650-1350 |

`ws.js` becomes an orchestrator (~100 lines) that imports and wires these modules.

**Effort:** 8-12 hours. **Risk:** Medium (many files but each is simple). **Prerequisite for:** Phase 1 multi-project watchers.

### 9.2 State Management (Amends Section 7, `app/state.js`)

Full rewrite to nested project-scoped structure:

```javascript
{
  activeProject: "project-name",
  projects: {
    [name]: {
      activeRunId: null,    // remove ghost field from per-project if unused
      runs: { [id]: runObj },
      logLines: [],
      beads: { issues: [], dbExists: false, loading: false },
      webhookInbox: { events: [], controlAction: 'continue' }
    }
  },
  preferences: { theme, sidebarCollapsed, notifications }  // GLOBAL, not per-project
}
```

**Impact:** ~23 files (19 source + 4 tests). All view components that call `store.getState()` must access `state.projects[state.activeProject].X`. Preferences remain global (one user, one theme). Remove unused `activeRunId` field.

**Key files:** `state.js`, `main.js`, `notifications.js`, all `views/*.js`, `state.test.js`, `main-*.test.js`.

### 9.3 REST API Scoping (Amends Section 7, `server/app.js`)

Use URL path prefix pattern for project-scoped endpoints:

```
Project-scoped (23 endpoints):
  /api/projects/:projectId/runs
  /api/projects/:projectId/runs/:id/status
  /api/projects/:projectId/settings
  /api/projects/:projectId/beads/issues
  /api/projects/:projectId/costs
  /api/projects/:projectId/branches
  /api/projects/:projectId/plan-files
  /api/projects/:projectId/project-info
  ... etc

Global (unchanged):
  /api/webhooks/test
  /api/webhooks/inbox
  /api/webhooks/inbox/control

New global endpoints:
  GET  /api/projects              — list registered projects
  POST /api/projects              — register new project
  DELETE /api/projects/:projectId — unregister project
```

**Implementation:** Create Express sub-router with `projectResolver` middleware that validates `:projectId` and injects `req.project = { worcaDir, projectRoot, settingsPath }`. Extract handler logic from closured values to `req.project` references.

### 9.4 Process Manager (Amends Section 7, `server/process-manager.js`)

Replace current stateless functions with a `ProcessManager` class:

```javascript
class ProcessManager {
  constructor(projectRegistry) {
    this.registry = projectRegistry;
    this.processes = new Map(); // projectName → { pid, worcaDir, startTime }
  }
  startPipeline(projectName, opts) { ... }
  stopPipeline(projectName) { ... }  // NO pgrep fallback
  pausePipeline(projectName, runId) { ... }
  restartStage(projectName, stageKey, opts) { ... }
}
```

**Critical:** Remove the `pgrep -f run_pipeline.py` fallback (lines 285-301) that could kill the wrong project's pipeline. PID file is the sole source of truth. The class provides explicit project-to-process mapping needed for both W-032 and future W-030 multi-pipeline support.

### 9.5 Project Registry Format (Amends Section 2)

Replace single `~/.worca/projects.json` with directory-based registry:

```
~/.worca/projects.d/
  worca-cc.json    → { "name": "worca-cc", "path": "/dev/worca-cc" }
  my-api.json      → { "name": "my-api", "path": "/dev/my-api" }
  frontend.json    → { "name": "frontend", "path": "/dev/frontend" }
```

**Rationale:** Eliminates race condition when multiple pipelines self-register simultaneously. Each pipeline writes its own file atomically via `tempfile.mkstemp()` + `os.rename()`. No file locking needed.

**Server-side:** `project-registry.js` scans `projects.d/` to assemble project list. Watches directory for add/remove events.

**Pipeline-side:** New `worca/utils/project_registry.py` with `auto_register_project(project_path)`.

### 9.6 Watcher Lifecycle (Amends Section 4.1)

Introduce `WatcherSet` class for per-project watcher lifecycle:

```javascript
class WatcherSet {
  constructor(projectId, worcaDir) { ... }
  create()   // Initialize statusWatcher, activeRunWatcher, beadsWatcher, logWatchers, eventWatchers
  destroy()  // Close all watchers, clear all timers, set closed=true
  isAlive()  // Check !closed && existsSync(worcaDir)
}
```

**Global server manages:** `Map<projectName, WatcherSet>`. On project add: `new WatcherSet(name, dir).create()`. On project remove: `watcherSet.destroy()`.

**Immediate fix:** Add `process.on('SIGTERM', cleanup)` and `process.on('exit', cleanup)` handlers to prevent orphaned watchers on shutdown.

### 9.7 Port Strategy (Amends Section 2.4)

Both modes default to 3400. Smart conflict detection before startup:

1. Read PID file (extended format: `{ pid, port, host, mode: "global"|"per-project", projectPath, started_at }`)
2. If port occupied by same mode: suggest `--port` flag
3. If port occupied by different mode: explain what's running, suggest stop command or alternate port
4. Fix hardcoded `http://localhost:3400` in `webhook-inbox.js` — derive URL from actual server port

**No silent fallback.** Fail with clear error messages. User explicitly chooses resolution.

### 9.8 Binary Distribution (Amends Section 6)

**Accept status quo for Phases 1-5.** Run global mode from one project's `.claude/worca-ui/` copy. Document this in README: "For global mode, launch from any project: `cd /path/to/any-project && worca-ui start --global`."

Phase 6 (standalone npm package) remains the proper fix. Not a blocker for Phases 1-5.

### 9.9 Testing Strategy (New Section)

Dual test approach for multi-project:

**Test doubles** (API contract tests):
- `FakeProjectRegistry` — in-memory project list
- `FakeFileWatcher` — simulated file change events
- `FakeProcessManager` — tracks spawn calls without real processes
- Use for: endpoint scoping, state isolation, message routing

**Test fixtures factory** (filesystem/WebSocket tests):
- `createMultiProjectFixture([{ name, runs, settings }])` — generates temp directory trees with populated `.worca/` dirs
- Matches existing `seedRun()` / `startServer()` patterns
- Use for: watcher behavior, log tailing, beads isolation, e2e flows

**New test files:**
- `test/multi-project-fixtures.js` — reusable fixture factory
- `test/multi-project-api.test.js` — project-scoped endpoints
- `test/multi-project-isolation.test.js` — cross-project data isolation
- `test/multi-project-websocket.test.js` — project-scoped subscriptions
- `test/multi-project-process-manager.test.js` — ProcessManager class
- `e2e/multi-project.spec.js` — browser-level project switching

**Playwright:** Maintain `--workers=1` constraint. Multi-project e2e tests are even more sensitive to parallel execution.

### 9.10 Webhook Strategy (Amends Section 1, Phase 3)

**File-watching is the sole data mechanism.** Webhooks are entirely optional.

- Global server uses file-watching (W-017 mechanism) for all data: logs, run state, beads, settings
- No auto-injection of webhook config into project files
- Projects that want sub-10ms updates can manually add webhook URL to their `settings.local.json`
- Phase 3 (Webhook Supplementary Channel) becomes: "Add `/api/projects/inbox` endpoint that accepts optional webhook hints to trigger immediate refresh (bypasses 75ms debounce). Zero configuration required."

**Rationale:** File-watching already provides complete data coverage. Webhooks add complexity (injection, lifecycle, cleanup) for marginal latency improvement (75ms → 5ms) that doesn't matter for pipeline monitoring UX.

### 9.11 Watcher Budget (Amends Section 4.1)

Add startup watcher budget calculation:

```javascript
function calculateWatcherBudget(projectCount, watchersPerProject = 19) {
  const total = projectCount * watchersPerProject;
  const LINUX_LIMIT = 8192;
  if (total > LINUX_LIMIT * 0.6) {
    console.warn(`Watcher budget: ${total}/${LINUX_LIMIT} (${(total/LINUX_LIMIT*100).toFixed(1)}%)`);
  }
  if (total > LINUX_LIMIT) {
    throw new Error(`Watcher limit exceeded. Reduce projects or run: sysctl -w fs.inotify.max_user_watches=65536`);
  }
}
```

Log budget on startup. Warn at 60%. Refuse above 100% with actionable sysctl command.

**Actual numbers:** 20 projects = 380 watchers (4.6% of limit). The 20-project default is conservative and safe.

### 9.12 URL Routing (Amends Section 5)

**Always require project in URL for global mode.** No "first project" fallback.

```
Global mode URLs:
  #/dashboard                          — Cross-project overview
  #/project/{slug}/active              — Project's active runs
  #/project/{slug}/history             — Project's run history
  #/project/{slug}/active?run={id}     — Specific run detail
  #/project/{slug}/settings            — Project settings
  #/project/{slug}/beads               — Project beads
```

**Legacy URL handling:** `#/active` or `#/history` → redirect to `#/dashboard` (project picker). No ambiguous "first project" resolution.

**Per-project mode (unchanged):** Existing `#/active`, `#/history` URLs work as today. No project prefix needed when server monitors a single project.

### 9.13 Dependency Strategy (Amends Section 6)

**Decouple W-032 from W-017 and W-030.** Implement needed features directly within W-032, not as separate prerequisite phases.

**Revised implementation sequence:**

| Phase | Scope | Notes |
|-------|-------|-------|
| 0 | ws.js decomposition + state rewrite + REST scoping | Foundation work (Findings 1-3) |
| 1 | Multi-project core | Project registry (projects.d/), project-scoped watchers (WatcherSet), ProcessManager class, URL routing, sidebar project picker, aggregated dashboard |
| 2 | Global installation | `--global` flag, CLI commands, dynamic registration, pipeline self-registration, port conflict detection |
| 3 | Webhook hints (optional) | `/api/projects/inbox` endpoint. No auto-injection. File-watching remains primary. |
| 4 | W-030 parallel pipelines | Implement inline when needed. Run ID uniqueness, worktree lifecycle, registry, run_multi.py. |
| 5 | W-030 integration | Three-level UI, worktree sub-watchers, multi-pipeline dashboard |
| 6 | Standalone package | Extract to `@worca/ui` npm package |

**Key change:** No dependency gates. W-017 tasks are absorbed into Phase 0-1. W-030 tasks are absorbed into Phase 4-5. Each phase is self-contained and shippable.

### 9.14 Notification System (New Section)

Phased implementation of cross-project attention management:

**Phase 1 (with W-032 Phase 1, 3 days):** Enhanced desktop notifications
- Add project name to notification title: `"[Project A] Pipeline Failed"`
- Smart delivery: only `run_failed` and `approval_needed` trigger desktop notifications
- Other events (test_failures, loop_limit_warning) are silent/feed-only
- Notification tag includes project: `worca-${projectId}-${eventType}-${runId}`
- Click navigates to `#/project/{slug}/active?run={id}`

**Phase 2 (with W-032 Phase 2, 5-6 days):** Project status badges
- Sidebar shows per-project status icons: green (idle), orange (running), red (error), yellow (approval needed)
- Unread error count badge per project
- Computed from all runs in project state

**Phase 3 (if needed at scale):** Global notification feed
- Persistent collapsible panel aggregating events across all projects
- Filtering by severity, project, event type
- Per-event and batch dismissal

### 9.15 Resource Management (New Section)

**SQLite connection pooling:**
- Replace per-request `new Database()` / `db.close()` in `beads-reader.js` with persistent pool
- 3-5 connections per project, reused across queries
- Prepared statements for common queries
- ~50% CPU reduction on beads operations

**Activity-based tiering:**

| Tier | Criteria | Resources |
|------|----------|-----------|
| Full | User viewing in UI OR pipeline running | All watchers, log tailing, beads polling, 75ms debounce |
| Polling | Registered but inactive | Status watcher only, 5s debounce, no log watchers, no beads polling |
| Archived | No activity for 24h+ | Read-only snapshots, no watchers |

Projects start in Polling tier. Promote to Full when WebSocket client subscribes. Demote when no clients and no active pipeline.
