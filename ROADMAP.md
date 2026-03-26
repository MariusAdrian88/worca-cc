# Roadmap

This document outlines the major features planned for worca-cc. Items are listed in order of priority, not scheduled to specific dates. The roadmap is a living document — additional features and changes may be added as the project evolves.

For detailed tracking, see [GitHub Issues](https://github.com/SinishaDjukic/worca-cc/issues).

---

## Parallel Pipeline Execution

Run multiple independent pipelines concurrently, each isolated in its own git worktree. ([W-030](https://github.com/SinishaDjukic/worca-cc/issues/54))

**Problem.** The pipeline is currently single-tenant — only one pipeline can run at a time per project directory. A PID file lock prevents concurrent starts, and even bypassing it leads to shared state corruption (active run pointer, beads database, git HEAD, cumulative stats). This is the primary throughput bottleneck for batch workloads.

**Approach.** Use git worktrees as the isolation boundary. Each pipeline runs in its own worktree with an independent working tree, `.worca/` state directory, beads database, and git branch. A new `run_multi.py` entry point orchestrates multiple pipelines via `ProcessPoolExecutor`, and a pipeline registry enables the UI and CLI to monitor all running pipelines.

**Benefit.** Multiplies throughput linearly — processing N independent work requests in roughly the time it takes to run one.

---

## Feedback Loops from Test and Review Stages

Close the loop between Test/Review failures and the Coordinator, enabling structured rework cycles with full traceability.

**Problem.** When the Tester or Guardian identifies failures, the current pipeline either retries within the same stage or halts. There is no mechanism to feed detailed failure analysis back to the Coordinator so it can decompose rework into tracked beads tasks — leading to untraceable fix attempts and lost context between iterations.

**Approach.** When the Test or Review stage produces failures, it generates a structured feedback plan describing what failed, why, and what needs to change. This plan is routed back to the Coordinator, which breaks it down into new beads tasks with dependencies on the original work. The Implementer then picks up these tasks through the normal dispatch flow.

**Benefit.** Comprehensive test failure results or extensive review feedback get decomposed into separate, trackable implementation tasks — rather than being passed as a monolithic retry prompt that the Implementer must interpret on its own.

---

## Pipeline Templates

Support predefined pipeline templates that configure stage flow, agent selection, and governance rules for different work types. ([W-023](https://github.com/SinishaDjukic/worca-cc/issues/23))

**Problem.** The current pipeline uses a single fixed stage flow (Preflight → Plan → Coordinate → Implement → Test → Review → PR → Learn) regardless of the work type. A bugfix doesn't need the same planning depth as a new feature. An incident analysis doesn't need an Implementer. Users must manually toggle stages in settings for each run.

**Approach.** Introduce pipeline templates — named configurations that define which stages run, in what order, with which agents and settings. Templates are selected at run time, and the existing stage flow becomes the `default` template.

**Benefit.** Eliminates unnecessary stages per work type, reducing both token cost and end-to-end run time.

**Example templates:**
- **feature** — Full pipeline: Plan → Coordinate → Implement → Test → Review → PR → Learn
- **bugfix** — Abbreviated flow: skip deep planning, focus on reproducing the bug, fixing, and testing
- **incident-analysis** — Read-only investigation: Plan → Coordinate (analysis tasks) → Review → Learn, no code changes
- **refactor** — Emphasize Review and Test stages with stricter governance thresholds
