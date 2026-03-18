# W-027: Optional Prompt + Smart Title Generation

## Context

The worca-ui currently requires a non-empty `inputValue` for every run. This forces users to type filler prompts like "implement the feature" even when a GH issue, spec file, or plan file already provides all context. These generic prompts also produce poor pipeline titles and branch names.

**Goals:**
1. Make the prompt textarea optional when a work source (GH issue, spec file) or plan file is provided
2. Generate meaningful titles/branches from the actual content rather than generic prompts

## Phase 1: Python Backend

### 1a. `work_request.py` — Add LLM title extraction + plan file normalizer

**File:** `.claude/worca/orchestrator/work_request.py`

Add `generate_smart_title(content, source_hint)`:
- Calls `claude -p "Extract a concise 5-8 word title..." --output-format text --model haiku`
- Truncates content to 10k chars
- 30-second subprocess timeout
- Returns empty string on any failure (caller falls back to heading/filename)
- Sanity checks: non-empty, <100 chars, no newlines

Add `normalize_plan_file(path, content=None)`:
- Reads file if content not provided
- Title: `generate_smart_title()` → first `#` heading fallback → filename fallback
- Returns `WorkRequest(source_type="plan_file", ...)`

Update `normalize_spec_file()`:
- Add `generate_smart_title()` call before the heading extraction
- Keep heading + filename as fallbacks

Update `normalize()` signature to `normalize(source_type, source_value, **kwargs)`:
- Add `"plan"` dispatch to `normalize_plan_file()`

**GH issue titles: used verbatim** — `normalize_github_issue()` unchanged, the title from the API goes directly to `_sanitize_branch_name()` which handles special char replacement.

### 1b. `run_pipeline.py` — Optional args + prompt merging

**File:** `.claude/scripts/run_pipeline.py`

Replace mutually exclusive required group with individual args:
- `--prompt`, `--source`, `--spec` all optional
- Manual validation: `--source` and `--spec` mutually exclusive; at least one of `--prompt`/`--source`/`--spec`/`--plan` required

New normalization flow:
```
if args.source → normalize("source", value)
elif args.spec → normalize("spec", value)
elif args.plan → normalize("plan", args.plan)
elif args.prompt → normalize("prompt", value)
```

Prompt merging: when `--prompt` accompanies a source/spec/plan, append it as `## Additional Instructions` to `work_request.description`.

Title priority (after normalization):
1. GH issue → title used verbatim (already set by `normalize_github_issue`)
2. Spec file → LLM-extracted title (already set in updated `normalize_spec_file`)
3. Plan file → LLM-extracted title (already set in `normalize_plan_file`)
4. Prompt → raw text as title (existing behavior)

### 1c. Tests

**File:** `tests/test_work_request.py`

- `TestNormalizePlanFile`: with heading, without heading, empty file
- `TestGenerateSmartTitle`: mock subprocess for success, timeout, failure, empty content
- `TestNormalize`: plan type dispatch
- CLI arg parsing: plan-only, source+prompt, no args (error), source+spec (error)

## Phase 2: Server (JS)

### 2a. `app.js` — New validation for optional prompt

**File:** `.claude/worca-ui/server/app.js`

New `POST /api/runs` payload:
```json
{
  "sourceType": "none" | "source" | "spec",
  "sourceValue": "gh:issue:42",
  "prompt": "extra instructions",
  "planFile": "docs/plans/foo.md",
  "msize": 1, "mloops": 1, "branch": ""
}
```

Validation: at least one of (source, planFile, prompt) must be provided.

Backwards compat: detect old `{ inputType, inputValue }` format and normalize:
- `inputType=prompt` → `sourceType=none, prompt=inputValue`
- `inputType=source|spec` → `sourceType=inputType, sourceValue=inputValue`

### 2b. `process-manager.js` — Separate source + prompt args

**File:** `.claude/worca-ui/server/process-manager.js`

Replace single `--prompt|--source|--spec <inputValue>` with:
```js
if (sourceType === 'source') args.push('--source', sourceValue);
else if (sourceType === 'spec') args.push('--spec', sourceValue);
if (prompt) args.push('--prompt', prompt);
// plan-only: neither source nor prompt args; --plan alone suffices
```

## Phase 3: UI

### 3a. `new-run.js` — Restructured form

**File:** `.claude/worca-ui/app/views/new-run.js`

**New layout:**

Section 1 — "Work Source":
- Source type selector: `None / GitHub Issue / Spec File`
- Source input field (hidden when None)
- Plan file autocomplete (moved from Advanced)

Section 2 — "Prompt":
- `sl-textarea` (8 rows)
- Dynamic label: "Prompt (required)" when no source and no plan; "Additional Instructions (optional)" otherwise

Section 3 — "Advanced Options":
- msize, mloops, branch only

**State changes:**
- Rename `inputType` → `sourceType` (default `'none'`)
- Keep `selectedPlan` as-is

**Validation in `submitNewRun()`:**
- `hasSource = sourceType !== 'none' && sourceValue`
- `hasPlan = !!selectedPlan`
- `hasPrompt = !!promptValue`
- Error if none of the three

### 3b. Build

```bash
cd .claude/worca-ui && npm run build
```

## Verification

1. **CLI backwards compat:**
   - `python .claude/scripts/run_pipeline.py --prompt "Add auth"` → works as before
   - `python .claude/scripts/run_pipeline.py --spec docs/spec.md` → LLM-generated title
   - `python .claude/scripts/run_pipeline.py --source gh:issue:42` → GH issue title verbatim
   - `python .claude/scripts/run_pipeline.py --plan docs/plans/foo.md` → plan-only run, LLM title
   - `python .claude/scripts/run_pipeline.py --source gh:issue:42 --prompt "focus on auth"` → combined
2. **UI:** Test all scenarios via worca-ui form
3. **Tests:** `pytest tests/ -v` and `npx vitest run .claude/worca-ui/server/`
4. **Branch names:** Verify `_sanitize_branch_name()` produces good slugs from LLM/GH titles

## Files Modified

| File | Changes |
|------|---------|
| `.claude/worca/orchestrator/work_request.py` | Add `generate_smart_title()`, `normalize_plan_file()`, update `normalize_spec_file()`, update `normalize()` |
| `.claude/scripts/run_pipeline.py` | Optional args, plan-only path, prompt merging |
| `.claude/worca-ui/server/app.js` | New validation, backwards compat normalization |
| `.claude/worca-ui/server/process-manager.js` | Separate source + prompt arg building |
| `.claude/worca-ui/app/views/new-run.js` | Restructured form layout |
| `tests/test_work_request.py` | New tests for plan file, smart title, updated normalize |
