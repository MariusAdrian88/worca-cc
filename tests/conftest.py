"""Global test fixtures.

Prevents test runs from polluting ~/.worca/projects.d/ with temporary project
entries that would then show up in the global worca-ui.
"""

import pytest


@pytest.fixture(autouse=True)
def _isolate_project_registry(monkeypatch, tmp_path):
    """Redirect auto_register_project to a throwaway directory so test projects
    never leak into the real ~/.worca/projects.d/."""
    fake_prefs = tmp_path / "fake_worca_prefs"
    fake_prefs.mkdir()

    import worca.utils.project_registry as reg

    _original = reg.auto_register_project

    def _isolated(project_root, prefs_dir=str(fake_prefs)):
        return _original(project_root, prefs_dir=prefs_dir)

    monkeypatch.setattr(reg, "auto_register_project", _isolated)
