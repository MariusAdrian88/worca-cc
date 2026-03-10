"""Single work request pipeline runner.

Orchestrates the full pipeline from plan through PR.
"""

import json
import os
import re
import subprocess
from typing import Optional

from worca.orchestrator.prompt_builder import PromptBuilder
from worca.orchestrator.stages import Stage, can_transition, get_stage_config, STAGE_AGENT_MAP
from worca.orchestrator.work_request import WorkRequest
from worca.state.status import load_status, save_status, update_stage, set_milestone, init_status
from worca.utils.beads import bd_ready, bd_update
from worca.utils.claude_cli import run_agent
from worca.utils.git import create_branch


class LoopExhaustedError(Exception):
    """Raised when a loop reaches its maximum iterations."""
    pass


class PipelineError(Exception):
    """Raised when pipeline encounters an unrecoverable error."""
    pass


def _sanitize_branch_name(title: str) -> str:
    """Convert a title to a valid git branch name."""
    name = title.lower().strip()
    name = re.sub(r'[^a-z0-9\-]', '-', name)
    name = re.sub(r'-+', '-', name)
    name = name.strip('-')
    return f"worca/{name[:40]}"


def _agent_path(agent_name: str) -> str:
    """Resolve agent name to the .md definition file path."""
    return f".claude/agents/core/{agent_name}.md"


def _schema_path(schema_name: str) -> str:
    """Resolve schema filename to full path."""
    return f".claude/worca/schemas/{schema_name}"


def _save_stage_output(stage: Stage, result: dict, logs_dir: str = ".worca/logs") -> None:
    """Save stage output to a log file for resume support."""
    os.makedirs(logs_dir, exist_ok=True)
    path = os.path.join(logs_dir, f"{stage.value}.json")
    with open(path, "w") as f:
        json.dump(result, f, indent=2)


def run_stage(
    stage: Stage,
    prompt: str,
    settings_path: str = ".claude/settings.json",
    msize: int = 1,
) -> tuple[dict, dict]:
    """Run a single pipeline stage.

    Gets stage config via get_stage_config(), calls run_agent() with the
    appropriate agent path, prompt, max_turns, and schema.

    Args:
        prompt: The rendered user prompt for this stage.
        msize: Multiplier for max_turns (1-10). E.g. msize=2 doubles turns.

    Returns (structured_output, raw_envelope) tuple. The structured_output
    is the schema-conforming result used by pipeline logic. The raw_envelope
    is the full claude CLI JSON response for logging.
    """
    config = get_stage_config(stage, settings_path=settings_path)
    max_turns = config["max_turns"] * msize
    raw = run_agent(
        prompt=prompt,
        agent=_agent_path(config["agent"]),
        max_turns=max_turns,
        output_format="json",
        json_schema=_schema_path(config["schema"]),
    )
    # claude CLI returns a JSON envelope; extract structured_output if present
    if isinstance(raw, dict) and "structured_output" in raw:
        return raw["structured_output"], raw
    return raw, raw


def check_loop_limit(
    loop_name: str,
    current_iteration: int,
    settings_path: str = ".claude/settings.json",
    mloops: int = 1,
) -> bool:
    """Check if the current iteration is within the configured loop limit.

    Reads loop limits from settings.json under worca.loops namespace.
    Returns True if current_iteration < limit, False if exhausted.
    If no limit configured, defaults to 10.

    Args:
        mloops: Multiplier for the loop limit (1-10). E.g. mloops=2 doubles max loops.
    """
    default_limit = 10
    try:
        with open(settings_path) as f:
            settings = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        settings = {}

    loops = settings.get("worca", {}).get("loops", {})
    limit = loops.get(loop_name, default_limit) * mloops
    return current_iteration < limit


def handle_pr_review(outcome: str, status: dict) -> tuple:
    """Handle the outcome of a PR review.

    Args:
        outcome: One of "approve", "request_changes", "reject", "restart_planning"
        status: Current pipeline status dict

    Returns:
        Tuple of (next_stage_or_None, updated_status).
        None for next_stage means pipeline is complete or stopped.
    """
    status["pr_review_outcome"] = outcome
    if outcome == "approve":
        return (None, status)
    elif outcome == "request_changes":
        return (Stage.IMPLEMENT, status)
    elif outcome == "reject":
        return (None, status)
    elif outcome == "restart_planning":
        return (Stage.PLAN, status)
    else:
        raise PipelineError(f"Unknown PR review outcome: {outcome}")


