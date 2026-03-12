# Implement Sticky Header in Running, History, Beads, and Costs Pages

**Date**: 2026-03-12
**Branch**: `worca/implement-sticky-header-in-running-histo-ZRJ`

## Problem

When scrolling long content on the Running, History, Beads, and Costs pages, the `.content-header` (containing the page title, back button, and action buttons) scrolls away with the content. Users lose access to navigation and actions, requiring them to scroll back to the top.

## Current Architecture

The app uses a two-column layout:
```
┌──────────────────────────────────────────────────┐
│ .app-shell (flex row, height: 100vh)             │
│ ├─ .sidebar (250px, fixed height)                │
│ └─ .main-content (flex:1, overflow:auto, p:24px) │
│    ├─ notification banner                        │
│    ├─ .content-header  ← THIS SCROLLS AWAY       │
│    └─ page content (varies per view)             │
└──────────────────────────────────────────────────┘
```

Key details:
- **Scroll container**: `.main-content` is the scroll container (`overflow: auto`)
- **Header rendering**: `contentHeaderView()` in `main.js:574-678` renders the header dynamically per route
- **Render pipeline**: `rerender()` in `main.js:791-805` composes `<main class="main-content"> → notification banner → contentHeaderView() → mainContentView()`
- **Affected pages**: Running (`section='active'`), History (`section='history'`), Beads (`section='beads'`), Costs (`section='costs'`)
- **Existing sticky**: The run-detail logs column already uses `position: sticky; top: 0` — confirms the pattern works within `.main-content`

## Design

Make `.content-header` sticky at the top of `.main-content` for the four target pages. The header should:
1. Stay fixed at the top while page content scrolls beneath it
2. Have a solid background (not transparent) so content doesn't show through
3. Add a subtle bottom shadow when scrolled to provide visual separation
4. Not affect the Dashboard or Run Detail pages (which have their own layouts)

### Approach: CSS `position: sticky` on `.content-header`

Since `.main-content` is the scroll container with `overflow: auto`, `position: sticky` on `.content-header` will work correctly — the sticky element sticks relative to its scroll container.

The simplest approach is to make the header sticky globally (for all pages that use it) rather than conditionally per route. This is correct because:
- Dashboard doesn't scroll much (summary cards)
- Run Detail has its own two-column grid layout where the header is short
- Settings page is short
- New Run page has the submit button in the header — sticky is actually helpful there too

**Decision**: Make `.content-header` sticky globally. All pages benefit from this.

## Implementation Tasks

### Task 1: Make `.content-header` sticky via CSS
**File**: `.claude/worca-ui/app/styles.css` (lines 250-257)
**Complexity**: Low

Update the `.content-header` rule:

```css
.content-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 20px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border-subtle);

  /* Sticky behavior */
  position: sticky;
  top: -24px;          /* Negative of .main-content padding-top (24px) */
  z-index: 10;
  background: var(--bg);
  padding-top: 24px;   /* Compensate: absorb .main-content's top padding */
  margin-top: -24px;   /* Pull up into .main-content padding area */
}
```

**Why `top: -24px` and `margin-top: -24px`**: `.main-content` has `padding: 24px 32px`. The header sits 24px down from the top of the scroll area. By setting `top: -24px`, the header sticks when it reaches the actual visual top of the viewport area. The `margin-top: -24px` and `padding-top: 24px` make the header fill the padding gap seamlessly when stuck.

### Task 2: Add scroll shadow effect with JS listener
**File**: `.claude/worca-ui/app/styles.css` + `.claude/worca-ui/app/main.js`
**Complexity**: Low

Add a scroll listener on `.main-content` that toggles a `.content-header--scrolled` class when `scrollTop > 0`.

CSS additions:
```css
.content-header--scrolled {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  border-bottom-color: transparent;
}

[data-theme="dark"] .content-header--scrolled {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}
```

JS addition in `main.js`:
```js
let scrollListenerAttached = false;

function attachStickyHeaderListener() {
  if (scrollListenerAttached) return;
  const mainEl = document.querySelector('.main-content');
  if (!mainEl) return;
  mainEl.addEventListener('scroll', () => {
    const header = mainEl.querySelector('.content-header');
    if (header) {
      header.classList.toggle('content-header--scrolled', mainEl.scrollTop > 10);
    }
  }, { passive: true });
  scrollListenerAttached = true;
}
```

Call `attachStickyHeaderListener()` after the first `rerender()` call.

### Task 3: Handle dark theme
**File**: `.claude/worca-ui/app/styles.css`
**Complexity**: Low

Ensure the sticky header looks correct in dark mode:
- `background: var(--bg)` already resolves correctly for both themes
- Shadow needs a stronger shadow for dark theme (covered in Task 2 CSS)

### Task 4: Verify no z-index conflicts
**Complexity**: Low

Check that `z-index: 10` on `.content-header` doesn't conflict with:
- Shoelace dialogs/overlays (typically z-index: 1000+) — no conflict
- The sidebar (no z-index, separate flex column) — no conflict
- `.run-detail-layout__logs` sticky (z-index not set, `top: 0`) — no conflict since it's in a different grid cell

### Task 5: Test across all affected pages
**Complexity**: Low

Manual verification on each page:
- **Running** (`#/active`): Header stays sticky above run cards list
- **History** (`#/history`): Header stays sticky above history run cards
- **Beads run list** (`#/beads`): Header sticky, beads filter bar scrolls normally
- **Beads kanban** (`#/beads/:runId`): Header sticky above kanban board
- **Costs** (`#/costs`): Header sticky above cost stats and run cost list
- **Dashboard** (`#/`): Header sticky (no harm, page is usually short)
- **Run Detail** (`#/active/:runId`): Header sticky above two-column layout — verify logs column `position: sticky` still works correctly

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Sticky header overlaps notification banner | Low | Banner renders before header in DOM; both are flow children. Banner will push header down, sticky applies from header's natural position. Test to confirm. |
| Content jumps when header becomes sticky | Low | The `margin-top`/`padding-top` compensation ensures no layout shift. |
| Z-index stacking issues with Shoelace modals | Very Low | Shoelace uses z-index 1000+, our header uses 10. |
| Performance of scroll listener | Very Low | Passive listener, simple classList toggle, no reflow triggers. |

## Files Modified

1. **`.claude/worca-ui/app/styles.css`** — Sticky positioning + scroll shadow styles
2. **`.claude/worca-ui/app/main.js`** — Scroll listener attachment

## Not In Scope

- Making the beads filter bar (`beads-filters`) sticky within the beads panel (could be a follow-up)
- Making the costs summary stats row sticky on the costs page
- Any changes to the sidebar (already full-height)
