import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { iconSvg, Lightbulb, Loader, AlertTriangle, RefreshCw } from '../utils/icons.js';

/**
 * Map importance level to sl-badge variant.
 */
export function importanceBadge(importance) {
  switch (importance) {
    case 'critical': return 'danger';
    case 'high': return 'warning';
    case 'medium': return 'primary';
    case 'low': return 'neutral';
    default: return 'neutral';
  }
}

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}

function summaryStripView(summary) {
  if (!summary) return nothing;
  return html`
    <div class="learnings-summary-strip">
      <span><span class="meta-label">Termination:</span> <span class="meta-value">${summary.termination}</span></span>
      <span><span class="meta-label">Iterations:</span> <span class="meta-value">${summary.total_iterations}</span></span>
      ${summary.test_fix_loops != null ? html`<span><span class="meta-label">Test-fix loops:</span> <span class="meta-value">${summary.test_fix_loops}</span></span>` : nothing}
      ${summary.review_fix_loops != null ? html`<span><span class="meta-label">Review-fix loops:</span> <span class="meta-value">${summary.review_fix_loops}</span></span>` : nothing}
    </div>
  `;
}

function observationsTableView(observations) {
  return html`
    <h4 class="learnings-table-title">Observations</h4>
    <div class="learnings-table">
      <div class="learnings-table-header">
        <span>Importance</span>
        <span>Category</span>
        <span>Description</span>
        <span>Evidence</span>
        <span>Count</span>
      </div>
      ${observations.map(obs => html`
        <div class="learnings-table-row">
          <sl-badge variant="${importanceBadge(obs.importance)}" pill>
            ${obs.importance}
          </sl-badge>
          <span class="learnings-category">${obs.category}</span>
          <span>${obs.description}</span>
          <span class="learnings-evidence">${obs.evidence}</span>
          <span>${obs.occurrences || 1}</span>
        </div>
      `)}
    </div>
  `;
}

function suggestionsTableView(suggestions) {
  return html`
    <h4 class="learnings-table-title">Suggestions</h4>
    <div class="learnings-table">
      <div class="learnings-table-header learnings-table-header--suggestions">
        <span>Target</span>
        <span>Suggestion</span>
        <span>Rationale</span>
      </div>
      ${suggestions.map(s => html`
        <div class="learnings-table-row learnings-table-row--suggestions">
          <span class="learnings-target">${s.target}</span>
          <span>${s.description}</span>
          <span class="learnings-rationale">${s.rationale}</span>
        </div>
      `)}
    </div>
  `;
}

function recurringPatternsView(patterns) {
  if (!patterns) return nothing;
  const crossBead = patterns.cross_bead || [];
  const testFix = patterns.test_fix_loops || [];
  const reviewFix = patterns.review_fix_loops || [];
  if (crossBead.length === 0 && testFix.length === 0 && reviewFix.length === 0) return nothing;

  return html`
    <h4 class="learnings-table-title">Recurring Patterns</h4>
    ${crossBead.length > 0 ? html`
      <h5 class="learnings-subtable-title">Cross-Bead</h5>
      <div class="learnings-table">
        <div class="learnings-table-header learnings-table-header--patterns">
          <span>Pattern</span>
          <span>Affected Beads</span>
          <span>Frequency</span>
        </div>
        ${crossBead.map(p => html`
          <div class="learnings-table-row learnings-table-row--patterns">
            <span>${p.pattern}</span>
            <span>${(p.affected_beads || []).join(', ')}</span>
            <span>${p.frequency}</span>
          </div>
        `)}
      </div>
    ` : nothing}
    ${testFix.length > 0 ? html`
      <h5 class="learnings-subtable-title">Test-Fix Loops</h5>
      <div class="learnings-table">
        <div class="learnings-table-header learnings-table-header--patterns">
          <span>Pattern</span>
          <span>Iterations</span>
          <span>Resolved</span>
        </div>
        ${testFix.map(p => html`
          <div class="learnings-table-row learnings-table-row--patterns">
            <span>${p.pattern}</span>
            <span>${p.loop_iterations}</span>
            <span>${p.resolved ? 'Yes' : 'No'}</span>
          </div>
        `)}
      </div>
    ` : nothing}
    ${reviewFix.length > 0 ? html`
      <h5 class="learnings-subtable-title">Review-Fix Loops</h5>
      <div class="learnings-table">
        <div class="learnings-table-header learnings-table-header--patterns">
          <span>Pattern</span>
          <span>Iterations</span>
          <span>Resolved</span>
        </div>
        ${reviewFix.map(p => html`
          <div class="learnings-table-row learnings-table-row--patterns">
            <span>${p.pattern}</span>
            <span>${p.loop_iterations}</span>
            <span>${p.resolved ? 'Yes' : 'No'}</span>
          </div>
        `)}
      </div>
    ` : nothing}
  `;
}

