# W-023: Batch Implement Then Test


**Goal:** Change the pipeline's implement stage from per-bead test/review cycles to a batch model: implement ALL beads sequentially first, then run TEST once, then REVIEW once. On failure, a single "fix" implementer receives the full error list and fixes everything in one pass. Repeat until clean or limit exhausted.

**Architecture:** The runner's stage loop replaces the current interleaved IMPLEMENT→TEST→REVIEW per-bead cycle with two distinct phases: (1) an implement-all loop that drains `bd ready` and closes each bead after implementation, (2) a single TEST→REVIEW pass on the merged result. If TEST or REVIEW finds issues, a fix agent runs with the full error context, then TEST→REVIEW repeats. The fix agent is the same implementer agent but receives an enriched prompt with all failures. This requires wiring PromptBuilder output into the actual agent prompt (currently PromptBuilder output is stored for UI only and never sent to agents — a gap this plan also fixes).

**Tech Stack:** No new dependencies. Changes to `runner.py`, `prompt_builder.py`, `stages.py`, `implementer.md`. No schema changes.

**Depends on:** Nothing. This simplifies the existing runner logic rather than adding to it.

---

## 1. Scope and Boundaries

### In scope

- Replace per-bead IMPLEMENT→TEST→REVIEW loop with batch-then-test flow
- Wire PromptBuilder output into the actual agent prompt (fix existing gap where `rendered_prompt` is UI-only)
- Add a "fix" pass that gives the implementer full test failures + review issues
- Reuse existing `implement_test` and `pr_changes` loop limits for retry passes
- Update implementer agent prompt to support both "implement bead" and "fix errors" modes
- Update status tracking to distinguish implement-all phase from fix phase
- Maintain backward compatibility: no changes to coordinator, schemas, or UI

### Out of scope

- Parallel implementer execution (W-002) — orthogonal; batch-then-test is the loop structure, parallel is the dispatch strategy within the implement phase
- UI changes for the new flow (iterations still work the same — just fewer of them)
- Changes to TEST or REVIEW agent prompts (they already work on full codebase state)
- Resume support for the new flow (W-001 covers resume generically)

---

## 2. Current Flow vs Proposed Flow

### Current (per-bead)

```
while bd_ready():
    IMPLEMENT(bead) → TEST → REVIEW
        if test fails → retry IMPLEMENT(same bead) → TEST → ...
        if review changes → retry IMPLEMENT(same bead) → TEST → REVIEW → ...
        if review approves → bd_close(bead) → next bead
```

Each bead goes through its own TEST→REVIEW cycle before the next bead starts. A 5-bead pipeline runs TEST at least 5 times and REVIEW at least 5 times.

### Proposed (batch-then-test)

```
Phase 1 — Implement All:
    while bd_ready():
        IMPLEMENT(bead) → bd_close(bead)

Phase 2 — Validate:
    TEST (all changes)
    if passed:
        REVIEW (all changes)
        if approved → done (advance to PR)
        if changes requested → Phase 3
    if failed → Phase 3

Phase 3 — Fix (retry loop):
    IMPLEMENT (fix mode — full error context, no bead assignment)
    → TEST → if failed → loop (up to implement_test limit)
    → REVIEW → if changes → loop (up to pr_changes limit)
    → if approved → done
```

A 5-bead pipeline runs TEST once (minimum) and REVIEW once (minimum). Retries are whole-project fixes, not per-bead.

---

## 3. Critical Finding: PromptBuilder Output Is Not Sent to Agents

### Current state

`context["prompt"]` is set once at line 620 of `runner.py`:

```python
context = {
    "prompt": work_request.description or work_request.title,
    "_run_dir": run_dir,
    "_logs_dir": logs_dir,
}
```

This never changes. `run_stage()` reads `context.get("prompt", "")` and wraps it in a generic `_STAGE_PROMPT_PREFIX`:

```python
"Implement the code changes described in the work request. "
"Follow the plan and complete the tasks assigned to you.\n\n"
"Work request: {prompt}"
```

