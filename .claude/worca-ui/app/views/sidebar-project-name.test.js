import { describe, it, expect } from 'vitest';
import { sidebarView } from './sidebar.js';

function makeState(overrides = {}) {
  return {
    runs: {},
    preferences: { sidebarCollapsed: false },
    beads: { issues: [], dbExists: false },
    projectName: '',
    ...overrides,
  };
}

const route = { section: 'dashboard' };
const conn = 'open';
const handlers = { onNavigate: () => {} };

/**
 * Walk a lit-html TemplateResult tree and collect all string values.
 */
function collectStrings(tpl) {
  const out = [];
  if (!tpl) return out;
  if (tpl.strings) {
    for (const s of tpl.strings) out.push(s);
  }
  if (tpl.values) {
    for (const v of tpl.values) {
      if (typeof v === 'string') out.push(v);
      else if (v && v.strings) out.push(...collectStrings(v));
    }
  }
  return out;
}

function templateContains(tpl, pattern) {
  const all = collectStrings(tpl).join('');
  return pattern instanceof RegExp ? pattern.test(all) : all.includes(pattern);
}

describe('sidebar project name', () => {
  it('renders project-name class when projectName is set', () => {
    const state = makeState({ projectName: 'my-project' });
    const tpl = sidebarView(state, route, conn, handlers);
    expect(templateContains(tpl, 'project-name')).toBe(true);
    expect(templateContains(tpl, 'my-project')).toBe(true);
  });

  it('does not render project-name when projectName is empty', () => {
    const state = makeState({ projectName: '' });
    const tpl = sidebarView(state, route, conn, handlers);
    expect(templateContains(tpl, 'project-name')).toBe(false);
  });

  it('includes collapsed class when sidebar is collapsed', () => {
    const state = makeState({
      projectName: 'my-project',
      preferences: { sidebarCollapsed: true },
    });
    const tpl = sidebarView(state, route, conn, handlers);
    expect(templateContains(tpl, 'collapsed')).toBe(true);
    expect(templateContains(tpl, 'project-name')).toBe(true);
  });
});
