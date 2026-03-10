import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { iconSvg, Play, FileText } from '../utils/icons.js';

// Module-level state
let inputType = 'prompt';
let submitStatus = null; // null | 'submitting' | 'error'
let submitError = '';
let planFiles = null; // cached response
let planFilter = '';
let planDropdownOpen = false;
let selectedPlan = '';

function inputLabel(type) {
  if (type === 'source') return 'GitHub Issue URL';
  if (type === 'spec') return 'Spec File Path';
  return 'Prompt';
}

function fetchPlanFiles() {
  if (planFiles) return Promise.resolve(planFiles);
  return fetch('/api/plan-files')
    .then(r => r.json())
    .then(data => {
      if (data.ok) planFiles = data.files;
      return planFiles || [];
    })
    .catch(() => []);
}

function filteredPlanFiles() {
  if (!planFiles) return [];
  if (!planFilter) return planFiles;
  const term = planFilter.toLowerCase();
  return planFiles.filter(f =>
    f.name.toLowerCase().includes(term) || f.path.toLowerCase().includes(term)
  );
}

function groupedPlanFiles(files) {
  const groups = {};
  for (const f of files) {
    if (!groups[f.dir]) groups[f.dir] = [];
    groups[f.dir].push(f);
  }
  return groups;
}

export function newRunView(state, { rerender, onStarted }) {
  const runs = Object.values(state.runs);
  const isRunning = runs.some(r => r.active);

  function handleInputTypeChange(e) {
    inputType = e.target.value;
    rerender();
  }

  function handlePlanFocus() {
    fetchPlanFiles().then(() => {
      planDropdownOpen = true;
      rerender();
    });
  }

  function handlePlanInput(e) {
    planFilter = e.target.value;
    selectedPlan = '';
    planDropdownOpen = true;
    rerender();
  }

  function handlePlanBlur() {
    // Delay to allow click events on dropdown items
    setTimeout(() => {
      planDropdownOpen = false;
      rerender();
    }, 200);
  }

  function handlePlanSelect(file) {
    selectedPlan = file.path;
    planFilter = file.path;
    planDropdownOpen = false;
    rerender();
  }

  function handlePlanClear() {
    selectedPlan = '';
    planFilter = '';
    rerender();
  }

  async function handleSubmit() {
    const inputEl = document.getElementById('new-run-input-value');
    const msizeEl = document.getElementById('new-run-msize');
    const mloopsEl = document.getElementById('new-run-mloops');

    const inputValue = inputEl?.value?.trim() || '';
    if (!inputValue) {
      submitStatus = 'error';
      submitError = 'Please enter a value.';
      rerender();
      return;
    }

    const msize = msizeEl ? parseInt(msizeEl.value, 10) || 1 : 1;
    const mloops = mloopsEl ? parseInt(mloopsEl.value, 10) || 1 : 1;

    submitStatus = 'submitting';
    submitError = '';
    rerender();

    try {
      const body = {
        inputType,
        inputValue,
        msize: Math.max(1, Math.min(10, msize)),
        mloops: Math.max(1, Math.min(10, mloops)),
      };
      if (selectedPlan) body.planFile = selectedPlan;

      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (data.ok) {
        submitStatus = null;
        onStarted();
      } else {
        submitStatus = 'error';
        submitError = data.error || 'Failed to start pipeline';
        rerender();
      }
    } catch (err) {
      submitStatus = 'error';
      submitError = err.message || 'Network error';
      rerender();
    }
  }

  const filtered = filteredPlanFiles();
  const grouped = groupedPlanFiles(filtered);

  return html`
    <div class="new-run-page">
      <div class="new-run-header">
        <h2>Start New Pipeline</h2>
        <p class="text-muted">Configure and launch a new pipeline run.</p>
      </div>

      <div class="new-run-form">
        <div class="new-run-section">
          <div class="settings-field">
            <label class="settings-label">Input Type</label>
            <sl-select id="new-run-input-type" value=${inputType} @sl-change=${handleInputTypeChange}>
              <sl-option value="prompt">Prompt</sl-option>
              <sl-option value="source">GitHub Issue</sl-option>
              <sl-option value="spec">Spec File</sl-option>
            </sl-select>
          </div>

          <div class="settings-field">
            <label class="settings-label">${inputLabel(inputType)}</label>
            ${inputType === 'prompt'
              ? html`<sl-textarea id="new-run-input-value" rows="4" placeholder="Describe what the pipeline should do..."></sl-textarea>`
              : html`<sl-input id="new-run-input-value" placeholder=${inputType === 'source' ? 'https://github.com/...' : 'path/to/spec.md'}></sl-input>`
            }
          </div>
        </div>

        <sl-details summary="Advanced Options">
          <div class="new-run-advanced">
            <div class="new-run-grid">
              <div class="settings-field">
                <label class="settings-label">Size Multiplier (msize)</label>
                <sl-input id="new-run-msize" type="number" min="1" max="10" value="1"></sl-input>
                <span class="settings-field-hint">Scales max_turns per stage (1-10)</span>
              </div>

              <div class="settings-field">
                <label class="settings-label">Loop Multiplier (mloops)</label>
                <sl-input id="new-run-mloops" type="number" min="1" max="10" value="1"></sl-input>
                <span class="settings-field-hint">Scales max loop iterations (1-10)</span>
              </div>
            </div>

            <div class="settings-field">
              <label class="settings-label">Plan File (optional)</label>
              <div class="plan-autocomplete">
                <sl-input
                  id="new-run-plan"
                  placeholder="Type to search plan files..."
                  .value=${planFilter}
                  @sl-input=${handlePlanInput}
                  @sl-focus=${handlePlanFocus}
                  @sl-blur=${handlePlanBlur}
                  clearable
                  @sl-clear=${handlePlanClear}
                >
                  <span slot="prefix">${unsafeHTML(iconSvg(FileText, 14))}</span>
                </sl-input>
                ${planDropdownOpen && filtered.length > 0 ? html`
                  <div class="plan-dropdown">
                    ${Object.entries(grouped).map(([dir, files]) => html`
                      <div class="plan-group-header">${dir}/</div>
                      ${files.map(f => html`
                        <div class="plan-item" @mousedown=${() => handlePlanSelect(f)}>
                          ${f.name}
                        </div>
                      `)}
                    `)}
                  </div>
                ` : nothing}
              </div>
              <span class="settings-field-hint">Skips the planning stage. Relative to project root.</span>
            </div>
          </div>
        </sl-details>

        <div class="new-run-actions">
          <sl-button
            variant="primary"
            size="large"
            ?disabled=${submitStatus === 'submitting' || isRunning}
            @click=${handleSubmit}
          >
            ${unsafeHTML(iconSvg(Play, 16))}
            ${submitStatus === 'submitting' ? 'Starting...' : 'Start Pipeline'}
          </sl-button>
          ${isRunning ? html`<span class="new-run-warning">A pipeline is currently running.</span>` : nothing}
          ${submitStatus === 'error' ? html`<span class="new-run-error">${submitError}</span>` : nothing}
        </div>
      </div>
    </div>
  `;
}