The PromptBuilder's `rendered_prompt` (which includes bead assignment, test failures, review issues, retry history) is stored in `status.json` and `iter_record["prompt"]` for **UI visibility only**. It is never passed to `run_stage()` or `run_agent()`.

### Impact

- The implementer agent discovers its task via `bd ready` / `bd show` (the agent `.md` file instructs this)
- Test failure context is never injected into retry prompts — the implementer relies on running tests itself to find failures
- Review issue context is never injected either
- The entire PromptBuilder retry logic (`_build_implement_retry`) produces output that no agent ever sees

### Fix (required for batch-then-test)

The fix phase needs to tell the implementer **what to fix**. We must wire PromptBuilder output into the actual prompt. Two options:

**Option A — Replace `context["prompt"]`:**
```python
context["prompt"] = rendered_prompt  # before run_stage()
```
Simple but mutates shared state. Would need to be reset for non-implement stages.

**Option B (recommended) — Pass rendered prompt to `run_stage()`:**
```python
result, raw_envelope = run_stage(
    current_stage, context, settings_path,
    msize=msize, iteration=iter_num,
    prompt_override=rendered_prompt,  # NEW parameter
)
```

`run_stage()` uses `prompt_override` when provided, falling back to `context["prompt"]` otherwise. This is clean, explicit, and doesn't affect other stages.

```python
def run_stage(stage, context, settings_path, msize=1, iteration=1,
              prompt_override=None):
    raw_prompt = prompt_override or context.get("prompt", "")
    prompt = _build_stage_prompt(stage, raw_prompt)
    ...
```

---

## 4. Runner Changes

### 4.1 File: `.claude/worca/orchestrator/runner.py`

The implement stage section (currently lines 744-1076) is replaced with a cleaner structure.

### 4.2 Phase 1: Implement All Beads

```python
if current_stage == Stage.IMPLEMENT:
    trigger = _next_trigger.get(Stage.IMPLEMENT.value, "initial")

    if trigger in ("initial", "next_bead"):
        # Phase 1: implement all beads sequentially
        bead = _query_ready_bead()
        if bead:
            bead_id = bead["id"]
            _claim_bead(bead_id)
            prompt_builder.update_context("assigned_bead_id", bead_id)
            prompt_builder.update_context("assigned_bead_title", bead["title"])
            details = bd_show(bead_id)
            prompt_builder.update_context("assigned_bead_description",
                                          details.get("description", ""))

            # Run implementer for this bead
            rendered_prompt = prompt_builder.build("implement", 0)
            result, raw_envelope = run_stage(
                current_stage, context, settings_path,
                msize=msize, iteration=iter_num,
                prompt_override=rendered_prompt,
            )

            # Record result, close bead
            _record_iteration(status, result, raw_envelope, ...)
            prompt_builder.update_context("files_changed",
                result.get("files_changed", []))
            prompt_builder.update_context("tests_added",
                result.get("tests_added", []))
            bd_close(bead_id, reason="implemented")

            # Accumulate files across all beads
            all_files = prompt_builder.get_context("all_files_changed") or []
            all_files.extend(result.get("files_changed", []))
            prompt_builder.update_context("all_files_changed", all_files)
            all_tests = prompt_builder.get_context("all_tests_added") or []
            all_tests.extend(result.get("tests_added", []))
            prompt_builder.update_context("all_tests_added", all_tests)

            # Check for more beads
            next_bead = _query_ready_bead()
            if next_bead:
                _next_trigger[Stage.IMPLEMENT.value] = "next_bead"
                stage_idx = stage_order.index(Stage.IMPLEMENT)
                continue
            else:
                # All beads done — set accumulated files for TEST
                prompt_builder.update_context("files_changed",
                    list(set(all_files)))
                prompt_builder.update_context("tests_added",
                    list(set(all_tests)))
                # Fall through to stage_idx += 1 → TEST
        else:
            # No beads available (edge case) — skip to TEST
            pass
```

