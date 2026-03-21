# W-001: Pipeline Resume & Checkpointing

**Date:** 2026-03-21 (revised)
**Status:** Draft
**Author:** Manual design review
**Supersedes:** Previous W-001 draft (narrow scope, resume-only)
**Related:** W-003 (Events & Webhooks), W-009 (Pipeline Control Actions)

---

## 1. Goal & Scope

Transform the pipeline from a fire-and-forget process into a **fully controllable lifecycle** with pause, stop, resume, webhook events, and UI controls. Today, if a run crashes or gets interrupted, context is lost and recovery is fragile. This plan addresses:

1. **Pause** — gracefully suspend at the next clean iteration boundary
2. **Stop** — kill the running pipeline process (SIGTERM)
3. **Resume** — restart from the last completed iteration within a stage
4. **Webhook events** — emit all lifecycle events with shell-based hooks
5. **UI controls** — full lifecycle management from the browser
6. **State icons** — visual status indicators with colors throughout the UI

### In Scope

- Pipeline state machine: PENDING → RUNNING → PAUSED / COMPLETED / FAILED
- Control file protocol for pause/stop signals
- Iteration-level resume (not just stage-level)
- PromptBuilder state persistence for context recovery
- Loop counter persistence
- Git HEAD divergence guard on resume
- Event emission at all lifecycle points
- Shell-based webhook hooks (stdin JSON)
- REST API endpoints for pause/resume/stop
- UI buttons, status badges, and state icons with colors
- CLI commands: `worca pause`, `worca stop`, `worca resume`, `worca status`

### Out of Scope

- Multi-run concurrency (still single-run via PID lock)
- Mid-agent-call pause (only between iterations)
- Persistent event store (stays JSONL file)
- Authentication for webhook receivers
- Remote pipeline control (local machine only)

---

## 2. State Machine

```
                        ┌──────────────────────┐
                        │    (inter-iteration   │
                        │     loop)             │
    ┌─────────┐  start  ├─────────┐            │
    │ PENDING ├────────►│ RUNNING ├────────────┘
    └─────────┘         └────┬────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
           pause          completes      crash/stop
              │              │              │
        ┌─────▼────┐  ┌─────▼──────┐  ┌────▼─────┐
        │  PAUSED  │  │ COMPLETED  │  │  FAILED  │
        └─────┬────┘  └────────────┘  └────┬─────┘
              │                             │
              │          resume             │
              └──────────┬──────────────────┘
                         │
                  ┌──────▼──────┐
                  │  RESUMING   │──► RUNNING
                  └─────────────┘
```

### Transitions

| From | To | Trigger |
|------|----|---------|
| PENDING | RUNNING | Pipeline starts |
| RUNNING | RUNNING | Iteration completes, next begins |
| RUNNING | PAUSED | Control file `pause` detected between iterations |
| RUNNING | COMPLETED | Final stage completes successfully |
| RUNNING | FAILED | Crash, error, or SIGTERM (stop) |
| PAUSED | RESUMING → RUNNING | `resume` action (re-launches process) |
| FAILED | RESUMING → RUNNING | `resume` action with dirty-state recovery |

### Why No Separate STOPPED State

From the resume logic's perspective, stopped and crashed are identical — both have potentially dirty state from an incomplete iteration. The `reason` field in status.json distinguishes them for display: `"reason": "stopped"` vs `"reason": "error"` vs `"reason": "signal"`.

---

## 3. Control File Protocol

### Location

```
.worca/runs/{run_id}/control.json
```

### Format

```json
{
  "action": "pause",
  "requested_at": "2026-03-21T14:30:00Z",
  "source": "ui"
}
```

### Actions

| Action | Orchestrator Behavior |
|--------|----------------------|
| `pause` | Finish nothing more, save state cleanly, write status `paused`, exit with code 0 |
| `stop` | Send SIGTERM to running Claude subprocess, mark status `failed` with `reason: "stopped"`, exit |

### Orchestrator Polling

The orchestrator checks for the control file at the **top of every iteration loop** — a cheap `os.path.exists()` + `json.load()` call. This means:

