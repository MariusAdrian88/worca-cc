# W-033: Pipeline Archive

## Problem

When a pipeline is started by mistake or fails for an irrelevant reason, it remains visible in the dashboard and run history as a failed/errored run. This pollutes the UI — the "Recent Failures" section, error counts, and sidebar status dots all reflect runs the user no longer cares about. There is no way to dismiss these without deleting data.

## Proposal

Add a soft-archive mechanism: a flag on the run's `status.json` that hides the run from default views. Archived runs can be revealed via a filter chip in the history view and unarchived if needed.

## Design

### Data Model

Add two optional fields to the run's `status.json`:

```json
{
  "archived": true,
  "archived_at": "2026-04-02T12:00:00Z"
}
```

- `archived: true` — marks the run as archived
- `archived_at` — ISO 8601 timestamp of when it was archived
- Unarchiving removes both fields (or sets `archived: false`)
- No file moves — the run stays in `.worca/runs/` or `.worca/results/`

### Server API

Two new POST endpoints in `worca-ui/server/project-routes.js`:

**`POST /api/projects/:projectId/runs/:id/archive`**
- Locates the run's `status.json` (in `.worca/runs/{id}/` or `.worca/results/{id}/`)
- Sets `archived: true` and `archived_at` to current UTC ISO timestamp
- Writes atomically using `writeFileSync` to a temp file + `renameSync` to the target path (the existing server code uses direct `writeFileSync` without temp+rename — the archive endpoints should introduce this safer pattern)
- Returns `{ ok: true }`
- 404 if run not found
- On error, returns `{ ok: false, error: "message" }` (matching existing error response format)

**`POST /api/projects/:projectId/runs/:id/unarchive`**
- Removes `archived` and `archived_at` fields from the run's `status.json`
- Same atomic write pattern
- Returns `{ ok: true }`
- 404 if run not found

After successful archive/unarchive, the endpoint should trigger a WebSocket broadcast (e.g., `run-archived` / `run-unarchived` with `{ runId }`) so other connected clients update in real time, consistent with existing action endpoints that broadcast `run-stopped`, `run-started`, etc.

Both endpoints must call `validateRunId(req.params.id)` (existing guard at `project-routes.js:44-52`) and use the `requireWorcaDir` middleware, consistent with all existing run-action routes.

A new `findRunStatusPath(worcaDir, runId)` helper must be extracted — this pattern is currently inlined in stop/resume/restart routes. The helper searches `.worca/runs/{id}/status.json`, then `.worca/results/{id}/status.json`, then legacy `.worca/results/{id}.json`.

Both operations are **idempotent**: archiving an already-archived run returns `{ ok: true }` (no-op), same for unarchiving a non-archived run.

### Run Discovery

`watcher.js` `discoverRuns()` remains unchanged — it returns all runs including archived ones. The `archived` flag is part of the status data and propagates to the client automatically.

### Client-Side Filtering Strategy

**Key insight:** Rather than adding archive filters to every view (15+ consumers), the filtering is centralized in the state layer (`state.js` and `main.js`). All existing views automatically see only non-archived runs with zero changes.

#### state.js — split runs into two maps

Add `archivedRuns: {}` to the initial state alongside `runs: {}`.

Add a new `setRunsBulk(runArray)` method that partitions incoming runs:
- Runs where `run.archived === true` → `state.archivedRuns`
- All other runs → `state.runs`

Update `setRun(runId, data)` to route to the correct map:
- If `data.archived === true`, put in `archivedRuns` (and remove from `runs` if present)
- Otherwise, put in `runs` (and remove from `archivedRuns` if present)

**Result:** `state.runs` never contains archived runs. All 15+ view consumers (dashboard, run-list, sidebar, token-costs, etc.) read `state.runs` and automatically exclude archived runs with zero code changes.

#### main.js — use setRunsBulk + add handlers

Replace the **simple** bulk loops (~4-5 sites) with `store.setRunsBulk(payload.runs)`. The multi-project merge loops (e.g., `runs-list` handler at line ~250 with selective merge/pruning by project, and `fetchAllProjectRuns()` at line ~524 with project tagging) must remain as manual loops because they do merge-with-pruning, not simple replacement. Add `if (run.archived)` routing to `archivedRuns` in those manual loops.

Add two new handler functions:
- `archiveRun(runId)` — POST to archive endpoint, then refresh runs
- `unarchiveRun(runId)` — POST to unarchive endpoint, then refresh runs

Thread `onArchive` and `onUnarchive` callbacks through to `runCardView` call sites.

**ID-based lookups:** Seven sites in main.js do `state.runs[route.runId]` or `store.getState().runs[route.runId]` (lines ~803, ~1201, ~1231, ~1267, ~1281, ~1432, ~1443). Each needs a fallback: `state.runs[id] ?? state.archivedRuns[id]` (use `??` not `||` to avoid falsy-value bugs). This only affects the run-detail render paths in main.js, not the views themselves.