Key difference from current code: after implementing a bead, instead of advancing to TEST, it loops back to IMPLEMENT for the next bead. TEST only runs after all beads are exhausted.

### 4.3 Phase 2 & 3: Test, Review, Fix Loop

```python
    elif trigger in ("test_failure", "review_changes"):
        # Phase 3: fix mode — no bead assignment, full error context
        prompt_builder.update_context("assigned_bead_id", None)
        fix_iteration = prompt_builder.get_context("bead_prompt_iteration") or 0
        rendered_prompt = prompt_builder.build("implement", fix_iteration)

        result, raw_envelope = run_stage(
            current_stage, context, settings_path,
            msize=msize, iteration=iter_num,
            prompt_override=rendered_prompt,
        )

        _record_iteration(status, result, raw_envelope, ...)
        prompt_builder.update_context("files_changed",
            result.get("files_changed", []))
        prompt_builder.update_context("tests_added",
            result.get("tests_added", []))
        # Fall through to TEST
```

### 4.4 TEST handler (simplified)

```python
elif current_stage == Stage.TEST:
    passed = result.get("passed", False)
    prompt_builder.update_context("test_passed", passed)
    prompt_builder.update_context("test_coverage", result.get("coverage_pct"))
    prompt_builder.update_context("proof_artifacts",
                                  result.get("proof_artifacts", []))
    if not passed:
        new_failures = result.get("failures", [])
        # Accumulate failure history
        prev_history = prompt_builder.get_context("test_failure_history") or []
        prev_history.append({"attempt": len(prev_history) + 1,
                             "failures": new_failures})
        prompt_builder.update_context("test_failure_history", prev_history)
        prompt_builder.update_context("test_failures", new_failures)
        prompt_builder.update_context("review_issues", None)
        prompt_builder.update_context("review_history", None)

        loop_counters["implement_test"] = loop_counters.get("implement_test", 0) + 1
        bead_prompt_iter = prompt_builder.get_context("bead_prompt_iteration") or 0
        prompt_builder.update_context("bead_prompt_iteration", bead_prompt_iter + 1)

        if check_loop_limit("implement_test", loop_counters["implement_test"],
                            settings_path, mloops=mloops):
            _next_trigger[Stage.IMPLEMENT.value] = "test_failure"
            stage_idx = stage_order.index(Stage.IMPLEMENT)
            continue
        else:
            _log("Test fix limit exhausted — finishing", "warn")
```

No per-bead key — just `implement_test` as a flat counter. Uses the existing limit (default 10).

### 4.5 REVIEW handler (simplified)

```python
elif current_stage == Stage.REVIEW:
    outcome = result.get("outcome", "approve")
    next_stage, status = handle_pr_review(outcome, status)

    if next_stage is None:
        if outcome == "reject":
            raise PipelineError("PR rejected")
        # Approved — advance to PR
        _log("Review approved", "ok")

    elif next_stage == Stage.IMPLEMENT:
        new_issues = result.get("issues", [])
        critical_issues = [i for i in new_issues
                           if i.get("severity") in ("critical", "major")]
        if not critical_issues:
            _log("Only minor issues — treating as approve", "ok")
        else:
            prev_history = prompt_builder.get_context("review_history") or []
            prev_history.append({"attempt": len(prev_history) + 1,
                                 "issues": new_issues})
            prompt_builder.update_context("review_history", prev_history)
            prompt_builder.update_context("review_issues", critical_issues)
            prompt_builder.update_context("test_failures", None)
            prompt_builder.update_context("test_failure_history", None)

            loop_counters["pr_changes"] = loop_counters.get("pr_changes", 0) + 1
            bead_prompt_iter = prompt_builder.get_context("bead_prompt_iteration") or 0
            prompt_builder.update_context("bead_prompt_iteration", bead_prompt_iter + 1)

            if check_loop_limit("pr_changes", loop_counters["pr_changes"],
                                settings_path, mloops=mloops):
                _next_trigger[Stage.IMPLEMENT.value] = "review_changes"
                stage_idx = stage_order.index(Stage.IMPLEMENT)
                continue
            else:
                _log("Review fix limit exhausted — finishing", "warn")

    elif next_stage == Stage.PLAN:
        # restart_planning (unchanged)
        ...
```