- Pause takes effect **after the current agent call completes** (seconds to minutes)
- The state is always clean when paused (iteration either completed or never started)
- No mid-agent-call interruption (agent calls are atomic from the orchestrator's perspective)

### Lifecycle

1. External actor (CLI, UI, webhook) writes `control.json`
2. Orchestrator detects it at the next iteration boundary
3. Orchestrator reads and **deletes** the control file
4. Orchestrator executes the action (pause or stop)

### Resume

Resume does **not** use the control file. It spawns a new `run_pipeline.py --resume` process. The new process:

1. Reads `status.json` to find the last state
2. Recovers context from completed iterations
3. Continues from where it left off

---

## 4. Iteration-Level Resume

### Current Behavior

Resume finds the first non-completed stage and re-runs it from scratch, losing all completed iterations within that stage.

### New Behavior

Resume finds the first non-completed stage, then within that stage:

1. Identifies the last **completed** iteration
2. **Discards** any `in_progress` iteration (dirty state from crash/stop)
3. Rebuilds PromptBuilder context from all completed iteration outputs
4. Resumes from iteration N+1
5. Restores persisted loop counters

### Status.json Changes

```json
{
  "stages": {
    "implement": {
      "status": "in_progress",
      "iterations": [
        {"number": 1, "status": "completed", "output": {...}},
        {"number": 2, "status": "completed", "output": {...}},
        {"number": 3, "status": "in_progress"}
      ]
    }
  },
  "loop_counters": {
    "implement_test": 3,
    "pr_changes": 0,
    "restart_planning": 0
  },
  "git_head": "abc123def456",
  "pipeline_status": "paused"
}
```

**New fields:**
- `loop_counters` (top-level) — persisted after each iteration
- `git_head` — SHA recorded at pipeline start, validated on resume
- `pipeline_status` — overall run state: `"running"`, `"paused"`, `"completed"`, `"failed"`

### PromptBuilder Persistence

After each completed iteration, save PromptBuilder context:

```
.worca/runs/{run_id}/prompt_context.json
```

```json
{
  "plan_approach": "...",
  "coordinate_output": "...",
  "test_failures": "...",
  "assigned_bead_id": "beads-xxx",
  "custom_keys": {}
}
```

On resume, `PromptBuilder` is initialized from this file instead of being reconstructed from logs (which loses inter-stage metadata).

### Git Divergence Guard

On resume:
1. Read `git_head` from status.json
2. Compare with current `git rev-parse HEAD`
3. If different: warn and ask for confirmation (CLI) or show warning in UI
4. If same: proceed silently

---

## 5. Webhook / Event System

### Event Types

All events write to `events.jsonl` AND fire configured shell hooks.

| Event | Payload |
|-------|---------|
| `pipeline.started` | `{run_id, work_request, branch}` |
| `pipeline.paused` | `{run_id, stage, iteration, reason}` |
| `pipeline.resumed` | `{run_id, stage, iteration, resume_from}` |
| `pipeline.completed` | `{run_id, stages_summary, token_usage}` |
| `pipeline.failed` | `{run_id, stage, iteration, error, reason}` |
| `stage.started` | `{run_id, stage, agent, model}` |
| `stage.completed` | `{run_id, stage, iterations_count, output_summary}` |
| `stage.failed` | `{run_id, stage, iteration, error}` |
| `iteration.started` | `{run_id, stage, iteration_number}` |
| `iteration.completed` | `{run_id, stage, iteration_number, duration_ms, cost_usd}` |
| `milestone.reached` | `{run_id, milestone, value}` |

### Event Envelope

```json
{
  "schema_version": "1",
  "event_id": "<uuid4>",
  "event_type": "pipeline.paused",
  "timestamp": "<ISO-8601 UTC>",
  "run_id": "20260321-143000",
  "payload": { ... }
}
```

### Hook Configuration

```json
// .claude/settings.json
"worca": {
  "hooks": {
    "pipeline.started": ["curl -s -X POST http://localhost:3000/api/webhook -d @-"],
    "pipeline.completed": ["./scripts/notify.sh"],
    "stage.completed": ["curl -s -X POST http://localhost:3000/api/webhook -d @-"],
    "*": []
  }
}
```

**Execution model:**
- Hooks receive the full event JSON envelope on **stdin**
- Array value allows multiple handlers per event
- `*` matches all events (catch-all)
- Hooks run asynchronously (fire-and-forget, don't block the pipeline)
- Hook failures are logged but never halt the pipeline

### Relationship to W-003

W-003 defines the comprehensive event schema and webhook delivery with retries. This plan implements the **minimal v1** needed for pipeline control. The full W-003 schema (tool-call events, governance events, etc.) can be added incrementally on top.

---

## 6. CLI Commands

New top-level commands (thin wrappers around control file + process management):

| Command | Effect |
|---------|--------|
| `worca pause [run_id]` | Write `control.json` with `action: pause` |
| `worca stop [run_id]` | Write `control.json` with `action: stop` + SIGTERM to PID |
| `worca resume [run_id]` | Spawn `run_pipeline.py --resume` |
| `worca status [run_id]` | Print current pipeline state, stage, iteration |

When `run_id` is omitted, operates on the active run (from `.worca/active_run`).

### Implementation

Add `worca` as a Python CLI entry point in `pyproject.toml`, or as a standalone script at `.claude/scripts/worca.py`. Each command is ~20 lines — read active_run, write control file or spawn process.

---

## 7. REST API Endpoints

Extend the existing Express server in `server/app.js`:

| Method | Endpoint | Effect |
|--------|----------|--------|
| `POST` | `/api/runs/:id/pause` | Write control.json for the run |
| `POST` | `/api/runs/:id/resume` | Spawn `run_pipeline.py --resume` via ProcessManager |
| `POST` | `/api/runs/:id/stop` | Write control.json + SIGTERM via ProcessManager |
| `GET` | `/api/runs/:id/status` | Return current pipeline_status + stage + iteration |

**Pause endpoint:**
```javascript
app.post('/api/runs/:id/pause', (req, res) => {
  const controlPath = join(worcaDir, 'runs', req.params.id, 'control.json');
  writeFileSync(controlPath, JSON.stringify({
    action: 'pause',
    requested_at: new Date().toISOString(),
    source: 'ui'
  }));
  res.json({ ok: true });
});
```

**Resume endpoint** uses the existing `startPipeline()` from `process-manager.js` with `resume: true`.

**Stop endpoint** uses the existing `stopPipeline()` from `process-manager.js`, plus writes control.json as a belt-and-suspenders measure.

### WebSocket Events

Add to the existing WS protocol:

| Event | Direction | Payload |
|-------|-----------|---------|
| `pipeline-paused` | server → client | `{run_id, stage, iteration}` |
| `pipeline-resumed` | server → client | `{run_id, stage, iteration}` |
| `pause-run` | client → server | `{run_id}` |
| `resume-run` | client → server | `{run_id}` (already exists) |
| `stop-run` | client → server | `{run_id}` |

The server file watcher already monitors `.worca/` — when `status.json` changes with `pipeline_status: "paused"`, it broadcasts `pipeline-paused` to connected clients.

---

## 8. UI Changes

### 8.1 Status Icons & Colors

Extend `app/utils/status-badge.js` with new states:

| State | Icon (Lucide) | Color | CSS Class | Badge Variant |
|-------|---------------|-------|-----------|---------------|
| `pending` | `Circle` | Gray `#94a3b8` | `status-pending` | `neutral` |
| `running` | `Loader` (spin) | Blue `#3b82f6` | `status-running` | `primary` |
| `paused` | `Pause` | Amber `#f59e0b` | `status-paused` | `warning` |
| `completed` | `CircleCheck` | Green `#22c55e` | `status-completed` | `success` |
| `failed` | `CircleAlert` | Red `#ef4444` | `status-failed` | `danger` |
| `resuming` | `RotateCw` (spin) | Blue `#3b82f6` | `status-resuming` | `primary` |
| `skipped` | `CircleSlash` | Gray `#94a3b8` | `status-skipped` | `neutral` |

**Migration:** The current `in_progress` status maps to `running`. The current `error` maps to `failed`. The current `interrupted` maps to `paused`. Update `resolveStatus()` to handle the new naming.

### 8.2 Where Icons Appear

Icons with colors appear in every location that shows pipeline or stage status:

1. **Sidebar run list** — icon + color dot next to each run title
2. **Dashboard active runs** — colored status badge on each run card
3. **Run cards** (`run-card.js`) — status icon in header, colored border-left accent
4. **Run detail** (`run-detail.js`) — large status badge in header area
5. **Stage timeline** (`stage-timeline.js`) — per-stage icon in timeline nodes
6. **Stage badges** — colored pills in run cards showing stage completion
7. **History / results list** — icon + color for archived runs

### 8.3 Control Buttons

Add to `run-detail.js` header area:

| Button | Icon | Visible When | Action |
|--------|------|-------------|--------|
| **Pause** | `Pause` | RUNNING | `POST /api/runs/:id/pause` |
| **Resume** | `Play` | PAUSED or FAILED | `POST /api/runs/:id/resume` |
| **Stop** | `Square` | RUNNING or PAUSED | `POST /api/runs/:id/stop` with confirmation dialog |

**Button styling:**
- Pause: amber outline button
- Resume: green filled button
- Stop: red outline button, requires `sl-dialog` confirmation

### 8.4 Run Card Updates

In `run-card.js`, add:
- Left border accent color matching pipeline status
- Animated pulse on the status icon when RUNNING
- Static pause icon when PAUSED
- Tooltip showing time in current state (e.g., "Paused 5m ago")

### 8.5 Dashboard Updates

In `dashboard.js`:
- Group active runs by state: RUNNING first, then PAUSED, then FAILED
- Show count badges: "2 running, 1 paused"
- Quick-action buttons inline on each card (pause/resume)

---

## 9. Implementation Phases

### Phase 1: Core State Machine & Control File (Python)

**Files modified:**
- `.claude/worca/orchestrator/runner.py` — control file polling in iteration loop, pipeline_status field
- `.claude/worca/state/status.py` — add `pipeline_status`, `loop_counters`, `git_head` fields
- `.claude/worca/orchestrator/resume.py` — iteration-level resume logic, PromptBuilder recovery
- `.claude/worca/orchestrator/prompt_builder.py` — save/load context to `prompt_context.json`

**New files:**
- `.claude/worca/orchestrator/control.py` — control file read/write/delete utilities
- `.claude/scripts/worca.py` — CLI entry point for pause/stop/resume/status
- `tests/test_control.py` — control file protocol tests
- `tests/test_iteration_resume.py` — iteration-level resume tests

**Deliverable:** `worca pause`, `worca stop`, `worca resume` work from CLI. Pipeline saves/restores state at iteration boundaries.

### Phase 2: Event System & Webhooks (Python)

**Files modified:**
- `.claude/worca/orchestrator/runner.py` — emit events at all lifecycle points
- `.claude/settings.json` — add `worca.hooks` configuration

**New files:**
- `.claude/worca/orchestrator/events.py` — event emitter with hook execution
- `tests/test_events.py` — event emission and hook dispatch tests

**Deliverable:** All lifecycle events written to `events.jsonl` and dispatched to configured shell hooks.

### Phase 3: REST API & WebSocket (Node.js)

**Files modified:**
- `.claude/worca-ui/server/app.js` — add pause/resume/stop endpoints
- `.claude/worca-ui/server/ws.js` — add pause/resume/stop WS messages, broadcast pipeline state changes
- `.claude/worca-ui/server/process-manager.js` — add `pausePipeline()`, update `startPipeline()` for resume
- `.claude/worca-ui/server/watcher.js` — detect `pipeline_status` changes in status.json

**Deliverable:** REST + WebSocket API for full lifecycle control.

### Phase 4: UI Controls & Icons (Frontend)

**Files modified:**
- `.claude/worca-ui/app/utils/status-badge.js` — new states, icons, colors
- `.claude/worca-ui/app/utils/icons.js` — add `Play`, `Square`, `RotateCw`, `CircleSlash` icons
- `.claude/worca-ui/app/views/run-card.js` — status icon, border accent, tooltip
- `.claude/worca-ui/app/views/run-detail.js` — control buttons (pause/resume/stop)
- `.claude/worca-ui/app/views/stage-timeline.js` — updated stage icons
- `.claude/worca-ui/app/views/dashboard.js` — grouped active runs, count badges
- `.claude/worca-ui/app/views/sidebar.js` — status icon next to run titles
- `.claude/worca-ui/app/views/run-list.js` — status icons in list view
- `.claude/worca-ui/app/styles.css` — new status color classes, button styles

**Deliverable:** Full visual lifecycle in the browser with icons, colors, and control buttons.

### Phase 5: Browser-Based Testing (Playwright)

**New dev dependency:**
- `@playwright/test` added to `worca-ui/package.json`

**New files:**
- `.claude/worca-ui/test/browser/playwright.config.js` — Playwright config (Chromium only, localhost server)
- `.claude/worca-ui/test/browser/fixtures.js` — shared test fixtures (server startup, mock .worca directory, status.json seeding)
- `.claude/worca-ui/test/browser/status-icons.spec.js` — visual: status icons and colors
- `.claude/worca-ui/test/browser/control-buttons.spec.js` — interaction: pause/resume/stop buttons
- `.claude/worca-ui/test/browser/run-lifecycle.spec.js` — integration: full pause→resume→complete flow
- `.claude/worca-ui/test/browser/dashboard.spec.js` — visual: dashboard grouping and count badges
- `.claude/worca-ui/test/browser/sidebar.spec.js` — visual: sidebar status icons
- `.claude/worca-ui/test/browser/stage-timeline.spec.js` — visual: stage timeline states
- `.claude/worca-ui/test/browser/websocket-updates.spec.js` — integration: real-time status changes via WS

**Scripts added to `package.json`:**
```json
"test:browser": "npx playwright test --project=chromium",
"test:browser:headed": "npx playwright test --project=chromium --headed",
"test:browser:debug": "npx playwright test --project=chromium --debug"
```

**Deliverable:** Full browser test suite covering visual states, user interactions, and real-time WebSocket updates.

---

## 10. Testing Strategy

### 10.1 Unit Tests (Python)

| Test | What It Verifies |
|------|-----------------|
| `test_control_file_pause` | Orchestrator detects pause control file and exits cleanly |
| `test_control_file_stop` | Orchestrator detects stop control file and sends SIGTERM |
| `test_control_file_consumed` | Control file is deleted after being read |
| `test_iteration_resume_clean` | Resume after pause starts from iteration N+1 |
| `test_iteration_resume_dirty` | Resume after crash discards in_progress iteration |
| `test_loop_counters_persisted` | Loop counters survive across resume |
| `test_prompt_context_saved` | PromptBuilder context written after each iteration |
| `test_prompt_context_loaded` | PromptBuilder initialized from saved context on resume |
| `test_git_divergence_detected` | Resume warns when HEAD differs from saved git_head |
| `test_event_emission` | Events written to events.jsonl with correct envelope |
| `test_hook_dispatch` | Shell hooks receive event JSON on stdin |
| `test_hook_failure_non_blocking` | Failed hook doesn't halt the pipeline |

### 10.2 Server Integration Tests (Node.js / Vitest)

| Test | What It Verifies |
|------|-----------------|
| `test_pause_endpoint` | POST /api/runs/:id/pause writes control.json |
| `test_resume_endpoint` | POST /api/runs/:id/resume spawns pipeline process |
| `test_stop_endpoint` | POST /api/runs/:id/stop sends SIGTERM |
| `test_ws_pipeline_paused` | WebSocket broadcasts pipeline-paused on status change |

### 10.3 Browser Tests (Playwright / Chromium)

End-to-end browser tests run against a real worca-ui server with a mock `.worca/` directory seeded with test status.json files. Tests use Playwright's Chromium browser.

#### Test Infrastructure

**Fixtures (`test/browser/fixtures.js`):**
- `startServer()` — boots the Express + WS server on a random port with a temp `.worca/` dir
- `seedRun(runId, statusOverrides)` — writes a status.json with configurable `pipeline_status`, stages, and iterations
- `writeControlFile(runId, action)` — simulates external control file writes
- `waitForWsMessage(page, eventType)` — helper to await specific WebSocket messages in the browser

**Playwright config:**
- Single project: Chromium only (matching the Playwright MCP setup)
- Base URL: `http://127.0.0.1:{random_port}`
- Web server: auto-start via `startServer()` fixture
- Screenshots on failure: saved to `test/browser/screenshots/`
- Timeout: 30s per test (accounts for server startup + rendering)

#### Visual Tests — Status Icons & Colors

**`status-icons.spec.js`:**

| Test | Steps | Assertion |
|------|-------|-----------|
| `running icon is blue spinner` | Seed run with `pipeline_status: "running"` → navigate to run list | Run card has `.status-running` class, icon is Loader SVG with `.icon-spin` |
| `paused icon is amber pause` | Seed run with `pipeline_status: "paused"` → navigate to run list | Run card has `.status-paused` class, icon is Pause SVG, color is `#f59e0b` |
| `failed icon is red alert` | Seed run with `pipeline_status: "failed"` → navigate to run list | Run card has `.status-failed` class, icon is CircleAlert SVG, color is `#ef4444` |
| `completed icon is green check` | Seed run with `pipeline_status: "completed"` → navigate to run list | Run card has `.status-completed` class, icon is CircleCheck SVG, color is `#22c55e` |
| `resuming icon is blue spinner` | Seed run with `pipeline_status: "resuming"` → navigate to run list | Run card has `.status-resuming` class, icon is RotateCw SVG with `.icon-spin` |
| `skipped icon is gray circle` | Seed run with stage `status: "skipped"` → navigate to run detail | Stage has `.status-skipped` class, icon is CircleSlash SVG |
| `run card has colored left border` | Seed runs in each state → navigate to run list | Each card's `border-left-color` matches its status color |

#### Visual Tests — Dashboard & Sidebar

**`dashboard.spec.js`:**

| Test | Steps | Assertion |
|------|-------|-----------|
| `groups active runs by state` | Seed 2 running + 1 paused + 1 failed → navigate to dashboard | Running runs appear first, then paused, then failed |
| `shows count badges` | Seed multiple runs → navigate to dashboard | Count badges show "2 running, 1 paused" (or similar) |
| `quick-action buttons on cards` | Seed 1 running + 1 paused → navigate to dashboard | Running card has Pause button, paused card has Resume button |

**`sidebar.spec.js`:**

| Test | Steps | Assertion |
|------|-------|-----------|
| `sidebar shows status icons` | Seed runs in various states → check sidebar | Each run entry has the correct status icon and color |
| `sidebar updates on state change` | Seed running run → trigger WS `pipeline-paused` update | Sidebar icon changes from Loader to Pause without page reload |

#### Visual Tests — Stage Timeline

**`stage-timeline.spec.js`:**

| Test | Steps | Assertion |
|------|-------|-----------|
| `completed stages show green check` | Seed run with 3 completed stages → navigate to run detail | First 3 timeline nodes have CircleCheck icons in green |
| `current stage shows blue spinner` | Seed run with in_progress stage → navigate to run detail | Active stage node has Loader icon with spin animation |
| `failed stage shows red alert` | Seed run with failed stage → navigate to run detail | Failed stage node has CircleAlert icon in red |
| `paused stage shows amber pause` | Seed run paused during IMPLEMENT → navigate to run detail | IMPLEMENT node shows Pause icon in amber |
| `pending stages show gray circles` | Seed run mid-pipeline → navigate to run detail | Future stages have gray Circle icons |

#### Interaction Tests — Control Buttons

**`control-buttons.spec.js`:**

| Test | Steps | Assertion |
|------|-------|-----------|
| `pause button visible when running` | Seed running run → navigate to run detail | Pause button is visible, Resume and Stop-while-paused are not |
| `resume button visible when paused` | Seed paused run → navigate to run detail | Resume button is visible, Pause is not |
| `resume button visible when failed` | Seed failed run → navigate to run detail | Resume button is visible |
| `stop button visible when running` | Seed running run → navigate to run detail | Stop button is visible |
| `stop button visible when paused` | Seed paused run → navigate to run detail | Stop button is visible |
| `pause click sends API request` | Seed running run → click Pause → intercept network | `POST /api/runs/:id/pause` is called |
| `resume click sends API request` | Seed paused run → click Resume → intercept network | `POST /api/runs/:id/resume` is called |
| `stop click shows confirmation` | Seed running run → click Stop | Shoelace confirmation dialog appears |
| `stop confirm sends API request` | Click Stop → confirm dialog → intercept network | `POST /api/runs/:id/stop` is called |
| `stop cancel does nothing` | Click Stop → cancel dialog → check network | No API call made |
| `buttons disabled during pending request` | Click Pause → check button state | Button shows loading state, is disabled until response |

#### Integration Tests — WebSocket Real-Time Updates

**`websocket-updates.spec.js`:**

| Test | Steps | Assertion |
|------|-------|-----------|
| `status badge updates on pipeline-paused` | Seed running run → navigate → mutate status.json to paused | Badge changes from RUNNING (blue) to PAUSED (amber) without reload |
| `status badge updates on pipeline-resumed` | Seed paused run → navigate → mutate status.json to running | Badge changes from PAUSED to RUNNING without reload |
| `status badge updates on pipeline-completed` | Seed running run → navigate → mutate status.json to completed | Badge changes from RUNNING to COMPLETED (green) without reload |
| `status badge updates on pipeline-failed` | Seed running run → navigate → mutate status.json to failed | Badge changes from RUNNING to FAILED (red) without reload |
| `control buttons update on state change` | Seed running run → navigate → mutate to paused | Pause button disappears, Resume button appears |
| `stage timeline updates live` | Seed run at PLAN stage → mutate to COORDINATE in_progress | Timeline updates: PLAN gets check, COORDINATE gets spinner |
| `dashboard reorders on state change` | Seed 2 running → navigate → pause one | Paused run moves to paused group |

#### Integration Tests — Full Lifecycle Flow

**`run-lifecycle.spec.js`:**

| Test | Steps | Assertion |
|------|-------|-----------|
| `pause then resume flow` | Seed running → click Pause → verify paused state → click Resume → verify running state | All transitions reflected in badges, buttons, timeline |
| `stop then resume flow` | Seed running → click Stop → confirm → verify failed state → click Resume → verify running | Status shows FAILED with reason "stopped", then recovers |
| `resume from failed with dirty iteration` | Seed failed run with in_progress iteration → click Resume | UI shows RESUMING briefly, then RUNNING, dirty iteration is not displayed |
| `multiple runs different states` | Seed 3 runs (running, paused, completed) → navigate dashboard | All three display correct icons, colors, and buttons simultaneously |

#### Screenshot Baselines (Optional)

For visual regression, Playwright can capture and compare screenshots:
- `test/browser/screenshots/` — baseline screenshots per test
- Use `expect(page).toHaveScreenshot()` for pixel-level comparison
- Particularly useful for: status icon colors, button styling, dashboard layout
- Run with `--update-snapshots` to refresh baselines after intentional changes

---

## 11. Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Control file race condition (two actors write simultaneously) | Last-writer-wins is acceptable for single-user tool |
| Pipeline crashes before reading control file | Control file persists on disk; next resume will clean it up |
| PromptBuilder context grows unbounded | Cap at 100KB; truncate oldest entries |
| Agent call takes very long before pause takes effect | Document that pause happens at next iteration boundary; add estimated wait time to UI |
| Status.json write not atomic (crash during save) | Use write-to-temp + rename pattern for atomic saves |

---

## 12. Future Extensions

- **Scheduled pause** — pause after stage X completes (e.g., pause after PLAN for manual review)
- **Conditional resume** — resume only if external condition is met (webhook callback)
- **Run queue** — queue multiple work requests, execute sequentially
- **Remote control** — expose API over network with auth for team use
