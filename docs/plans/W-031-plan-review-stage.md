# W-031: Plan Review Stage

## Problem

When the pipeline generates or receives an implementation plan, it proceeds directly to the COORDINATE stage without validation. LLM-generated plans frequently miss important details — incomplete edge cases, incorrect API assumptions, under-specified task decomposition, or misalignment with the existing codebase. Plans provided as files (pre-written) can also be stale or contain errors. There is no mechanism to catch these issues before the pipeline commits to coordination and implementation.

## Proposal

Add a `PLAN_REVIEW` stage between PLAN and COORDINATE that always reviews the plan regardless of source (generated or file-provided). The stage uses a dedicated `plan_reviewer` agent (opus) that validates the plan against the work request, codebase, and external documentation. If the reviewer finds critical/major issues, the plan loops back to the PLAN stage for revision. The loop count is configurable (default 2, integer) so users can allow more revision passes for complex plans.

## Design

### 1. Stage Definition & Ordering

**New enum value:** `Stage.PLAN_REVIEW`

**Updated STAGE_ORDER:**
```
PREFLIGHT -> PLAN -> PLAN_REVIEW -> COORDINATE -> IMPLEMENT -> TEST -> REVIEW -> PR
```

**Updated TRANSITIONS:**
```
PLAN        -> PLAN_REVIEW          (replaces PLAN -> COORDINATE)
PLAN_REVIEW -> COORDINATE           (on approve)
PLAN_REVIEW -> PLAN                 (on revise, loop-back)
```

**New mappings in stages.py:**
- `STAGE_AGENT_MAP[Stage.PLAN_REVIEW]` = `"plan_reviewer"`
- `STAGE_SCHEMA_MAP[Stage.PLAN_REVIEW]` = `"plan_review.json"`

### 2. Loop Mechanics

**Config key:** `worca.loops.plan_review` — set to `2` in `settings.json` (note: `check_loop_limit` code defaults to 5 when no config key is found, so the settings.json entry is required to enforce the intended limit of 2)

Semantics: max number of times the plan can be sent back to PLAN for revision.

With default 2:
1. PLAN produces plan -> PLAN_REVIEW reviews -> finds critical/major issues -> loops back to PLAN (revision 1)
2. PLAN revises -> PLAN_REVIEW reviews again -> finds issues -> loops back to PLAN (revision 2)
3. PLAN revises -> PLAN_REVIEW reviews -> if still issues, loop exhausted -> proceeds to COORDINATE with warning

**Loop counter key:** `loop_counters["plan_review"]`

**New trigger value for PLAN stage:** `"plan_review_revise"` — sent back by plan reviewer with feedback. Added to existing triggers (`"initial"`, `"restart_planning"`).

**mloops multiplier** applies as with all other loops.

### 3. Plan Reviewer Agent

**New file:** `.claude/agents/core/plan_reviewer.md`

**Role:** Review the implementation plan for completeness, feasibility, and gaps. Produces structured feedback. Does NOT modify the plan.

**What the reviewer checks:**

1. **Completeness** — Does the plan cover all requirements from the work request? Missing edge cases?
2. **Feasibility** — Are the proposed tasks achievable? Are dependencies realistic?
3. **Test strategy** — Is the testing approach adequate for the scope?
4. **Architecture fit** — Does the approach align with existing codebase patterns (informed by CLAUDE.md)?
5. **Task decomposition quality** — Are tasks atomic enough for single-implementer sessions? Too coarse? Too fine?
6. **Risk identification** — Unaddressed risks, missing rollback strategy, security concerns?
7. **Library/API validation** — Cross-check any library APIs, function signatures, or SDK methods mentioned in the plan against current documentation using available MCP tools:
   - `context7` — resolve library IDs and fetch current docs for referenced libraries
   - `WebSearch` — search for up-to-date API references, breaking changes, deprecations
   - `WebFetch` — fetch specific documentation URLs mentioned in the plan
   - Any other documentation MCP servers available in the session (e.g., deepwiki)

**Agent rules:**
- Read-only — do NOT modify the plan file, source code, or any files
- CAN use MCP tools (context7, WebSearch, WebFetch) for documentation cross-checks
- CAN read codebase files to validate plan assumptions against actual code
- Do NOT run tests or execute commands beyond reading/searching
- Do NOT invoke skills
- Must read CLAUDE.md and explore codebase to validate plan claims
- Produce `plan_review.json` with outcome and structured issues
- Spend at most 10 turns on external MCP lookups (context7, WebSearch, WebFetch). If MCP tools fail or are unavailable, proceed with codebase-only validation and note which external checks were skipped in the `evidence` field.