def _query_ready_bead() -> dict | None:
    """Query bd ready and return the first available bead, or None."""
    try:
        items = bd_ready()
        if items:
            return items[0]
    except Exception:
        pass
    return None


def _claim_bead(bead_id: str) -> bool:
    """Claim a bead by setting its status to in_progress."""
    return bd_update(bead_id, status="in_progress")


def _ensure_beads_initialized() -> None:
    """Check if beads is initialized in the current project, init if not."""
    result = subprocess.run(
        ["bd", "stats"], capture_output=True, text=True
    )
    if result.returncode != 0:
        init_result = subprocess.run(
            ["bd", "init"], capture_output=True, text=True
        )
        if init_result.returncode != 0:
            raise PipelineError(f"Failed to initialize beads: {init_result.stderr}")


def run_pipeline(
    work_request: WorkRequest,
    settings_path: str = ".claude/settings.json",
    status_path: str = ".worca/status.json",
    msize: int = 1,
    mloops: int = 1,
) -> dict:
    """Run the full pipeline for a single work request.

    Creates branch, initializes status, then runs stages in sequence:
    PLAN -> (milestone gate) -> COORDINATE -> IMPLEMENT -> TEST -> REVIEW -> PR

    Handles loops:
    - test failure -> back to implement
    - review changes -> back to implement

    Args:
        msize: Multiplier for max_turns per stage (1-10).
        mloops: Multiplier for max loop iterations (1-10).

    Checks loop limits, raises LoopExhaustedError when exceeded.
    Saves status after each stage transition.
    Returns final status.
    """
    logs_dir = os.path.join(os.path.dirname(status_path), "logs")

    # Check for resume
    existing = load_status(status_path)
    if existing:
        from worca.orchestrator.resume import find_resume_point
        resume_stage = find_resume_point(existing)
        if resume_stage is not None:
            status = existing
            branch_name = status.get("branch", "")
        else:
            return existing  # all done
    else:
        # Fresh start
        branch_name = _sanitize_branch_name(work_request.title)
        create_branch(branch_name)

        wr_dict = {
            "source_type": work_request.source_type,
            "title": work_request.title,
            "description": work_request.description,
            "source_ref": work_request.source_ref,
            "priority": work_request.priority,
        }
        status = init_status(wr_dict, branch_name)
        save_status(status, status_path)
        resume_stage = None

    prompt_builder = PromptBuilder(
        work_request.title,
        work_request.description,
    )
    loop_counters = {}

    stage_order = [Stage.PLAN, Stage.COORDINATE, Stage.IMPLEMENT, Stage.TEST, Stage.REVIEW, Stage.PR]

    # Determine starting index
    if resume_stage:
        stage_idx = stage_order.index(resume_stage)
    else:
        stage_idx = 0

    while stage_idx < len(stage_order):
        current_stage = stage_order[stage_idx]

        # Update current stage tracker
        status["stage"] = current_stage.value

        # Ensure beads is initialized before coordinate stage
        if current_stage == Stage.COORDINATE:
            _ensure_beads_initialized()

        # Try to assign a specific bead before implement stage
        if current_stage == Stage.IMPLEMENT:
            bead = _query_ready_bead()
            if bead:
                _claim_bead(bead["id"])
                prompt_builder.update_context("assigned_bead_id", bead["id"])
                prompt_builder.update_context("assigned_bead_title", bead["title"])
                prompt_builder.update_context("assigned_bead_description", bead["description"])

        # Build stage-specific prompt
        iteration = loop_counters.get(f"{current_stage.value}_iteration", 0)
        rendered_prompt = prompt_builder.build(current_stage.value, iteration)

        # Store rendered prompt in status for UI visibility
        if "stages" not in status:
            status["stages"] = {}
        if current_stage.value not in status.get("stages", {}):
            status["stages"][current_stage.value] = {}
        status["stages"][current_stage.value]["prompt"] = rendered_prompt

        # Mark stage as in_progress
        update_stage(status, current_stage.value, status="in_progress")
        save_status(status, status_path)

        # Run the stage with rendered prompt
        result, raw_envelope = run_stage(current_stage, rendered_prompt, settings_path, msize=msize)

        # Save full envelope for resume/debugging
        _save_stage_output(current_stage, raw_envelope, logs_dir)

        # Mark stage completed
        update_stage(status, current_stage.value, status="completed")
        save_status(status, status_path)

        # Thread stage outputs into PromptBuilder for downstream stages
        if current_stage == Stage.PLAN:
            prompt_builder.update_context("plan_approach", result.get("approach", ""))
            prompt_builder.update_context("plan_tasks_outline", result.get("tasks_outline", []))
            # Milestone gate
            approved = result.get("approved", True)
            set_milestone(status, "plan_approved", approved)
            save_status(status, status_path)
            if not approved:
                raise PipelineError("Plan not approved")

        elif current_stage == Stage.COORDINATE:
            prompt_builder.update_context("beads_ids", result.get("beads_ids", []))
            prompt_builder.update_context("dependency_graph", result.get("dependency_graph", {}))

        elif current_stage == Stage.IMPLEMENT:
            prompt_builder.update_context("files_changed", result.get("files_changed", []))
            prompt_builder.update_context("tests_added", result.get("tests_added", []))

        elif current_stage == Stage.TEST:
            passed = result.get("passed", False)
            prompt_builder.update_context("test_passed", passed)
            prompt_builder.update_context("test_coverage", result.get("coverage_pct"))
            prompt_builder.update_context("proof_artifacts", result.get("proof_artifacts", []))
            if not passed:
                # Thread test failures for the implement retry; clear stale review context
                prompt_builder.update_context("test_failures", result.get("failures", []))
                prompt_builder.update_context("review_issues", None)
                loop_key = "implement_test"
                loop_counters[loop_key] = loop_counters.get(loop_key, 0) + 1
                loop_counters["implement_iteration"] = loop_counters.get("implement_iteration", 0) + 1
                if not check_loop_limit(loop_key, loop_counters[loop_key], settings_path, mloops=mloops):
                    raise LoopExhaustedError(
                        f"Loop {loop_key} exhausted after {loop_counters[loop_key]} iterations"
                    )
                stage_idx = stage_order.index(Stage.IMPLEMENT)
                continue

        elif current_stage == Stage.REVIEW:
            outcome = result.get("outcome", "approve")
            next_stage, status = handle_pr_review(outcome, status)
            if next_stage is None:
                if outcome == "reject":
                    raise PipelineError("PR rejected")
                # approved — continue to PR
            elif next_stage == Stage.IMPLEMENT:
                # Thread review feedback for the implement retry; clear stale test context
                prompt_builder.update_context("review_issues", result.get("issues", []))
                prompt_builder.update_context("test_failures", None)
                loop_key = "pr_changes"
                loop_counters[loop_key] = loop_counters.get(loop_key, 0) + 1
                loop_counters["implement_iteration"] = loop_counters.get("implement_iteration", 0) + 1
                if not check_loop_limit(loop_key, loop_counters[loop_key], settings_path, mloops=mloops):
                    raise LoopExhaustedError(
                        f"Loop {loop_key} exhausted after {loop_counters[loop_key]} iterations"
                    )
                stage_idx = stage_order.index(Stage.IMPLEMENT)
                continue
            elif next_stage == Stage.PLAN:
                loop_key = "restart_planning"
                loop_counters[loop_key] = loop_counters.get(loop_key, 0) + 1
                if not check_loop_limit(loop_key, loop_counters[loop_key], settings_path, mloops=mloops):
                    raise LoopExhaustedError(
                        f"Loop {loop_key} exhausted after {loop_counters[loop_key]} iterations"
                    )
                stage_idx = stage_order.index(Stage.PLAN)
                continue

        stage_idx += 1

    return status
