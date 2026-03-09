import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { stageTimelineView } from './stage-timeline.js';
import { statusClass, statusIcon, resolveStatus } from '../utils/status-badge.js';
import { formatDuration, elapsed, formatTimestamp } from '../utils/duration.js';
import { iconSvg, Clock, Timer, Cpu, GitBranch, RefreshCw } from '../utils/icons.js';

function _lastStageEnd(stages) {
  if (!stages) return null;
  let latest = null;
  for (const s of Object.values(stages)) {
    if (s.completed_at && (!latest || s.completed_at > latest)) latest = s.completed_at;
  }
  return latest;
}

function _badgeVariant(status) {
  if (status === 'completed') return 'success';
  if (status === 'error') return 'danger';
  if (status === 'in_progress' || status === 'interrupted') return 'warning';
  return 'neutral';
}

function _iterStatusIcon(iter) {
  const s = iter.status || 'pending';
  if (s === 'completed' && iter.outcome === 'success') return html`<span class="iter-status-icon success">${unsafeHTML(statusIcon('completed', 12))}</span>`;
  if (s === 'completed') return html`<span class="iter-status-icon">${unsafeHTML(statusIcon('completed', 12))}</span>`;
  if (s === 'error') return html`<span class="iter-status-icon failure">${unsafeHTML(statusIcon('error', 12))}</span>`;
  if (s === 'in_progress') return html`<span class="iter-status-icon in-progress">${unsafeHTML(statusIcon('in_progress', 12))}</span>`;
  return nothing;
}

function _triggerLabel(trigger) {
  if (!trigger) return nothing;
  const labels = {
    initial: 'Initial run',
    test_failure: 'Test failure',
    review_changes: 'Review changes',
    restart_planning: 'Restart planning',
  };
  return html`<span class="iteration-trigger">${labels[trigger] || trigger}</span>`;
}

function _outcomeLabel(outcome) {
  if (!outcome) return nothing;
  const cls = outcome === 'success' ? 'success' : 'failure';
  return html`<span class="iteration-outcome ${cls}">${outcome.replace(/_/g, ' ')}</span>`;
}

function timingStripView(startedAt, completedAt, extra = nothing) {
  const dur = startedAt ? formatDuration(elapsed(startedAt, completedAt || null)) : '';
  return html`
    <div class="timing-strip">
      ${startedAt ? html`<span class="timing-strip-item"><span class="meta-label">Started:</span> ${formatTimestamp(startedAt)}</span>` : nothing}
      ${completedAt ? html`<span class="timing-strip-item"><span class="meta-label">Finished:</span> ${formatTimestamp(completedAt)}</span>` : nothing}
      ${dur ? html`<span class="timing-strip-item"><span class="meta-label">Duration:</span> ${dur}</span>` : nothing}
      ${extra}
    </div>
  `;
}

function _iterationDetailView(iter, stageKey, stageAgent) {
  const agentName = iter.agent || stageAgent || stageKey;
  const model = iter.model || '';
  return html`
    <div class="iteration-detail">
      ${timingStripView(iter.started_at, iter.completed_at)}
      <div class="stage-info-strip">
        ${agentName ? html`<span class="stage-info-item"><span class="stage-meta-icon">${unsafeHTML(iconSvg(Cpu, 12))}</span> ${agentName}${model ? html` <span class="text-muted">(${model})</span>` : ''}</span>` : nothing}
        ${iter.turns ? html`<span class="stage-info-item"><span class="meta-label">Turns:</span> ${iter.turns}</span>` : nothing}
        ${iter.cost_usd != null ? html`<span class="stage-info-item"><span class="meta-label">Cost:</span> $${Number(iter.cost_usd).toFixed(2)}</span>` : nothing}
      </div>
      ${iter.trigger ? html`<div class="detail-row">${_triggerLabel(iter.trigger)}</div>` : nothing}
      ${iter.outcome ? html`<div class="detail-row">${_outcomeLabel(iter.outcome)}</div>` : nothing}
    </div>
  `;
}

