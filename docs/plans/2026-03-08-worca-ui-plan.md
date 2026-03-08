# worca-ui Implementation Plan

> **For pipeline agents:** Follow your agent role instructions. Do not invoke skills.

**Goal:** Build a pipeline monitoring UI for worca-cc with vertical sidebar navigation, real-time status updates via WebSocket, and log streaming.

**Architecture:** Express + WebSocket server watches `.worca/status.json` and log files, pushes updates to a lit-html SPA. File watcher pattern from beads-ui, adapted for pipeline domain. Generic stage system derived from data, not hardcoded.

**Tech Stack:** lit-html, Express, ws, esbuild, Vitest, vanilla JS (ES2022, JSDoc types)

**Design doc:** `docs/plans/2026-03-08-worca-ui-design.md`

**Reference codebase:** `/Volumes/Apps/dev/ccexperiments/beads-ui/` (architecture patterns only, no code copying)

---

### Task 1: Project Scaffolding

**Files:**
- Create: `.claude/worca-ui/package.json`
- Create: `.claude/worca-ui/.gitignore`

**Step 1: Create package.json**

```json
{
  "name": "worca-ui",
  "version": "0.1.0",
  "description": "Pipeline monitoring UI for worca-cc",
  "type": "module",
  "bin": {
    "worca-ui": "./bin/worca-ui.js"
  },
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "start": "node server/index.js --debug",
    "build": "node scripts/build-frontend.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "express": "^5.2.1",
    "lit-html": "^3.3.1",
    "marked": "^17.0.1",
    "ws": "^8.18.3"
  },
  "devDependencies": {
    "esbuild": "^0.27.1",
    "vitest": "^4.0.15"
  }
}
```

**Step 2: Create .gitignore**

```
node_modules/
app/main.bundle.js
app/main.bundle.js.map
```

**Step 3: Install dependencies**

Run: `cd .claude/worca-ui && npm install`
Expected: `node_modules/` created, no errors

**Step 4: Commit**

```bash
git add .claude/worca-ui/package.json .claude/worca-ui/.gitignore .claude/worca-ui/package-lock.json
git commit -m "scaffold: worca-ui project with dependencies"
```

---

### Task 2: Protocol Module (shared between client and server)

**Files:**
- Create: `.claude/worca-ui/app/protocol.js`
- Test: `.claude/worca-ui/app/protocol.test.js`

**Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest';
import {
  MESSAGE_TYPES, nextId, makeRequest, makeOk, makeError,
  isMessageType, isRequest, decodeRequest
} from './protocol.js';

