# worca-ui Modernization Design

## Goal

Modernize the worca-ui pipeline dashboard from hand-coded vanilla components to a polished, modern UI using Shoelace web components, xterm.js for the log viewer, and Lucide icons — without introducing heavy frameworks.

## Current State

- **Templating**: lit-html v3.3.1 (stays)
- **Components**: Hand-coded HTML elements styled with pure CSS
- **Icons**: Unicode emoji (circles, checkmarks, arrows)
- **Log viewer**: Manual `<div>` line rendering, capped at 5000 lines
- **Font**: System font stack
- **Build**: esbuild (stays)
- **Backend**: Express + ws (no changes)

## New Dependencies

| Package | Purpose | Size (gzipped) |
|---------|---------|----------------|
| `@shoelace-style/shoelace` | Web component library (select, details, badge, button, icon-button, tooltip) | ~70KB (tree-shakeable) |
| `xterm` | Terminal emulator for log viewer | ~35KB |
| `@xterm/addon-search` | Search within terminal | ~5KB |
| `@xterm/addon-fit` | Auto-resize terminal to container | ~3KB |
| `lucide` | SVG icon library | ~2KB per icon used |

**Font**: Inter via Google Fonts CDN (no npm dep).

## Component Mapping

### Replaced by Shoelace

| Current | New | Shoelace Component |
|---------|-----|-------------------|
| `<details class="stage-panel">` | `<sl-details>` | Animated expand/collapse |
| `<select class="log-stage-filter">` | `<sl-select>` | Proper dropdown with keyboard nav |
| `<input class="log-search">` | `<sl-input>` | Search icon, clearable |
| `<button class="log-autoscroll-btn">` | `<sl-button>` | With icon slot |
| `<button class="theme-toggle">` | `<sl-icon-button>` | Sun/moon icons |
| `<span class="badge">` | `<sl-badge>` | Pill badge with variants |
| `<span class="status-badge">` | `<sl-badge>` | With pulse attribute for in-progress |

### Replaced by xterm.js

| Current | New |
|---------|-----|
| `.log-viewer` div with manual line rendering | xterm.js Terminal instance |
| Manual auto-scroll logic | Native terminal scrollback |
| Text search via JS filter | `@xterm/addon-search` overlay |
| 5000-line cap with DOM elements | Canvas-rendered virtual scroll (handles 100K+ lines) |

### Replaced by Lucide

| Current | New |
|---------|-----|
| Unicode `○` (pending) | `<lucide-circle>` or inline SVG |
| Unicode `●` (in-progress) | `<lucide-loader>` with spin animation |
| Unicode `✓` (completed) | `<lucide-check-circle>` |
| Unicode `✗` (error) | `<lucide-alert-circle>` |
| Unicode `☀/☾` (theme toggle) | `<lucide-sun>` / `<lucide-moon>` |

### Stays Custom (restyled)

- **Sidebar navigation** — Shoelace has no nav component; keep hand-coded, apply modern CSS
- **Stage timeline stepper** — Unique pipeline visualization, no library equivalent; restyle with larger nodes, gradients, better animations
- **App shell layout** — Flex layout stays, improved spacing

## Visual Design

### Typography
- **Font**: Inter (Google Fonts)
- **Base size**: 15px (up from 14px)
- **Headings**: Semi-bold (600), tighter letter-spacing
- **Monospace**: 'JetBrains Mono', 'SF Mono', 'Fira Code' (for log viewer, code elements)

### Color Palette
Keep existing slate/blue palette, enhance with:
- More subtle gradients on active elements
- Better contrast ratios (WCAG AA compliance)
- Softer shadow depths for card layering

### Cards & Surfaces
- Border-radius: 12px (up from 8px)
- Shadow: multi-layer (subtle ambient + directional)
- Background: slight tint differentiation between layers
- Border: 1px solid with reduced opacity

### Sidebar
- Semi-transparent background with `backdrop-filter: blur(12px)`
- Slightly wider hover states
- Active item: filled accent background with white text (keep current pattern)

### Stage Timeline
- Node size: 52px (up from 44px)
- Connector thickness: 4px (up from 3px)
- In-progress: gradient border animation (rotating conic gradient)
- Completed: subtle scale-up transition
- Better visual weight and spacing

