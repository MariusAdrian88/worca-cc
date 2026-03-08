# E2E Visual Test Procedures

These tests are executed via Playwright MCP browser tools during development review.

## Prerequisites

Start the server with test data:
```bash
cd /Volumes/Apps/dev/ccexperiments/worca-cc
mkdir -p .worca/logs .worca/results
cp .claude/worca-ui/test/fixtures/status-running.json .worca/status.json
node .claude/worca-ui/server/index.js --port 3402
```

## Test Cases

### 1. Sidebar renders
- Navigate to http://127.0.0.1:3402
- Verify "WORCA" logo visible
- Verify "Pipeline" section header
- Verify "Active" and "History" navigation items

### 2. Theme toggle
- Click theme toggle button (moon icon)
- Verify `data-theme="dark"` on `<html>`
- Click again to restore light theme

### 3. Empty dashboard
- Start server without .worca/status.json
- Navigate to http://127.0.0.1:3402
- Verify "No active pipeline runs" message

### 4. Active run appears
- Copy status-running.json to .worca/status.json
- Reload page
- Verify run appears in Active list

### 5. Run detail
- Click on a run
- Verify stage timeline renders with correct state icons
- Verify run header shows title, status, branch

### 6. Stage timeline states
- Verify completed stages show checkmark
- Verify in_progress stage pulses
- Verify pending stages show circle

### 7. Log viewer
- Verify log panel renders at bottom
- Verify stage filter dropdown present
- Verify search input present

### 8. Generic stages
- Write status.json with custom "deploy" stage
- Verify it renders with title-cased label

### 9. Connection status
- Verify green dot when connected
- Stop server, verify red dot appears

### 10. Live update
- Modify .worca/status.json while UI is open
- Verify UI updates automatically
