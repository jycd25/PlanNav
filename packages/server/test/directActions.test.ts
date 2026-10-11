import { describe, it, expect } from 'vitest';
import { matchDirect, normalizePhrase } from '../src/directActions.js';

describe('normalizePhrase', () => {
  it('lowercases, straightens quotes, collapses spaces and drops trailing punctuation', () => {
    expect(normalizePhrase('  I’m   STARTING now!  ')).toBe("i'm starting now");
    expect(normalizePhrase("What's on today?")).toBe("what's on today");
    expect(normalizePhrase('Apply my baseline to this week.')).toBe('apply my baseline to this week');
  });
});

describe('matchDirect', () => {
  it('maps the chip phrases and the exact intent-table phrases with no free argument to one tool', () => {
    expect(matchDirect("I'm starting now")).toEqual({ tool: 'shift_day', input: {} });
    expect(matchDirect('Start my day.')).toEqual({ tool: 'shift_day', input: {} });
    expect(matchDirect('Apply my baseline to this week')).toEqual({ tool: 'apply_baseline', input: { week_of: 'this week' } });
    expect(matchDirect('Apply my baseline to next week')).toEqual({ tool: 'apply_baseline', input: { week_of: 'next week' } });
    expect(matchDirect('apply my baseline')).toEqual({ tool: 'apply_baseline', input: { week_of: 'next week' } });
    expect(matchDirect("What's on today?")).toEqual({ tool: 'get_schedule', input: {} });
    expect(matchDirect('How am I doing?')).toEqual({ tool: 'get_summary', input: {} });
  });
  it('leaves "let\'s go" to the model: it is as often a yes to the model\'s last question as a start of the day', () => {
    for (const t of ["Let's go!", 'lets go', 'Let’s go.']) expect(matchDirect(t), t).toBeNull();
    expect(matchDirect('start my day')).toEqual({ tool: 'shift_day', input: {} });
    expect(matchDirect("I'm starting now")).toEqual({ tool: 'shift_day', input: {} });
  });
  it('never short-circuits a near match: anything beyond the exact phrase goes to the model', () => {
    for (const t of ["I'm starting now, but skip Reading", "I'm starting now with Building", 'Apply my baseline to this week except Friday', "What's on today and tomorrow?", 'how am i doing this week', 'start', "I'm not starting now", 'Busy until 15:00', 'Plan my day.']) {
      expect(matchDirect(t), t).toBeNull();
    }
  });
});
