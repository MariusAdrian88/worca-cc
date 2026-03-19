import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { iconSvg, Lightbulb } from '../utils/icons.js';

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

/**
 * Render the learnings section panel.
 * @param {object|null|undefined} learnings - The learnings data from status.stages.learn output
 * @param {object} options - { onRunLearn: Function, learnRunning: boolean }
 */
export function learningsSectionView(learnings, options = {}) {
  const hasData = learnings && learnings.observations;
  const observations = hasData ? learnings.observations : [];
  const suggestions = hasData ? (learnings.suggestions || []) : [];
  const countLabel = `${observations.length} observation${observations.length !== 1 ? 's' : ''}`;

  return html`
    <div class="learnings-section">
      <sl-details class="learnings-panel">
        <div slot="summary" class="learnings-header">
          <span class="learnings-icon">${unsafeHTML(iconSvg(Lightbulb, 16))}</span>
          <span class="learnings-title">Learnings</span>
          ${hasData ? html`<span class="learnings-count">${countLabel}</span>` : nothing}
        </div>

        ${!hasData ? html`
          <div class="learnings-empty">
            <p>Learning analysis has not been run for this pipeline execution.</p>
            <sl-button variant="primary" size="small" @click=${options.onRunLearn}
              ?disabled=${options.learnRunning}>
              ${options.learnRunning ? 'Analyzing...' : 'Run Learning Analysis'}
            </sl-button>
          </div>
        ` : html`
          ${summaryStripView(learnings.run_summary)}
          ${observationsTableView(observations)}
          ${suggestionsTableView(suggestions)}
          ${recurringPatternsView(learnings.recurring_patterns)}
        `}
      </sl-details>
    </div>
  `;
}
