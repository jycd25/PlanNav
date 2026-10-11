import { describe, it, expect } from 'vitest';
import { learnRoutine } from '../src/routine.js';
import { DEFAULT_SETTINGS, type Task } from '../src/types.js';

// A past week (Mon Sep 28 .. Fri Oct 2, 2026) the user laid out by hand.
const ev = (day: number, sh: number, sm: number, eh: number, em: number, title: string) => ({
  title, start: new Date(2026, 8, day, sh, sm).toISOString(), end: new Date(2026, 8, day, eh, em).toISOString(),
});
const week = [
  ...[28, 29, 30].flatMap((d) => [
    ev(d, 8, 0, 9, 30, 'Morning study'),
    ev(d, 9, 30, 11, 30, 'LeetCode grinding'),
    ev(d, 13, 0, 15, 0, 'ML grinding'),
    ev(d, 15, 0, 17, 0, 'Software — system design & engineering'),
    ev(d, 20, 0, 22, 0, 'Working — startup build'),
  ]),
  ev(31, 9, 0, 12, 0, 'LeetCode grinding'), // Thursday Oct 1
  ev(31, 14, 0, 18, 0, 'Working — startup build'),
  ev(32, 9, 0, 12, 0, 'ML grinding'),       // Friday Oct 2
];
const task = (id: string, name: string): Task => ({ id, name, color: '#000', priority: 1, budgetMinutes: 60, budgetPeriod: 'day', archived: false, createdAt: '' });
const tasks = [task('lc', 'Leetcode'), task('ml', 'Machine learning interview'), task('startup', 'Startup build')];

describe('learnRoutine', () => {
  const r = learnRoutine(week, tasks, DEFAULT_SETTINGS);

  it('derives availability windows per weekday, keeping the gaps between blocks', () => {
    expect(r.availability).toEqual([
      { days: [1, 2, 3], start: '08:00', end: '11:30' },
      { days: [1, 2, 3], start: '13:00', end: '17:00' },
      { days: [1, 2, 3], start: '20:00', end: '22:00' },
      { days: [4, 5], start: '09:00', end: '12:00' }, // identical windows on different weekdays are grouped
      { days: [4], start: '14:00', end: '18:00' },
    ]);
    expect(r.gaps).toEqual([
      { days: [1, 2, 3], start: '11:30', end: '13:00' },
      { days: [1, 2, 3], start: '17:00', end: '20:00' },
      { days: [4], start: '12:00', end: '14:00' },
    ]);
  });

  it('matches event titles to tasks and infers each task\'s segment and typical minutes per day', () => {
    const byId = Object.fromEntries(r.tasks.map((t) => [t.taskId, t]));
    expect(byId.lc).toMatchObject({ name: 'Leetcode', segment: 'morning', minutesPerDay: 135 }); // (120*3 + 180) / 4 days
    expect(byId.ml).toMatchObject({ name: 'Machine learning interview', segment: 'afternoon', minutesPerDay: 135 }); // (120*3 + 180) / 4
    expect(byId.startup).toMatchObject({ name: 'Startup build', segment: 'evening', minutesPerDay: 150 }); // (120*3 + 240) / 4
  });

  it('infers cadence (daily vs weekly), weekly totals, and session length', () => {
    const byId = Object.fromEntries(r.tasks.map((t) => [t.taskId, t]));
    expect(byId.lc).toMatchObject({ cadence: 'daily', minutesPerWeek: 540, sessionMinutes: 120 });      // 4 of 5 days
    expect(byId.startup).toMatchObject({ cadence: 'daily', minutesPerWeek: 600, sessionMinutes: 120 });
    const weeklyOnly = learnRoutine([ev(28, 9, 0, 11, 0, 'Leetcode grinding'), ev(29, 9, 0, 11, 0, 'Morning study'), ev(30, 9, 0, 10, 0, 'Morning study'), ev(31, 9, 0, 11, 0, 'Morning study')], tasks, DEFAULT_SETTINGS);
    expect(weeklyOnly.tasks[0]).toMatchObject({ taskId: 'lc', cadence: 'weekly', minutesPerWeek: 120, sessionMinutes: 120 });
    expect(weeklyOnly.unmatched[0]).toMatchObject({ title: 'Morning study', cadence: 'daily', sessionMinutes: 120 });
  });

  it('reports titles that match no task, with their segment and minutes', () => {
    expect(r.unmatched.map((u) => [u.title, u.segment, u.minutesPerDay, u.days])).toEqual([
      ['Morning study', 'morning', 90, 3],
      ['Software — system design & engineering', 'afternoon', 120, 3],
    ]);
  });

  it('handles an empty calendar', () => {
    expect(learnRoutine([], tasks, DEFAULT_SETTINGS)).toEqual({ availability: [], gaps: [], tasks: [], unmatched: [], days: 0, weeks: 0, workStyle: { style: 'unknown', medianMinutes: 0 } });
  });
});