describe('protocol', () => {
  it('nextId returns unique sortable strings', () => {
    const a = nextId();
    const b = nextId();
    expect(typeof a).toBe('string');
    expect(a).not.toBe(b);
  });

  it('makeRequest creates valid envelope', () => {
    const req = makeRequest('list-runs', { filter: 'active' });
    expect(req.type).toBe('list-runs');
    expect(req.payload).toEqual({ filter: 'active' });
    expect(typeof req.id).toBe('string');
  });

  it('makeOk creates success reply', () => {
    const req = makeRequest('list-runs');
    const reply = makeOk(req, { runs: [] });
    expect(reply.ok).toBe(true);
    expect(reply.id).toBe(req.id);
    expect(reply.payload).toEqual({ runs: [] });
  });

  it('makeError creates error reply', () => {
    const req = makeRequest('list-runs');
    const reply = makeError(req, 'NOT_FOUND', 'Run not found');
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('NOT_FOUND');
  });

  it('isMessageType validates known types', () => {
    expect(isMessageType('list-runs')).toBe(true);
    expect(isMessageType('bogus')).toBe(false);
  });

  it('isRequest validates envelope shape', () => {
    expect(isRequest({ id: '1', type: 'list-runs' })).toBe(true);
    expect(isRequest({ id: '1' })).toBe(false);
    expect(isRequest(null)).toBe(false);
  });

  it('decodeRequest throws on invalid input', () => {
    expect(() => decodeRequest({})).toThrow();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd .claude/worca-ui && npx vitest run app/protocol.test.js`
Expected: FAIL — module not found

**Step 3: Write protocol.js**

Define the worca-ui message types:

```js
/**
 * Protocol definitions for worca-ui WebSocket communication.
 */

/** @typedef {'subscribe-run'|'unsubscribe-run'|'subscribe-log'|'unsubscribe-log'|'list-runs'|'get-preferences'|'set-preferences'|'run-snapshot'|'run-update'|'runs-list'|'log-line'|'log-bulk'|'preferences'} MessageType */

/** @type {MessageType[]} */
export const MESSAGE_TYPES = [
  'subscribe-run', 'unsubscribe-run',
  'subscribe-log', 'unsubscribe-log',
  'list-runs',
  'get-preferences', 'set-preferences',
  // Server → Client events
  'run-snapshot', 'run-update', 'runs-list',
  'log-line', 'log-bulk',
  'preferences'
];

export function nextId() {
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${now}-${rand}`;
}

export function makeRequest(type, payload, id = nextId()) {
  return { id, type, payload };
}

export function makeOk(req, payload) {
  return { id: req.id, ok: true, type: req.type, payload };
}

export function makeError(req, code, message, details) {
  return { id: req.id, ok: false, type: req.type, error: { code, message, details } };
}

export function isMessageType(value) {
  return typeof value === 'string' && MESSAGE_TYPES.includes(value);
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isRequest(value) {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && typeof value.type === 'string';
}

export function decodeRequest(json) {
  if (!isRequest(json)) throw new Error('Invalid request envelope');
  return json;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd .claude/worca-ui && npx vitest run app/protocol.test.js`
Expected: All 7 tests PASS

**Step 5: Commit**

```bash
git add .claude/worca-ui/app/protocol.js .claude/worca-ui/app/protocol.test.js
git commit -m "feat: protocol module with message types and envelope helpers"
```

---

### Task 3: Client State Store

**Files:**
- Create: `.claude/worca-ui/app/state.js`
- Test: `.claude/worca-ui/app/state.test.js`

**Step 1: Write the failing tests**

```js
import { describe, it, expect, vi } from 'vitest';
import { createStore } from './state.js';

describe('state store', () => {
  it('initializes with defaults', () => {
    const store = createStore();
    const s = store.getState();
    expect(s.activeRunId).toBe(null);
    expect(s.runs).toEqual({});
    expect(s.logLines).toEqual([]);
    expect(s.preferences).toEqual({ theme: 'light', sidebarCollapsed: false });
  });

  it('accepts initial overrides', () => {
    const store = createStore({ preferences: { theme: 'dark', sidebarCollapsed: true } });
    expect(store.getState().preferences.theme).toBe('dark');
  });

  it('setState merges shallowly', () => {
    const store = createStore();
    store.setState({ activeRunId: 'run-1' });
    expect(store.getState().activeRunId).toBe('run-1');
    expect(store.getState().runs).toEqual({});
  });

  it('setState merges preferences deeply', () => {
    const store = createStore();
    store.setState({ preferences: { theme: 'dark' } });
    expect(store.getState().preferences.theme).toBe('dark');
    expect(store.getState().preferences.sidebarCollapsed).toBe(false);
  });

  it('notifies subscribers on change', () => {
    const store = createStore();
    const fn = vi.fn();
    store.subscribe(fn);
    store.setState({ activeRunId: 'run-1' });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('does not notify if state unchanged', () => {
    const store = createStore();
    const fn = vi.fn();
    store.subscribe(fn);
    store.setState({ activeRunId: null });
    expect(fn).not.toHaveBeenCalled();
  });

  it('unsubscribe stops notifications', () => {
    const store = createStore();
    const fn = vi.fn();
    const unsub = store.subscribe(fn);
    unsub();
    store.setState({ activeRunId: 'run-1' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('setRun adds/updates a run in the runs map', () => {
    const store = createStore();
    store.setRun('run-1', { stage: 'plan', stages: {} });
    expect(store.getState().runs['run-1'].stage).toBe('plan');
  });

  it('appendLog adds lines and caps at limit', () => {
    const store = createStore();
    for (let i = 0; i < 10; i++) {
      store.appendLog({ line: `line-${i}`, stage: 'plan' });
    }
    expect(store.getState().logLines.length).toBe(10);
  });

  it('clearLog empties logLines', () => {
    const store = createStore();
    store.appendLog({ line: 'hello', stage: 'plan' });
    store.clearLog();
    expect(store.getState().logLines).toEqual([]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd .claude/worca-ui && npx vitest run app/state.test.js`
Expected: FAIL — module not found

**Step 3: Write state.js**

```js
/**
 * Reactive state store for worca-ui.
 */

const LOG_CAP = 5000;

export function createStore(initial = {}) {
  let state = {
    activeRunId: initial.activeRunId ?? null,
    runs: initial.runs ?? {},
    logLines: initial.logLines ?? [],
    preferences: {
      theme: initial.preferences?.theme ?? 'light',
      sidebarCollapsed: initial.preferences?.sidebarCollapsed ?? false
    }
  };

  const subs = new Set();

  function emit() {
    for (const fn of Array.from(subs)) {
      try { fn(state); } catch { /* ignore */ }
    }
  }

  return {
    getState() { return state; },

    setState(patch) {
      const next = {
        ...state,
        ...patch,
        preferences: { ...state.preferences, ...(patch.preferences || {}) }
      };
      if (
        next.activeRunId === state.activeRunId &&
        next.runs === state.runs &&
        next.logLines === state.logLines &&
        next.preferences.theme === state.preferences.theme &&
        next.preferences.sidebarCollapsed === state.preferences.sidebarCollapsed
      ) return;
      state = next;
      emit();
    },

    setRun(runId, data) {
      const runs = { ...state.runs, [runId]: data };
      state = { ...state, runs };
      emit();
    },

    appendLog(entry) {
      const logLines = [...state.logLines, entry];
      if (logLines.length > LOG_CAP) logLines.splice(0, logLines.length - LOG_CAP);
      state = { ...state, logLines };
      emit();
    },

    clearLog() {
      state = { ...state, logLines: [] };
      emit();
    },

    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    }
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `cd .claude/worca-ui && npx vitest run app/state.test.js`
Expected: All 10 tests PASS

**Step 5: Commit**

```bash
git add .claude/worca-ui/app/state.js .claude/worca-ui/app/state.test.js
git commit -m "feat: reactive state store with runs, log, and preferences"
```

---

### Task 4: Utility Modules

**Files:**
- Create: `.claude/worca-ui/app/utils/logging.js`
- Create: `.claude/worca-ui/app/utils/duration.js`
- Create: `.claude/worca-ui/app/utils/status-badge.js`
- Create: `.claude/worca-ui/app/utils/theme.js`
- Test: `.claude/worca-ui/app/utils/duration.test.js`
- Test: `.claude/worca-ui/app/utils/status-badge.test.js`

**Step 1: Write failing tests for duration.js**

```js
import { describe, it, expect } from 'vitest';
import { formatDuration, elapsed } from './duration.js';

describe('formatDuration', () => {
  it('formats seconds', () => {
    expect(formatDuration(45000)).toBe('45s');
  });
  it('formats minutes and seconds', () => {
    expect(formatDuration(125000)).toBe('2m 5s');
  });
  it('formats hours', () => {
    expect(formatDuration(3661000)).toBe('1h 1m 1s');
  });
  it('handles zero', () => {
    expect(formatDuration(0)).toBe('0s');
  });
});

describe('elapsed', () => {
  it('computes ms between two ISO strings', () => {
    const start = '2026-03-08T10:00:00Z';
    const end = '2026-03-08T10:01:30Z';
    expect(elapsed(start, end)).toBe(90000);
  });
  it('uses now if end is null', () => {
    const start = new Date(Date.now() - 5000).toISOString();
    const ms = elapsed(start, null);
    expect(ms).toBeGreaterThanOrEqual(4900);
    expect(ms).toBeLessThan(6000);
  });
});
```

**Step 2: Write failing tests for status-badge.js**

```js
import { describe, it, expect } from 'vitest';
import { statusClass, statusIcon } from './status-badge.js';

describe('status-badge', () => {
  it('maps pending to correct class', () => {
    expect(statusClass('pending')).toBe('status-pending');
  });
  it('maps in_progress', () => {
    expect(statusClass('in_progress')).toBe('status-in-progress');
  });
  it('maps completed', () => {
    expect(statusClass('completed')).toBe('status-completed');
  });
  it('maps error', () => {
    expect(statusClass('error')).toBe('status-error');
  });
  it('returns fallback for unknown', () => {
    expect(statusClass('whatever')).toBe('status-unknown');
  });
  it('statusIcon returns correct symbols', () => {
    expect(statusIcon('completed')).toBe('\u2713');
    expect(statusIcon('error')).toBe('\u2717');
    expect(statusIcon('pending')).toBe('\u25CB');
  });
});
```

**Step 3: Run tests to verify they fail**

Run: `cd .claude/worca-ui && npx vitest run app/utils/`
Expected: FAIL — modules not found

**Step 4: Implement all utility modules**

`logging.js`:
```js
export function debug(namespace) {
  const prefix = `worca-ui:${namespace}`;
  const enabled = typeof localStorage !== 'undefined'
    && (localStorage.getItem('debug') || '').includes('worca-ui');
  return (...args) => {
    if (enabled) console.log(prefix, ...args);
  };
}
```

`duration.js`:
```js
export function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function elapsed(startIso, endIso) {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  return end - start;
}
```

`status-badge.js`:
```js
const CLASS_MAP = {
  pending: 'status-pending',
  in_progress: 'status-in-progress',
  completed: 'status-completed',
  error: 'status-error'
};

const ICON_MAP = {
  pending: '\u25CB',
  in_progress: '\u25CF',
  completed: '\u2713',
  error: '\u2717'
};

export function statusClass(status) {
  return CLASS_MAP[status] || 'status-unknown';
}

export function statusIcon(status) {
  return ICON_MAP[status] || '?';
}
```

`theme.js`:
```js
export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

export function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
```

**Step 5: Run tests to verify they pass**

Run: `cd .claude/worca-ui && npx vitest run app/utils/`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add .claude/worca-ui/app/utils/
git commit -m "feat: utility modules — logging, duration, status badges, theme"
```

---

### Task 5: Server — Settings Reader & Preferences

**Files:**
- Create: `.claude/worca-ui/server/settings-reader.js`
- Create: `.claude/worca-ui/server/preferences.js`
- Test: `.claude/worca-ui/server/settings-reader.test.js`
- Test: `.claude/worca-ui/server/preferences.test.js`

**Step 1: Write failing tests for settings-reader**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readSettings } from './settings-reader.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('settings-reader', () => {
  let dir;
  beforeEach(() => {
    dir = join(tmpdir(), `worca-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads agent config from settings.json', () => {
    const settings = {
      worca: {
        agents: { planner: { model: 'opus', max_turns: 40 } },
        loops: { implement_test: 10 }
      }
    };
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
    const result = readSettings(join(dir, 'settings.json'));
    expect(result.agents.planner.model).toBe('opus');
    expect(result.loops.implement_test).toBe(10);
  });

  it('returns defaults for missing file', () => {
    const result = readSettings(join(dir, 'missing.json'));
    expect(result.agents).toEqual({});
    expect(result.loops).toEqual({});
    expect(result.milestones).toEqual({});
    expect(result.stageUi).toEqual({});
  });

  it('reads optional UI stage config', () => {
    const settings = {
      worca: {
        ui: { stages: { deploy: { label: 'Deploy', icon: 'rocket' } } }
      }
    };
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
    const result = readSettings(join(dir, 'settings.json'));
    expect(result.stageUi.deploy.label).toBe('Deploy');
  });
});
```

**Step 2: Write failing tests for preferences**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readPreferences, writePreferences } from './preferences.js';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('preferences', () => {
  let dir;
  beforeEach(() => {
    dir = join(tmpdir(), `worca-prefs-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns defaults when file missing', () => {
    const prefs = readPreferences(join(dir, 'preferences.json'));
    expect(prefs.theme).toBe('light');
  });

  it('writes and reads back', () => {
    const path = join(dir, 'preferences.json');
    writePreferences({ theme: 'dark' }, path);
    const prefs = readPreferences(path);
    expect(prefs.theme).toBe('dark');
  });

  it('creates parent directory if needed', () => {
    const path = join(dir, 'sub', 'dir', 'preferences.json');
    writePreferences({ theme: 'dark' }, path);
    const prefs = readPreferences(path);
    expect(prefs.theme).toBe('dark');
  });
});
```

**Step 3: Run tests to verify they fail**

Run: `cd .claude/worca-ui && npx vitest run server/settings-reader.test.js server/preferences.test.js`
Expected: FAIL

**Step 4: Implement settings-reader.js**

```js
import { readFileSync } from 'node:fs';

export function readSettings(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const worca = raw.worca || {};
    return {
      agents: worca.agents || {},
      loops: worca.loops || {},
      milestones: worca.milestones || {},
      stageUi: worca.ui?.stages || {}
    };
  } catch {
    return { agents: {}, loops: {}, milestones: {}, stageUi: {} };
  }
}
```

**Step 5: Implement preferences.js**

```js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULTS = { theme: 'light' };

export function readPreferences(path) {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writePreferences(prefs, path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(prefs, null, 2) + '\n');
}
```

**Step 6: Run tests to verify they pass**

Run: `cd .claude/worca-ui && npx vitest run server/settings-reader.test.js server/preferences.test.js`
Expected: All PASS

**Step 7: Commit**

```bash
git add .claude/worca-ui/server/settings-reader.js .claude/worca-ui/server/preferences.js
git add .claude/worca-ui/server/settings-reader.test.js .claude/worca-ui/server/preferences.test.js
git commit -m "feat: settings reader and preferences persistence"
```

---

### Task 6: Server — File Watcher & Run Discovery

**Files:**
- Create: `.claude/worca-ui/server/watcher.js`
- Test: `.claude/worca-ui/server/watcher.test.js`

**Step 1: Write failing tests**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { discoverRuns, createRunId } from './watcher.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('watcher', () => {
  let dir;
  beforeEach(() => {
    dir = join(tmpdir(), `worca-watch-${Date.now()}`);
    mkdirSync(join(dir, 'results'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('createRunId generates deterministic ID from status', () => {
    const status = { started_at: '2026-03-08T10:00:00Z', work_request: { title: 'test' } };
    const id = createRunId(status);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(createRunId(status)).toBe(id);
  });

  it('discoverRuns finds active run from status.json', () => {
    const status = {
      started_at: '2026-03-08T10:00:00Z',
      stage: 'implement',
      work_request: { title: 'test' },
      stages: { plan: { status: 'completed' }, implement: { status: 'in_progress' } }
    };
    writeFileSync(join(dir, 'status.json'), JSON.stringify(status));
    const runs = discoverRuns(dir);
    expect(runs.length).toBe(1);
    expect(runs[0].stage).toBe('implement');
    expect(runs[0].active).toBe(true);
  });

  it('discoverRuns finds completed runs from results/', () => {
    const result = {
      started_at: '2026-03-07T09:00:00Z',
      stage: 'pr',
      work_request: { title: 'old run' },
      stages: { plan: { status: 'completed' }, pr: { status: 'completed' } }
    };
    writeFileSync(join(dir, 'results', 'abc123.json'), JSON.stringify(result));
    const runs = discoverRuns(dir);
    expect(runs.length).toBe(1);
    expect(runs[0].active).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd .claude/worca-ui && npx vitest run server/watcher.test.js`
Expected: FAIL

**Step 3: Implement watcher.js**

```js
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export function createRunId(status) {
  const key = `${status.started_at}:${status.work_request?.title || ''}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function isTerminal(status) {
  if (!status.stages) return false;
  const values = Object.values(status.stages);
  return values.length > 0 && values.every(s =>
    s.status === 'completed' || s.status === 'error'
  );
}

export function discoverRuns(worcaDir) {
  const runs = [];

  const statusPath = join(worcaDir, 'status.json');
  if (existsSync(statusPath)) {
    try {
      const status = JSON.parse(readFileSync(statusPath, 'utf8'));
      runs.push({ id: createRunId(status), active: !isTerminal(status), ...status });
    } catch { /* ignore malformed */ }
  }

  const resultsDir = join(worcaDir, 'results');
  if (existsSync(resultsDir)) {
    for (const file of readdirSync(resultsDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(readFileSync(join(resultsDir, file), 'utf8'));
        if (data.started_at) {
          runs.push({ id: createRunId(data), active: false, ...data });
        }
      } catch { /* ignore */ }
    }
  }

  return runs;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd .claude/worca-ui && npx vitest run server/watcher.test.js`
Expected: All PASS

**Step 5: Commit**

```bash
git add .claude/worca-ui/server/watcher.js .claude/worca-ui/server/watcher.test.js
git commit -m "feat: run discovery from .worca/ directory"
```

---

### Task 7: Server — Log Tailer

**Files:**
- Create: `.claude/worca-ui/server/log-tailer.js`
- Test: `.claude/worca-ui/server/log-tailer.test.js`

**Step 1: Write failing tests**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readLastLines, resolveLogPath } from './log-tailer.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('log-tailer', () => {
  let dir;
  beforeEach(() => {
    dir = join(tmpdir(), `worca-log-${Date.now()}`);
    mkdirSync(join(dir, 'logs'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('readLastLines returns last N lines', () => {
    const path = join(dir, 'logs', 'orchestrator.log');
    writeFileSync(path, 'line1\nline2\nline3\nline4\nline5\n');
    const lines = readLastLines(path, 3);
    expect(lines).toEqual(['line3', 'line4', 'line5']);
  });

  it('readLastLines returns all lines if fewer than N', () => {
    const path = join(dir, 'logs', 'test.log');
    writeFileSync(path, 'only\n');
    const lines = readLastLines(path, 100);
    expect(lines).toEqual(['only']);
  });

  it('readLastLines returns empty array for missing file', () => {
    const lines = readLastLines(join(dir, 'nope.log'), 10);
    expect(lines).toEqual([]);
  });

  it('resolveLogPath returns stage log path', () => {
    const path = resolveLogPath(dir, 'plan');
    expect(path).toBe(join(dir, 'logs', 'plan.log'));
  });

  it('resolveLogPath returns orchestrator log for null stage', () => {
    const path = resolveLogPath(dir, null);
    expect(path).toBe(join(dir, 'logs', 'orchestrator.log'));
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd .claude/worca-ui && npx vitest run server/log-tailer.test.js`

**Step 3: Implement log-tailer.js**

```js
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function resolveLogPath(worcaDir, stage) {
  if (!stage) return join(worcaDir, 'logs', 'orchestrator.log');
  return join(worcaDir, 'logs', `${stage}.log`);
}

export function readLastLines(filePath, n) {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd .claude/worca-ui && npx vitest run server/log-tailer.test.js`
Expected: All PASS

**Step 5: Commit**

```bash
git add .claude/worca-ui/server/log-tailer.js .claude/worca-ui/server/log-tailer.test.js
git commit -m "feat: log tailer primitives — readLastLines and path resolution"
```

---

### Task 8: Server — Express App & Static Serving

**Files:**
- Create: `.claude/worca-ui/server/app.js`
- Create: `.claude/worca-ui/server/index.js`
- Create: `.claude/worca-ui/app/index.html`

**Step 1: Create the Express app factory**

```js
// server/app.js
import express from 'express';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

export function createApp() {
  const app = express();
  const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
  app.use(express.static(appDir));
  app.get('*', (req, res) => {
    res.sendFile(join(appDir, 'index.html'));
  });
  return app;
}
```

**Step 2: Create the server entry point**

```js
// server/index.js
import { createServer } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createApp } from './app.js';
import { attachWsServer } from './ws.js';

// Parse argv
let port = 3400;
let host = '127.0.0.1';
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--port' && process.argv[i + 1]) port = parseInt(process.argv[++i], 10);
  if (process.argv[i] === '--host' && process.argv[i + 1]) host = process.argv[++i];
}

const cwd = process.cwd();
const app = createApp();
const server = createServer(app);

attachWsServer(server, {
  worcaDir: join(cwd, '.worca'),
  settingsPath: join(cwd, '.claude', 'settings.json'),
  prefsPath: join(homedir(), '.worca', 'preferences.json')
});

server.listen(port, host, () => {
  console.log(`worca-ui running at http://${host}:${port}`);
});
```

**Step 3: Create minimal index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>worca-ui</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/main.bundle.js" onerror="
    var s=document.createElement('script');
    s.type='module';s.src='/main.js';
    document.body.appendChild(s);
  "></script>
</body>
</html>
```

**Step 4: Test manually**

Run: `cd /Volumes/Apps/dev/ccexperiments/worca-cc && node .claude/worca-ui/server/index.js`
Expected: `worca-ui running at http://127.0.0.1:3400`. Ctrl+C to stop.

**Step 5: Commit**

```bash
git add .claude/worca-ui/server/app.js .claude/worca-ui/server/index.js .claude/worca-ui/app/index.html
git commit -m "feat: Express server with static file serving"
```

---

### Task 9: Server — WebSocket Handler

**Files:**
- Create: `.claude/worca-ui/server/ws.js`

This is the largest server module. It handles client connections, message routing, file watcher integration, and log tailing.

**Step 1: Write ws.js**

Implement the WebSocket server with:
- Connection management with heartbeat
- Message routing for all protocol message types
- `list-runs` → calls `discoverRuns()`, returns runs + settings
- `subscribe-run` / `unsubscribe-run` → per-client subscription tracking
- `subscribe-log` / `unsubscribe-log` → starts/stops log file tailing
- `get-preferences` / `set-preferences` → reads/writes `~/.worca/preferences.json`
- `fs.watch` on `.worca/` directory → pushes `run-snapshot` to subscribed clients on status.json change
- `fs.watch` on log files → pushes `log-line` events to log subscribers
- Debounced refresh (75ms) to coalesce rapid file changes

Reference the beads-ui WebSocket server pattern at `/Volumes/Apps/dev/ccexperiments/beads-ui/server/ws.js` for connection management, heartbeat, and subscription tracking patterns.

Key difference from beads-ui: uses `fs.watch` on `.worca/status.json` instead of database file, and adds log file tailing.

**Step 2: Test manually**

Run: `cd /Volumes/Apps/dev/ccexperiments/worca-cc && node .claude/worca-ui/server/index.js`
Use a WebSocket client to send `{"id":"1","type":"list-runs"}` and verify response.

**Step 3: Commit**

```bash
git add .claude/worca-ui/server/ws.js
git commit -m "feat: WebSocket server with run subscriptions, log streaming, preferences"
```

---

### Task 10: Client — WebSocket Client

**Files:**
- Create: `.claude/worca-ui/app/ws.js`

**Step 1: Write ws.js**

Follow the same pattern as beads-ui's `app/ws.js` — persistent connection, auto-reconnect with exponential backoff, request/response correlation by ID, event dispatching, queue during disconnect.

Reference: `/Volumes/Apps/dev/ccexperiments/beads-ui/app/ws.js`

Changes from beads-ui:
- Import from local `./protocol.js` (worca-ui message types)
- Same API: `.send(type, payload)`, `.on(type, handler)`, `.onConnection(handler)`, `.close()`, `.getState()`

**Step 2: Commit**

```bash
git add .claude/worca-ui/app/ws.js
git commit -m "feat: WebSocket client with auto-reconnect and message correlation"
```

---

### Task 11: Client — Router

**Files:**
- Create: `.claude/worca-ui/app/router.js`
- Test: `.claude/worca-ui/app/router.test.js`

**Step 1: Write failing tests**

```js
import { describe, it, expect } from 'vitest';
import { parseHash, buildHash } from './router.js';

describe('router', () => {
  it('parseHash extracts section and runId', () => {
    expect(parseHash('#/active')).toEqual({ section: 'active', runId: null });
    expect(parseHash('#/active?run=abc')).toEqual({ section: 'active', runId: 'abc' });
    expect(parseHash('#/history')).toEqual({ section: 'history', runId: null });
    expect(parseHash('')).toEqual({ section: 'active', runId: null });
  });

  it('buildHash creates hash string', () => {
    expect(buildHash('active', null)).toBe('#/active');
    expect(buildHash('active', 'run-1')).toBe('#/active?run=run-1');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd .claude/worca-ui && npx vitest run app/router.test.js`

**Step 3: Implement router.js**

```js
export function parseHash(hash) {
  const clean = (hash || '').replace(/^#\/?/, '');
  const [path, query] = clean.split('?');
  const section = path || 'active';
  const params = new URLSearchParams(query || '');
  return { section, runId: params.get('run') || null };
}

export function buildHash(section, runId) {
  const base = `#/${section}`;
  return runId ? `${base}?run=${runId}` : base;
}

export function onHashChange(callback) {
  const handler = () => callback(parseHash(location.hash));
  window.addEventListener('hashchange', handler);
  return () => window.removeEventListener('hashchange', handler);
}

export function navigate(section, runId) {
  location.hash = buildHash(section, runId);
}
```

**Step 4: Run tests to verify they pass**

**Step 5: Commit**

```bash
git add .claude/worca-ui/app/router.js .claude/worca-ui/app/router.test.js
git commit -m "feat: hash-based router with section and runId"
```

---

### Task 12: CSS Stylesheet

**Files:**
- Create: `.claude/worca-ui/app/styles.css`

**Step 1: Write complete stylesheet**

This is the full CSS file. Key sections:

**CSS variables** for light/dark themes using `[data-theme="dark"]`:
```css
:root {
  --sidebar-width: 240px;
  --fg: #1a1a2e;
  --bg: #ffffff;
  --bg-secondary: #f8f9fa;
  --border: #e2e8f0;
  --muted: #64748b;
  --accent: #6366f1;
  --accent-hover: #4f46e5;
  --status-pending: #94a3b8;
  --status-in-progress: #f59e0b;
  --status-completed: #22c55e;
  --status-error: #ef4444;
  --log-bg: #0f172a;
  --log-fg: #e2e8f0;
}

[data-theme="dark"] {
  --fg: #e2e8f0;
  --bg: #0f172a;
  --bg-secondary: #1e293b;
  --border: #334155;
  --muted: #94a3b8;
}
```

**Component classes:** `.app-shell` (flex row), `.sidebar` (fixed width, flex column), `.main-content` (flex 1), `.sidebar-section`, `.sidebar-item`, `.run-header`, `.stage-timeline`, `.stage-node`, `.stage-connector`, `.stage-detail`, `.stage-panel`, `.log-viewer`, `.log-line`, `.status-badge` variants, `.theme-toggle`, `.connection-indicator`, `.run-list`, `.run-list-item`, `.dashboard`, `.stat-card`, `.empty-state`, `.badge`.

Apply the `@superpowers:frontend-design` skill aesthetic sense — clean spacing, subtle shadows, smooth transitions.

**Step 2: Commit**

```bash
git add .claude/worca-ui/app/styles.css
git commit -m "feat: complete stylesheet with light/dark themes and all components"
```

---

### Task 13: Client — Sidebar View

**Files:**
- Create: `.claude/worca-ui/app/views/sidebar.js`

**Step 1: Write sidebar.js**

lit-html template rendering:
- Logo/title ("WORCA") at top
- Expandable "Pipeline" section with Active, History items
- Count badges from state
- Active item highlighting from route
- Connection status indicator (green/red/yellow dot)
- Theme toggle at bottom

Reference the design doc layout section for exact structure.

**Step 2: Commit**

```bash
git add .claude/worca-ui/app/views/sidebar.js
git commit -m "feat: sidebar view with navigation, counts, connection status"
```

---

### Task 14: Client — Stage Timeline View

**Files:**
- Create: `.claude/worca-ui/app/views/stage-timeline.js`

**Step 1: Write stage-timeline.js**

Renders horizontal pipeline progress:
- Stage nodes with icons from `statusIcon()` and labels
- Connector lines between nodes
- Pulse animation for in_progress stage
- Loop indicators for stages with `iteration > 1`
- Milestone markers from `worca.milestones`
- Labels from `settings.stageUi[name].label` or title-cased from key
- All stages derived from `status.json` data — NO hardcoded stage names

**Step 2: Commit**

```bash
git add .claude/worca-ui/app/views/stage-timeline.js
git commit -m "feat: stage timeline view — generic, data-driven stages"
```

---

### Task 15: Client — Run Detail View

**Files:**
- Create: `.claude/worca-ui/app/views/run-detail.js`

**Step 1: Write run-detail.js**

Full run detail rendering:
- Header: work request title, status badge, branch, duration, PR link
- Stage timeline (from Task 14)
- Expandable `<details>` panels per stage showing: status, timestamps, duration, agent+model, iterations, task progress
- Empty state when no run selected
- Stage-to-agent mapping uses settings.json `worca.agents` keys

**Step 2: Commit**

```bash
git add .claude/worca-ui/app/views/run-detail.js
git commit -m "feat: run detail view with header, timeline, and stage panels"
```

---

### Task 16: Client — Log Viewer View

**Files:**
- Create: `.claude/worca-ui/app/views/log-viewer.js`

**Step 1: Write log-viewer.js**

Bottom log panel:
- Stage filter dropdown (All + one per stage from data)
- Monospace log lines
- Auto-scroll with pause/resume button
- Search input for client-side filtering

**Step 2: Commit**

```bash
git add .claude/worca-ui/app/views/log-viewer.js
git commit -m "feat: log viewer with stage filter, search, and auto-scroll"
```

---

### Task 17: Client — Run List & Dashboard Views

**Files:**
- Create: `.claude/worca-ui/app/views/run-list.js`
- Create: `.claude/worca-ui/app/views/dashboard.js`

**Step 1: Write run-list.js** — list of runs filtered by active/history, click to select

**Step 2: Write dashboard.js** — landing page with summary counts and active runs

**Step 3: Commit**

```bash
git add .claude/worca-ui/app/views/run-list.js .claude/worca-ui/app/views/dashboard.js
git commit -m "feat: run list and dashboard views"
```

---

### Task 18: Client — Main App Shell

**Files:**
- Create: `.claude/worca-ui/app/main.js`

**Step 1: Write main.js**

Bootstraps the SPA:
- Creates state store, WebSocket client
- Sets up router (hash-based)
- Wires WS events to state updates (runs-list, run-snapshot, log-line, log-bulk, preferences)
- On connection open: sends `list-runs` and `get-preferences`
- On route change: subscribes to selected run and its logs
- Renders sidebar + main content on every state/route change using `lit-html render()`
- Theme toggle sends `set-preferences` via WS
- Auto-scroll logic for log viewer

**Step 2: Commit**

```bash
git add .claude/worca-ui/app/main.js
git commit -m "feat: main app shell — wires state, WS, router, and all views"
```

---

### Task 19: CLI — worca-ui command

**Files:**
- Create: `.claude/worca-ui/bin/worca-ui.js`

**Step 1: Write worca-ui.js**

`#!/usr/bin/env node` CLI with commands: `start`, `stop`, `restart`, `status`

- PID file at `~/.worca/worca-ui.pid` (JSON: `{ pid, port, host, started_at }`)
- `start` — uses `spawn(detached)` to launch server, writes PID file
- `stop` — reads PID, sends SIGTERM, removes PID file
- `restart` — stop then start
- `status` — reads PID, checks `process.kill(pid, 0)`
- `--open` flag uses `spawn('open', [url])` (not `exec`) for safe URL opening
- `--port`, `--host` options

**Step 2: Make executable**

Run: `chmod +x .claude/worca-ui/bin/worca-ui.js`

**Step 3: Test CLI**

Run: `node .claude/worca-ui/bin/worca-ui.js start --port 3401`
Run: `node .claude/worca-ui/bin/worca-ui.js status`
Run: `node .claude/worca-ui/bin/worca-ui.js stop`

**Step 4: Commit**

```bash
git add .claude/worca-ui/bin/worca-ui.js
git commit -m "feat: CLI — start, stop, restart, status with PID management"
```

---

### Task 20: Build Script

**Files:**
- Create: `.claude/worca-ui/scripts/build-frontend.js`

**Step 1: Write build-frontend.js**

Follow beads-ui pattern. Reference: `/Volumes/Apps/dev/ccexperiments/beads-ui/scripts/build-frontend.js`

Entry: `app/main.js` → Output: `app/main.bundle.js` (ESM, ES2020, minified, source maps)

**Step 2: Test build**

Run: `cd .claude/worca-ui && node scripts/build-frontend.js`
Expected: `app/main.bundle.js` created

**Step 3: Commit**

```bash
git add .claude/worca-ui/scripts/build-frontend.js
git commit -m "feat: esbuild frontend bundler"
```

---

### Task 21: Test Fixtures

**Files:**
- Create: `.claude/worca-ui/test/fixtures/status-pending.json`
- Create: `.claude/worca-ui/test/fixtures/status-running.json`
- Create: `.claude/worca-ui/test/fixtures/status-completed.json`
- Create: `.claude/worca-ui/test/fixtures/status-error.json`
- Create: `.claude/worca-ui/test/fixtures/settings-with-ui.json`

**Step 1: Create fixture files based on real data**

`status-pending.json` — all 6 stages pending (from worca-cc `.worca/status.json` pattern)
`status-running.json` — plan+coordinate completed, implement in_progress with `task_progress: "2/5"`, iteration: 1
`status-completed.json` — all stages completed, milestones approved (from `test-project/.worca/status.json` pattern)
`status-error.json` — test stage has `status: "error"`
`settings-with-ui.json` — includes `worca.ui.stages` with custom labels/icons for "deploy" stage

**Step 2: Commit**

```bash
git add .claude/worca-ui/test/fixtures/
git commit -m "test: fixture files for various pipeline states"
```

---

### Task 22: Integration Test — WebSocket Server

**Files:**
- Create: `.claude/worca-ui/test/ws-integration.test.js`

**Step 1: Write integration tests**

Test cases:
- `list-runs` returns empty when no status.json exists
- `list-runs` finds active run after writing status.json to temp .worca/ dir
- `list-runs` finds completed runs from results/ directory
- `subscribe-run` returns run snapshot for known runId
- `subscribe-run` returns error for unknown runId
- `get-preferences` / `set-preferences` round-trip
- `set-preferences` broadcasts to all connected clients

Use temp directories for all test data, clean up in afterEach.

**Step 2: Run integration tests**

Run: `cd .claude/worca-ui && npx vitest run test/ws-integration.test.js`
Expected: All PASS

**Step 3: Commit**

```bash
git add .claude/worca-ui/test/ws-integration.test.js
git commit -m "test: WebSocket integration tests — list-runs, subscribe, preferences"
```

---

### Task 23: Visual/E2E Tests with Playwright MCP

**Files:**
- Create: `.claude/worca-ui/test/e2e/visual-tests.md`

**Step 1: Document E2E test procedures**

These tests are executed via Playwright MCP browser tools during development review.

Test cases:
1. **Sidebar renders** — navigate, verify "WORCA" logo, Pipeline section, Active/History items
2. **Theme toggle** — click toggle, verify `data-theme="dark"`, click again to restore
3. **Empty dashboard** — no runs, verify "No active pipeline runs"
4. **Active run appears** — write status-running fixture, reload, verify run in Active
5. **Run detail** — click run, verify stage timeline renders with correct state icons
6. **Stage timeline states** — verify pending/in_progress/completed/error icons
7. **Log viewer** — verify log panel renders, stage filter dropdown present
8. **Generic stages** — write status.json with custom "deploy" stage, verify it renders
9. **Connection status** — verify green dot when connected
10. **Live update** — modify status.json while UI is open, verify automatic update

**Step 2: Commit**

```bash
git add .claude/worca-ui/test/e2e/visual-tests.md
git commit -m "docs: E2E visual test procedures for Playwright MCP"
```

---

### Task 24: Polish & Final Wiring

**Step 1: Run full test suite**

Run: `cd .claude/worca-ui && npx vitest run`
Expected: All unit + integration tests PASS

**Step 2: Build and test production bundle**

Run: `cd .claude/worca-ui && node scripts/build-frontend.js && node server/index.js --port 3402`
Expected: UI loads from bundle at `http://127.0.0.1:3402`

**Step 3: Visual smoke test with Playwright MCP**

- Navigate to `http://127.0.0.1:3402`
- Take browser snapshot, verify sidebar + main content layout
- Verify theme toggle works
- Verify connection indicator shows "open"

**Step 4: npm link for global command**

Run: `cd .claude/worca-ui && npm link`
Expected: `worca-ui` command available globally

Run: `worca-ui start --port 3403 --open`
Run: `worca-ui status`
Run: `worca-ui stop`

**Step 5: Final commit**

```bash
git add -A .claude/worca-ui/
git commit -m "feat: worca-ui v0.1.0 — pipeline monitoring UI"
```