### Log Viewer (xterm.js)
- Dark terminal theme matching existing `--log-bg` (#0f172a)
- ANSI color codes for stage tags (each stage gets a distinct color)
- Proper cursor, selection, copy-paste
- Fit addon for responsive sizing
- Search addon for Ctrl+F overlay
- Custom scrollbar styling via xterm options

### Animations & Transitions
- All transitions: 200ms ease-out
- Stage status changes: fade + scale micro-animation
- Panel expand/collapse: smooth height via Shoelace
- Connection indicator: improved pulse animation

## Shoelace Theme Integration

Map existing CSS custom properties to Shoelace's token system:

```css
:root {
  /* Map worca tokens → Shoelace tokens */
  --sl-color-primary-600: var(--accent);
  --sl-color-success-600: var(--status-completed);
  --sl-color-warning-600: var(--status-in-progress);
  --sl-color-danger-600: var(--status-error);
  --sl-color-neutral-600: var(--status-pending);
  --sl-border-radius-medium: var(--radius);
  --sl-border-radius-large: var(--radius-lg);
  --sl-font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --sl-font-mono: 'JetBrains Mono', 'SF Mono', monospace;
  --sl-shadow-small: var(--shadow-sm);
  --sl-shadow-medium: var(--shadow-md);
}

[data-theme="dark"] {
  /* Dark overrides cascade naturally */
}
```

## xterm.js Log Viewer Architecture

New file: `app/views/log-terminal.js`

```
                    ┌─────────────────────────────┐
                    │ <sl-select> Stage Filter     │
                    ├─────────────────────────────┤
                    │                             │
                    │   xterm.js Terminal          │
                    │   (canvas rendering)         │
                    │                             │
                    │   Ctrl+F → search addon     │
                    │                             │
                    └─────────────────────────────┘
```

- Terminal created once per run subscription
- Log lines written via `terminal.writeln()` with ANSI escape codes for colorized stage tags
- Each stage gets a unique ANSI color (mapped from a palette of 8 distinct colors)
- `addon-fit` handles container resize
- `addon-search` provides native search overlay
- Auto-scroll: always follows bottom unless user scrolls up (native xterm behavior)
- Clear terminal on run change

## File Changes

| File | Type | Description |
|------|------|-------------|
| `app/index.html` | Edit | Add Inter font CDN link, Shoelace base CSS |
| `app/styles.css` | Rewrite | Remove styles replaced by Shoelace, add theme mapping, modernize remaining custom styles |
| `app/views/sidebar.js` | Edit | Lucide icons, `<sl-badge>`, `<sl-icon-button>` theme toggle |
| `app/views/stage-timeline.js` | Edit | Lucide icons, CSS class updates for larger nodes |
| `app/views/run-detail.js` | Edit | `<sl-details>` stage panels, `<sl-badge>` status, Lucide icons |
| `app/views/log-viewer.js` | Rewrite | Replace with xterm.js terminal wrapper |
| `app/views/run-list.js` | Edit | Lucide icons, improved card styling |
| `app/views/dashboard.js` | Edit | Stat card visual refresh |
| `app/utils/status-badge.js` | Edit | Return Lucide SVG icons instead of Unicode |
| `app/main.js` | Edit | Import Shoelace component registrations, xterm lifecycle |
| `scripts/build-frontend.js` | Edit | Handle Shoelace asset copying if needed |
| `package.json` | Edit | Add new dependencies |

## What Does NOT Change

- `app/state.js` — Reactive store (no changes)
- `app/ws.js` — WebSocket client (no changes)
- `app/router.js` — Hash routing (no changes)
- `app/protocol.js` — Message types (no changes)
- `server/*` — Entire backend (no changes)
- `bin/worca-ui.js` — CLI (no changes)

## Testing

### Existing Tests
All existing unit tests must continue passing. The state, router, protocol, ws, and server modules are untouched.

### Updated Tests
- `utils/status-badge.test.js` — Verify Lucide icon output format
- View snapshot tests — Update expected output for Shoelace elements

### New E2E Tests (Playwright MCP)
- Verify Shoelace components render and are interactive
- Verify xterm.js terminal shows log lines
- Verify theme switching applies to both custom CSS and Shoelace tokens
- Verify search in terminal works
- Verify stage filter dropdown works

## Implementation Order

1. **Install dependencies** — `npm install` new packages
2. **Setup Shoelace** — Import registrations, add theme CSS mapping
3. **Replace icons** — Lucide SVGs in status-badge.js
4. **Modernize sidebar** — Lucide icons, `<sl-badge>`, `<sl-icon-button>`
5. **Modernize stage timeline** — Larger nodes, gradient animations, Lucide icons
6. **Modernize run detail** — `<sl-details>`, `<sl-badge>`, better layout
7. **Replace log viewer** — xterm.js terminal with search/fit addons
8. **CSS overhaul** — Typography, spacing, shadows, card design, theme tokens
9. **Update build** — Ensure esbuild bundles everything correctly
10. **Run tests** — All existing + new E2E
