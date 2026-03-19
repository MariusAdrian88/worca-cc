import { describe, it, expect } from 'vitest';
import { learningsSectionView, importanceBadge } from './learnings-panel.js';

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
      else if (typeof v === 'number') result += String(v);
      else if (typeof v === 'boolean') result += '';
      else if (Array.isArray(v)) result += v.map(renderToString).join('');
      else if (v && v.strings) result += renderToString(v);
      // unsafeHTML directives, functions, etc. — skip
    }
  });
  return result;
}

const SAMPLE_LEARNINGS = {
  run_summary: {
    termination: 'success',
    total_iterations: 5,
    test_fix_loops: 2,
    review_fix_loops: 1,
    plan_restarts: 0,
  },
  observations: [
    {
      category: 'test_loop',
      importance: 'high',
      description: 'Repeated test failures in auth module',
      evidence: 'Tests failed 3 times before passing',
      occurrences: 3,
    },
    {
      category: 'planning',
      importance: 'medium',
      description: 'Plan missed edge case',
      evidence: 'Auth edge case discovered during implementation',
      occurrences: 1,
    },
  ],
  suggestions: [
    {
      target: 'prompt:tester',
      description: 'Add auth edge case coverage guidance',
      rationale: 'Would prevent repeated test-fix loops',
    },
  ],
  recurring_patterns: {
    cross_bead: [
      { pattern: 'Missing imports', affected_beads: ['bead-1', 'bead-2'], frequency: 4 },
    ],
    test_fix_loops: [
      { pattern: 'Type mismatch in API calls', loop_iterations: 3, resolved: true },
    ],
    review_fix_loops: [],
  },
};

describe('learningsSectionView', () => {
  describe('empty state', () => {
    it('renders empty state when no learnings data', () => {
      const html = renderToString(learningsSectionView(null, { onRunLearn: () => {}, learnRunning: false }));
      expect(html).toContain('learnings-section');
      expect(html).toContain('learnings-empty');
      expect(html).toContain('Learning analysis has not been run');
      expect(html).toContain('Run Learning Analysis');
    });

    it('renders empty state for undefined learnings', () => {
      const html = renderToString(learningsSectionView(undefined, { onRunLearn: () => {}, learnRunning: false }));
      expect(html).toContain('learnings-empty');
    });

    it('shows Analyzing... button text when learnRunning is true', () => {
      const html = renderToString(learningsSectionView(null, { onRunLearn: () => {}, learnRunning: true }));
      expect(html).toContain('Analyzing...');
      expect(html).not.toContain('Run Learning Analysis');
    });
  });

  describe('with learnings data', () => {
    it('renders learnings-section wrapper', () => {
      const html = renderToString(learningsSectionView(SAMPLE_LEARNINGS, { onRunLearn: () => {}, learnRunning: false }));
      expect(html).toContain('learnings-section');
      expect(html).not.toContain('learnings-empty');
    });

    it('renders header with observation count', () => {
      const html = renderToString(learningsSectionView(SAMPLE_LEARNINGS, { onRunLearn: () => {}, learnRunning: false }));
      expect(html).toContain('learnings-header');
      expect(html).toContain('Learnings');
      expect(html).toContain('2 observations');
    });

    it('renders run summary strip', () => {
      const html = renderToString(learningsSectionView(SAMPLE_LEARNINGS, { onRunLearn: () => {}, learnRunning: false }));
      expect(html).toContain('learnings-summary-strip');
      expect(html).toContain('success');
      expect(html).toContain('5');
    });

    it('renders observations table with rows', () => {
      const html = renderToString(learningsSectionView(SAMPLE_LEARNINGS, { onRunLearn: () => {}, learnRunning: false }));
      expect(html).toContain('Observations');
      expect(html).toContain('learnings-table-header');
      expect(html).toContain('learnings-table-row');
      expect(html).toContain('Repeated test failures in auth module');
      expect(html).toContain('test_loop');
      expect(html).toContain('high');
    });

    it('renders suggestions table with rows', () => {
      const html = renderToString(learningsSectionView(SAMPLE_LEARNINGS, { onRunLearn: () => {}, learnRunning: false }));
      expect(html).toContain('Suggestions');
      expect(html).toContain('prompt:tester');
      expect(html).toContain('Add auth edge case coverage guidance');
      expect(html).toContain('Would prevent repeated test-fix loops');
    });

    it('renders recurring patterns section', () => {
      const html = renderToString(learningsSectionView(SAMPLE_LEARNINGS, { onRunLearn: () => {}, learnRunning: false }));
      expect(html).toContain('Recurring Patterns');
      expect(html).toContain('Cross-Bead');
      expect(html).toContain('Missing imports');
      expect(html).toContain('Test-Fix Loops');
      expect(html).toContain('Type mismatch in API calls');
    });

    it('does not render empty recurring pattern sections', () => {
      const html = renderToString(learningsSectionView(SAMPLE_LEARNINGS, { onRunLearn: () => {}, learnRunning: false }));
      // review_fix_loops is empty, should not render its sub-section
      expect(html).not.toContain('Review-Fix Loops');
    });
  });

  describe('edge cases', () => {
    it('handles learnings with no observations', () => {
      const data = { ...SAMPLE_LEARNINGS, observations: [] };
      const html = renderToString(learningsSectionView(data, { onRunLearn: () => {}, learnRunning: false }));
      expect(html).toContain('0 observations');
    });

    it('handles learnings with no suggestions', () => {
      const data = { ...SAMPLE_LEARNINGS, suggestions: [] };
      const html = renderToString(learningsSectionView(data, { onRunLearn: () => {}, learnRunning: false }));
      expect(html).toContain('Suggestions');
      // Should still render the section header but no rows
    });

    it('handles missing recurring_patterns', () => {
      const data = { ...SAMPLE_LEARNINGS, recurring_patterns: undefined };
      const html = renderToString(learningsSectionView(data, { onRunLearn: () => {}, learnRunning: false }));
      expect(html).toContain('learnings-section');
      expect(html).not.toContain('Recurring Patterns');
    });

    it('defaults occurrences to 1 when missing', () => {
      const data = {
        ...SAMPLE_LEARNINGS,
        observations: [{ category: 'test_loop', importance: 'low', description: 'x', evidence: 'y' }],
      };
      const html = renderToString(learningsSectionView(data, { onRunLearn: () => {}, learnRunning: false }));
      // The row should render "1" as the count
      expect(html).toContain('learnings-table-row');
    });
  });
});

describe('importanceBadge', () => {
  it('returns danger for critical', () => {
    expect(importanceBadge('critical')).toBe('danger');
  });

  it('returns warning for high', () => {
    expect(importanceBadge('high')).toBe('warning');
  });

  it('returns primary for medium', () => {
    expect(importanceBadge('medium')).toBe('primary');
  });

  it('returns neutral for low', () => {
    expect(importanceBadge('low')).toBe('neutral');
  });

  it('returns neutral for unknown', () => {
    expect(importanceBadge('unknown')).toBe('neutral');
  });
});
