import { html } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { iconSvg, Activity, CircleCheck, CircleAlert, Zap, Plus } from '../utils/icons.js';
import { runCardView } from './run-card.js';

export function dashboardView(state, { onSelectRun, onNavigate } = {}) {
  const runs = Object.values(state.runs);
  const active = runs.filter(r => r.active);
  const completed = runs.filter(r => !r.active);
  const errored = runs.filter(r => {
    const stages = r.stages ? Object.values(r.stages) : [];
    return stages.some(s => s.status === 'error');
  });
  const total = runs.length;

  return html`
    <div class="dashboard">
      <div class="dashboard-stats">
        <div class="stat-card stat-total">
          <div class="stat-icon-ring">${unsafeHTML(iconSvg(Zap, 20))}</div>
          <div class="stat-body">
            <span class="stat-number">${total}</span>
            <span class="stat-label">Total Runs</span>
          </div>
        </div>
        <div class="stat-card stat-active">
          <div class="stat-icon-ring">${unsafeHTML(iconSvg(Activity, 20))}</div>
          <div class="stat-body">
            <span class="stat-number">${active.length}</span>
            <span class="stat-label">Active</span>
          </div>
        </div>
        <div class="stat-card stat-completed">
          <div class="stat-icon-ring">${unsafeHTML(iconSvg(CircleCheck, 20))}</div>
          <div class="stat-body">
            <span class="stat-number">${completed.length}</span>
            <span class="stat-label">Completed</span>
          </div>
        </div>
        <div class="stat-card stat-errors">
          <div class="stat-icon-ring">${unsafeHTML(iconSvg(CircleAlert, 20))}</div>
          <div class="stat-body">
            <span class="stat-number">${errored.length}</span>
            <span class="stat-label">Errors</span>
          </div>
        </div>
      </div>

      <div class="dashboard-actions">
        <sl-button variant="primary" @click=${() => onNavigate && onNavigate('new-run')}>
          ${unsafeHTML(iconSvg(Plus, 16))}
          New Pipeline
        </sl-button>
      </div>

      <h3 class="dashboard-section-title">Active Runs</h3>
      ${active.length > 0 ? html`
        <div class="run-list">
          ${active.map(run => runCardView(run, { onClick: onSelectRun }))}
        </div>
      ` : html`<div class="empty-state">No running pipelines</div>`}
    </div>
  `;
}