**Notification suppression:** The `run-snapshot` and `run-update` WS handlers call `notificationManager.handleRunUpdate` before `setRun`. If a snapshot arrives for an archived run (e.g., watcher re-reads its status.json), skip the notification — the user explicitly dismissed it. Check `data.archived === true` before notifying.

### UI Changes

#### run-card.js

- Add `onArchive` and `onUnarchive` callback props to `runCardView()`
- **Archive button**: shown when `onArchive` is provided AND `overallStatus === 'paused' || overallStatus === 'failed'` AND the run is NOT already archived. Rendered below the Resume button.
- **Unarchive button**: shown when `onUnarchive` is provided AND `run.archived === true`. Replaces the Archive button.
- Archive button triggers a confirmation dialog before calling `onArchive(run.id)`.
- Both buttons use the same `run-card-actions` wrapper div as Resume.

Button styling:
- Archive: text button, neutral/muted style (not destructive red — it's reversible)
- Unarchive: text button, same style

#### Confirmation Dialog

Reuse the existing `showConfirm()` helper from `utils/confirm-dialog.js` (already imported in main.js). On Archive button click:
- Call `showConfirm({ title: "Archive Pipeline Run", message: "This run will be hidden from the dashboard and history. You can find it later using the 'archived' filter.", confirmLabel: "Archive", variant: "danger" })`
- On confirm → call `onArchive(run.id)`
- No confirmation for Unarchive (safe, instantly reversible)

No new dialog component needed — the existing `confirmDialogTemplate` + `showConfirm` pattern handles this.

#### run-list.js

- Add `'archived'` to the `HISTORY_STATUSES` array
- Add `archivedRuns` prop (from `state.archivedRuns`) to the view
- The "archived" chip count shows `Object.values(archivedRuns).length`
- When `statusFilter === 'archived'`, display runs from `archivedRuns` instead of `runs`
- Archived run cards get `onUnarchive` instead of `onArchive`
- All other filter chips work against `runs` (which already excludes archived) — no changes needed

#### dashboard.js

No changes needed — reads `state.runs` which already excludes archived runs.

#### sidebar.js

No changes needed — reads `state.runs` which already excludes archived runs. `projectStatus()`, `historyCount`, and `activeCount` all automatically correct.

#### token-costs.js

One-line change: the run list should include both visible and archived runs, since costs represent real spend regardless of archive status. Use `[...Object.values(state.runs), ...Object.values(state.archivedRuns)]` for the runs input. The `tokenData` from the server-side `/costs` endpoint already includes all runs.

## Implementation Plan

### Step 1: Server API endpoints

**Files:** `.claude/worca-ui/server/project-routes.js`

1. Extract `findRunStatusPath(worcaDir, runId)` helper from inline patterns in existing stop/resume/restart routes — searches `.worca/runs/{id}/status.json` → `.worca/results/{id}/status.json` → `.worca/results/{id}.json`
2. Add `POST /runs/:id/archive` route:
   - Call `validateRunId(req.params.id)` first (400 on invalid)
   - Use `requireWorcaDir` middleware
   - Find status path, read JSON, set `archived: true` + `archived_at`, write via temp file + `renameSync`
   - Idempotent: if already archived, return `{ ok: true }` (no-op)
   - Broadcast `run-archived` event via WebSocket
3. Add `POST /runs/:id/unarchive` route:
   - Same guards (`validateRunId`, `requireWorcaDir`)
   - Find status path, read JSON, delete `archived` + `archived_at` keys, atomic write
   - Idempotent: if not archived, return `{ ok: true }` (no-op)
   - Broadcast `run-unarchived` event via WebSocket
4. Add tests in `worca-ui/server/` for both endpoints:
   - Happy path (archive + unarchive)
   - 404 (run not found)
   - 400 (invalid runId)
   - Idempotency (re-archive, re-unarchive)
   - Run in `results/` directory (not just `runs/`)

### Step 2: State layer — centralized archive filtering

**Files:** `.claude/worca-ui/app/state.js`

1. Add `archivedRuns: {}` to initial state
2. Add `setRunsBulk(runArray)` method:
   - Partitions array: `archived === true` → `archivedRuns`, rest → `runs`
   - Replaces both maps entirely (same semantics as current bulk pattern)
3. Update `setRun(runId, data)`:
   - If `data.archived === true`: set in `archivedRuns`, delete from `runs` if present
   - Otherwise: set in `runs`, delete from `archivedRuns` if present
4. Add `archivedRuns` to the equality check in `setState()` to prevent unnecessary re-renders
5. Add unit tests for `state.js`:
   - `setRunsBulk` partitions correctly (mix of archived + non-archived)
   - `setRunsBulk([])` clears both maps
   - `setRun` routes archived run to `archivedRuns`
   - `setRun` moves run between maps when `archived` flag changes
   - `setRun` with non-archived data removes from `archivedRuns` if present

### Step 3: main.js — use setRunsBulk + add handlers

**Files:** `.claude/worca-ui/app/main.js`

1. Replace the **simple** bulk loops (~4-5 sites) with `store.setRunsBulk(payload.runs || [])`. Leave the multi-project merge loops (runs-list handler ~line 250, fetchAllProjectRuns ~line 524) as manual loops — they do merge-with-pruning that `setRunsBulk` can't express. Add `if (run.archived)` routing to `archivedRuns` in those manual loops.
2. Add `archiveRun(runId)` handler — POST to `/api/projects/{pid}/runs/{runId}/archive`, with error handling: show user feedback on failure (e.g., console warning or toast), then trigger runs refresh
3. Add `unarchiveRun(runId)` handler — POST to `/api/projects/{pid}/runs/{runId}/unarchive`, same error handling, then trigger runs refresh
4. Add ID-lookup fallback for run-detail: `state.runs[id] ?? state.archivedRuns[id]` (use `??` not `||`) in all 7 render paths (~lines 803, 1201, 1231, 1267, 1281, 1432, 1443)
5. In `run-snapshot` and `run-update` handlers: skip `notificationManager.handleRunUpdate` when `data.archived === true` to avoid notifications for dismissed runs
6. Thread `onArchive`/`onUnarchive` callbacks through to `runCardView` call sites

### Step 4: UI — run-card Archive/Unarchive buttons

**Files:** `.claude/worca-ui/app/views/run-card.js`

1. Add `onArchive` and `onUnarchive` to destructured options
2. Add `archiveBtn` template: shown when `onArchive && !run.archived && (overallStatus === 'paused' || overallStatus === 'failed')`
3. Add `unarchiveBtn` template: shown when `onUnarchive && run.archived`
4. Render both after `${resumeBtn}` in the card template
5. Style buttons in `styles.css` — `.btn-quick-archive` similar to `.btn-quick-resume` but neutral color

### Step 5: Confirmation dialog

**Files:** `.claude/worca-ui/app/main.js` (uses existing `utils/confirm-dialog.js`)

1. In the `onArchive` handler (before calling the API), call `showConfirm()` from existing `utils/confirm-dialog.js`
2. On confirm → proceed with archive API call
3. On cancel → no-op
4. No new dialog component needed — reuses existing `confirmDialogTemplate` + `showConfirm` pattern already in the project

### Step 6: UI — run-list archived chip

**Files:** `.claude/worca-ui/app/views/run-list.js`

1. Add `'archived'` to `HISTORY_STATUSES`
2. Accept `archivedRuns` as a new parameter (passed from main.js via `state.archivedRuns`)
3. When `statusFilter === 'archived'`, display runs from `archivedRuns` array
4. Add `statusCounts.archived = archivedRuns.length` for the chip badge
5. Pass `onUnarchive` to `runCardView` for archived runs, `onArchive` for non-archived

### Step 7: token-costs.js — include archived runs in cost totals

**Files:** `.claude/worca-ui/app/views/token-costs.js`

1. Change the runs input from `Object.values(state.runs)` to `[...Object.values(state.runs), ...Object.values(state.archivedRuns)]`
2. Costs represent real spend regardless of archive status

### Step 8: Build and test

1. `cd .claude/worca-ui && npm run build`
2. Run state.js unit tests
3. Run server tests: `npx vitest run .claude/worca-ui/server/`
4. Manual smoke test: start UI, archive a failed run, verify it disappears from dashboard/sidebar/history, check archived filter chip, unarchive, verify costs still include archived run

## Considerations

- **No migration needed**: existing runs without `archived` field are treated as not archived (`run.archived === true` is false for `undefined`)
- **Minimal view changes**: by filtering in the state layer (`state.js`), dashboard.js, sidebar.js, and most view consumers need zero changes — they read `state.runs` which never contains archived runs
- **Key files changed**: `state.js` (new `setRunsBulk` + routing logic + tests), `main.js` (replace simple bulk loops + archive handlers + ID fallbacks + notification suppression), `run-card.js` (archive/unarchive buttons), `run-list.js` (archived chip), `project-routes.js` (API endpoints + WS broadcast), `token-costs.js` (one-line: include archived in cost totals)
- **Atomic writes**: archive/unarchive introduce temp file + `renameSync` pattern (the existing server code uses direct `writeFileSync` — this is an improvement)
- **WebSocket events**: archive/unarchive broadcast `run-archived`/`run-unarchived` events so other connected clients update in real time
- **Cost dashboard**: archived runs ARE included in cost totals — costs represent real spend regardless of archive status
- **Idempotent operations**: re-archiving or re-unarchiving returns `{ ok: true }` as a no-op
- **Multi-project merge loops**: the complex merge/pruning loops in main.js (~2 sites) remain manual with an added `archived` check; only simple bulk loops use `setRunsBulk`
- **No Python changes**: the archive feature is purely UI/server-side. The Python orchestrator and hooks are unaffected. The `archived` field in `status.json` is ignored by the pipeline runner.