**Governance enforcement (required changes):**
- Add `"plan_reviewer"` to `read_only_agents` tuple in `guard.py` to enforce read-only at the hook level
- Add `"plan_reviewer"` entry to `DISPATCH_RULES` in `tracking.py` (empty set — no subagent dispatch allowed)
- Add `"plan_reviewer"` to the test-execution block list in `guard.py` (alongside planner/coordinator)
- Audit `pre_tool_use.py` to confirm MCP tools (context7, WebSearch, WebFetch) are permitted for the `plan_reviewer` agent; add to allowed tools if blocked

**Issue categories:** `completeness`, `feasibility`, `test_strategy`, `architecture`, `decomposition`, `risk`, `api_assumption`

**Severity gating:** Only `critical` and `major` issues trigger `revise` outcome. `minor` issues are logged but treated as `approve` (same pattern as REVIEW stage code review).

### 4. Schema

**New file:** `.claude/worca/schemas/plan_review.json`

```json
{
  "type": "object",
  "required": ["outcome", "issues", "summary"],
  "properties": {
    "outcome": {
      "type": "string",
      "enum": ["approve", "revise"]
    },
    "issues": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["category", "severity", "description"],
        "properties": {
          "category": {
            "type": "string",
            "enum": ["completeness", "feasibility", "test_strategy", "architecture", "decomposition", "risk", "api_assumption"]
          },
          "severity": {
            "type": "string",
            "enum": ["critical", "major", "minor"]
          },
          "description": {
            "type": "string"
          },
          "suggestion": {
            "type": "string"
          },
          "evidence": {
            "type": "string"
          }
        }
      }
    },
    "summary": {
      "type": "string"
    }
  }
}
```

### 5. Prompt Builder

**New method: `_build_plan_review(iteration)`**

Content:
- The plan file content (from `plan_approach` context or reads MASTER_PLAN.md)
- The original work request for cross-reference
- Instructions to use MCP tools for external API/library validation
- On iteration > 0: includes `plan_review_history` showing previous review attempts so the reviewer checks whether prior issues were addressed

**Amended method: `_build_plan(iteration)` — revision mode**

The trigger value `"plan_review_revise"` is passed to `_build_plan` via a context key (e.g., `plan_revision_mode=True`), since `_build_plan(iteration)` only takes an iteration parameter. The method checks this context key to switch between initial and revision prompts, consistent with how `_build_implement` uses context keys (`test_failures`, `review_issues`) to distinguish modes.

When `plan_revision_mode` context key is set:
- Switches to a revision prompt (like `_build_implement_retry` pattern)
- Includes `plan_review_issues` — the specific critical/major issues to address
- Includes `plan_review_history` — cumulative review history
- Instructs: "Revise the plan to address these issues. Do NOT start from scratch."

**New context keys:**

| Key | Set By | Used By |
|-----|--------|---------|
| `plan_review_issues` | PLAN_REVIEW | PLAN (revision prompt) |
| `plan_review_history` | PLAN_REVIEW | PLAN (revision), PLAN_REVIEW (subsequent reviews) |
| `plan_revision_mode` | PLAN_REVIEW (set to `True` on revise) | PLAN (`_build_plan` checks this to switch to revision prompt) |

**Context lifecycle:**
- On **revise**: set `plan_review_issues`, `plan_review_history`, `plan_revision_mode=True`, then call `prompt_builder.save_context()` before looping back (required for crash/resume support)
- On **approve**: clear `plan_review_issues` and `plan_revision_mode` to prevent leaking into later PLAN re-runs (e.g., if REVIEW loops back to PLAN later), then call `prompt_builder.save_context()`

### 6. Runner Integration

**New PLAN_REVIEW handler block in runner.py stage loop:**

Must also add `Stage.PLAN_REVIEW` entry to `_STAGE_PROMPT_PREFIX` dict.