No per-bead deferred logic. No context clearing between beads. No "next bead" check after review. The entire "advance to next bead" flow is removed from REVIEW — it only exists in the implement-all phase.

---

## 5. What Gets Removed

The following logic in lines 744-1076 is **deleted**:

| Lines | Logic | Why removed |
|-------|-------|-------------|
| 744-756 | Bead claim at top of every IMPLEMENT iteration | Moved into Phase 1 only |
| 928-966 | Test failure: per-bead loop key, deferred-bead logic, next-bead check | Replaced by flat `implement_test` counter |
| 989-1019 | Review approve: close bead, check next bead, clear context | Bead closing moved to Phase 1; no next-bead check in REVIEW |
| 1021-1055 | Review minor issues: close bead, check next bead | Same |
| 1056-1105 | Review changes: per-bead loop key, deferred-bead logic, next-bead check | Replaced by flat `pr_changes` counter |
| 1007-1016 | Context clearing between beads (8 `update_context(None)` calls) | Not needed — no bead switching in test/review |

**Estimated reduction:** ~150 lines of complex interleaved logic replaced by ~80 lines of linear flow.

---

## 6. PromptBuilder Changes

### 6.1 Wire rendered prompt into agent calls

**File:** `.claude/worca/orchestrator/runner.py`

Add `prompt_override` parameter to `run_stage()`:

```python
def run_stage(stage, context, settings_path, msize=1, iteration=1,
              prompt_override=None):
    config = get_stage_config(stage, settings_path=settings_path)
    max_turns = config["max_turns"] * msize
    raw_prompt = prompt_override or context.get("prompt", "")
    prompt = _build_stage_prompt(stage, raw_prompt)
    ...
```

Call with `prompt_override=rendered_prompt` for IMPLEMENT stage (both Phase 1 and Phase 3). For TEST, REVIEW, and other stages, omit `prompt_override` — they continue using the raw work request.

### 6.2 Fix mode prompt template

**File:** `.claude/worca/orchestrator/prompt_builder.py`

The existing `_build_implement_retry()` already renders test failures and review issues. It now actually reaches the agent (via `prompt_override`), making it functional instead of UI-only.

Update `_build_implement_retry()` to handle the no-bead case:

```python
def _build_implement_retry(self, iteration: int) -> str:
    parts = []
    assigned = self._context.get("assigned_bead_id")

    if assigned:
        # Per-bead retry (not used in batch-then-test, but kept for compatibility)
        parts.append(f"## PRIORITY: Fix Issues (attempt {iteration})")
        parts.append(self._assigned_task_section())
    else:
        # Fix mode: no specific bead, fix all issues in the project
        parts.append(f"## PRIORITY: Fix All Issues (attempt {iteration})")
        parts.append("You are fixing issues found after implementing all tasks. "
                      "You have full access to the codebase — fix whatever is broken.")

    # Rest of method unchanged — renders test_failures, review_issues, history
    ...
```

### 6.3 `_build_test()` and `_build_review()` — no changes

These methods read `files_changed` and `tests_added` from context. After Phase 1, these contain the **accumulated** file lists from all beads. The TEST and REVIEW agents see the full picture. No changes needed.

---

## 7. Implementer Agent Prompt Changes

### 7.1 File: `.claude/agents/core/implementer.md`

Add fix mode instructions:

```markdown
## Fix Mode

When your prompt says "Fix All Issues" or "Fix Test Failures" or "Fix Review Issues":

1. Read the error list in the prompt carefully
2. For each error, identify the root cause in the codebase
3. Fix the code — you are NOT limited to a single bead's scope
4. Run the full test suite to verify your fixes
5. Do NOT use `bd ready` or `bd close` — you are fixing, not implementing
6. Produce a structured result with all files you changed

## Output

Produce a structured result following the `implement.json` schema.
In fix mode, set `bead_id` to `"fix"` (sentinel value).
```

