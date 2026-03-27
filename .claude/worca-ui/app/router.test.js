import { describe, expect, it } from 'vitest';
import { buildHash, parseHash } from './router.js';

describe('router', () => {
  it('parseHash extracts section and runId', () => {
    expect(parseHash('#/active')).toEqual({ section: 'active', runId: null });
    expect(parseHash('#/active?run=abc')).toEqual({
      section: 'active',
      runId: 'abc',
    });
    expect(parseHash('#/history')).toEqual({ section: 'history', runId: null });
    expect(parseHash('')).toEqual({ section: 'active', runId: null });
  });

  it('buildHash creates hash string', () => {
    expect(buildHash('active', null)).toBe('#/active');
    expect(buildHash('active', 'run-1')).toBe('#/active?run=run-1');
  });
});
