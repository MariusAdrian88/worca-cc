# W-024: Loop Limit Tuning for Batch-Then-Test

> **Status:** Open
> **Depends on:** W-023 (Batch Implement Then Test)
> **Date:** 2026-03-14

---

## Problem

The loop limits in `settings.json` were designed for the old serial per-bead flow (implement one bead → test → fix → next bead). W-023 changed the execution model to batch-then-test, which makes several limits incorrect:

1. **`bead_iteration` has no config entry** — falls back to the hardcoded default of 10. If the coordinator creates >10 beads, the remainder are silently abandoned.
2. **`implement_test: 10` is too high** — in batch mode each fix cycle runs TEST across all code + a full fix agent pass. 10 cycles is expensive and unlikely to converge if 3 didn't.
3. **`pr_changes` key mismatch** — settings.json has `code_review: 5` but runner.py checks `pr_changes`, so the configured value is ignored and the hardcoded default of 10 is used instead.
4. **No combined fix cap** — `implement_test` and `pr_changes` are independent counters. A pipeline could burn through 10 test-fix + 10 review-fix = 20 fix iterations.
5. **`--mloops` multiplies uniformly** — `--mloops 3` turns `bead_iteration` into 30 (fine) but also turns `implement_test` into 30 (wasteful for batch fix cycles).

## Findings from W-023 Real-World Test Runs

### Run 1 (Simple Snake Game — 6 beads)
- 6 beads implemented, 0 fix cycles needed
- TEST passed first try (111 tests)
- REVIEW approved first try

### Run 2 (Complex Snake Game — 9 beads)
- 9 beads implemented, 1 review-fix cycle needed
- TEST passed first try (381 tests)
- REVIEW requested changes (missing blinking effect)
- Fix agent fixed 1 file in 1m4s, re-test passed, re-review approved

**Observation:** In both runs, the implementer got each bead right in one shot. The fix cycle was triggered by a review-level integration gap, not broken code. The current `implement_test: 10` would have allowed 9 more expensive retry cycles before giving up — massively over-provisioned.

## Current State

### settings.json (`worca.loops`)
```json
{
  "implement_test": 10,
  "code_review": 5,       // ← key mismatch: runner checks "pr_changes"
  "pr_changes": 3,        // ← not present, runner falls back to default 10
  "restart_planning": 2
}
```

### runner.py loop counters
| Counter Key | Where Used | Default | Actual Effective Limit |
|---|---|---|---|
| `bead_iteration` | Phase 1 bead loop (line 947) | 10 (hardcoded default) | 10 |
| `implement_test` | Test-fail → fix cycle (line 990) | 10 (from settings) | 10 |
| `pr_changes` | Review → fix cycle (line 1043) | 10 (hardcoded default, settings key mismatch) | 10 |
| `implement_iteration` | Incremented but never checked | N/A | unused |
| `restart_planning` | Reviewer says "start over" (line 1057) | 2 (from settings) | 2 |

### check_loop_limit() (line 421)
```python
def check_loop_limit(loop_name, current_iteration, settings_path, mloops=1):
    default_limit = 10
    loops = settings.get("worca", {}).get("loops", {})
    limit = loops.get(loop_name, default_limit) * mloops
    return current_iteration < limit
```

## Proposed Changes

### 1. Fix settings.json keys

```json
{
  "implement_test": 3,
  "pr_changes": 3,
  "restart_planning": 2
}
```

Remove `code_review` (dead key). Remove `bead_iteration` (now derived from coordinator output).

### 2. Derive bead limit from coordinator output

Replace the fixed `bead_iteration` config with a dynamic limit based on the number of beads the coordinator created. After COORDINATE completes, the runner already has `beads_ids` (line 899-900). Use `len(beads_ids)` as the bead iteration cap.

```python
# After COORDINATE handler:
max_beads = len(prompt_builder.get_context("beads_ids") or [])

# In IMPLEMENT Phase 1 bead loop (replacing check_loop_limit call):
if loop_counters["bead_iteration"] < max_beads:
    # continue to next bead
else:
    if next_bead:
        _log(f"Bead limit reached ({max_beads}) but bd ready returned more beads — stale beads from prior run?", "warn")
```

This eliminates the `bead_iteration` config key entirely. No buffer needed — the beads are a closed set. If `bd ready` returns beads beyond the expected count, that's a bug (stale beads from a prior run), and the runner should warn rather than silently continue.

Remove `bead_iteration` from settings.json.

### 3. Tune fix cycle limits for batch mode

| Loop Key | Old | New | Rationale |
|---|---|---|---|
| `implement_test` | 10 | **3** | Each batch fix cycle is expensive (full test suite + fix agent). If 3 passes don't fix it, the errors are likely systemic and need human intervention. |
| `pr_changes` | 10 (bug) | **3** | Same reasoning. Review issues are typically minor — 3 cycles is generous. |
| `restart_planning` | 2 | **2** | Already sensible. Restarting planning is a major reset. |

### 3. Remove `implement_iteration` counter

It's incremented on lines 942, 986, and 1039 but never checked against any limit. Either give it a purpose or remove it to reduce confusion.

### 4. Consider `--mloops` scoping (discussion)

Current: `--mloops` multiplies all limits uniformly.

Options:
- **A) Keep uniform** — simple, predictable. User sets `--mloops 3` meaning "I want 3x patience on everything." With new lower defaults (3 × 3 = 9 fix cycles), this is reasonable.
- **B) Only multiply `bead_iteration`** — fix cycle limits stay fixed regardless of `--mloops`. Rationale: more beads is a complexity signal, but more fix cycles is just burning money.
- **C) Separate multipliers** — `--mloops-beads` and `--mloops-fixes`. Too complex for the benefit.

**Recommendation:** Option A (keep uniform). With bead_iteration now derived from coordinator output (not configurable), `--mloops` only affects fix cycles and restart_planning. Even `--mloops 3` produces sensible limits (implement_test=9, pr_changes=9).

### 5. Consider a total fix cap (discussion)

Add a `max_total_fixes` limit (default: 5) that caps the sum of `implement_test + pr_changes`. This prevents a pipeline from spending 3 test-fix + 3 review-fix = 6 expensive fix iterations when the combined budget should be lower.

**Counter-argument:** test-fix and review-fix address different problems (broken code vs. code quality). Capping them together could prematurely stop a pipeline that has real but distinct issues in both areas. With both set to 3, the worst case is 6 fix cycles, which is probably acceptable.

**Recommendation:** Skip this for now. Re-evaluate if real-world runs show excessive fix cycling.

## Implementation Tasks

1. **Fix `code_review` → `pr_changes` key mismatch** — remove `code_review` from settings.json, add `pr_changes: 3`
2. **Change `implement_test` from 10 to 3** in settings.json
3. **Derive bead limit from `len(beads_ids)`** — replace `check_loop_limit("bead_iteration", ...)` in runner.py with dynamic cap from coordinator output. Add warning log if `bd ready` returns beads beyond the expected count.
4. **Remove `implement_iteration` counter** from runner.py (incremented but never checked)
5. **Update tests** that assert on loop limit values
6. **Update README/docs** if loop limits are documented

## Testing

- Verify bead loop stops at exactly `len(beads_ids)` and logs warning if `bd ready` returns more
- Verify `check_loop_limit("implement_test", 2, ...)` returns True, `3` returns False
- Verify `check_loop_limit("pr_changes", 2, ...)` returns True, `3` returns False
- Verify `--mloops 2` doubles all limits correctly
- Verify the `code_review` key is no longer read anywhere
