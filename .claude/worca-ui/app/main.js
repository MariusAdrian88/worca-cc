import { html, render } from 'lit-html';
import { createStore } from './state.js';
import { createWsClient } from './ws.js';
import { parseHash, onHashChange, navigate } from './router.js';
import { applyTheme } from './utils/theme.js';
import { sidebarView } from './views/sidebar.js';
import { runDetailView } from './views/run-detail.js';
import { runListView } from './views/run-list.js';
import { dashboardView } from './views/dashboard.js';
import { logViewerView } from './views/log-viewer.js';

const store = createStore();
const ws = createWsClient();
let route = parseHash(location.hash);
let connectionState = ws.getState();
let autoScroll = true;
let logFilter = '*';
let logSearch = '';
let settings = {};

// --- Wire WS events to state ---

ws.on('runs-list', (payload) => {
  const runs = {};
  for (const run of (payload.runs || [])) {
    runs[run.id] = run;
  }
  store.setState({ runs });
  if (payload.settings) settings = payload.settings;
});

ws.on('run-snapshot', (payload) => {
  if (payload && payload.id) {
    store.setRun(payload.id, payload);
  }
});

ws.on('run-update', (payload) => {
  if (payload && payload.id) {
    store.setRun(payload.id, payload);
  }
});

ws.on('log-line', (payload) => {
  if (payload) {
    store.appendLog(payload);
  }
});

ws.on('log-bulk', (payload) => {
  if (payload && Array.isArray(payload.lines)) {
    for (const line of payload.lines) {
      store.appendLog({ stage: payload.stage, line });
    }
  }
});

ws.on('preferences', (payload) => {
  if (payload) {
    store.setState({ preferences: payload });
    applyTheme(payload.theme || 'light');
  }
});

// --- Connection handling ---

ws.onConnection((state) => {
  connectionState = state;
  if (state === 'open') {
    ws.send('list-runs').then(payload => {
      const runs = {};
      for (const run of (payload.runs || [])) {
        runs[run.id] = run;
      }
      store.setState({ runs });
      if (payload.settings) settings = payload.settings;
    }).catch(() => {});

    ws.send('get-preferences').then(prefs => {
      store.setState({ preferences: prefs });
      applyTheme(prefs.theme || 'light');
    }).catch(() => {});

    // Subscribe to active run if selected
    if (route.runId) {
      ws.send('subscribe-run', { runId: route.runId }).catch(() => {});
      ws.send('subscribe-log', { stage: logFilter === '*' ? null : logFilter }).catch(() => {});
    }
  }
  rerender();
});

// --- Routing ---

onHashChange((newRoute) => {
  const prevRunId = route.runId;
  route = newRoute;

  if (prevRunId && prevRunId !== route.runId) {
    ws.send('unsubscribe-run').catch(() => {});
    ws.send('unsubscribe-log').catch(() => {});
    store.clearLog();
  }

  if (route.runId && route.runId !== prevRunId) {
    ws.send('subscribe-run', { runId: route.runId }).catch(() => {});
    ws.send('subscribe-log', { stage: null }).catch(() => {});
  }

  rerender();
});

// --- Actions ---

function handleNavigate(section) {
  navigate(section, null);
}

function handleSelectRun(runId) {
  navigate(route.section, runId);
}

function handleThemeToggle() {
  const current = store.getState().preferences.theme;
  const next = current === 'dark' ? 'light' : 'dark';
  ws.send('set-preferences', { theme: next }).catch(() => {});
  store.setState({ preferences: { theme: next } });
  applyTheme(next);
}

function handleStageFilter(stage) {
  logFilter = stage;
  rerender();
}

function handleSearch(term) {
  logSearch = term;
  rerender();
}

function handleToggleAutoScroll() {
  autoScroll = !autoScroll;
  rerender();
}

// --- Render ---

function mainContentView() {
  const state = store.getState();
  const runs = Object.values(state.runs);

  if (route.runId) {
    const run = state.runs[route.runId];
    return html`
      ${runDetailView(run, settings)}
      ${logViewerView(filteredLogState(state), {
        onStageFilter: handleStageFilter,
        onSearch: handleSearch,
        onToggleAutoScroll: handleToggleAutoScroll,
        autoScroll
      })}
    `;
  }

  if (route.section === 'history') {
    return runListView(runs, 'history', { onSelectRun: handleSelectRun });
  }

  if (route.section === 'active') {
    const activeRuns = runs.filter(r => r.active);
    if (activeRuns.length === 1) {
      navigate('active', activeRuns[0].id);
      return html``;
    }
    return runListView(runs, 'active', { onSelectRun: handleSelectRun });
  }

  return dashboardView(state);
}

function filteredLogState(state) {
  let lines = state.logLines;
  if (logFilter !== '*') {
    lines = lines.filter(l => l.stage === logFilter);
  }
  if (logSearch) {
    const term = logSearch.toLowerCase();
    lines = lines.filter(l => (l.line || '').toLowerCase().includes(term));
  }
  return { ...state, logLines: lines };
}

function rerender() {
  const state = store.getState();
  const appEl = document.getElementById('app');
  if (!appEl) return;

  render(html`
    <div class="app-shell">
      ${sidebarView(state, route, connectionState, {
        onNavigate: handleNavigate,
        onThemeToggle: handleThemeToggle
      })}
      <main class="main-content">
        ${mainContentView()}
      </main>
    </div>
  `, appEl);

  // Auto-scroll log viewer
  if (autoScroll) {
    const logEl = document.getElementById('log-lines');
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }
}

// --- Bootstrap ---

store.subscribe(() => rerender());
applyTheme(store.getState().preferences.theme);
rerender();