```python
elif current_stage == Stage.PLAN_REVIEW:
    # Validate structured output against schema before acting on it.
    # On schema validation failure, treat as agent error (retry via error_classifier).
    # If retries exhausted, default to "revise" (fail-closed), NOT "approve".
    outcome = result.get("outcome", "revise")  # fail-closed default
    issues = result.get("issues", [])
    critical_issues = [i for i in issues if i.get("severity") in ("critical", "major")]

    # Record iteration (required for status.json, UI, and resume)
    complete_iteration(status, Stage.PLAN_REVIEW, result, iteration=pb_iteration)
    update_stage(status, Stage.PLAN_REVIEW, "completed")
    save_status(status, status_path)
    if ctx:
        emit_event(ctx, STAGE_COMPLETED, stage_completed_payload(Stage.PLAN_REVIEW, result))

    if outcome == "revise" and critical_issues:
        # Thread review feedback — only critical/major issues to limit context growth
        prev_history = prompt_builder.get_context("plan_review_history") or []
        prev_history.append({"attempt": len(prev_history) + 1, "issues": critical_issues})
        prompt_builder.update_context("plan_review_history", prev_history)
        prompt_builder.update_context("plan_review_issues", critical_issues)
        prompt_builder.update_context("plan_revision_mode", True)
        prompt_builder.save_context()

        # Check loop limit
        loop_counters["plan_review"] = loop_counters.get("plan_review", 0) + 1
        status["loop_counters"] = dict(loop_counters)
        save_status(status, status_path)
        loop_counters[f"{Stage.PLAN_REVIEW.value}_iteration"] = \
            loop_counters.get(f"{Stage.PLAN_REVIEW.value}_iteration", 0) + 1

        if check_loop_limit("plan_review", loop_counters["plan_review"],
                            settings_path, mloops=mloops):
            if ctx:
                emit_event(ctx, LOOP_TRIGGERED,
                           loop_triggered_payload("plan_review", loop_counters["plan_review"]))
            # Reset PLAN stage status and plan_approved milestone for re-run
            update_stage(status, Stage.PLAN, "pending")
            status.get("milestones", {}).pop("plan_approved", None)
            save_status(status, status_path)

            _next_trigger[Stage.PLAN.value] = "plan_review_revise"
            stage_idx = stage_order.index(Stage.PLAN)
            continue  # Loop back to PLAN
        else:
            if ctx:
                emit_event(ctx, LOOP_EXHAUSTED, ...)
            _log("Plan review loop exhausted -- proceeding to COORDINATE", "warn")
            # Fall through to advance to COORDINATE
    else:
        # Clear cross-context keys to prevent leaking into later PLAN re-runs
        prompt_builder.update_context("plan_review_issues", None)
        prompt_builder.update_context("plan_revision_mode", None)
        prompt_builder.save_context()

        if not critical_issues and issues:
            _log(f"Plan approved with {len(issues)} minor issues (logged)", "ok")
        else:
            _log("Plan approved by reviewer", "ok")
```

**Resume support:** No special handling needed. Existing `find_resume_point()` checks stage completion status in STAGE_ORDER. PLAN_REVIEW works naturally as a first-class stage.

**Event emissions:** Standard `STAGE_STARTED`, `STAGE_COMPLETED`, `LOOP_TRIGGERED`, `LOOP_EXHAUSTED` events. No new event types needed.

### 7. Settings Configuration

**Additions to `.claude/settings.json` under `worca`:**

```json
{
  "worca": {
    "stages": {
      "plan_review": {
        "agent": "plan_reviewer",
        "enabled": true
      }
    },
    "agents": {
      "plan_reviewer": {
        "model": "opus",
        "max_turns": 50
      }
    },
    "loops": {
      "plan_review": 2
    }
  }
}
```

Users can:
- Disable entirely: `"stages.plan_review.enabled": false`
- Change model: `"agents.plan_reviewer.model": "sonnet"`
- Adjust turns: `"agents.plan_reviewer.max_turns": 75`
- Adjust loop count: `"loops.plan_review": 5` (for complex plans)
- Override agent instructions: via the `worca-agent-override` mechanism (project-level `.claude/agents/overrides/plan_reviewer.md`)

## Files Changed

| File | Change |
|------|--------|
| `.claude/worca/orchestrator/stages.py` | Add `PLAN_REVIEW` to enum, `STAGE_ORDER`, `TRANSITIONS`, `STAGE_AGENT_MAP`, `STAGE_SCHEMA_MAP` |
| `.claude/worca/orchestrator/runner.py` | Add PLAN_REVIEW handler block in stage loop, thread context to prompt builder |
| `.claude/worca/orchestrator/prompt_builder.py` | Add `_build_plan_review()`, amend `_build_plan()` for `plan_review_revise` trigger |
| `.claude/settings.json` | Add `stages.plan_review`, `agents.plan_reviewer`, `loops.plan_review: 2` |
| `.claude/agents/core/plan_reviewer.md` | New agent template |
| `.claude/worca/schemas/plan_review.json` | New output schema |
| `.claude/worca-ui/app/views/settings.js` | Add `PLAN_REVIEW` to hardcoded `STAGE_ORDER` array and `STAGE_AGENT_MAP` dict so the settings page shows the new stage's toggles |
| `.claude/worca/hooks/guard.py` | Add `"plan_reviewer"` to `read_only_agents` tuple and test-execution block list |
| `.claude/worca/hooks/tracking.py` | Add `"plan_reviewer"` entry to `DISPATCH_RULES` (empty set) |
| `tests/` | New tests for plan_review stage, loop mechanics, prompt builder methods (see test scenarios below) |

## Files NOT Changed