### 7.2 Bead ID in fix mode

The `implement.json` schema requires `bead_id`. In fix mode, use `"fix"` as a sentinel value. No schema change needed — it's already `type: string`.

---

## 8. Status Tracking Changes

### 8.1 Iteration records

Phase 1 iterations have `trigger: "initial"` or `trigger: "next_bead"` and include a `bead_id` in the iteration extras.

Phase 3 iterations have `trigger: "test_failure"` or `trigger: "review_changes"` and `bead_id: "fix"`.

No structural changes to status.json — the same `iterations[]` array with the same fields. The UI's tab group works unchanged.

### 8.2 Loop counters

| Counter | Current (per-bead) | New (batch) |
|---------|-------------------|-------------|
| `implement_test:{bead_id}` | Per-bead test retries | **Removed** |
| `implement_test` | Not used | Flat counter for test-fix passes |
| `pr_changes:{bead_id}` | Per-bead review retries | **Removed** |
| `pr_changes` | Not used | Flat counter for review-fix passes |
| `bead_iteration` | Total beads processed | **Unchanged** — still counts beads in Phase 1 |
| `implement_iteration` | Global counter (never checked) | **Unchanged** |

---

## 9. Edge Cases

### 9.1 No beads available

If `bd ready` returns nothing at the start of Phase 1, skip directly to TEST. This handles the case where all beads were pre-implemented (e.g., manual work before pipeline start).

### 9.2 Single bead

Degenerates to: IMPLEMENT(bead) → TEST → REVIEW. Functionally identical to current flow, just without per-bead retry — the fix phase handles retries instead. Slightly more efficient (no redundant bead-claiming on retry).

### 9.3 Bead implementation fails

If `run_stage()` raises an exception during Phase 1 (agent crash, timeout), the bead is left `in_progress` in beads. The pipeline stops. On `--resume`, Phase 1 restarts from `bd ready` which will return the unclosed bead.

### 9.4 Fix agent creates new files

The fix agent may create files that weren't in any bead's `files_changed`. The `implement.json` output captures `files_changed` — the status record reflects what actually changed.

### 9.5 All beads implemented but tests still fail after limit

Same as current behavior: log a warning, finish the pipeline. The beads are already closed (they were closed in Phase 1). The test failures are recorded in status.

### 9.6 Deferred beads

The deferred-bead concept (setting a bead back to `open` after retry exhaustion) no longer applies. All beads are implemented and closed in Phase 1. Fix retries operate on the whole codebase, not individual beads. If fix retries are exhausted, the pipeline finishes with the test failures logged.

---

## 10. Interaction with W-002 (Parallel Implementer Execution)

Batch-then-test and parallel execution are orthogonal:

- **Batch-then-test** changes the outer loop: implement all → test → review → fix loop
- **Parallel execution** changes the inner dispatch: run implementers concurrently instead of sequentially

Combined flow:
```
Phase 1 — Implement All (parallel):
    For each wave in parallel_groups:
        Fan out implementers in worktrees
        Merge results
        Close beads

Phase 2 — Validate:
    TEST → REVIEW

Phase 3 — Fix (serial):
    IMPLEMENT (fix mode) → TEST → REVIEW → loop
```

The fix phase remains serial — it's a single agent fixing identified issues on the merged codebase. No worktree isolation needed.

---

## 11. Implementation Tasks

### Task 1: Add `prompt_override` to `run_stage()`

**File:** `.claude/worca/orchestrator/runner.py`

Add `prompt_override: str = None` parameter. Use it when provided, fall back to `context.get("prompt")`.

**Lines changed:** ~5 (function signature + one line in body)

---

### Task 2: Rewrite IMPLEMENT stage handler — Phase 1

**File:** `.claude/worca/orchestrator/runner.py`

Replace lines 744-756 (bead claim) and the IMPLEMENT result handler (lines 898-905) with the Phase 1 loop: claim bead → implement → close → accumulate files → check `bd ready` → loop or advance.

