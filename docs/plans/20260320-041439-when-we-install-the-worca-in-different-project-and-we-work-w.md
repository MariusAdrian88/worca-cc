# Plan: Display Project Directory Name in Worca UI Sidebar

## Problem

When worca is installed in multiple projects and multiple worca-ui instances are open in the browser simultaneously, there is no way to distinguish which instance belongs to which project. The UI always shows the same hardcoded "WORCA" branding with no project-specific context.

## Proposal

Add the project directory name directly below the "WORCA" title in the upper-left sidebar logo area. The server already discovers the project root path — we just need to expose it via the API and render it in the sidebar.

## Implementation

### Task 1: Add `/api/project-info` endpoint to the server

**File:** `.claude/worca-ui/server/app.js`

Add a new GET endpoint that returns the project directory name derived from the already-resolved `projectRoot` path:

```javascript
app.get('/api/project-info', (req, res) => {
  const dirName = path.basename(projectRoot);
  res.json({ name: dirName });
});
```

The `projectRoot` variable is already available in `app.js` scope (passed from `index.js` during app creation). Use `path.basename()` to extract just the directory name (e.g., `/home/user/my-project` → `my-project`).

### Task 2: Fetch project name at UI startup and store in state

**File:** `.claude/worca-ui/app/main.js`

During app initialization (near existing `fetch('/api/costs')` calls), fetch the project info:

```javascript
fetch('/api/project-info').then(r => r.json()).then(data => {
  state.projectName = data.name;
  render();
});
```

**File:** `.claude/worca-ui/app/state.js`

Add `projectName: ''` to the initial state object.

### Task 3: Display project name in sidebar below "WORCA" title

**File:** `.claude/worca-ui/app/views/sidebar.js`

Update the sidebar logo `div` to include the project name beneath the logo text:

```javascript
<div class="sidebar-logo" @click=${() => onNavigate('dashboard')} style="cursor:pointer">
  <span class="logo-text">WORCA</span>
  ${projectName ? html`<span class="project-name">${projectName}</span>` : ''}
</div>
```

Pass `projectName` from state into the sidebar view function parameters.

**File:** `.claude/worca-ui/app/styles.css`

Add styling for the project name label:

```css
.project-name {
  display: block;
  font-family: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace;
  font-size: 11px;
  font-weight: 400;
  color: var(--fg-muted);
  letter-spacing: 0.02em;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

### Task 4: Update browser tab title with project name

**File:** `.claude/worca-ui/app/main.js`

When the project name is fetched, also update `document.title`:

```javascript
document.title = data.name ? `${data.name} — worca` : 'worca-ui';
```

This helps distinguish multiple tabs in the browser tab bar.

### Task 5: Build and test

1. Rebuild the frontend bundle: `cd .claude/worca-ui && npm run build`
2. Run existing UI server tests: `npx vitest run .claude/worca-ui/server/`
3. Manually verify the sidebar shows the project directory name

## Files Changed

| File | Change |
|------|--------|
| `.claude/worca-ui/server/app.js` | Add `GET /api/project-info` endpoint |
| `.claude/worca-ui/app/state.js` | Add `projectName` to initial state |
| `.claude/worca-ui/app/main.js` | Fetch project info on startup, update document.title |
| `.claude/worca-ui/app/views/sidebar.js` | Render project name below WORCA logo |
| `.claude/worca-ui/app/styles.css` | Add `.project-name` styles |

## Considerations

- **Long directory names:** Handled with `text-overflow: ellipsis` and `overflow: hidden` so names don't break the sidebar layout.
- **No config needed:** The project name is automatically derived from the filesystem path — no user configuration required.
- **Tab title:** Updating `document.title` gives a second visual cue when switching between browser tabs, complementing the sidebar label.
- **Backward compatible:** The endpoint is additive; existing UI builds without this change will simply not fetch or display the name.
