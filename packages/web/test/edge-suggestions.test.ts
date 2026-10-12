import { describe, it, expect } from 'vitest';
import { suggestions, type SuggestionContext } from '../src/chat/suggestions.js';

const at = (h: number, m = 0, d = 7) => new Date(2026, 9, d, h, m); // Wed Oct 7 2026 (d = 8 is Thursday)
type Status = 'pending' | 'done' | 'skipped' | 'missed';
const block = (taskName: string, start: Date, end: Date, status: Status = 'pending') => ({ taskName, start: start.toISOString(), end: end.toISOString(), status });
const laid: SuggestionContext = { ready: true, weekApplied: true, tasks: ['Leetcode'], todayBlocks: [], now: at(10) };

describe('suggestions: setup state', () => {
  it('with no baseline and no tasks: exactly three chips, in order', () => {
    expect(suggestions({ ready: false, weekApplied: false, tasks: [], todayBlocks: [], now: at(10) })).toEqual([
      "Let's set up my schedule.", 'Add a task Reading, 30 min a day, priority 3', 'Use my imported calendar as my baseline',
    ]);
  });
  it('with no baseline but tasks: "Suggest a schedule from my tasks" is second', () => {
    expect(suggestions({ ready: false, weekApplied: false, tasks: ['Leetcode'], todayBlocks: [], now: at(10) })).toEqual([
      "Let's set up my schedule.", 'Suggest a schedule from my tasks', 'Add a task Reading, 30 min a day, priority 3', 'Use my imported calendar as my baseline',
    ]);
  });
  it('without a baseline, weekApplied and today\'s blocks are ignored', () => {
    const s = suggestions({ ready: false, weekApplied: true, tasks: [], todayBlocks: [block('Leetcode', at(9), at(10))], now: at(10) });
    expect(s).toEqual(["Let's set up my schedule.", 'Add a task Reading, 30 min a day, priority 3', 'Use my imported calendar as my baseline']);
  });
});

describe('suggestions: baseline not applied', () => {
  it('offers both applies and the day question, whatever the blocks or time', () => {
    const expected = ['Apply my baseline to this week', 'Apply my baseline to next week', "What's on today?"];
    expect(suggestions({ ...laid, weekApplied: false })).toEqual(expected);
    expect(suggestions({ ...laid, weekApplied: false, now: at(23, 55), todayBlocks: [block('Leetcode', at(9), at(10))] })).toEqual(expected);
    expect(suggestions({ ...laid, weekApplied: false, tasks: [] })).toEqual(expected);
  });
});

describe('suggestions: a laid-out day, by the clock', () => {
  it('at 00:05 with nothing yet: start, busy until 01:00, the two questions', () => {
    expect(suggestions({ ...laid, now: at(0, 5) })).toEqual(["I'm starting now", 'Busy until 01:00', "What's on today?", 'How am I doing?']);
  });
  it('at 23:55 the next whole hour is 00:00; an unmarked past block and a block in progress fill the five slots', () => {
    const s = suggestions({ ...laid, now: at(23, 55), todayBlocks: [block('Reading', at(22), at(23)), block('Leetcode', at(23, 30), at(0, 30, 8))] });
    expect(s).toEqual(["I'm starting now", 'Busy until 00:00', "I didn't finish Reading", 'Note on Leetcode: not focused', "What's on today?"]);
    expect(s).toHaveLength(5);
  });
  it('exactly on the hour the busy chip points to the next hour, not the current one', () => {
    expect(suggestions({ ...laid, now: at(14, 0) })[1]).toBe('Busy until 15:00');
    expect(suggestions({ ...laid, now: at(14, 59) })[1]).toBe('Busy until 15:00');
  });
  it('a block ending exactly now counts as over; one starting exactly now counts as in progress', () => {
    const s = suggestions({ ...laid, now: at(10), todayBlocks: [block('Reading', at(9), at(10)), block('Leetcode', at(10), at(11))] });
    expect(s).toContain("I didn't finish Reading");
    expect(s).toContain('Note on Leetcode: not focused');
  });
  it('a block ending exactly now is not "in progress"', () => {
    const s = suggestions({ ...laid, now: at(10), todayBlocks: [block('Reading', at(9), at(10))] });
    expect(s.some((c) => c.startsWith('Note on'))).toBe(false);
  });
  it('a block that is still running past its end (unmarked, ended) is offered as unfinished, not as a note target', () => {
    const s = suggestions({ ...laid, now: at(10, 20), todayBlocks: [block('Leetcode', at(9), at(10))] });
    expect(s).toEqual(["I'm starting now", 'Busy until 11:00', "I didn't finish Leetcode", "What's on today?", 'How am I doing?']);
  });
  it('a missed block is offered as unfinished; done and skipped are not', () => {
    expect(suggestions({ ...laid, todayBlocks: [block('Reading', at(8), at(9), 'missed')] })).toContain("I didn't finish Reading");
    expect(suggestions({ ...laid, todayBlocks: [block('Reading', at(8), at(9), 'done')] })).not.toContain("I didn't finish Reading");
    expect(suggestions({ ...laid, todayBlocks: [block('Reading', at(8), at(9), 'skipped')] })).not.toContain("I didn't finish Reading");
  });
  it('with several unmarked past blocks, the one that ended last is named', () => {
    const s = suggestions({ ...laid, now: at(12), todayBlocks: [block('A', at(7), at(8)), block('C', at(10), at(11)), block('B', at(8), at(9))] });
    expect(s[2]).toBe("I didn't finish C");
  });
  it('a done block in progress gets no note chip; only a pending one does', () => {
    expect(suggestions({ ...laid, todayBlocks: [block('Leetcode', at(9, 30), at(10, 30), 'done')] })).not.toContain('Note on Leetcode: not focused');
    expect(suggestions({ ...laid, todayBlocks: [block('Leetcode', at(9, 30), at(10, 30))] })).toContain('Note on Leetcode: not focused');
  });
  it('a future block contributes nothing', () => {
    expect(suggestions({ ...laid, todayBlocks: [block('Leetcode', at(14), at(15))] })).toEqual(["I'm starting now", 'Busy until 11:00', "What's on today?", 'How am I doing?']);
  });
  it('never more than five chips and never a duplicate, even with many blocks', () => {
    const blocks = Array.from({ length: 12 }, (_, i) => block(`T${i}`, at(i), at(i + 1)));
    const s = suggestions({ ...laid, now: at(12, 30), todayBlocks: blocks });
    expect(s).toHaveLength(5);
    expect(new Set(s).size).toBe(5);
    expect(s).toEqual(["I'm starting now", 'Busy until 13:00', "I didn't finish T11", "What's on today?", 'How am I doing?']);
  });
  it('the task list does not matter once the week is laid out', () => {
    expect(suggestions({ ...laid, tasks: [] })).toEqual(suggestions(laid));
  });
});