export function runDetailView(run, settings = {}) {
  if (!run) {
    return html`<div class="empty-state">Select a run to view details</div>`;
  }

  const branch = run.branch || run.work_request?.branch || '';
  const pr = run.pr_url || null;
  const endTime = run.completed_at
    || (!run.active ? _lastStageEnd(run.stages) : null);
  const stages = run.stages || {};
  const stageUi = settings.stageUi || {};
  const agents = settings.agents || {};

  return html`
    <div class="run-detail">
      ${stageTimelineView(stages, stageUi, run.active)}

      <div class="run-info-section">
        ${branch ? html`
          <div class="run-branch">
            <span class="stage-meta-icon">${unsafeHTML(iconSvg(GitBranch, 14))}</span>
            <span>${branch}</span>
            ${pr ? html`<a class="run-pr-link" href="${pr}" target="_blank">View PR</a>` : nothing}
          </div>
        ` : nothing}
        ${timingStripView(run.started_at, endTime)}
      </div>

      <div class="stage-panels">
        ${Object.entries(stages).map(([key, stage]) => {
          const label = stageUi[key]?.label || key.replace(/_/g, ' ').toUpperCase();
          const stageStatus = resolveStatus(stage.status || 'pending', run.active);
          const stageAgent = stage.agent || agents[key]?.agent || key;
          const stageModel = stage.model || agents[key]?.model || '';
          const stageDuration = stage.started_at
            ? formatDuration(elapsed(stage.started_at, stage.completed_at || null))
            : '';
          const iterations = stage.iterations || [];
          const hasMultipleIterations = iterations.length > 1;

          return html`
            <sl-details ?open=${stageStatus === 'in_progress'} class="stage-panel">
              <div slot="summary" class="stage-panel-header">
                <span class="stage-panel-icon ${statusClass(stageStatus)}">${unsafeHTML(statusIcon(stageStatus))}</span>
                <span class="stage-panel-label">${label}</span>
                <span class="stage-panel-meta">
                  ${hasMultipleIterations ? html`
                    <span class="stage-meta-item stage-meta-iteration">
                      <span class="stage-meta-icon">${unsafeHTML(iconSvg(RefreshCw, 11))}</span>
                      ${iterations.length} iterations
                    </span>
                  ` : nothing}
                  ${stage.completed_at ? html`
                    <span class="stage-meta-item">
                      <span class="stage-meta-icon">${unsafeHTML(iconSvg(Clock, 11))}</span>
                      ${formatTimestamp(stage.completed_at)}
                    </span>
                  ` : nothing}
                  ${stageDuration ? html`
                    <span class="stage-meta-item">
                      <span class="stage-meta-icon">${unsafeHTML(iconSvg(Timer, 11))}</span>
                      ${stageDuration}
                    </span>
                  ` : nothing}
                </span>
                <sl-badge variant="${_badgeVariant(stageStatus)}" pill>
                  ${stageStatus.replace(/_/g, ' ')}
                </sl-badge>
              </div>
              ${hasMultipleIterations ? html`
                <sl-tab-group>
                  ${iterations.map(iter => html`
                    <sl-tab slot="nav" panel="iter-${key}-${iter.number}">
                      Iter ${iter.number} ${_iterStatusIcon(iter)}
                    </sl-tab>
                  `)}
                  ${iterations.map(iter => html`
                    <sl-tab-panel name="iter-${key}-${iter.number}">
                      ${_iterationDetailView(iter, key, stageAgent)}
                    </sl-tab-panel>
                  `)}
                </sl-tab-group>
              ` : html`
                <div class="stage-detail">
                  ${timingStripView(stage.started_at, stage.completed_at)}
                  <div class="stage-info-strip">
                    ${stageAgent ? html`<span class="stage-info-item"><span class="stage-meta-icon">${unsafeHTML(iconSvg(Cpu, 12))}</span> ${stageAgent}${stageModel ? html` <span class="text-muted">(${stageModel})</span>` : ''}</span>` : nothing}
                    ${iterations.length === 1 && iterations[0].turns ? html`<span class="stage-info-item"><span class="meta-label">Turns:</span> ${iterations[0].turns}</span>` : nothing}
                    ${iterations.length === 1 && iterations[0].cost_usd != null ? html`<span class="stage-info-item"><span class="meta-label">Cost:</span> $${Number(iterations[0].cost_usd).toFixed(2)}</span>` : nothing}
                  </div>
                  ${iterations.length === 1 && iterations[0].trigger ? html`<div class="detail-row">${_triggerLabel(iterations[0].trigger)}</div>` : nothing}
                  ${iterations.length === 1 && iterations[0].outcome ? html`<div class="detail-row">${_outcomeLabel(iterations[0].outcome)}</div>` : nothing}
                  ${stage.task_progress ? html`<div class="detail-row"><span class="detail-label">Progress:</span> ${stage.task_progress}</div>` : nothing}
                  ${stage.error ? html`<div class="detail-row detail-error"><span class="detail-label">Error:</span> ${stage.error}</div>` : nothing}
                </div>
              `}
            </sl-details>
          `;
        })}
      </div>
    </div>
  `;
}
