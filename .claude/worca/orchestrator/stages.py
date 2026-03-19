"""Pipeline stage definitions and transition validation."""
import json
from enum import Enum
from typing import Optional


class Stage(Enum):
    """Pipeline stages in order."""
    PLAN = "plan"
    COORDINATE = "coordinate"
    IMPLEMENT = "implement"
    TEST = "test"
    REVIEW = "review"
    PR = "pr"
    LEARN = "learn"


TRANSITIONS = {
    Stage.PLAN: {Stage.COORDINATE},
    Stage.COORDINATE: {Stage.IMPLEMENT},
    Stage.IMPLEMENT: {Stage.TEST},
    Stage.TEST: {Stage.REVIEW, Stage.IMPLEMENT},
    Stage.REVIEW: {Stage.PR, Stage.IMPLEMENT, Stage.PLAN},
    Stage.PR: set(),
}

STAGE_AGENT_MAP = {
    Stage.PLAN: "planner",
    Stage.COORDINATE: "coordinator",
    Stage.IMPLEMENT: "implementer",
    Stage.TEST: "tester",
    Stage.REVIEW: "guardian",
    Stage.PR: "guardian",
    Stage.LEARN: "learner",
}

STAGE_SCHEMA_MAP = {
    Stage.PLAN: "plan.json",
    Stage.COORDINATE: "coordinate.json",
    Stage.IMPLEMENT: "implement.json",
    Stage.TEST: "test_result.json",
    Stage.REVIEW: "review.json",
    Stage.PR: "pr.json",
    Stage.LEARN: "learn.json",
}


def can_transition(from_stage: Stage, to_stage: Stage) -> bool:
    """Return True if transition from from_stage to to_stage is valid."""
    return to_stage in TRANSITIONS.get(from_stage, set())


# Canonical stage order (not configurable — use enabled flag to skip)
STAGE_ORDER = [Stage.PLAN, Stage.COORDINATE, Stage.IMPLEMENT, Stage.TEST, Stage.REVIEW, Stage.PR]


def _read_settings(settings_path: str) -> dict:
    """Read and parse settings.json, returning empty dict on failure."""
    try:
        with open(settings_path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def get_stage_config(stage: Stage, settings_path: str = ".claude/settings.json") -> dict:
    """Read settings.json and return agent config for the given stage.

    Agent mapping priority:
    1. worca.stages.<stage>.agent (if present)
    2. STAGE_AGENT_MAP[stage] (hardcoded default)
    """
    settings = _read_settings(settings_path)
    worca = settings.get("worca", {})

    # Determine agent: prefer stages config, fall back to hardcoded map
    stages_config = worca.get("stages", {})
    stage_entry = stages_config.get(stage.value, {})
    agent_name = stage_entry.get("agent") or STAGE_AGENT_MAP[stage]

    agent_config = worca.get("agents", {}).get(agent_name, {})
    return {
        "agent": agent_name,
        "model": agent_config.get("model", "sonnet"),
        "max_turns": agent_config.get("max_turns", 30),
        "schema": STAGE_SCHEMA_MAP.get(stage, f"{stage.value}.json"),
    }


def get_enabled_stages(settings_path: str = ".claude/settings.json") -> list:
    """Return list of enabled stages in pipeline order.

    Reads worca.stages.<stage>.enabled from settings.json.
    Stages default to enabled if not configured.
    """
    settings = _read_settings(settings_path)
    stages_config = settings.get("worca", {}).get("stages", {})

    enabled = []
    for stage in STAGE_ORDER:
        stage_entry = stages_config.get(stage.value, {})
        if stage_entry.get("enabled", True):
            enabled.append(stage)
    return enabled


def is_learn_enabled(settings_path: str = ".claude/settings.json") -> bool:
    """Check if learn stage is enabled. Defaults to False (opposite of other stages)."""
    settings = _read_settings(settings_path)
    return settings.get("worca", {}).get("stages", {}).get("learn", {}).get("enabled", False)
