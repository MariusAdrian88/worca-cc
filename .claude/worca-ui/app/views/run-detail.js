import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { stageTimelineView } from './stage-timeline.js';
import { statusClass, statusIcon, resolveStatus } from '../utils/status-badge.js';
import { formatDuration, elapsed, formatTimestamp } from '../utils/duration.js';

function _lastStageEnd(stages) {
  if (!stages) return null;
  let latest = null;
  for (const s of Object.values(stages)) {
    if (s.completed_at && (!latest || s.completed_at > latest)) latest = s.completed_at;
  }
  return latest;
}

export function runDetailView(run, settings = {}) {
  if (!run) {
    return html`<div class="empty-state">Select a run to view details</div>`;
  }

  const branch = run.branch || run.work_request?.branch || '';
  const pr = run.pr_url || null;
  // Use completed_at if set; for non-active runs without it, freeze at last stage completion
  const endTime = run.completed_at
    || (!run.active ? _lastStageEnd(run.stages) : null);
  const duration = run.started_at
    ? formatDuration(elapsed(run.started_at, endTime))
    : 'N/A';
  const stages = run.stages || {};
  const stageUi = settings.stageUi || {};
  const agents = settings.agents || {};

  return html`
    <div class="run-detail">
      <div class="run-header">
        <div class="run-header-left">
          <sl-badge variant="${run.active ? 'warning' : 'success'}" pill>
            ${unsafeHTML(statusIcon(run.active ? 'in_progress' : 'completed', 12))}
            ${run.active ? 'Running' : 'Completed'}
          </sl-badge>
          ${pr ? html`<a class="run-meta run-pr-link" href="${pr}" target="_blank">View PR</a>` : nothing}
        </div>
      </div>
      <div class="run-meta-grid">
        <span class="run-meta-item"><span class="meta-label">Branch:</span> ${branch || 'N/A'}</span>
        <span class="run-meta-item"><span class="meta-label">Started:</span> ${formatTimestamp(run.started_at)}</span>
        <span class="run-meta-item"><span class="meta-label">Finished:</span> ${formatTimestamp(run.completed_at)}</span>
        <span class="run-meta-item"><span class="meta-label">Duration:</span> ${duration}</span>
      </div>

      ${stageTimelineView(stages, stageUi, run.active)}

      <div class="stage-panels">
        ${Object.entries(stages).map(([key, stage]) => {
          const label = stageUi[key]?.label || key.replace(/_/g, ' ').toUpperCase();
          const stageStatus = resolveStatus(stage.status || 'pending', run.active);
          const agentKey = Object.keys(agents).find(a => a === key) || null;
          const agent = agentKey ? agents[agentKey] : null;
          const stageDuration = stage.started_at
            ? formatDuration(elapsed(stage.started_at, stage.completed_at || null))
            : '';

          return html`
            <sl-details ?open=${stageStatus === 'in_progress'} class="stage-panel">
              <div slot="summary" class="stage-panel-header">
                <span class="stage-panel-icon ${statusClass(stageStatus)}">${unsafeHTML(statusIcon(stageStatus))}</span>
                <span class="stage-panel-label">${label}</span>
                <sl-badge variant="${stageStatus === 'completed' ? 'success' : stageStatus === 'error' ? 'danger' : stageStatus === 'in_progress' ? 'warning' : stageStatus === 'interrupted' ? 'warning' : 'neutral'}" pill>
                  ${stageStatus.replace(/_/g, ' ')}
                </sl-badge>
              </div>
              <div class="stage-detail">
                ${stage.started_at ? html`<div class="detail-row"><span class="detail-label">Started:</span> ${formatTimestamp(stage.started_at)}</div>` : nothing}
                ${stage.completed_at ? html`<div class="detail-row"><span class="detail-label">Completed:</span> ${formatTimestamp(stage.completed_at)}</div>` : nothing}
                ${stageDuration ? html`<div class="detail-row"><span class="detail-label">Duration:</span> ${stageDuration}</div>` : nothing}
                ${agent ? html`<div class="detail-row"><span class="detail-label">Agent:</span> ${agentKey} (${agent.model})</div>` : nothing}
                ${stage.iteration > 1 ? html`<div class="detail-row"><span class="detail-label">Iteration:</span> ${stage.iteration}</div>` : nothing}
                ${stage.task_progress ? html`<div class="detail-row"><span class="detail-label">Progress:</span> ${stage.task_progress}</div>` : nothing}
                ${stage.error ? html`<div class="detail-row detail-error"><span class="detail-label">Error:</span> ${stage.error}</div>` : nothing}
              </div>
            </sl-details>
          `;
        })}
      </div>
    </div>
  `;
}
