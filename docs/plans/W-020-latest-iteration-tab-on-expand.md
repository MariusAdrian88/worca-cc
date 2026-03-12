# Plan: Show Latest Iteration Tab on Stage Expand (with User Override Memory)

## Problem

When a stage section (`<sl-details>`) is expanded, the `<sl-tab-group>` inside always defaults to showing the **first** iteration tab (Iter 1). The desired behavior is:

1. **Default**: Show the **latest** (highest-numbered) iteration tab when expanding a stage
2. **Override**: If the user has manually switched to a different iteration tab for that stage, remember that choice and restore it on subsequent expansions

Currently there is zero app-level tracking of tab state — Shoelace manages it internally, and that state is lost/reset on every lit-html re-render.

## Approach

Use a **module-level `Map`** in `main.js` to track per-stage iteration tab selections. No state store changes needed — this is ephemeral UI state that doesn't need to persist across page reloads or be shared with other components.

### Key Insight: Shoelace `sl-tab-group.show(panelName)`

Shoelace's tab group has a `.show(panelName)` method that programmatically activates a tab. We'll call this after the `<sl-details>` expand event fires, using `requestAnimationFrame` to ensure the DOM is ready.

## Implementation Steps

### Task 1: Add per-stage tab selection tracking (`main.js`)

**File**: `.claude/worca-ui/app/main.js`

Add a module-level Map to store user tab selections per stage:

```js
const stageIterationTab = new Map(); // stageKey → iterationNumber (user's last manual choice)
```

Add a handler function that `run-detail.js` will call when the user manually switches tabs:

```js
function handleStageTabChange(stageKey, iterationNumber) {
  stageIterationTab.set(stageKey, iterationNumber);
}
```

Pass `stageIterationTab` and `handleStageTabChange` to `runDetailView()` via the `options` parameter:

```js
runDetailView(run, settings, {
  promptCache: ...,
  onRestartStage: ...,
  beads: ...,
  stageIterationTab,        // NEW
  onStageTabChange: handleStageTabChange,  // NEW
})
```

**Complexity**: Low — 3 additions (map, handler, options pass-through)

### Task 2: Wire up tab-change listener and expand-event logic (`run-detail.js`)

**File**: `.claude/worca-ui/app/views/run-detail.js`

This is the core change. Two things need to happen:

#### 2a: Listen for manual tab switches

Add an `@sl-tab-show` event listener on `<sl-tab-group>` that fires when a user clicks a tab. Extract the iteration number from the panel name and call `onStageTabChange`:

```js
<sl-tab-group @sl-tab-show=${(e) => {
  const panel = e.detail.name; // "iter-plan-3"
  const num = parseInt(panel.split('-').pop(), 10);
  if (!isNaN(num)) options.onStageTabChange?.(key, num);
}}>
```

#### 2b: Auto-select the correct tab on expand

Add an `@sl-after-show` event listener on `<sl-details>` (fires after the panel finishes expanding). Inside, find the `<sl-tab-group>` child and call `.show()` with the correct panel name:

```js
<sl-details
  ?open=${stageStatus === 'in_progress'}
  class="stage-panel"
  @sl-after-show=${(e) => {
    if (!hasMultipleIterations) return;
    const tabGroup = e.target.querySelector('sl-tab-group');
    if (!tabGroup) return;
    const userChoice = options.stageIterationTab?.get(key);
    const targetIter = userChoice ?? iterations[iterations.length - 1].number;
    const panelName = `iter-${key}-${targetIter}`;
    // Use rAF to ensure Shoelace tab-group has rendered
    requestAnimationFrame(() => tabGroup.show(panelName));
  }}
>
```

Logic:
- If `stageIterationTab` has an entry for this stage → use the user's previous choice
- Otherwise → use `iterations[iterations.length - 1].number` (latest iteration)

**Complexity**: Medium — two event listeners, DOM query, timing consideration

### Task 3: Clear stale tab memory when navigating away from a run

**File**: `.claude/worca-ui/app/main.js`

When the user navigates to a different run, clear the tab memory so it doesn't carry over:

```js
// In onHashChange handler, where prevRunId !== route.runId:
if (prevRunId && prevRunId !== route.runId) {
  stageIterationTab.clear();  // NEW
  // ... existing cleanup
}
```

**Complexity**: Low — one line addition

### Task 4: Handle live updates (new iteration appearing while stage is expanded)

**File**: `.claude/worca-ui/app/views/run-detail.js` (no additional code needed, but verify behavior)

When a new iteration appears (e.g., test loop-back adds iteration 3):
- If the user hasn't manually switched tabs → the latest tab should auto-select on next render
- If the user HAS manually switched → their choice persists

The current approach handles this naturally:
- `stageIterationTab` won't have an entry if user never switched → defaults to latest
- `stageIterationTab` WILL have an entry if user switched → preserves choice
- **Edge case**: If user selected iter 2 and iter 3 appears, they stay on iter 2 (correct — they explicitly chose it)

No additional code needed, but this should be verified during testing.

## Files Changed

| File | Change | Lines |
|------|--------|-------|
| `.claude/worca-ui/app/main.js` | Add `stageIterationTab` map, handler, pass to view, clear on nav | ~8 |
| `.claude/worca-ui/app/views/run-detail.js` | Add `@sl-after-show` on details, `@sl-tab-show` on tab-group | ~15 |

## Testing Strategy

1. **Manual E2E**: Expand a multi-iteration stage → verify latest tab is shown, not first
2. **Manual E2E**: Switch to iter 1 → collapse → re-expand → verify iter 1 is still shown
3. **Manual E2E**: Navigate to different run → return → verify tab memory is cleared
4. **Manual E2E**: Watch a live run with loop-backs → verify new iterations auto-select when user hasn't overridden
5. **Unit test** (optional): Test the tab selection logic (userChoice ?? latest) in isolation

## Edge Cases Handled

- **Single-iteration stages**: No tab group rendered, no listeners attached, no effect
- **Stage not yet started** (pending): No iterations, no tab group, no effect
- **User expands stage before any render**: `requestAnimationFrame` ensures timing safety
- **Tab group show() called with non-existent panel**: Shoelace ignores it gracefully
- **stageIterationTab cleared on run switch**: Prevents stale state leaking between runs

## Not In Scope

- Persisting tab selections across page reloads (session storage) — ephemeral is fine
- Persisting expand/collapse state of stage panels — separate feature
- Changing the initial `?open` behavior (only `in_progress` stages auto-expand)
