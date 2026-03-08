import { html } from 'lit-html';
import { statusClass, statusIcon } from '../utils/status-badge.js';

function stageLabel(key, stageUi) {
  if (stageUi && stageUi[key]?.label) return stageUi[key].label;
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function stageTimelineView(stages, stageUi = {}, milestones = {}) {
  if (!stages || typeof stages !== 'object') return html``;

  const entries = Object.entries(stages);
  if (entries.length === 0) return html`<div class="empty-state">No stages</div>`;

  return html`
    <div class="stage-timeline">
      ${entries.map(([key, stage], i) => {
        const status = stage.status || 'pending';
        const icon = statusIcon(status);
        const label = stageLabel(key, stageUi);
        const isPulse = status === 'in_progress';
        const hasMilestone = milestones[`${key}_approval`];
        const iteration = stage.iteration;

        return html`
          ${i > 0 ? html`<div class="stage-connector ${entries[i - 1]?.[1]?.status === 'completed' ? 'completed' : ''}"></div>` : ''}
          <div class="stage-node ${statusClass(status)} ${isPulse ? 'pulse' : ''}">
            <div class="stage-icon">${icon}</div>
            <div class="stage-label">${label}</div>
            ${iteration > 1 ? html`<span class="loop-indicator">\u21BB${iteration}</span>` : ''}
            ${hasMilestone ? html`<span class="milestone-marker">\u2691</span>` : ''}
          </div>
        `;
      })}
    </div>
  `;
}
