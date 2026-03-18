# W-026: GitHub Issue Lifecycle Management

## Goal

When the pipeline is started from a GitHub issue (`--source gh:issue:N`), automatically update the issue throughout the run: mark it "in progress" at start, post a summary comment with metrics at completion, and close it.

## Design

### Guard clause

All write-back is gated on `source_type == "github_issue"`. Runs from `--prompt`, `--spec`, or `--source bd:*` are unaffected.

Extract issue number:
```python
def _gh_issue_number(status):
    wr = status.get("work_request", {})
    if wr.get("source_type") != "github_issue":
        return None
    ref = wr.get("source_ref", "")  # "gh:42"
    return ref.split(":")[-1] if ref.startswith("gh:") else None
```

### On pipeline start

**Where:** `runner.py`, after first `save_status()` call (~line 613).

**Actions:**
1. Add `in-progress` label: `gh issue edit {N} --add-label in-progress`
2. Post start comment:
   ```
   Pipeline started — run `{run_id}` on branch `{branch}`
   ```

Create the `in-progress` label if it doesn't exist (idempotent, one-time).

### On pipeline success

**Where:** `runner.py`, after `completed_at` is set and `save_status()` called (~line 1102).

**Actions:**
1. Post summary comment with metrics table
2. Remove `in-progress` label: `gh issue edit {N} --remove-label in-progress`
3. Close issue: `gh issue close {N}`

**Summary comment format:**
```markdown
## Pipeline Complete

| Metric | Value |
|--------|-------|
| Duration | 31m 7s |
| Iterations | 13 (coord: 1, impl: 4, test: 4, review: 3, pr: 1) |
| Cost | $14.62 |
| Turns | 322 |
| Branch | `worca/title-slug-ABC` |
| Run ID | `20260312-050843` |
```

Duration is computed from `started_at`/`completed_at`. Iteration breakdown comes from `token_usage.by_stage`. Cost from `token_usage.total_cost_usd`.

### On pipeline failure

**Where:** `except PipelineError` and `except LoopExhaustedError` in `run_pipeline.py` `main()`.

**Actions:**
1. Post failure comment with error reason and partial metrics
2. Remove `in-progress` label
3. Do NOT close the issue (leave open for retry)

### Implementation

Single new module: `.claude/worca/utils/gh_issues.py`

```python
def gh_issue_number(status) -> str | None
def gh_issue_start(status) -> None      # label + comment
def gh_issue_complete(status) -> None   # comment + unlabel + close
def gh_issue_fail(status, error) -> None # comment + unlabel
```

Each function is a thin wrapper around `subprocess.run(["gh", ...])` with error suppression (GitHub write-back should never crash the pipeline).

**Caller changes:**
- `runner.py` `run_pipeline()`: call `gh_issue_start()` after init, `gh_issue_complete()` after completion
- `run_pipeline.py` `main()`: call `gh_issue_fail()` in exception handlers

### Error handling

All `gh` calls are wrapped in try/except with warnings to stderr. GitHub being unreachable must never fail the pipeline. Pattern:
```python
try:
    subprocess.run(["gh", "issue", ...], check=True, capture_output=True, timeout=15)
except Exception as e:
    print(f"Warning: GitHub write-back failed: {e}", file=sys.stderr)
```

## Files to create/modify

| File | Action |
|------|--------|
| `.claude/worca/utils/gh_issues.py` | **Create** — all GitHub issue helpers |
| `.claude/worca/runner.py` | **Modify** — call `gh_issue_start` and `gh_issue_complete` |
| `.claude/scripts/run_pipeline.py` | **Modify** — call `gh_issue_fail` in exception handlers |
| `tests/test_gh_issues.py` | **Create** — unit tests (mock subprocess) |

## Not in scope

- Project board column moves (GitHub Projects API is separate)
- Beads-sourced runs (`--source bd:*`)
- PR linking (guardian already creates PRs)