const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Render the learnings section panel.
 * @param {object|null|undefined} learnStage - The full learn stage object from status.stages.learn
 * @param {object} options - { onRunLearn: Function }
 */
export function learningsSectionView(learnStage, options = {}) {
  const status = learnStage?.status;
  const output = learnStage?.iterations?.[0]?.output;
  const hasData = output && output.observations;
  const error = learnStage?.error || learnStage?.iterations?.[0]?.error;
  const startedAt = learnStage?.started_at || learnStage?.iterations?.[0]?.started_at;

  let innerContent;

  if (status === 'in_progress' || status === 'pending') {
    const startTime = startedAt ? new Date(startedAt) : null;
    const elapsedMs = startTime ? Date.now() - startTime.getTime() : 0;
    const isStale = elapsedMs > STALE_THRESHOLD_MS;

    if (isStale) {
      innerContent = html`
        <div class="learnings-error">
          <div class="learnings-error-icon">
            ${unsafeHTML(iconSvg(AlertTriangle, 20))}
          </div>
          <div class="learnings-error-text">
            <p class="learnings-error-title">Learning analysis appears to have stalled</p>
            <p class="learnings-error-detail">Started ${startTime.toLocaleTimeString()} (${formatElapsed(elapsedMs)} ago)</p>
          </div>
          <sl-button variant="warning" size="small" @click=${options.onRunLearn}>
            ${unsafeHTML(iconSvg(RefreshCw, 14))} Retry
          </sl-button>
        </div>
      `;
    } else {
      const elapsed = startTime ? formatElapsed(elapsedMs) : '';
      innerContent = html`
        <div class="learnings-in-progress">
          <div class="learnings-in-progress-spinner">
            ${unsafeHTML(iconSvg(Loader, 20, 'icon-spin'))}
          </div>
          <div class="learnings-in-progress-text">
            <p class="learnings-in-progress-title">Learning analysis in progress...</p>
            ${startTime ? html`
              <p class="learnings-in-progress-meta">
                Started ${startTime.toLocaleTimeString()}${elapsed ? html` &mdash; ${elapsed}` : nothing}
              </p>
            ` : nothing}
          </div>
        </div>
      `;
    }
  } else if (status === 'error') {
    innerContent = html`
      <div class="learnings-error">
        <div class="learnings-error-icon">
          ${unsafeHTML(iconSvg(AlertTriangle, 20))}
        </div>
        <div class="learnings-error-text">
          <p class="learnings-error-title">Learning analysis failed</p>
          ${error ? html`<p class="learnings-error-detail">${error}</p>` : nothing}
        </div>
        <sl-button variant="warning" size="small" @click=${options.onRunLearn}>
          ${unsafeHTML(iconSvg(RefreshCw, 14))} Retry Learning Analysis
        </sl-button>
      </div>
    `;
  } else if (hasData) {
    innerContent = html`
      ${summaryStripView(output.run_summary)}
      ${observationsTableView(output.observations)}
      ${suggestionsTableView(output.suggestions || [])}
      ${recurringPatternsView(output.recurring_patterns)}
      <div class="learnings-rerun">
        <sl-button variant="text" size="small" @click=${options.onRunLearn}>
          ${unsafeHTML(iconSvg(RefreshCw, 12))} Re-run Analysis
        </sl-button>
      </div>
    `;
  } else {
    innerContent = html`
      <div class="learnings-empty">
        <p>Learning analysis has not been run for this pipeline execution.</p>
        <sl-button variant="primary" size="small" @click=${options.onRunLearn}>
          Run Learning Analysis
        </sl-button>
      </div>
    `;
  }

  const observations = hasData ? output.observations : [];
  const countLabel = `${observations.length} observation${observations.length !== 1 ? 's' : ''}`;
  const isInProgress = status === 'in_progress' || status === 'pending';

  return html`
    <div class="learnings-section">
      <sl-details class="learnings-panel" ?open=${isInProgress}>
        <div slot="summary" class="learnings-header">
          <span class="learnings-icon">${unsafeHTML(iconSvg(Lightbulb, 16))}</span>
          <span class="learnings-title">Learnings</span>
          ${isInProgress ? html`
            <sl-badge variant="warning" pill>
              ${unsafeHTML(iconSvg(Loader, 10, 'icon-spin'))} Analyzing
            </sl-badge>
          ` : nothing}
          ${hasData ? html`<span class="learnings-count">${countLabel}</span>` : nothing}
          ${status === 'error' ? html`<sl-badge variant="danger" pill>Error</sl-badge>` : nothing}
        </div>
        ${innerContent}
      </sl-details>
    </div>
  `;
}
