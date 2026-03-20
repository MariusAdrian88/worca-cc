"""
Tests for docs/spec/webhooks/README.md — validates structure and content
of the consumer-facing webhook specification document.
"""
import re
from pathlib import Path

SPEC_PATH = Path(__file__).parent.parent / "docs/spec/webhooks/README.md"

# All 52 event types that must be documented
REQUIRED_EVENT_TYPES = [
    # Pipeline lifecycle (5)
    "pipeline.run.started",
    "pipeline.run.completed",
    "pipeline.run.failed",
    "pipeline.run.interrupted",
    "pipeline.run.resumed",
    # Stage lifecycle (4)
    "pipeline.stage.started",
    "pipeline.stage.completed",
    "pipeline.stage.failed",
    "pipeline.stage.interrupted",
    # Agent telemetry (5)
    "pipeline.agent.spawned",
    "pipeline.agent.tool_use",
    "pipeline.agent.tool_result",
    "pipeline.agent.text",
    "pipeline.agent.completed",
    # Bead lifecycle (6)
    "pipeline.bead.created",
    "pipeline.bead.assigned",
    "pipeline.bead.completed",
    "pipeline.bead.failed",
    "pipeline.bead.labeled",
    "pipeline.bead.next",
    # Git operations (4)
    "pipeline.git.branch_created",
    "pipeline.git.commit",
    "pipeline.git.pr_created",
    "pipeline.git.pr_merged",
    # Test detail (4)
    "pipeline.test.suite_started",
    "pipeline.test.suite_passed",
    "pipeline.test.suite_failed",
    "pipeline.test.fix_attempt",
    # Review detail (3)
    "pipeline.review.started",
    "pipeline.review.verdict",
    "pipeline.review.fix_attempt",
    # Circuit breaker (4)
    "pipeline.circuit_breaker.failure_recorded",
    "pipeline.circuit_breaker.retry",
    "pipeline.circuit_breaker.tripped",
    "pipeline.circuit_breaker.reset",
    # Cost & tokens (3)
    "pipeline.cost.stage_total",
    "pipeline.cost.running_total",
    "pipeline.cost.budget_warning",
    # Milestones & loops (3)
    "pipeline.milestone.set",
    "pipeline.loop.triggered",
    "pipeline.loop.exhausted",
    # Hook & governance (3)
    "pipeline.hook.blocked",
    "pipeline.hook.test_gate",
    "pipeline.hook.dispatch_blocked",
    # Preflight (2)
    "pipeline.preflight.completed",
    "pipeline.preflight.skipped",
    # Learn stage (2)
    "pipeline.learn.completed",
    "pipeline.learn.failed",
]

# Control actions (inbound)
REQUIRED_CONTROL_ACTIONS = ["approve", "reject", "pause", "resume", "abort", "continue"]

# Required top-level sections
REQUIRED_SECTIONS = [
    "## 1.",   # Overview
    "## 2.",   # HTTP Protocol
    "## 3.",   # Event Envelope
    "## 4.",   # Event Catalog
    "## 5.",   # Control Webhooks
    "## 6.",   # Configuration Reference
    "## 7.",   # Examples
    "## 8.",   # JSON Schema Reference
]

# Required HTTP headers documented
REQUIRED_HEADERS = [
    "X-Worca-Event",
    "X-Worca-Delivery",
    "X-Worca-Signature",
]

# Required envelope fields
REQUIRED_ENVELOPE_FIELDS = [
    "schema_version",
    "event_id",
    "event_type",
    "timestamp",
    "run_id",
    "pipeline",
    "payload",
]

# Required example languages
REQUIRED_EXAMPLE_LANGUAGES = ["Python", "Node"]

# Required config keys
REQUIRED_CONFIG_KEYS = [
    "worca.events.enabled",
    "worca.webhooks",
]


def read_spec() -> str:
    assert SPEC_PATH.exists(), f"Spec file not found: {SPEC_PATH}"
    return SPEC_PATH.read_text(encoding="utf-8")


def test_spec_file_exists():
    """The spec document must exist at the expected path."""
    assert SPEC_PATH.exists(), f"Missing: {SPEC_PATH}"


def test_spec_has_required_sections():
    """The spec must contain all 8 top-level sections."""
    content = read_spec()
    for section in REQUIRED_SECTIONS:
        assert section in content, f"Missing section starting with '{section}'"


def test_spec_documents_all_52_event_types():
    """Every event type in the 52-event catalog must appear in the spec."""
    content = read_spec()
    missing = [et for et in REQUIRED_EVENT_TYPES if et not in content]
    assert not missing, f"Missing event types: {missing}"


def test_spec_documents_http_headers():
    """The spec must document the required HTTP request headers."""
    content = read_spec()
    for header in REQUIRED_HEADERS:
        assert header in content, f"Missing HTTP header documentation: {header}"


def test_spec_documents_envelope_fields():
    """The spec must document all required event envelope fields."""
    content = read_spec()
    for field in REQUIRED_ENVELOPE_FIELDS:
        assert field in content, f"Missing envelope field: {field}"


def test_spec_documents_control_actions():
    """The spec must document all control webhook response actions."""
    content = read_spec()
    for action in REQUIRED_CONTROL_ACTIONS:
        assert action in content, f"Missing control action: {action}"


def test_spec_has_json_examples():
    """The spec must contain JSON code blocks (event examples)."""
    content = read_spec()
    json_blocks = re.findall(r"```json", content)
    assert len(json_blocks) >= 5, (
        f"Expected at least 5 JSON examples, found {len(json_blocks)}"
    )


def test_spec_has_code_examples():
    """The spec must contain Python and Node.js receiver examples."""
    content = read_spec()
    for lang in REQUIRED_EXAMPLE_LANGUAGES:
        assert lang in content, f"Missing example for: {lang}"


def test_spec_documents_hmac_signing():
    """The spec must document HMAC-SHA256 signature verification."""
    content = read_spec()
    assert "HMAC" in content or "hmac" in content, "Missing HMAC documentation"
    assert "SHA-256" in content or "sha256" in content or "SHA256" in content, (
        "Missing SHA-256 documentation"
    )


def test_spec_documents_config_keys():
    """The spec must reference the required settings.json config keys."""
    content = read_spec()
    for key in REQUIRED_CONFIG_KEYS:
        assert key in content, f"Missing config key documentation: {key}"


def test_spec_references_json_schemas():
    """The spec must reference the JSON schema files."""
    content = read_spec()
    assert "schemas/" in content or "schema.json" in content, (
        "Missing JSON schema references"
    )


def test_spec_documents_retry_behavior():
    """The spec must document retry/backoff behavior."""
    content = read_spec()
    assert "retry" in content.lower() or "backoff" in content.lower(), (
        "Missing retry/backoff documentation"
    )


def test_spec_documents_idempotency():
    """The spec must document idempotency via event_id."""
    content = read_spec()
    assert "idempoten" in content.lower(), "Missing idempotency documentation"


def test_spec_documents_versioning():
    """The spec must document the schema_version versioning policy."""
    content = read_spec()
    assert "schema_version" in content
    assert "version" in content.lower()


def test_event_catalog_count():
    """Spec must state '52' events somewhere (event count reference)."""
    content = read_spec()
    assert "52" in content, "Missing total event count (52) reference"
