import { describe, it, expect } from 'vitest';
import { inferWorkStyle, learnRoutine, matchTask } from '../src/routine.js';
import { DEFAULT_SETTINGS, type Task } from '../src/types.js';

const ev = (day: number, sh: number, sm: number, eh: number, em: number, title: string, month = 9) => ({
  title, start: new Date(2026, month, day, sh, sm).toISOString(), end: new Date(2026, month, day, eh, em).toISOString(),
});
const task = (id: string, name: string): Task => ({ id, name, color: '#000', priority: 1, budgetMinutes: 60, budgetPeriod: 'day', archived: false, createdAt: '' });

describe('inferWorkStyle at the boundaries', () => {
  it('90 is deep, 60 is varied, 61 and 89 are balanced', () => {
    expect(inferWorkStyle([90])).toEqual({ style: 'deep', medianMinutes: 90 });
    expect(inferWorkStyle([60])).toEqual({ style: 'varied', medianMinutes: 60 });
    expect(inferWorkStyle([61])).toEqual({ style: 'balanced', medianMinutes: 61 });
    expect(inferWorkStyle([89])).toEqual({ style: 'balanced', medianMinutes: 89 });
  });
  it('zero and negative lengths are ignored; only such lengths read as unknown', () => {
    expect(inferWorkStyle([0, -5, 120])).toEqual({ style: 'deep', medianMinutes: 120 });
    expect(inferWorkStyle([0, -5])).toEqual({ style: 'unknown', medianMinutes: 0 });
    expect(inferWorkStyle([])).toEqual({ style: 'unknown', medianMinutes: 0 });
  });
  it('an even count takes the lower middle value', () => {
    expect(inferWorkStyle([30, 120])).toEqual({ style: 'varied', medianMinutes: 30 });
    expect(inferWorkStyle([120, 30, 90, 45])).toEqual({ style: 'varied', medianMinutes: 45 });
  });
});

describe('matchTask at the edges', () => {
  const tasks = [task('ml', 'Machine learning'), task('lc', 'Leetcode'), task('mli', 'Machine learning interview')];
  it('an acronym in the title matches the task whose initials it is; the longest matching name wins', () => {
    expect(matchTask('ML practice', tasks)!.id).toBe('mli'); // both "Machine learning" and "Machine learning interview" match; the longer name wins
    expect(matchTask('MLI prep', tasks)!.id).toBe('mli');
    expect(matchTask('leetcode', [tasks[0], tasks[1]])!.id).toBe('lc');
  });
  it('matching ignores case and punctuation; stop words alone match nothing', () => {
    expect(matchTask('LEET-CODE', tasks)).toBeUndefined(); // "leet code" is two tokens, neither "leetcode"
    expect(matchTask('LeetCode!!', tasks)!.id).toBe('lc');
    expect(matchTask('Work session', tasks)).toBeUndefined();
  });
  // Regression (fixed 2026-10-12): an empty (or whitespace-only) title normalizes to '', and every task name includes '', so an untitled event
  // matches every task and is handed to the longest name. Expected: no match (undefined). Actual: the task 'mli'.
  // Cause: routine.ts matchTask, the `t.includes(n) || n.includes(t)` test with t === ''.
  it('an empty title matches no task', () => {
    expect(matchTask('', tasks)).toBeUndefined();
    expect(matchTask('   ', tasks)).toBeUndefined();
  });
  it('a task with an empty or punctuation-only name never matches; a title that is a prefix of a name matches by inclusion', () => {
    expect(matchTask('anything', [task('e', ''), task('p', '---')])).toBeUndefined();
    expect(matchTask('Machine', tasks)!.id).toBe('mli'); // "machine" is inside both names; the longer wins
  });
});

