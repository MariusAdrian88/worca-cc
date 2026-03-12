import { html } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { iconSvg, Lock, Loader } from '../utils/icons.js';
import { formatTimestamp } from '../utils/duration.js';

export function priorityVariant(priority) {
  if (priority === 0 || priority === 1) return 'danger';
  if (priority === 2) return 'warning';
  return 'neutral';
}

export function statusVariant(status) {
  if (status === 'open') return 'success';
  if (status === 'in_progress') return 'warning';
  if (status === 'closed') return 'neutral';
  return 'neutral';
}

export function beadsStatusClass(issue) {
  if (issue.blocked_by && issue.blocked_by.length > 0) return 'blocked';
  return issue.status;
}

function computeLayers(issues) {
  const ids = new Set(issues.map(i => i.id));
  const layer = new Map(issues.map(i => [i.id, 0]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const issue of issues) {
      for (const dep of issue.depends_on) {
        if (!ids.has(dep)) continue;
        const candidate = (layer.get(dep) ?? 0) + 1;
        if (candidate > layer.get(issue.id)) {
          layer.set(issue.id, candidate);
          changed = true;
        }
      }
    }
  }
  return layer;
}

export function beadsDependencyGraph(issues) {
  if (!issues || issues.length === 0) return '';

  const NODE_W = 140, NODE_H = 40, H_GAP = 60, V_GAP = 24, PADDING = 16;
  const layers = computeLayers(issues);
  const maxLayer = Math.max(...layers.values(), 0);

  const layerGroups = new Map();
  for (const issue of issues) {
    const l = layers.get(issue.id) ?? 0;
    if (!layerGroups.has(l)) layerGroups.set(l, []);
    layerGroups.get(l).push(issue);
  }

  const maxPerLayer = Math.max(...[...layerGroups.values()].map(g => g.length), 1);
  const svgW = Math.round(PADDING * 2 + (maxLayer + 1) * (NODE_W + H_GAP));
  const svgH = Math.round(PADDING * 2 + maxPerLayer * (NODE_H + V_GAP));

  const positions = new Map();
  for (const [l, group] of layerGroups) {
    for (let i = 0; i < group.length; i++) {
      positions.set(group[i].id, {
        x: Math.round(PADDING + l * (NODE_W + H_GAP)),
        y: Math.round(PADDING + i * (NODE_H + V_GAP))
      });
    }
  }

  let edges = '';
  for (const issue of issues) {
    const to = positions.get(issue.id);
    if (!to) continue;
    for (const depId of issue.depends_on) {
      const from = positions.get(depId);
      if (!from) continue;
      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_H / 2;
      const cx = Math.round((x1 + x2) / 2);
      const isBlocked = issue.blocked_by && issue.blocked_by.includes(depId);
      const cls = isBlocked ? 'beads-graph-edge beads-graph-edge--blocked' : 'beads-graph-edge';
      const marker = isBlocked ? 'url(#beads-arrow-blocked)' : 'url(#beads-arrow)';
      edges += `<path class="${cls}" d="M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}" marker-end="${marker}"/>`;
    }
  }

  let nodes = '';
  for (const issue of issues) {
    const pos = positions.get(issue.id);
    if (!pos) continue;
    const sc = beadsStatusClass(issue);
    const title = issue.title || '';
    const label = title.length > 18 ? title.slice(0, 18) + '...' : title;
    nodes += `<g class="beads-graph-node beads-graph-node--${sc}" transform="translate(${pos.x},${pos.y})">
      <rect width="${NODE_W}" height="${NODE_H}" rx="6"/>
      <text x="8" y="14" class="beads-graph-node-id">#${issue.id}</text>
      <text x="8" y="28">${escapeXml(label)}</text>
    </g>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">
    <defs>
      <marker id="beads-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border)"/>
      </marker>
      <marker id="beads-arrow-blocked" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--status-error)"/>
      </marker>
    </defs>
    ${edges}
    ${nodes}
  </svg>`;
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function beadsIssueRow(issue, { starting, onStartIssue }) {
  const isClosed = issue.status === 'closed';
  const isBlocked = issue.blocked_by && issue.blocked_by.length > 0;
  const canStart = issue.status === 'open' && !isBlocked && starting === null;
  const isStarting = starting === issue.id;

  return html`
    <div class="beads-issue-row ${isClosed ? 'beads-issue-row--closed' : ''}">
      <sl-badge variant="${priorityVariant(issue.priority)}" pill>P${issue.priority}</sl-badge>
      <sl-badge variant="${statusVariant(issue.status)}">${issue.status}</sl-badge>
      <div class="beads-issue-body">
        <div class="beads-issue-title">${issue.title}</div>
        ${issue.body ? html`<div class="beads-issue-excerpt">${(issue.body || '').slice(0, 120)}</div>` : ''}
        ${issue.depends_on && issue.depends_on.length > 0 ? html`
          <div class="beads-issue-deps">
            ${issue.depends_on.map(depId => html`
              <span class="beads-dep-chip ${issue.blocked_by && issue.blocked_by.includes(depId) ? 'beads-dep-chip--blocked' : ''}">
                ${issue.blocked_by && issue.blocked_by.includes(depId) ? unsafeHTML(iconSvg(Lock, 10)) : ''}
                #${depId}
              </span>
            `)}
          </div>
        ` : ''}
      </div>
      ${!isClosed ? html`
        <div class="beads-issue-actions">
          <sl-button variant="primary" size="small"
            ?disabled=${!canStart}
            @click=${() => canStart && onStartIssue(issue.id)}>
            ${isStarting ? unsafeHTML(iconSvg(Loader, 14, 'icon-spin')) : ''}
            ${isStarting ? 'Starting...' : 'Start Pipeline'}
          </sl-button>
        </div>
      ` : html`<div class="beads-issue-actions"></div>`}
    </div>
  `;
}

// --- Run selector helpers ---

function buildRunOptions(runs, linkedRefs) {
  const runOptions = [];
  const knownRefIds = new Set();

  // Sort runs: active first, then by started_at descending
  const sorted = [...(runs || [])].sort((a, b) => {
    if (a.active && !b.active) return -1;
    if (!a.active && b.active) return 1;
    const aTime = a.started_at || '';
    const bTime = b.started_at || '';
    return bTime.localeCompare(aTime);
  });

  for (const run of sorted) {
    const title = run.work_request?.title || run.id;
    const firstLine = title.split('\n')[0];
    const label = firstLine.length > 40 ? firstLine.slice(0, 40) + '\u2026' : firstLine;
    const date = run.started_at ? formatTimestamp(run.started_at) : '';
    const prefix = run.active ? '\u25CF ' : '';
    runOptions.push({
      value: run.id,
      label: `${prefix}${label}`,
      detail: date,
    });
    knownRefIds.add(run.id);
  }

  // Add orphan refs (in linkedRefs but not in known runs)
  for (const ref of (linkedRefs || [])) {
    const runId = ref.replace('worca:', '');
    if (!knownRefIds.has(runId)) {
      const short = runId.length > 12 ? runId.slice(0, 12) + '\u2026' : runId;
      runOptions.push({
        value: runId,
        label: `Run ${short}`,
        detail: '',
      });
    }
  }

  return runOptions;
}

// --- Kanban board view ---

function beadsKanbanView(issues, { starting, onStartIssue }) {
  const columns = [
    { key: 'open', label: 'Open', items: [] },
    { key: 'in_progress', label: 'In Progress', items: [] },
    { key: 'closed', label: 'Closed', items: [] },
  ];
  const colMap = new Map(columns.map(c => [c.key, c]));

  for (const issue of issues) {
    const col = colMap.get(issue.status) || colMap.get('open');
    col.items.push(issue);
  }

  // Sort each column by priority (P0 first)
  for (const col of columns) {
    col.items.sort((a, b) => a.priority - b.priority);
  }

  return html`
    <div class="beads-kanban">
      ${columns.map(col => html`
        <div class="beads-kanban-column">
          <div class="beads-kanban-header beads-kanban-header--${col.key}">
            ${col.label}
            <sl-badge variant="neutral" pill>${col.items.length}</sl-badge>
          </div>
          ${col.items.length === 0 ? html`
            <div class="beads-kanban-empty">No issues</div>
          ` : ''}
          ${col.items.map(issue => {
            const isBlocked = issue.blocked_by && issue.blocked_by.length > 0;
            return html`
              <div class="beads-kanban-card ${isBlocked ? 'beads-kanban-card--blocked' : ''}">
                <div class="beads-kanban-card-header">
                  <sl-badge variant="${priorityVariant(issue.priority)}" pill>P${issue.priority}</sl-badge>
                  <span class="beads-kanban-card-id">#${issue.id}</span>
                </div>
                <div class="beads-kanban-card-title">${issue.title}</div>
                ${isBlocked ? html`
                  <div class="beads-kanban-card-blocked">
                    ${unsafeHTML(iconSvg(Lock, 10))}
                    blocked by: ${issue.blocked_by.map(id => `#${id}`).join(', ')}
                  </div>
                ` : ''}
              </div>
            `;
          })}
        </div>
      `)}
    </div>
  `;
}

// --- Main panel view ---

export function beadsPanelView(beads, {
  statusFilter, priorityFilter, starting, startError,
  onStatusFilter, onPriorityFilter, onStartIssue, onDismissError,
  runFilter = 'all', runIssues = [], runLoading = false,
  linkedRefs = [], runs = [], onRunFilter,
}) {
  if (beads.dbExists === false) {
    return html`<div class="empty-state">No Beads database found. Initialize Beads with <code>bd init</code> in your project.</div>`;
  }
  if (beads.loading) {
    return html`<div class="empty-state">Loading Beads issues...</div>`;
  }

  const isRunSelected = runFilter !== 'all' && runFilter !== 'unlinked';
  const showKanban = isRunSelected;

  // Decide which issues to display
  let displayIssues;
  if (runFilter === 'all') {
    displayIssues = beads.issues ?? [];
  } else {
    displayIssues = runIssues;
  }

  // Apply status and priority filters
  let filtered = displayIssues;
  if (statusFilter !== 'all') filtered = filtered.filter(i => i.status === statusFilter);
  if (priorityFilter !== 'all') filtered = filtered.filter(i => String(i.priority) === priorityFilter);

  // Build run selector options
  const runOptions = buildRunOptions(runs, linkedRefs);

  // Status filter options: include 'closed' when a specific run is selected
  const statusOptions = isRunSelected
    ? html`
        <sl-option value="all">All statuses</sl-option>
        <sl-option value="open">Open</sl-option>
        <sl-option value="in_progress">In Progress</sl-option>
        <sl-option value="closed">Closed</sl-option>
      `
    : html`
        <sl-option value="all">All statuses</sl-option>
        <sl-option value="open">Open</sl-option>
        <sl-option value="in_progress">In Progress</sl-option>
      `;

  const filtersView = html`
    <div class="beads-filters">
      <sl-select value=${runFilter} @sl-change=${(e) => onRunFilter?.(e.target.value)}>
        <sl-option value="all">All Open Issues</sl-option>
        <sl-option value="unlinked">Unlinked Issues</sl-option>
        ${runOptions.length > 0 ? html`<sl-divider></sl-divider>` : ''}
        ${runOptions.map(opt => html`
          <sl-option value=${opt.value}>${opt.label}${opt.detail ? ` (${opt.detail})` : ''}</sl-option>
        `)}
      </sl-select>
      <sl-select value=${statusFilter} @sl-change=${(e) => onStatusFilter(e.target.value)}>
        ${statusOptions}
      </sl-select>
      <sl-select value=${priorityFilter} @sl-change=${(e) => onPriorityFilter(e.target.value)}>
        <sl-option value="all">All priorities</sl-option>
        <sl-option value="0">P0 - Critical</sl-option>
        <sl-option value="1">P1 - High</sl-option>
        <sl-option value="2">P2 - Medium</sl-option>
        <sl-option value="3">P3 - Low</sl-option>
        <sl-option value="4">P4 - Backlog</sl-option>
      </sl-select>
      <span class="beads-filter-count">${filtered.length} issue${filtered.length !== 1 ? 's' : ''}</span>
    </div>
  `;

  if (displayIssues.length === 0 && runFilter === 'all' && !runLoading) {
    return html`<div class="empty-state">No open Beads issues found.</div>`;
  }

  if (runLoading) {
    return html`
      <div class="beads-panel">
        ${filtersView}
        <div class="empty-state">Loading issues...</div>
      </div>
    `;
  }

  if (filtered.length === 0) {
    return html`
      <div class="beads-panel">
        ${filtersView}
        <div class="empty-state">${displayIssues.length === 0 ? 'No issues found for this selection.' : 'No issues match the current filters.'}</div>
      </div>
    `;
  }

  return html`
    <div class="beads-panel">
      ${filtersView}

      ${showKanban ? beadsKanbanView(filtered, { starting, onStartIssue }) : html`
        <div class="beads-issue-list">
          ${filtered.map(issue => beadsIssueRow(issue, { starting, onStartIssue }))}
        </div>

        ${filtered.length > 1 ? html`
          <div class="beads-graph-section">
            <div class="beads-graph-section-title">Dependencies</div>
            <div class="beads-graph-container">
              ${unsafeHTML(beadsDependencyGraph(filtered))}
            </div>
          </div>
        ` : ''}
      `}

      ${startError ? html`
        <sl-dialog label="Could Not Start Pipeline" open @sl-after-hide=${onDismissError}>
          <p>${startError}</p>
          <sl-button slot="footer" variant="primary" @click=${() => document.querySelector('sl-dialog[label="Could Not Start Pipeline"]')?.hide()}>
            OK
          </sl-button>
        </sl-dialog>
      ` : ''}
    </div>
  `;
}
