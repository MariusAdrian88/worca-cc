# Settings Page Design

## Overview
Add a full-page Settings view to worca-ui that visualizes and allows editing all pipeline configuration from `.claude/settings.json`.

## Architecture

```
Browser                           Server
┌──────────────────┐    GET     ┌──────────────┐
│ settings.js      │──────────→│ /api/settings │→ reads settings.json
│ (lit-html view)  │           │               │
│                  │   POST    │               │
│ Save button      │──────────→│ /api/settings │→ deep-merge + write
└──────────────────┘           └──────────────┘
```

## Files

### New
- `app/views/settings.js` — Settings view with 4 tabs

### Modified
- `app/main.js` — Add 'settings' route + Shoelace imports (sl-tab-group, sl-tab, sl-tab-panel, sl-switch, sl-alert)
- `app/router.js` — Add 'settings' to valid sections
- `app/views/sidebar.js` — Add gear icon in footer next to theme toggle
- `app/utils/icons.js` — Add Settings, Shield, Workflow, Sliders, Users, Cpu icons
- `server/app.js` — Add GET/POST /api/settings REST endpoints
- `app/styles.css` — Add section 27 for settings styles

## REST API

### GET /api/settings
Returns `settings.worca` object from settings.json.

### POST /api/settings
Accepts partial `worca` object. Deep-merges with existing config, preserving hooks/permissions. Writes back to settings.json with proper formatting.

## Tabs

### Tab 1: Agents
Card per agent (planner, coordinator, implementer, tester, guardian). Each card:
- Model: sl-select with opus/sonnet/haiku options
- Max turns: sl-input type=number
- Save button at bottom

### Tab 2: Pipeline
- Stage flow visualization: plan → coordinate → implement → test → review → pr
- Stage-to-agent mapping table
- Loop limits: sl-input type=number for implement_test, code_review, pr_changes, restart_planning
- Milestone gates: sl-switch for plan_approval, pr_approval, deploy_approval
- Save button at bottom

### Tab 3: Governance
- Guard rules as sl-switch toggles (visual representation, read-only display of active rules):
  - rm -rf blocking
  - .env write blocking
  - Force-push blocking
  - Git commit restriction
- Test gate: strike threshold display
- Dispatch rules: table showing which agents can spawn sub-agents
- Permissions: list of allowed patterns from permissions.allow
- Save button at bottom (for editable fields)

### Tab 4: Preferences
- Theme toggle (light/dark) using existing theme mechanism
- Save button

## Patterns
- lit-html template functions (same as dashboard.js, run-detail.js)
- Shoelace web components for all form controls
- Lucide icons via utils/icons.js
- fetch() for REST API calls
- sl-alert for save feedback (success/error)
