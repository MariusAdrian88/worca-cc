import { html, nothing } from 'lit-html';

export function logViewerView(state, { onStageFilter, onSearch, onToggleAutoScroll, autoScroll }) {
  const { logLines } = state;
  const stages = [...new Set(logLines.map(l => l.stage).filter(Boolean))];

  return html`
    <div class="log-viewer">
      <div class="log-controls">
        <select class="log-stage-filter" @change=${(e) => onStageFilter(e.target.value)}>
          <option value="*">All Stages</option>
          ${stages.map(s => html`<option value="${s}">${s}</option>`)}
        </select>
        <input class="log-search" type="text" placeholder="Filter logs\u2026"
               @input=${(e) => onSearch(e.target.value)} />
        <button class="log-autoscroll-btn ${autoScroll ? 'active' : ''}"
                @click=${onToggleAutoScroll}
                title="${autoScroll ? 'Auto-scroll on' : 'Auto-scroll off'}">
          ${autoScroll ? '\u2193 Auto' : '\u2193 Paused'}
        </button>
      </div>
      <div class="log-lines" id="log-lines">
        ${logLines.length === 0
          ? html`<div class="log-empty">No log output yet</div>`
          : logLines.map(entry => html`
            <div class="log-line">
              ${entry.timestamp ? html`<span class="log-timestamp">${entry.timestamp}</span>` : nothing}
              ${entry.stage ? html`<span class="log-stage-tag">${entry.stage}</span>` : nothing}
              <span class="log-text">${entry.line || entry}</span>
            </div>
          `)}
      </div>
    </div>
  `;
}
