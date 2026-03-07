"""Single work request pipeline runner.

Orchestrates the full pipeline from plan through PR.
"""

import json
import os
from typing import Optional

from worca.orchestrator.stages import Stage, can_transition, get_stage_config, STAGE_AGENT_MAP
from worca.orchestrator.work_request import WorkRequest
from worca.state.status import load_status, save_status, update_stage, set_milestone, init_status
from worca.utils.claude_cli import run_agent
from worca.utils.git import create_branch


class LoopExhaustedError(Exception):
    """Raised when a loop reaches its maximum iterations."""
    pass


class PipelineError(Exception):
    """Raised when pipeline encounters an unrecoverable error."""
    pass


def run_stage(stage: Stage, context: dict, settings_path: str = ".claude/settings.json") -> dict:
    """Run a single pipeline stage.

    Gets stage config via get_stage_config(), calls run_agent() with the
    appropriate agent, prompt, and max_turns.

    Returns the agent's JSON output.
    """
    config = get_stage_config(stage, settings_path=settings_path)
    prompt = context.get("prompt", "")
    result = run_agent(
        prompt=prompt,
        agent=config["agent"],
        max_turns=config["max_turns"],
    )
    return result


def check_loop_limit(
    loop_name: str,
    current_iteration: int,
    settings_path: str = ".claude/settings.json",
) -> bool:
    """Check if the current iteration is within the configured loop limit.

    Reads loop limits from settings.json under worca.loops namespace.
    Returns True if current_iteration < limit, False if exhausted.
    If no limit configured, defaults to 10.
    """
    default_limit = 10
    try:
        with open(settings_path) as f:
            settings = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        settings = {}

    loops = settings.get("worca", {}).get("loops", {})
    limit = loops.get(loop_name, default_limit)
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


def run_pipeline(
    work_request: WorkRequest,
    settings_path: str = ".claude/settings.json",
    status_path: str = ".worca/status.json",
) -> dict:
    """Run the full pipeline for a single work request.

    Creates branch, initializes status, then runs stages in sequence:
    PLAN -> (milestone gate) -> COORDINATE -> IMPLEMENT -> TEST -> REVIEW -> PR

    Handles loops:
    - test failure -> back to implement
    - review changes -> back to implement

    Checks loop limits, raises LoopExhaustedError when exceeded.
    Saves status after each stage transition.
    Returns final status.
    """
    # Create branch
    branch_name = f"worca/{work_request.title.lower().replace(' ', '-')[:40]}"
    create_branch(branch_name)

    # Initialize status
    wr_dict = {
        "source_type": work_request.source_type,
        "title": work_request.title,
        "description": work_request.description,
    }
    status = init_status(wr_dict, branch_name)
    save_status(status, status_path)

    context = {"prompt": work_request.description or work_request.title}
    loop_counters = {}

    stage_order = [Stage.PLAN, Stage.COORDINATE, Stage.IMPLEMENT, Stage.TEST, Stage.REVIEW, Stage.PR]
    stage_idx = 0

    while stage_idx < len(stage_order):
        current_stage = stage_order[stage_idx]

        # Mark stage as in_progress
        update_stage(status, current_stage.value, status="in_progress")
        save_status(status, status_path)

        # Run the stage
        result = run_stage(current_stage, context, settings_path)

        # Mark stage completed
        update_stage(status, current_stage.value, status="completed")
        save_status(status, status_path)

        # Milestone gate after PLAN
        if current_stage == Stage.PLAN:
            approved = result.get("approved", True)
            set_milestone(status, "plan_approved", approved)
            save_status(status, status_path)
            if not approved:
                raise PipelineError("Plan not approved")

        # Handle test results
        if current_stage == Stage.TEST:
            passed = result.get("passed", False)
            if not passed:
                loop_key = "implement_test"
                loop_counters[loop_key] = loop_counters.get(loop_key, 0) + 1
                if not check_loop_limit(loop_key, loop_counters[loop_key], settings_path):
                    raise LoopExhaustedError(
                        f"Loop {loop_key} exhausted after {loop_counters[loop_key]} iterations"
                    )
                # Go back to implement
                stage_idx = stage_order.index(Stage.IMPLEMENT)
                continue

        # Handle review results
        if current_stage == Stage.REVIEW:
            outcome = result.get("outcome", "approve")
            next_stage, status = handle_pr_review(outcome, status)
            if next_stage is None:
                if outcome == "reject":
                    raise PipelineError("PR rejected")
                # approved — continue to PR
            elif next_stage == Stage.IMPLEMENT:
                loop_key = "review_implement"
                loop_counters[loop_key] = loop_counters.get(loop_key, 0) + 1
                if not check_loop_limit(loop_key, loop_counters[loop_key], settings_path):
                    raise LoopExhaustedError(
                        f"Loop {loop_key} exhausted after {loop_counters[loop_key]} iterations"
                    )
                stage_idx = stage_order.index(Stage.IMPLEMENT)
                continue
            elif next_stage == Stage.PLAN:
                loop_key = "review_plan"
                loop_counters[loop_key] = loop_counters.get(loop_key, 0) + 1
                if not check_loop_limit(loop_key, loop_counters[loop_key], settings_path):
                    raise LoopExhaustedError(
                        f"Loop {loop_key} exhausted after {loop_counters[loop_key]} iterations"
                    )
                stage_idx = stage_order.index(Stage.PLAN)
                continue

        stage_idx += 1

    return status
