import { describe, it, expect } from 'vitest';
import { allocate } from '../src/allocate.js';
import { DEFAULT_SETTINGS, STANDARD_WEEK, type Task } from '../src/types.js';

const d = (h: number, m = 0) => new Date(2026, 9, 7, h, m);
const task = (id: string, priority: number): Task => ({
  id, name: id, color: '#000', priority, budgetMinutes: 0, budgetPeriod: 'day', archived: false, createdAt: '',
});
const settings = { ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, maxBlockMinutes: 60, minBlockMinutes: 30, slotMinutes: 15 };

describe('allocate', () => {
  it('weights priority over deficit by default: the top task keeps going while its deficit is still high', () => {
    const r = allocate([{ start: d(9), end: d(13) }], [task('b', 2), task('a', 1)], { a: 120, b: 60 }, settings);
    expect(r.map((x) => [x.taskId, x.start.getHours(), x.end.getHours()])).toEqual([
      ['a', 9, 10],
      ['a', 10, 11],
      ['b', 11, 12],
    ]);
  });

  it('with the deficit weight alone, tasks alternate (pure rotation)', () => {
    const rotation = { ...settings, weights: { priority: 0, deficit: 1 } };
    const r = allocate([{ start: d(9), end: d(13) }], [task('b', 2), task('a', 1)], { a: 120, b: 60 }, rotation);
    expect(r.map((x) => [x.taskId, x.start.getHours(), x.end.getHours()])).toEqual([
      ['a', 9, 10],
      ['b', 10, 11],
      ['a', 11, 12],
    ]);
  });

  it('grades priority across more than two tasks and breaks ties by priority then name', () => {
    const r = allocate([{ start: d(9), end: d(12) }], [task('c', 3), task('b', 2), task('a', 1)], { a: 60, b: 60, c: 60 }, settings);
    expect(r.map((x) => x.taskId)).toEqual(['a', 'b', 'c']);
    const tie = allocate([{ start: d(9), end: d(11) }], [task('y', 1), task('x', 1)], { x: 60, y: 60 }, settings);
    expect(tie.map((x) => x.taskId)).toEqual(['x', 'y']);
  });

  it('places must-do tasks before everything else', () => {
    const r = allocate([{ start: d(9), end: d(12) }], [task('a', 1), task('b', 2), task('c', 3)], { a: 60, b: 60, c: 60 }, settings, { boost: new Set(['c']) });
    expect(r.map((x) => x.taskId)).toEqual(['c', 'a', 'b']);
  });

  it('measures deficit against the period budget when given', () => {
    // a has already received half of its budget earlier; b has received nothing.
    const r = allocate([{ start: d(9), end: d(10) }], [task('a', 1), task('b', 1)], { a: 60, b: 60 }, settings, { periodRemaining: { a: 60, b: 60 }, periodBudget: { a: 120, b: 60 } });
    expect(r.map((x) => x.taskId)).toEqual(['b']);
  });

  it('gives higher priority the time when there is not enough for everyone', () => {
    const r = allocate([{ start: d(9), end: d(10) }], [task('low', 5), task('high', 1)], { low: 60, high: 60 }, settings);
    expect(r).toEqual([{ taskId: 'high', start: d(9), end: d(10) }]);
  });

  it('spans multiple free intervals and respects slot snapping', () => {
    const r = allocate(
      [{ start: d(9), end: d(9, 45) }, { start: d(11), end: d(12) }],
      [task('a', 1)],
      { a: 100 },
      settings,
    );
    expect(r).toEqual([
      { taskId: 'a', start: d(9), end: d(9, 45) },
      { taskId: 'a', start: d(11), end: d(11, 45) },
    ]);
  });

  it('skips tasks with less than minBlockMinutes remaining', () => {
    const r = allocate([{ start: d(9), end: d(12) }], [task('a', 1), task('b', 2)], { a: 20, b: 30 }, settings);
    expect(r).toEqual([{ taskId: 'b', start: d(9), end: d(9, 30) }]);
  });

  it('returns nothing with no free time', () => {
    expect(allocate([], [task('a', 1)], { a: 60 }, settings)).toEqual([]);
  });

  it('waits for a slot long enough for a whole sitting instead of cutting the session at a gap', () => {
    // a (60) fills the first hour; b (120) does not fit the hour left before the gap nor the lunch slot, but 14:00-17:00 holds it whole.
    const sessions = { ...settings, maxBlockMinutes: 120 };
    const b = { ...task('b', 2), sessionMinutes: 120 };
    const a = { ...task('a', 1), sessionMinutes: 60 };
    const r = allocate([{ start: d(9), end: d(11) }, { start: d(12), end: d(13) }, { start: d(14), end: d(17) }], [a, b], { a: 60, b: 120 }, sessions);
    expect(r).toEqual([
      { taskId: 'a', start: d(9), end: d(10) },
      { taskId: 'b', start: d(14), end: d(16) },
    ]);
  });

  it('never leaves the first free minutes empty to wait for a longer slot: a split sitting beats a late start', () => {
    const r = allocate([{ start: d(9), end: d(9, 45) }, { start: d(10, 30), end: d(12, 30) }], [task('a', 1)], { a: 120 }, settings);
    expect(r).toEqual([
      { taskId: 'a', start: d(9), end: d(9, 45) },
      { taskId: 'a', start: d(10, 30), end: d(11, 30) },
    ]);
  });

  it('takes a short slot when no later slot it accepts could hold the whole sitting', () => {
    const r = allocate([{ start: d(9), end: d(10) }, { start: d(11), end: d(11, 45) }, { start: d(13), end: d(16) }], [task('a', 1), task('b', 2)], { a: 60, b: 60 }, settings,
      { accepts: (t, slot) => t.id === 'a' || slot.start.getHours() < 12 });
    // b only accepts morning slots; 11:00-11:45 is the last of them, so b takes it short rather than waiting for the afternoon it may not use.
    expect(r).toEqual([
      { taskId: 'a', start: d(9), end: d(10) },
      { taskId: 'b', start: d(11), end: d(11, 45) },
    ]);
  });

  describe('a long run yields the cursor', () => {
    const weekly = (id: string, priority: number, session: number): Task => ({ ...task(id, priority), budgetPeriod: 'week', sessionMinutes: session });
    const sessions = { ...settings, maxBlockMinutes: 120 };
    const slots = [{ start: d(9), end: d(12) }, { start: d(14), end: d(17) }];
    const show = (r: ReturnType<typeof allocate>) => r.map((x) => [x.taskId, x.start.getHours(), x.end.getHours()]);

    it('a weekly task two sessions into a run lets a task that waits for a longer slot take the short slot', () => {
      // a (session 60) sits 9-11, two sessions. b (session 120) would wait for 14:00, but a's run does not stretch over 11-12: b takes it, scrap rule aside.
      const r = allocate(slots, [weekly('a', 1, 60), weekly('b', 2, 120)], { a: 180, b: 120 }, sessions, { wholeSittings: true });
      expect(show(r).slice(0, 3)).toEqual([['a', 9, 10], ['a', 10, 11], ['b', 11, 12]]);
    });

    it('a waiting task takes the short slot only when it is at least half its sitting: a scrap goes to the run', () => {
      // a (session 60, 150 left) sits 9-11, then 30 minutes to lunch. b (session 120) would get a 30-minute scrap of its 120: it waits for 14:00 and a finishes its run.
      const r = allocate([{ start: d(9), end: d(11, 30) }, { start: d(14), end: d(17) }], [weekly('a', 1, 60), weekly('b', 2, 120)], { a: 150, b: 120 }, sessions, { wholeSittings: true });
      expect(r).toEqual([
        { taskId: 'a', start: d(9), end: d(10) },
        { taskId: 'a', start: d(10), end: d(11) },
        { taskId: 'a', start: d(11), end: d(11, 30) },
        { taskId: 'b', start: d(14), end: d(16) },
      ]);
    });

    it('without a long run a waiting task does not jump the queue: it still waits for its longer slot', () => {
      // a (session 120) sits 9-11, one session: not a long run. b waits for 14:00, a's last hour goes first.
      const r = allocate(slots, [weekly('a', 1, 120), weekly('b', 2, 120)], { a: 180, b: 120 }, sessions, { wholeSittings: true });
      expect(show(r)).toEqual([['a', 9, 11], ['a', 11, 12], ['b', 14, 16]]);
    });

    it('a waiting task takes the cursor only after the candidates that need no waiting', () => {
      // a's run is long; c (session 60) fits here whole and b waits for 14:00: c goes first although b scores higher.
      const r = allocate(slots, [weekly('a', 1, 60), weekly('b', 2, 120), weekly('c', 3, 60)], { a: 180, b: 120, c: 60 }, sessions, { wholeSittings: true });
      expect(show(r).slice(0, 3)).toEqual([['a', 9, 10], ['a', 10, 11], ['c', 11, 12]]);
    });

    it('blocks already on the day (anchors) count toward the run', () => {
      // a sat 8-10 before this call (a hand-placed block); at 10:00 it yields to b, which fits whole.
      const r = allocate([{ start: d(10), end: d(12) }], [weekly('a', 1, 60), weekly('b', 2, 60)], { a: 120, b: 60 }, sessions, { anchors: { a: [{ start: d(8), end: d(10) }] } });
      expect(show(r)).toEqual([['b', 10, 11], ['a', 11, 12]]);
    });

    it('a daily task keeps its run: the rule is for weekly tasks', () => {
      const daily = { ...task('a', 1), sessionMinutes: 60 };
      const r = allocate([{ start: d(10), end: d(12) }], [daily, weekly('b', 2, 60)], { a: 120, b: 60 }, sessions, { anchors: { a: [{ start: d(8), end: d(10) }] } });
      expect(show(r)).toEqual([['a', 10, 11], ['a', 11, 12]]);
    });
  });
});