- `resume.py` — works automatically with new stage in STAGE_ORDER (note: `find_resume_point()` always resumes from PREFLIGHT and skips completed stages, so PLAN_REVIEW works naturally; however, a crash during a PLAN_REVIEW→PLAN loop-back may re-enter PLAN_REVIEW with stale plan data if PLAN was marked completed in a prior iteration — the loop-back handler above resets PLAN stage status to mitigate this)
- `error_classifier.py` — generic, no stage-specific logic
- Other agent templates — no changes needed

## Considerations

- **Loop exhaustion behavior:** When plan_review loop is exhausted, the pipeline proceeds to COORDINATE with the current plan and a warning. This matches the TEST loop exhaustion pattern (proceeds to REVIEW). An alternative would be to halt the pipeline, but that would block automated runs unnecessarily.
- **Human-in-the-loop (future):** A milestone gate (`plan_review_approval`) can be added later between PLAN_REVIEW approve and COORDINATE, requiring human sign-off on critical plans. This is out of scope for this change.
- **Plan file source:** The reviewer receives the same plan content regardless of whether it was generated by the PLAN stage or provided as a pre-existing file. The prompt builder reads MASTER_PLAN.md in both cases.
- **MCP tool availability:** The reviewer should gracefully handle cases where context7, WebSearch, or other MCP tools are not available — it still performs all codebase-based checks and notes that external validation was skipped.
- **MCP turn budget:** The agent prompt limits external MCP lookups to 10 turns max to prevent runaway cost. If tools fail or are unavailable, the agent proceeds with codebase-only validation.

## Test Scenarios

**Existing tests requiring updates:**
- `test_stages.py`: Update `len(Stage)` assertion (currently 8 → 9), update `TRANSITIONS[Stage.PLAN]` assertion (currently `{Stage.COORDINATE}` → `{Stage.PLAN_REVIEW}`), update `STAGE_ORDER` position assertions, update `get_enabled_stages` count
- `test_resume.py`: Add `plan_review` entries to hardcoded stage status dicts

**New test scenarios (by module):**

*stages.py:*
- `PLAN_REVIEW` is in `Stage` enum and `STAGE_ORDER` at correct position (between PLAN and COORDINATE)
- `TRANSITIONS[Stage.PLAN]` includes `Stage.PLAN_REVIEW`
- `TRANSITIONS[Stage.PLAN_REVIEW]` includes `{Stage.COORDINATE, Stage.PLAN}`
- `STAGE_AGENT_MAP[Stage.PLAN_REVIEW]` == `"plan_reviewer"`
- `STAGE_SCHEMA_MAP[Stage.PLAN_REVIEW]` == `"plan_review.json"`

*runner.py — PLAN_REVIEW handler:*
- **Approve path**: outcome=approve → advances to COORDINATE, clears `plan_review_issues` and `plan_revision_mode` context
- **Revise path**: outcome=revise with critical issues → loops back to PLAN, sets `plan_review_issues`/`plan_review_history`/`plan_revision_mode` context, increments `loop_counters["plan_review"]`, persists to `status["loop_counters"]`, resets PLAN stage status and `plan_approved` milestone
- **Revise with minor only**: outcome=revise but only minor issues → treated as approve (no loop-back)
- **Loop exhaustion**: loop counter exceeds limit → proceeds to COORDINATE with warning, emits `LOOP_EXHAUSTED`
- **Schema validation failure**: malformed agent output → treated as agent error (retry), not silent approve
- **Fail-closed default**: missing `outcome` field → defaults to `"revise"`
- **Context accumulation**: history stores only critical/major issues (not all issues)
- **Event emissions**: `STAGE_COMPLETED` emitted on both approve and revise paths; `LOOP_TRIGGERED` emitted on successful loop-back; all `emit_event` calls guarded with `if ctx:`
- **`complete_iteration`/`update_stage`/`save_status`** called before loop-back

*prompt_builder.py:*
- `_build_plan_review(iteration=0)`: includes plan content and work request
- `_build_plan_review(iteration>0)`: includes `plan_review_history`
- `_build_plan` with `plan_revision_mode=True` context: switches to revision prompt, includes `plan_review_issues` and `plan_review_history`
- `_build_plan` without `plan_revision_mode`: produces normal initial prompt (no regression)

*Disabled stage:*
- `stages.plan_review.enabled: false` → PLAN transitions directly to COORDINATE, PLAN_REVIEW is skipped in `get_enabled_stages()`

*Resume:*
- Crash during PLAN_REVIEW → resumes from PREFLIGHT, skips completed stages, re-enters PLAN_REVIEW
- Crash during loop-back (PLAN_REVIEW→PLAN) → PLAN stage status was reset, so PLAN re-runs correctly