describe('learnRoutine at the edges', () => {
  const tasks = [task('lc', 'Leetcode')];
  it('skips events with an end before or at their start, and events with unparseable dates', () => {
    const r = learnRoutine([
      ev(5, 9, 0, 9, 0, 'Leetcode'), ev(5, 10, 0, 9, 0, 'Leetcode'), { title: 'Leetcode', start: 'nope', end: 'never' },
      ev(6, 9, 0, 10, 0, 'Leetcode'),
    ], tasks, DEFAULT_SETTINGS);
    expect(r.days).toBe(1);
    expect(r.tasks).toEqual([{ taskId: 'lc', name: 'Leetcode', segment: 'morning', minutesPerDay: 60, days: 1, cadence: 'weekly', minutesPerWeek: 60, sessionMinutes: 60 }]);
    expect(r.availability).toEqual([{ days: [2], start: '09:00', end: '10:00' }]);
  });
  it('an event running past midnight ends the day\'s window at 24:00 and counts only the minutes before midnight', () => {
    const r = learnRoutine([{ title: 'Leetcode', start: new Date(2026, 9, 5, 22).toISOString(), end: new Date(2026, 9, 6, 2).toISOString() }], tasks, DEFAULT_SETTINGS);
    expect(r.availability).toEqual([{ days: [1], start: '22:00', end: '24:00' }]);
    expect(r.tasks[0]).toMatchObject({ minutesPerDay: 120, sessionMinutes: 120, segment: 'evening' });
  });
  it('an event ending exactly at midnight is a whole-evening window to 24:00', () => {
    const r = learnRoutine([{ title: 'Leetcode', start: new Date(2026, 9, 5, 23).toISOString(), end: new Date(2026, 9, 6, 0).toISOString() }], tasks, DEFAULT_SETTINGS);
    expect(r.availability).toEqual([{ days: [1], start: '23:00', end: '24:00' }]);
    expect(r.tasks[0].minutesPerDay).toBe(60);
  });
  it('the week start setting decides how many weeks a Saturday and a Sunday span', () => {
    const events = [ev(10, 9, 0, 10, 0, 'Leetcode'), ev(11, 9, 0, 10, 0, 'Leetcode')]; // Sat 10, Sun 11
    expect(learnRoutine(events, tasks, { ...DEFAULT_SETTINGS, weekStartsOn: 0 }).weeks).toBe(2);
    expect(learnRoutine(events, tasks, { ...DEFAULT_SETTINGS, weekStartsOn: 1 }).weeks).toBe(1);
    expect(learnRoutine(events, tasks, { ...DEFAULT_SETTINGS, weekStartsOn: 0 }).tasks[0].minutesPerWeek).toBe(60);
    expect(learnRoutine(events, tasks, { ...DEFAULT_SETTINGS, weekStartsOn: 1 }).tasks[0].minutesPerWeek).toBe(120);
  });
  it('fewer than three routine days is never "daily", even when the task is on every one of them', () => {
    const two = learnRoutine([ev(5, 9, 0, 10, 0, 'Leetcode'), ev(6, 9, 0, 10, 0, 'Leetcode')], tasks, DEFAULT_SETTINGS);
    expect(two.tasks[0].cadence).toBe('weekly');
    const three = learnRoutine([ev(5, 9, 0, 10, 0, 'Leetcode'), ev(6, 9, 0, 10, 0, 'Leetcode'), ev(7, 9, 0, 10, 0, 'Leetcode')], tasks, DEFAULT_SETTINGS);
    expect(three.tasks[0].cadence).toBe('daily');
    const threeOfFive = learnRoutine([ev(5, 9, 0, 10, 0, 'Leetcode'), ev(6, 9, 0, 10, 0, 'Leetcode'), ev(7, 9, 0, 10, 0, 'Leetcode'), ev(8, 9, 0, 10, 0, 'Other'), ev(9, 9, 0, 10, 0, 'Other')], tasks, DEFAULT_SETTINGS);
    expect(threeOfFive.tasks[0].cadence).toBe('daily'); // 3 of 5 days is exactly the 60% line
    const twoOfFour = learnRoutine([ev(5, 9, 0, 10, 0, 'Leetcode'), ev(6, 9, 0, 10, 0, 'Leetcode'), ev(7, 9, 0, 10, 0, 'Other'), ev(8, 9, 0, 10, 0, 'Other')], tasks, DEFAULT_SETTINGS);
    expect(twoOfFour.tasks[0].cadence).toBe('weekly');
  });
  it('the session length snaps to the slot grid and is never shorter than one slot', () => {
    const r = learnRoutine([ev(5, 9, 0, 9, 7, 'Leetcode'), ev(6, 9, 0, 9, 7, 'Leetcode'), ev(7, 9, 0, 9, 52, 'Leetcode')], tasks, { ...DEFAULT_SETTINGS, slotMinutes: 15 });
    expect(r.tasks[0].sessionMinutes).toBe(15); // median 7 rounds to 0 and is lifted to one slot
    expect(r.tasks[0].minutesPerDay).toBe(22); // (7 + 7 + 52) / 3 rounded
  });
  it('overlapping events on one day merge into one window and leave no gap; touching events too', () => {
    const r = learnRoutine([ev(5, 9, 0, 11, 0, 'Leetcode'), ev(5, 10, 0, 12, 0, 'Other'), ev(5, 12, 0, 13, 0, 'Third')], tasks, DEFAULT_SETTINGS);
    expect(r.availability).toEqual([{ days: [1], start: '09:00', end: '13:00' }]);
    expect(r.gaps).toEqual([]);
  });
  it('unmatched titles are grouped by the trimmed title, and their segment is the one with most minutes', () => {
    const r = learnRoutine([ev(5, 9, 0, 10, 0, '  Yoga '), ev(6, 18, 0, 21, 0, 'Yoga')], tasks, DEFAULT_SETTINGS);
    expect(r.unmatched).toEqual([{ title: 'Yoga', segment: 'evening', minutesPerDay: 120, days: 2, cadence: 'weekly', minutesPerWeek: 240, sessionMinutes: 60 }]); // the median of 60 and 180 is the lower middle
  });
});
