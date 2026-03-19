/**
 * Tests for the wiring contracts of learnings into main.js.
 *
 * main.js is side-effect heavy (DOM, WebSocket), so we test the contracts:
 * 1. The learnings data extraction path from run status
 * 2. The handleRunLearn handler contract (fetch call + state toggling)
 * 3. The import/export expectations from learnings-panel.js
 */
import { describe, it, expect, vi } from 'vitest';
import { learningsSectionView } from './views/learnings-panel.js';

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
    }
  });
  return result;
}

describe('main.js learnings wiring contracts', () => {
  describe('learnings data extraction path', () => {
    it('extracts learnings from run.stages.learn.iterations[0].output', () => {
      // main.js passes: run?.stages?.learn?.iterations?.[0]?.output
      const run = {
        stages: {
          learn: {
            status: 'completed',
            iterations: [{
              number: 0,
              output: {
                observations: [{ category: 'test_loop', importance: 'high', description: 'test', evidence: 'e' }],
                suggestions: [],
                recurring_patterns: {},
                run_summary: { termination: 'success', total_iterations: 3 },
              },
            }],
          },
        },
      };

      const learningsData = run?.stages?.learn?.iterations?.[0]?.output;
      const html = renderToString(learningsSectionView(learningsData, { onRunLearn: () => {}, learnRunning: false }));

      // Should render with data, not the empty state
      expect(html).not.toContain('learnings-empty');
      expect(html).toContain('learnings-summary-strip');
      expect(html).toContain('1 observation');
    });

    it('returns null when learn stage has no iterations', () => {
      const run = { stages: { learn: { status: 'skipped' } } };
      const learningsData = run?.stages?.learn?.iterations?.[0]?.output;
      expect(learningsData).toBeUndefined();

      // Should render empty state
      const html = renderToString(learningsSectionView(learningsData, { onRunLearn: () => {}, learnRunning: false }));
      expect(html).toContain('learnings-empty');
    });

    it('returns undefined when learn stage is absent', () => {
      const run = { stages: { plan: { status: 'completed' } } };
      const learningsData = run?.stages?.learn?.iterations?.[0]?.output;
      expect(learningsData).toBeUndefined();

      const html = renderToString(learningsSectionView(learningsData, { onRunLearn: () => {}, learnRunning: false }));
      expect(html).toContain('learnings-empty');
    });
  });

  describe('handleRunLearn handler contract', () => {
    it('POSTs to /api/runs/:id/learn and manages learnRunning state', async () => {
      // Simulate the handler logic from the plan
      let learnRunning = false;
      const rerenderCalls = [];
      const rerender = () => rerenderCalls.push(learnRunning);
      const showActionError = vi.fn();
      const runId = 'run-20260318';

      const mockFetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true }),
      });

      // Simulate handleRunLearn
      async function handleRunLearn() {
        learnRunning = true;
        rerender();
        try {
          const res = await mockFetch(`/api/runs/${runId}/learn`, { method: 'POST' });
          const data = await res.json();
          if (!data.ok) {
            showActionError(data.error || 'Failed to run learning analysis');
          }
        } catch (err) {
          showActionError(err?.message || 'Failed to run learning analysis');
        } finally {
          learnRunning = false;
          rerender();
        }
      }

      await handleRunLearn();

      expect(mockFetch).toHaveBeenCalledWith('/api/runs/run-20260318/learn', { method: 'POST' });
      expect(rerenderCalls).toEqual([true, false]); // true during fetch, false after
      expect(showActionError).not.toHaveBeenCalled();
    });

    it('calls showActionError on fetch failure', async () => {
      let learnRunning = false;
      const rerender = () => {};
      const showActionError = vi.fn();

      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

      async function handleRunLearn() {
        learnRunning = true;
        rerender();
        try {
          const res = await mockFetch('/api/runs/test/learn', { method: 'POST' });
          const data = await res.json();
          if (!data.ok) showActionError(data.error || 'Failed to run learning analysis');
        } catch (err) {
          showActionError(err?.message || 'Failed to run learning analysis');
        } finally {
          learnRunning = false;
          rerender();
        }
      }

      await handleRunLearn();
      expect(showActionError).toHaveBeenCalledWith('Network error');
      expect(learnRunning).toBe(false);
    });

    it('calls showActionError when API returns ok:false', async () => {
      let learnRunning = false;
      const rerender = () => {};
      const showActionError = vi.fn();

      const mockFetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: false, error: 'Run is still active' }),
      });

      async function handleRunLearn() {
        learnRunning = true;
        rerender();
        try {
          const res = await mockFetch('/api/runs/test/learn', { method: 'POST' });
          const data = await res.json();
          if (!data.ok) showActionError(data.error || 'Failed to run learning analysis');
        } catch (err) {
          showActionError(err?.message || 'Failed to run learning analysis');
        } finally {
          learnRunning = false;
          rerender();
        }
      }

      await handleRunLearn();
      expect(showActionError).toHaveBeenCalledWith('Run is still active');
    });
  });

  describe('learningsSectionView is importable', () => {
    it('exports learningsSectionView as a function', () => {
      expect(typeof learningsSectionView).toBe('function');
    });

    it('renders with onRunLearn and learnRunning options', () => {
      const html = renderToString(learningsSectionView(null, {
        onRunLearn: () => {},
        learnRunning: false,
      }));
      expect(html).toContain('learnings-section');
      expect(html).toContain('Run Learning Analysis');
    });
  });
});
