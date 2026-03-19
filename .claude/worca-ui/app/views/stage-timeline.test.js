import { describe, it, expect } from 'vitest';
import { stageTimelineView } from './stage-timeline.js';

function renderToString(template) {
  if (!template) return '';
  if (typeof template === 'string') return template;
  if (!template.strings) return String(template);
  let result = '';
  template.strings.forEach((s, i) => {
    result += s;
    if (i < template.values.length) {
      const v = template.values[i];
      if (typeof v === 'string') result += v;
      else if (Array.isArray(v)) result += v.map(renderToString).join('');
      else if (v && v.strings) result += renderToString(v);
      // unsafeHTML directives are objects with _$litDirective$ — skip them
    }
  });
  return result;
}

describe('stage-timeline STAGE_ICON', () => {
  it('renders skipped stage with status-skipped class', () => {
    const stages = { learn: { status: 'skipped' } };
    const result = stageTimelineView(stages, {}, true);
    const html = renderToString(result);
    expect(html).toContain('status-skipped');
  });

  it('does not pulse or spin for skipped status', () => {
    const stages = { learn: { status: 'skipped' } };
    const result = stageTimelineView(stages, {}, true);
    const html = renderToString(result);
    expect(html).not.toContain('pulse');
    expect(html).not.toContain('icon-spin');
  });
});
