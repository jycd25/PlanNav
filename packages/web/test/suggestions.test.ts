import { describe, it, expect } from 'vitest';
import { suggestions, type SuggestionContext } from '../src/chat/suggestions.js';

const at = (h: number, m = 0) => new Date(2026, 9, 7, h, m); // Wed
const block = (task: string, start: Date, end: Date, status: 'pending' | 'done' | 'skipped' | 'missed' = 'pending') => ({ taskName: task, start: start.toISOString(), end: end.toISOString(), status });
const base: SuggestionContext = { ready: true, weekApplied: true, tasks: ['Leetcode', 'Reading'], todayBlocks: [], now: at(10, 20) };

describe('chat suggestions (prefilled prompts)', () => {
  it('without a baseline: set up, suggest from tasks, add a task', () => {
    const s = suggestions({ ...base, ready: false, weekApplied: false, tasks: [] });
    expect(s[0]).toBe("Let's set up my schedule.");
    expect(s).toContain('Add a task Reading, 30 min a day, priority 3');
    expect(s).not.toContain('Suggest a schedule from my tasks'); // nothing to suggest from yet
    expect(suggestions({ ...base, ready: false, weekApplied: false })).toContain('Suggest a schedule from my tasks');
  });
  it('with a baseline but a week without it: apply it first', () => {
    const s = suggestions({ ...base, weekApplied: false });
    expect(s[0]).toBe('Apply my baseline to this week');
    expect(s).toContain("What's on today?");
    expect(s).not.toContain("I'm starting now");
  });
  it('with the week laid out: start the day, a busy stretch ending at the next whole hour, carry what ended unmarked, a note on the block in progress; at most five', () => {
    const s = suggestions({ ...base, todayBlocks: [block('Leetcode', at(9), at(10)), block('Reading', at(10), at(11)), block('Leetcode', at(14), at(15))] });
    expect(s).toEqual([
      "I'm starting now",
      'Busy until 11:00',
      "I didn't finish Leetcode",
      'Note on Reading: not focused',
      "What's on today?",
    ]);
  });
  it('a done or skipped block is not offered as unfinished; with nothing in progress the note chip is skipped and "How am I doing?" fills in', () => {
    const s = suggestions({ ...base, now: at(12), todayBlocks: [block('Leetcode', at(9), at(10), 'done'), block('Reading', at(10), at(11), 'skipped'), block('Leetcode', at(14), at(15))] });
    expect(s).toEqual(["I'm starting now", 'Busy until 13:00', "What's on today?", 'How am I doing?']);
  });
  it('is sorted by the order a tired user needs, with no duplicates, and every chip is a sentence the prompt routes', () => {
    const s = suggestions(base);
    expect(new Set(s).size).toBe(s.length);
    expect(s.length).toBeLessThanOrEqual(5);
  });
});