Pass `prompt_override=rendered_prompt` to `run_stage()`.

**Lines changed:** ~40 new, ~20 deleted

---

### Task 3: Rewrite TEST handler

**File:** `.claude/worca/orchestrator/runner.py`

Replace lines 908-966. Remove per-bead loop key (`implement_test:{bead_id}`), deferred-bead logic, next-bead check. Use flat `implement_test` counter. Rewind to IMPLEMENT with trigger `"test_failure"` on failure within limit.

**Lines changed:** ~25 new, ~60 deleted

---

### Task 4: Rewrite REVIEW handler

**File:** `.claude/worca/orchestrator/runner.py`

Replace lines 974-1105. Remove all next-bead checks, per-bead loop keys, deferred-bead logic, context clearing. Use flat `pr_changes` counter. Severity-gate unchanged. Rewind to IMPLEMENT with trigger `"review_changes"` on critical issues within limit.

**Lines changed:** ~30 new, ~130 deleted

---

### Task 5: Add IMPLEMENT fix-mode handler (Phase 3)

**File:** `.claude/worca/orchestrator/runner.py`

Add the `elif trigger in ("test_failure", "review_changes")` branch in the IMPLEMENT handler. Clear `assigned_bead_id`, build retry prompt via PromptBuilder, pass as `prompt_override`. No bead claiming.

**Lines changed:** ~20 new

---

### Task 6: Update `_build_implement_retry()` for no-bead mode

**File:** `.claude/worca/orchestrator/prompt_builder.py`

Update the method to handle `assigned_bead_id = None` — emit "Fix All Issues" header instead of per-bead header. Keep the failure/issue rendering unchanged.

**Lines changed:** ~10

---

### Task 7: Update `implementer.md` with fix mode

**File:** `.claude/agents/core/implementer.md`

Add "Fix Mode" section explaining: read errors from prompt, fix across the whole codebase, don't use `bd ready`/`bd close`, use `bead_id: "fix"` in output.

**Lines changed:** ~15

---

### Task 8: Wire `rendered_prompt` into all IMPLEMENT calls

**File:** `.claude/worca/orchestrator/runner.py`

Ensure both Phase 1 (bead implementation) and Phase 3 (fix mode) pass `prompt_override=rendered_prompt` to `run_stage()`. This makes PromptBuilder output functional rather than UI-only.

Also pass `prompt_override` for TEST and REVIEW stages so their PromptBuilder-rendered context (files_changed, test results) reaches the agent.

**Lines changed:** ~6 (adding `prompt_override=` at each `run_stage()` call site)

---

## 12. Rollout Order

Tasks must be implemented in this order:

1. **Task 1** (`prompt_override` on `run_stage`) — foundation; no behavior change
2. **Task 6** (`_build_implement_retry` no-bead mode) — prompt change; no behavior change
3. **Task 7** (`implementer.md` fix mode) — agent instruction; no behavior change
4. **Task 8** (wire `rendered_prompt` into calls) — now prompts actually reach agents; behavior improves
5. **Task 2** (Phase 1 implement-all) — loop structure changes
6. **Task 3** (TEST handler rewrite) — removes per-bead retry
7. **Task 4** (REVIEW handler rewrite) — removes per-bead retry
8. **Task 5** (Phase 3 fix mode) — adds fix loop

Tasks 1-4 can be landed incrementally without breaking the existing flow. Tasks 5-8 are the structural change and should land together.

---

## 13. Testing Strategy

### Unit tests

- `run_stage()` with `prompt_override`: verify the override reaches `run_agent()` prompt
- `_build_implement_retry()` with `assigned_bead_id=None`: verify "Fix All Issues" header
- Phase 1 loop: mock `bd_ready` returning 3 beads then None; verify 3 implement calls + 3 `bd_close` calls
- Fix mode: verify `assigned_bead_id` is None, `bead_prompt_iteration` increments, prompt contains test failures
- Loop limits: verify `implement_test` flat counter triggers limit correctly

### Integration tests

- Run pipeline with 2-bead task: verify both beads implemented before TEST runs
- Inject a test failure: verify fix agent runs with full error context
- Verify fix agent output has `bead_id: "fix"`
- Verify loop limit exhaustion finishes pipeline (not crash)

### Regression tests

- Single-bead pipeline: verify behavior is correct (implement → test → review → fix if needed)
- Zero-bead pipeline (`bd ready` returns nothing): verify TEST runs on current codebase state

---

## 14. Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Fix agent doesn't see error context | `prompt_override` ensures PromptBuilder output reaches agent (Task 1 + Task 8) |
| Fix agent scope too broad (breaks unrelated code) | `implementer.md` instructs to only fix listed issues; REVIEW catches regressions |
| All beads implemented but fundamentally wrong approach | Same risk as today — REVIEW can `restart_planning` to loop back to PLAN |
| Phase 1 crash leaves beads in bad state | Beads are `in_progress` until closed; `bd ready` on resume returns unclosed beads |
| Fix creates more issues than it solves | `implement_test` limit (default 10) prevents infinite loops |
| Prompt too large with all failures | Test failure lists are typically compact (test name + error); review issues are structured. Even 50 failures would be ~5KB of prompt |

---

## 15. Metrics Impact

| Metric | Current (5-bead pipeline) | Batch-then-test |
|--------|--------------------------|-----------------|
| TEST invocations (happy path) | 5 | 1 |
| REVIEW invocations (happy path) | 5 | 1 |
| IMPLEMENT invocations (happy path) | 5 | 5 |
| Total agent calls (happy path) | 15 | 7 |
| Cost (est. @ $0.30/test, $0.50/review) | $4.00 + impl | $0.80 + impl |
| Wall time saved | — | ~60% of test+review time |

On failure, add 1 IMPLEMENT + 1 TEST + 1 REVIEW per retry pass (vs. 1 IMPLEMENT + 1 TEST per bead retry currently). The fix agent may be more efficient since it sees all errors at once rather than fixing one bead's problems only to discover the next bead has the same issue.

---

## 16. File Summary

### Modified files

| File | Changes |
|------|---------|
| `.claude/worca/orchestrator/runner.py` | Add `prompt_override` to `run_stage()`; rewrite IMPLEMENT/TEST/REVIEW handlers; add Phase 1 implement-all loop and Phase 3 fix mode |
| `.claude/worca/orchestrator/prompt_builder.py` | Update `_build_implement_retry()` for no-bead fix mode |
| `.claude/agents/core/implementer.md` | Add fix mode instructions |

### No changes

| File | Why unchanged |
|------|---------------|
| `.claude/worca/schemas/implement.json` | `bead_id: "fix"` is valid string |
| `.claude/worca/schemas/test_result.json` | TEST schema unchanged |
| `.claude/worca/schemas/review.json` | REVIEW schema unchanged |
| `.claude/worca/state/status.py` | Iteration records use same fields |
| `.claude/worca/orchestrator/stages.py` | Stage order, limits unchanged |
| `.claude/worca-ui/` | UI renders iterations the same way |

---

## 17. Acceptance Criteria

1. **Batch implementation:** All beads are implemented and `bd close`-d before TEST runs.
2. **Single TEST pass:** TEST runs exactly once after all beads (happy path).
3. **Single REVIEW pass:** REVIEW runs exactly once after TEST passes (happy path).
4. **Fix mode works:** On test failure, IMPLEMENT runs with full error list in prompt; agent receives the rendered PromptBuilder output (not just raw work request).
5. **Loop limits work:** `implement_test` counter (flat, not per-bead) stops retries at configured limit.
6. **Fix agent output:** `bead_id: "fix"` in structured output; `files_changed` reflects actual changes.
7. **No bead leaks:** All beads are `closed` after Phase 1; no beads left `in_progress` on happy path.
8. **Backward compatible:** Single-bead pipelines produce identical results.
9. **Existing tests pass:** `pytest tests/ -v` passes.
