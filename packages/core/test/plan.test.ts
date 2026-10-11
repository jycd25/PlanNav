import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/store.js';
import { plan, resolveUntil } from '../src/plan.js';
import { remainingMinutes } from '../src/budget.js';
import { trackBlock } from '../src/track.js';
import { freeIntervals } from '../src/free.js';
import { DEFAULT_SETTINGS, STANDARD_WEEK, type Task, type Block } from '../src/types.js';

const d = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m); // Oct 2026: 5 Mon, 7 Wed, 9 Fri, 10 Sat
const task = (id: string, priority: number, budgetMinutes: number, budgetPeriod: 'day' | 'week' = 'day'): Task => ({
  id, name: id, color: '#000', priority, budgetMinutes, budgetPeriod, archived: false, createdAt: '2026-10-01T00:00:00.000Z',
});
const block = (id: string, taskId: string, start: Date, end: Date, status: Block['status'] = 'pending'): Block => ({
  id, taskId, start: start.toISOString(), end: end.toISOString(), status, createdAt: start.toISOString(), statusChangedAt: null,
});

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
  store.saveSettings({ ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, maxBlockMinutes: 60, minBlockMinutes: 30, slotMinutes: 15 });
});

describe('resolveUntil', () => {
  it('is end of working day when asked during the day', () => {
    expect(resolveUntil(d(7, 10), store.getSettings(), 'day')).toEqual(d(7, 18));
  });
  it('rolls to the next working day when asked after hours or on a weekend', () => {
    expect(resolveUntil(d(7, 22), store.getSettings(), 'day')).toEqual(d(8, 18));
    expect(resolveUntil(d(10, 10), store.getSettings(), 'day')).toEqual(d(12, 18));
  });
  it('fails clearly instead of recursing when there are no work days', () => {
    const noDays = { ...store.getSettings(), availability: [] };
    expect(() => resolveUntil(d(7, 10), noDays, 'week')).toThrow(/no availability/i);
    expect(() => resolveUntil(d(7, 10), noDays, 'day')).toThrow(/no availability/i);
  });
  it('runs through tomorrow when less than one sitting of today is left', () => {
    const evenings = { ...store.getSettings(), availability: [...STANDARD_WEEK, { days: [1, 2, 3, 4], start: '20:00', end: '22:30' }], maxBlockMinutes: 90 };
    expect(resolveUntil(d(7, 21, 15), evenings, 'day')).toEqual(d(8, 22, 30)); // 75 min left tonight
    expect(resolveUntil(d(7, 20, 30), evenings, 'day')).toEqual(d(7, 22, 30)); // 120 min left: tonight only
    expect(resolveUntil(d(7, 17, 15), store.getSettings(), 'day')).toEqual(d(8, 18)); // 45 min left of a plain work day
  });
  it('is end of the last work day this week for the week horizon', () => {
    expect(resolveUntil(d(7, 10), store.getSettings(), 'week')).toEqual(d(9, 18));
  });
});

describe('remainingMinutes', () => {
  it('subtracts done and pending blocks in the period, ignores skipped and missed', () => {
    const t = task('a', 1, 120);
    const blocks = [
      block('1', 'a', d(7, 9), d(7, 10), 'done'),
      block('2', 'a', d(7, 10), d(7, 10, 30), 'pending'),
      block('3', 'a', d(7, 11), d(7, 12), 'skipped'),
      block('4', 'a', d(6, 11), d(6, 12), 'done'), // yesterday
    ];
    expect(remainingMinutes(t, blocks, d(7, 13), store.getSettings())).toBe(30);
  });
});

describe('plan', () => {
  it('fills the day from now, avoiding commitments, by priority with rotation', () => {
    store.upsertTask(task('deep', 1, 120));
    store.upsertTask(task('email', 2, 60));
    store.addCommitment({ id: 'c1', title: 'Standup', start: d(7, 10).toISOString(), end: d(7, 10, 30).toISOString() });
    const r = plan(store, { now: d(7, 9, 5) });
    const got = r.created.map((b) => [store.getTask(b.taskId)!.name, new Date(b.start).getHours(), new Date(b.start).getMinutes(), new Date(b.end).getHours(), new Date(b.end).getMinutes()]);
    // deep (priority 1) keeps the lead while its deficit is high: 45 min until standup, then 60 more; its last 15 min is under
    // minBlockMinutes and is dropped. email follows.
    expect(got).toEqual([
      ['deep', 9, 15, 10, 0],
      ['deep', 10, 30, 11, 30],
      ['email', 11, 30, 12, 30],
    ]);
  });

  it('marks past pending blocks as missed and keeps future pending blocks that still fit', () => {
    store.upsertTask(task('a', 1, 90));
    store.insertBlocks([
      block('old', 'a', d(7, 9), d(7, 10)),
      block('future', 'a', d(7, 14), d(7, 15)),
    ]);
    const r = plan(store, { now: d(7, 13) });
    expect(r.missed.map((b) => b.id)).toEqual(['old']);
    expect(store.getBlock('old')!.status).toBe('missed');
    expect(store.getBlock('future')).toBeDefined();
    expect(r.kept.map((b) => b.id)).toEqual(['future']);
    expect(r.removed).toBe(0);
    // The missed block means not today: the 30 minutes the kept block leaves stay owed to the day's period but nothing more is placed today.
    expect(r.created).toEqual([]);
  });

  it('keeps done blocks and counts them against the budget', () => {
    store.upsertTask(task('a', 1, 60));
    store.insertBlocks([block('done1', 'a', d(7, 9), d(7, 9, 30), 'done')]);
    const r = plan(store, { now: d(7, 13) });
    expect(r.created.map((b) => [new Date(b.start).getHours(), new Date(b.end).getMinutes()])).toEqual([[13, 30]]);
  });

  it('a block finished early is not topped up: the planner treats its planned minutes as used', () => {
    store.upsertTask(task('a', 1, 60));
    store.insertBlocks([block('a1', 'a', d(7, 9), d(7, 10))]);
    trackBlock(store, 'a1', 'start', d(7, 9));
    trackBlock(store, 'a1', 'finish', d(7, 9, 30));
    const r = plan(store, { now: d(7, 9, 31), until: d(7, 18) });
    expect(r.created.filter((b) => b.taskId === 'a')).toEqual([]);
    expect(store.getBlock('a1')!.end).toBe(d(7, 9, 30).toISOString());
  });

  it('spreads a weekly budget across the remaining work days in whole sessions', () => {
    store.upsertTask(task('w', 1, 300, 'week')); // session = maxBlockMinutes = 60: five sessions over three days
    const r = plan(store, { now: d(7, 9), horizon: 'week' });
    const perDay = new Map<number, number>();
    for (const b of r.created) {
      const day = new Date(b.start).getDate();
      perDay.set(day, (perDay.get(day) ?? 0) + (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000);
    }
    expect([...perDay.keys()].sort()).toEqual([7, 8, 9]);
    expect(perDay.get(7)).toBe(120);
    expect(perDay.get(8)).toBe(120);
    expect(perDay.get(9)).toBe(60);
    expect(r.created.every((b) => (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000 === 60)).toBe(true);
  });

  it('schedules nothing when asked after working hours and rolls to the next day', () => {
    store.upsertTask(task('a', 1, 60));
    const r = plan(store, { now: d(7, 22) });
    expect(r.window.end).toEqual(d(8, 18));
    expect(r.created.every((b) => new Date(b.start).getDate() === 8)).toBe(true);
    expect(r.created.length).toBe(1);
  });

  it('does not count yesterday\'s done blocks against today\'s daily budget', () => {
    store.upsertTask(task('a', 1, 60));
    store.insertBlocks([block('y', 'a', d(6, 9), d(6, 10), 'done')]);
    const r = plan(store, { now: d(7, 9) });
    expect(r.created.length).toBe(1);
  });

  it('re-planning one day inside an already planned week keeps that day\'s block of a weekly budget', () => {
    store.upsertTask(task('w', 1, 300, 'week'));
    const week = plan(store, { now: d(5, 9), horizon: 'week' }); // Mon: 60 min on each of Mon..Fri
    expect(week.created.length).toBe(5);
    const monday = week.created.find((b) => new Date(b.start).getDate() === 5)!;
    store.updateBlock(monday.id, { status: 'done', statusChangedAt: d(5, 10).toISOString() });
    const tuesday = plan(store, { now: d(6, 9) });
    expect(tuesday.removed).toBe(0);
    expect(tuesday.kept.map((b) => b.id)).toEqual([week.created.find((b) => new Date(b.start).getDate() === 6)!.id]);
    expect(tuesday.created).toEqual([]);
    const minutes = store.listBlocks({ from: d(6, 0), to: d(7, 0) }).reduce((n, b) => n + (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000, 0);
    expect(minutes).toBe(60);
  });

  it('re-planning the rest of the same day after a week plan keeps today\'s share', () => {
    store.upsertTask(task('w', 1, 300, 'week'));
    plan(store, { now: d(5, 9), horizon: 'week' });
    const r = plan(store, { now: d(5, 9, 30), until: d(5, 16) }); // the 09-10 sitting is still under way: it is kept, nothing is added
    expect(r.created).toEqual([]);
    expect(r.kept.filter((b) => new Date(b.start).getDate() === 5)).toHaveLength(1);
  });

  it('plans tonight when an evening window exists', () => {
    store.saveSettings({ ...store.getSettings(), availability: [...STANDARD_WEEK, { days: [1, 2, 3, 4], start: '20:00', end: '22:30' }] });
    store.upsertTask(task('a', 1, 60));
    expect(resolveUntil(d(7, 21, 15), store.getSettings(), 'day')).toEqual(d(7, 22, 30));
    const r = plan(store, { now: d(7, 21, 15) });
    expect(r.created.map((b) => [new Date(b.start).getDate(), new Date(b.start).getHours(), new Date(b.start).getMinutes(), new Date(b.end).getHours(), new Date(b.end).getMinutes()])).toEqual([[7, 21, 15, 22, 15]]);
  });

  it('plans tonight and tomorrow when less than one sitting of tonight is left', () => {
    store.saveSettings({ ...store.getSettings(), availability: [...STANDARD_WEEK, { days: [1, 2, 3, 4], start: '20:00', end: '22:30' }], maxBlockMinutes: 90 });
    store.upsertTask(task('a', 1, 60));
    const r = plan(store, { now: d(7, 21, 15) });
    expect(r.window.end).toEqual(d(8, 22, 30));
    expect(r.created.map((b) => [new Date(b.start).getDate(), new Date(b.start).getHours(), new Date(b.start).getMinutes(), new Date(b.end).getHours(), new Date(b.end).getMinutes()])).toEqual([[7, 21, 15, 22, 15], [8, 9, 0, 10, 0]]);
  });

  it('treats recurring commitments as busy', () => {
    store.addRecurring({ id: 'standup', title: 'Standup', days: [1, 2, 3, 4, 5], start: '10:00', end: '10:30' });
    store.upsertTask(task('a', 1, 120));
    const r = plan(store, { now: d(7, 9) });
    expect(r.created.map((b) => [new Date(b.start).getHours(), new Date(b.start).getMinutes(), new Date(b.end).getHours(), new Date(b.end).getMinutes()])).toEqual([[9, 0, 10, 0], [10, 30, 11, 30]]);
  });

  it('places must-do tasks first for the day', () => {
    store.upsertTask(task('deep', 1, 60));
    store.upsertTask(task('email', 3, 60));
    const r = plan(store, { now: d(7, 9), mustDo: ['email'] });
    expect(r.created.map((b) => b.taskId)).toEqual(['email', 'deep']);
  });

  it('must-do means today: on a week horizon the named task leads the first day only', () => {
    store.upsertTask(task('deep', 1, 60));
    store.upsertTask(task('email', 3, 60));
    const r = plan(store, { now: d(5, 9), horizon: 'week', mustDo: ['email'] });
    const byDay = new Map<number, string[]>();
    for (const b of r.created) { const day = new Date(b.start).getDate(); byDay.set(day, [...(byDay.get(day) ?? []), b.taskId]); }
    expect(byDay.get(5)).toEqual(['email', 'deep']);
    for (const day of [6, 7, 8, 9]) expect(byDay.get(day), `day ${day}`).toEqual(['deep', 'email']);
  });

  it('creates nothing when a commitment covers the whole working day', () => {
    store.upsertTask(task('a', 1, 60));
    store.addCommitment({ id: 'c', title: 'Offsite', start: d(7, 8).toISOString(), end: d(7, 19).toISOString() });
    const r = plan(store, { now: d(7, 9) });
    expect(r.created).toEqual([]);
  });
});

describe('re-planning keeps blocks that still fit', () => {
  const at = (b: Block) => [new Date(b.start).getDate(), new Date(b.start).getHours(), new Date(b.start).getMinutes(), new Date(b.end).getHours(), new Date(b.end).getMinutes()];

  it('re-planning the same window keeps every block in place with its id', () => {
    store.upsertTask(task('a', 1, 120));
    store.upsertTask(task('b', 2, 60));
    const first = plan(store, { now: d(7, 9) });
    expect(first.created.length).toBe(3);
    const again = plan(store, { now: d(7, 9) });
    expect(again.removed).toBe(0);
    expect(again.created).toEqual([]);
    expect(again.kept.map((b) => [b.id, b.start, b.end])).toEqual(first.created.map((b) => [b.id, b.start, b.end]));
    expect(store.listBlocks().map((b) => b.id).sort()).toEqual(first.created.map((b) => b.id).sort());
  });

  it('a new commitment replaces only the block it covers; the rest keep their ids and the lost minutes are re-placed', () => {
    store.upsertTask(task('a', 1, 120));
    store.upsertTask(task('b', 2, 60));
    const first = plan(store, { now: d(7, 9) }); // a 09-10, a 10-11, b 11-12
    expect(first.created.map(at)).toEqual([[7, 9, 0, 10, 0], [7, 10, 0, 11, 0], [7, 11, 0, 12, 0]]);
    store.addCommitment({ id: 'c', title: 'Call', start: d(7, 10).toISOString(), end: d(7, 11).toISOString() });
    const again = plan(store, { now: d(7, 9) });
    expect(again.removed).toBe(1);
    expect(again.kept.map((b) => b.id)).toEqual([first.created[0].id, first.created[2].id]);
    expect(again.created.map(at)).toEqual([[7, 12, 0, 13, 0]]);
    expect(store.getBlock(first.created[1].id)).toBeUndefined();
  });

  it('a block outside shrunk availability is replaced, the others are kept', () => {
    store.upsertTask(task('a', 1, 120));
    const first = plan(store, { now: d(7, 9) }); // a 09-10, a 10-11
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '10:00', end: '18:00' }] });
    const again = plan(store, { now: d(7, 9) });
    expect(again.removed).toBe(1);
    expect(again.kept.map((b) => b.id)).toEqual([first.created[1].id]);
    expect(again.created.map(at)).toEqual([[7, 11, 0, 12, 0]]);
  });

  it('a block longer than the task\'s reduced budget is replaced by a shorter one', () => {
    store.upsertTask(task('a', 1, 60));
    plan(store, { now: d(7, 9) }); // a 09-10
    store.upsertTask(task('a', 1, 30));
    const again = plan(store, { now: d(7, 9) });
    expect(again.removed).toBe(1);
    expect(again.kept).toEqual([]);
    expect(again.created.map(at)).toEqual([[7, 9, 0, 9, 30]]);
  });

  it('a block that straddles the window end is still checked against a commitment just outside it', () => {
    store.upsertTask(task('a', 1, 120));
    const first = plan(store, { now: d(7, 9), until: d(7, 12) }); // a 09-10, a 10-11
    expect(first.created.map(at)).toEqual([[7, 9, 0, 10, 0], [7, 10, 0, 11, 0]]);
    store.addCommitment({ id: 'c', title: 'Call', start: d(7, 10, 45).toISOString(), end: d(7, 11, 30).toISOString() });
    const again = plan(store, { now: d(7, 9), until: d(7, 10, 30) });
    expect(again.kept.map((b) => b.id)).toEqual([first.created[0].id]);
    expect(again.removed).toBe(1);
    expect(again.created.map(at)).toEqual([[7, 10, 0, 10, 30]]);
    expect(store.listBlocks().every((b) => new Date(b.end) <= d(7, 10, 45))).toBe(true);
  });

  it('a block of an archived task is removed', () => {
    store.upsertTask(task('a', 1, 60));
    plan(store, { now: d(7, 9) });
    store.upsertTask({ ...task('a', 1, 60), archived: true });
    const again = plan(store, { now: d(7, 9) });
    expect(again.removed).toBe(1);
    expect(store.listBlocks()).toEqual([]);
  });

  it('a kept block of a weekly task uses up that day\'s session, so lost minutes land on the day that lost them', () => {
    store.upsertTask(task('w', 1, 300, 'week'));
    const week = plan(store, { now: d(5, 9), horizon: 'week' }); // 09-10 on each of Mon..Fri
    expect(week.created.length).toBe(5);
    store.addCommitment({ id: 'c', title: 'Call', start: d(7, 9).toISOString(), end: d(7, 10).toISOString() });
    const again = plan(store, { now: d(5, 9), horizon: 'week' });
    expect(again.removed).toBe(1);
    expect(again.kept.length).toBe(4);
    expect(again.created.map(at)).toEqual([[7, 10, 0, 11, 0]]);
  });

  // A week with a free morning hour (09:00-10:00) and an afternoon crumb (12:15-13:00) each day; w, morning-preferring,
  // 300 a week in 120-minute sittings, already holds an hour on Tue, Wed and Fri and needs 120 more, on track for its week.
  const topUpWeek = () => {
    store.saveSettings({ ...store.getSettings(), maxBlockMinutes: 120, availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '13:00' }] });
    store.addRecurring({ id: 's', title: 'Standup', days: [1, 2, 3, 4, 5], start: '10:00', end: '10:15' });
    store.upsertTask({ ...task('x', 1, 120), sessionMinutes: 120 });
    store.upsertTask({ ...task('w', 2, 300, 'week'), preferredSegment: 'morning', sessionMinutes: 120 });
    store.insertBlocks([5, 6, 7, 8, 9].map((day) => block(`x${day}`, 'x', d(day, 10, 15), d(day, 12, 15))));
    store.insertBlocks([6, 7, 9].map((day) => block(`w${day}`, 'w', d(day, 9), d(day, 10))));
    return plan(store, { now: d(5, 9), horizon: 'week' }).created.filter((b) => b.taskId === 'w').map(at);
  };

  it('an in-window day that already holds a sitting of a weekly task takes no top-up while the task is on track', () => {
    store.saveSettings({ ...store.getSettings(), maxBlockMinutes: 120, availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '13:00' }] });
    store.addRecurring({ id: 's', title: 'Standup', days: [1, 2, 3, 4, 5], start: '10:00', end: '10:15' });
    store.upsertTask(task('x', 1, 60));
    store.upsertTask({ ...task('w', 2, 300, 'week'), preferredSegment: 'morning', sessionMinutes: 120 });
    store.insertBlocks([5, 6, 7, 8, 9].map((day) => block(`x${day}`, 'x', d(day, 10, 15), d(day, 11, 15))));
    store.insertBlocks([5, 6, 7].map((day) => block(`w${day}`, 'w', d(day, 9), d(day, 10)))); // w holds an hour Mon..Wed, needs 120 more
    const w = plan(store, { now: d(5, 9), horizon: 'week' }).created.filter((b) => b.taskId === 'w').map(at);
    // Before: Monday and Tuesday were each topped up with 11:15-12:15 on the far side of x. The 120 minutes go to a day
    // that has nothing of w yet.
    expect(w.filter((b) => b[0] <= 7)).toEqual([]);
    expect(w.reduce((n, b) => n + (b[3] - b[1]) * 60 + (b[4] - b[2]), 0)).toBe(120);
  });

  it('the no-top-up rule yields when no other in-window day is open for the task: a Friday-only week does not lose the last hour', () => {
    store.saveSettings({ ...store.getSettings(), maxBlockMinutes: 120, availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '11:15' }] });
    store.addRecurring({ id: 's', title: 'Standup', days: [1, 2, 3, 4, 5], start: '10:00', end: '10:15' });
    store.upsertTask({ ...task('w', 1, 300, 'week'), sessionMinutes: 120 });
    store.upsertTask({ ...task('v', 2, 120, 'week'), sessionMinutes: 120 });
    store.insertBlocks([block('w5', 'w', d(5, 9), d(5, 11, 15), 'done'), block('w6', 'w', d(6, 9), d(6, 9, 45), 'done'), block('w9', 'w', d(9, 9), d(9, 10))]); // 135 + 45 + 60: w has 60 left
    const r = plan(store, { now: d(9, 9), horizon: 'week' }); // Friday only: 10:15-11:15 is the one free hour
    // w holds 09:00-10:00 today and is on track, but no later day remains: its last hour is placed here, whole, before
    // v's scrap of a 120-minute sitting.
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['w', 9, 10, 15, 11, 15]]);
  });

  it('a remainder closes the day of its last whole sitting, touching it where it can; one that cannot touch takes a second spot that day after another block, never opening the day, and System design never takes Wednesday 09:00 across the standup', () => {
    // A cap of 7: the four daily tasks and up to three weekly ones a day (at 4 the weekly tasks get no day at all).
    store.saveSettings({ ...store.getSettings(), maxBlockMinutes: 120, maxTasksPerDay: 7, availability: [
      { days: [1, 2, 3, 4, 5], start: '07:00', end: '13:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }, { days: [1, 2, 3, 4, 5], start: '19:00', end: '21:00' },
    ] });
    store.addRecurring({ id: 'standup', title: 'Standup', days: [1, 2, 3, 4, 5], start: '10:00', end: '10:15' });
    store.upsertTask({ ...task('lc', 1, 60), preferredSegment: 'morning', sessionMinutes: 60 });
    store.upsertTask({ ...task('ai', 2, 60), sessionMinutes: 60 });
    store.upsertTask({ ...task('build', 3, 120), preferredSegment: 'afternoon', sessionMinutes: 120 });
    store.upsertTask({ ...task('startup', 4, 120), preferredSegment: 'evening', sessionMinutes: 120 });
    store.upsertTask({ ...task('beh', 5, 300, 'week'), sessionMinutes: 120 });
    store.upsertTask({ ...task('ail', 6, 300, 'week'), sessionMinutes: 120 });
    store.upsertTask({ ...task('sd', 7, 300, 'week'), preferredSegment: 'morning', sessionMinutes: 120 });
    store.upsertTask({ ...task('ml', 8, 300, 'week'), preferredSegment: 'morning', sessionMinutes: 120 });
    const r = plan(store, { now: d(12, 7), horizon: 'week' });
    // The open minutes from `p` on (inside availability, under no block or standup), and the open minutes ending at `p`.
    const settings = store.getSettings();
    const taken = [...store.listBlocks().map((b) => ({ start: new Date(b.start), end: new Date(b.end) })), ...[12, 13, 14, 15, 16].map((day) => ({ start: d(day, 10), end: d(day, 10, 15) }))];
    const openFrom = (p: Date) => freeIntervals({ start: p, end: new Date(p.getTime() + 4 * 60 * 60_000) }, taken, settings).filter((f) => f.start.getTime() === p.getTime()).map((f) => (f.end.getTime() - f.start.getTime()) / 60_000)[0] ?? 0;
    const openUntil = (p: Date) => freeIntervals({ start: new Date(p.getTime() - 4 * 60 * 60_000), end: p }, taken, settings).filter((f) => f.end.getTime() === p.getTime()).map((f) => (f.end.getTime() - f.start.getTime()) / 60_000)[0] ?? 0;
    // On the days before the last, a weekly task holds a second spot on a day only for a remainder (shorter than a session)
    // that could not touch its whole sitting there: the time right after that sitting and right before it is not open for
    // the remainder's length. The second spot never opens the day: a block ends at or before its start. Friday, the last
    // day, takes what is free.
    for (const id of ['beh', 'ail', 'sd', 'ml']) {
      for (const day of [12, 13, 14, 15]) {
        const spans = r.created.filter((b) => b.taskId === id && new Date(b.start).getDate() === day).sort((a, b) => a.start.localeCompare(b.start));
        const apart = spans.filter((x, i) => i > 0 && x.start !== spans[i - 1].end);
        if (!apart.length) continue;
        const sitting = spans.find((x) => (new Date(x.end).getTime() - new Date(x.start).getTime()) / 60_000 >= 120)!;
        expect(sitting, `${id} on day ${day} has a whole sitting`).toBeDefined();
        expect(spans.length, `${id} on day ${day}: one second spot at most`).toBe(2);
        const spot = spans.find((x) => x !== sitting)!;
        const length = (new Date(spot.end).getTime() - new Date(spot.start).getTime()) / 60_000;
        expect(length, `${id} on day ${day}: the second spot is a remainder`).toBeLessThan(120);
        expect(Math.max(openFrom(new Date(sitting.end)), openUntil(new Date(sitting.start))), `${id} on day ${day}: the sitting could not be touched for ${length} minutes`).toBeLessThan(length);
        expect(store.listBlocks().some((b) => b.id !== spot.id && new Date(b.start).getDate() === day && b.end <= spot.start), `${id} on day ${day}: the second spot does not open the day`).toBe(true);
      }
    }
    expect(r.created.filter((b) => b.taskId === 'sd').map(at)).not.toContainEqual([14, 9, 0, 10, 0]);
    // With a remainder closing its own day, three weekly places a day meet every weekly budget to within a minimum block
    // (Behavioral's hour on Wednesday finds 45 minutes touching its sitting before the lunch gap; the quarter hour is lost).
    for (const id of ['beh', 'ail', 'sd', 'ml']) expect(r.created.filter((b) => b.taskId === id).reduce((n, b) => n + (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60_000, 0), id).toBeGreaterThan(300 - 30);
    expect(r.weeklyUnmet).toEqual([]);
  });

  it('scraps of a segment-preferring task go to its segment on later days before an off-segment crumb on an earlier day', () => {
    expect(topUpWeek()).toEqual([[5, 9, 0, 10, 0], [8, 9, 0, 10, 0]]);
  });

  it('the capped sweep admits the day\'s started tasks and the best new tasks up to the cap in total: hand-placed tasks that fill it admit no newcomer there', () => {
    // Friday 09:00-14:00, cap 2. x and y were placed by hand and y (weekly) still has budget: the capped sweep is theirs, so
    // y fills the day in whole sittings and the priority-1 newcomer z waits for the uncapped sweep, which finds nothing left.
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [5], start: '09:00', end: '14:00' }], maxTasksPerDay: 2 });
    store.upsertTask(task('z', 1, 60));
    store.upsertTask(task('y', 2, 300, 'week'));
    store.upsertTask(task('x', 3, 60));
    store.insertBlocks([{ ...block('hx', 'x', d(9, 9), d(9, 10)), source: 'manual' }, { ...block('hy', 'y', d(9, 10), d(9, 11)), source: 'manual' }]);
    const r = plan(store, { now: d(9, 9) });
    // y's hand-placed hour and two more make its three sessions for the day, the week's last (the rest is unmet).
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['y', 9, 11, 0, 12, 0], ['y', 9, 12, 0, 13, 0]]);
    // With room for one more, the best-scored newcomer is admitted and takes its hour first.
    store.saveSettings({ ...store.getSettings(), maxTasksPerDay: 3 });
    store.deleteBlocks(r.created.map((b) => b.id));
    const wider = plan(store, { now: d(9, 9) });
    expect(wider.created.map((b) => [b.taskId, ...at(b)])).toEqual([['z', 9, 11, 0, 12, 0], ['y', 9, 12, 0, 13, 0], ['y', 9, 13, 0, 14, 0]]);
  });

  it('a task whose block a new commitment covered keeps its claim on what the commitment left of that time, even when started tasks fill the cap', () => {
    // Friday 09:00-14:00, cap 2. x and y were placed by hand; y (weekly) still has budget. z (priority 1) had the planner's
    // 12:00-13:00, which a 12:00-12:30 call cuts short. z is admitted to the capped sweep for the freed 12:30-13:00 and what
    // follows it, so it takes 12:30-13:30 whole by score; y does not top itself up there and leave z a half-hour scrap.
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [5], start: '09:00', end: '14:00' }], maxTasksPerDay: 2 });
    store.upsertTask(task('z', 1, 60));
    store.upsertTask(task('y', 2, 300, 'week'));
    store.upsertTask(task('x', 3, 60));
    store.insertBlocks([
      { ...block('hx', 'x', d(9, 9), d(9, 10)), source: 'manual' },
      { ...block('hy', 'y', d(9, 10), d(9, 11)), source: 'manual' },
      block('pz', 'z', d(9, 12), d(9, 13)),
    ]);
    store.addCommitment({ id: 'call', title: 'Call', start: d(9, 12).toISOString(), end: d(9, 12, 30).toISOString() });
    const r = plan(store, { now: d(9, 9) });
    expect(r.removed).toBe(1);
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['y', 9, 11, 0, 12, 0], ['z', 9, 12, 30, 13, 30]]); // y at its two sessions for the day
  });

  it('a task whose sitting ran past the noon edge keeps the part of it a call leaves, even though that part is shorter than a sitting', () => {
    // The hand-arranged Friday on the merged head: Morning learning's 120 ran 11:00-13:00 across the noon edge; an
    // 11:00-11:30 call cuts it. The freed 11:30-13:00 is 90 minutes: no whole sitting, and cut at 12:00 in the segment
    // pass. It stays Morning learning's (more than half its sitting); Behavioral, started with budget, does not top
    // itself up there and appear twice.
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [5], start: '07:00', end: '13:00' }, { days: [5], start: '14:00', end: '18:00' }], maxBlockMinutes: 120, maxTasksPerDay: 4 });
    store.upsertTask({ ...task('lc', 1, 60), preferredSegment: 'morning', sessionMinutes: 60 });
    store.upsertTask({ ...task('aic', 2, 60), sessionMinutes: 60 });
    store.upsertTask({ ...task('b', 3, 120), preferredSegment: 'afternoon', sessionMinutes: 120 });
    store.upsertTask({ ...task('beh', 5, 300, 'week'), sessionMinutes: 120 });
    store.upsertTask({ ...task('sd', 7, 300, 'week'), preferredSegment: 'morning', sessionMinutes: 120 });
    store.upsertTask({ ...task('ml', 8, 300, 'week'), preferredSegment: 'morning', sessionMinutes: 120 });
    store.insertBlocks([
      { ...block('hl', 'lc', d(9, 7), d(9, 8)), source: 'manual' },
      { ...block('hb', 'b', d(9, 14), d(9, 16)), source: 'manual' },
      block('pa', 'aic', d(9, 8), d(9, 9)), block('ps', 'sd', d(9, 9), d(9, 11)), block('pm', 'ml', d(9, 11), d(9, 13)), block('pb', 'beh', d(9, 16), d(9, 18)),
    ]);
    store.addCommitment({ id: 'call', title: 'Call', start: d(9, 11).toISOString(), end: d(9, 11, 30).toISOString() });
    const r = plan(store, { now: d(9, 7) });
    expect(r.removed).toBe(1);
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['ml', 9, 11, 30, 13, 0]]);
  });

  it('a kept block does not lower its task\'s rank for the per-day cap: a re-plan admits the tasks a fresh plan would', () => {
    store.saveSettings({ ...store.getSettings(), maxTasksPerDay: 2 });
    store.upsertTask(task('kept', 5, 60));
    store.upsertTask(task('flex', 2, 120));
    store.upsertTask({ ...task('weekly', 7, 120, 'week'), preferredSegment: 'morning' });
    store.insertBlocks([block('k', 'kept', d(7, 9), d(7, 10))]);
    const r = plan(store, { now: d(7, 9) });
    expect(r.kept.map((b) => b.id)).toEqual(['k']);
    // flex (priority 2) is admitted beside the kept task, as on a fresh plan: the kept block does not lower flex's rank and
    // the priority-7 task does not take flex's place in the cap. The kept and flex tasks fill the cap of 2, and the
    // weekly task gets the day's one weekly place. Daily tasks lead across passes: flex's two hours take the morning
    // before the weekly task's segment pass, and the weekly task waits for Thursday's morning rather than taking 12:00.
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['flex', 7, 10, 0, 11, 0], ['flex', 7, 11, 0, 12, 0]]);
    expect(r.overCap).toEqual([]);
  });

  it('a block that gave way to a must-do is not reclaimed: its task does not re-take the gap ahead of the must-do', () => {
    // 09:00-12:00, cap 2: sd (mornings) 09-11 and x 11-12 fill the day. w, must-do, needs 120: sd's block gives way (x holds
    // priority 1). With x and w filling the cap, sd could re-enter the capped sweep only by reclaiming its old time the way
    // a task cut by a new commitment does; it must not, or its segment pass would re-take the gap ahead of w.
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' }], maxBlockMinutes: 120, maxTasksPerDay: 2 });
    store.upsertTask(task('x', 1, 60));
    store.upsertTask({ ...task('sd', 2, 120), sessionMinutes: 120, preferredSegment: 'morning' });
    store.upsertTask({ ...task('w', 3, 120, 'week'), sessionMinutes: 120 });
    const first = plan(store, { now: d(7, 9) });
    expect(first.created.map((b) => [b.taskId, ...at(b)])).toEqual([['sd', 7, 9, 0, 11, 0], ['x', 7, 11, 0, 12, 0]]);
    const r = plan(store, { now: d(7, 9), mustDo: ['w'] });
    expect(r.displaced.map(at)).toEqual([[7, 9, 0, 11, 0]]);
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['w', 7, 9, 0, 11, 0]]);
  });

  it('with room in the cap, a displaced task re-entering as a newcomer still does not take the held gap ahead of the must-do', () => {
    // Same day as above with the default cap (5): sd is admitted to the capped sweep as a newcomer, and the gap opened for w
    // stays w's through sd's segment pass (the held gap of 2197bd6); pinned so a pass reorder cannot undo it.
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' }], maxBlockMinutes: 120 });
    store.upsertTask(task('x', 1, 60));
    store.upsertTask({ ...task('sd', 2, 120), sessionMinutes: 120, preferredSegment: 'morning' });
    store.upsertTask({ ...task('w', 3, 120, 'week'), sessionMinutes: 120 });
    plan(store, { now: d(7, 9) }); // sd 09-11, x 11-12
    const r = plan(store, { now: d(7, 9), mustDo: ['w'] });
    expect(r.displaced.map(at)).toEqual([[7, 9, 0, 11, 0]]);
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['w', 7, 9, 0, 11, 0]]);
  });

  it('a must-do asked after hours holds its gap through the next day\'s segment pass: the block that gave way does not re-take it, and a second plan changes nothing', () => {
    // Wednesday 19:30, after the day's window: the plan runs on Thursday 09:00-11:00, which a (mornings) fills. w, must-do,
    // displaces a's block. The gap must stay held until Thursday's flexible pass, not open on the empty Wednesday the sweep
    // iterates first, or a's segment pass re-takes it, w is never placed, and every re-plan repeats the displacement.
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '11:00' }], maxBlockMinutes: 120 });
    store.upsertTask({ ...task('a', 2, 120), sessionMinutes: 120, preferredSegment: 'morning' });
    store.upsertTask({ ...task('w', 3, 60, 'week'), sessionMinutes: 60 });
    const first = plan(store, { now: d(7, 19, 30) });
    expect(first.created.map((b) => [b.taskId, ...at(b)])).toEqual([['a', 8, 9, 0, 11, 0]]);
    const r = plan(store, { now: d(7, 19, 30), mustDo: ['w'] });
    expect(r.displaced.map(at)).toEqual([[8, 9, 0, 11, 0]]);
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['w', 8, 9, 0, 10, 0], ['a', 8, 10, 0, 11, 0]]);
    const again = plan(store, { now: d(7, 19, 30), mustDo: ['w'] });
    expect([again.created, again.displaced, again.removed]).toEqual([[], [], 0]);
  });

  it('a must-do task that has less than a sitting today is extended to a whole one when the time after its block is free', () => {
    // a has 30 planned minutes of a 60-minute sitting at 09:00 and the half hour after is free: the block grows to 09:00-10:00
    // instead of being reported as "already has 09:00-09:30". A second identical plan then changes nothing.
    store.upsertTask(task('a', 2, 60));
    store.upsertTask(task('b', 1, 60));
    store.insertBlocks([block('pa', 'a', d(7, 9), d(7, 9, 30))]);
    const r = plan(store, { now: d(7, 9), mustDo: ['a'] });
    expect(r.extended.map((b) => [b.id, ...at(b)])).toEqual([['pa', 7, 9, 0, 10, 0]]);
    expect(store.getBlock('pa')!.end).toBe(d(7, 10).toISOString());
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['b', 7, 10, 0, 11, 0]]);
    const again = plan(store, { now: d(7, 9), mustDo: ['a'] });
    expect([again.extended, again.created, again.displaced, again.removed]).toEqual([[], [], [], 0]);
  });

  it('a must-do task whose scrap cannot grow gets a whole sitting elsewhere, in free time before anything gives way', () => {
    // a's 09:00-09:30 is followed by a hand-placed block: it cannot grow. a has budget for a whole sitting, so one is added
    // in the free time at 11:00; nothing is displaced.
    store.upsertTask(task('a', 2, 120));
    store.upsertTask(task('c', 1, 90));
    store.insertBlocks([block('pa', 'a', d(7, 9), d(7, 9, 30)), { ...block('hc', 'c', d(7, 9, 30), d(7, 11)), source: 'manual' }]);
    const r = plan(store, { now: d(7, 9), mustDo: ['a'] });
    expect(r.extended).toEqual([]);
    expect(r.displaced).toEqual([]);
    expect(r.created[0]).toMatchObject({ taskId: 'a', start: d(7, 11).toISOString(), end: d(7, 12).toISOString() });
    expect(store.getBlock('pa')!.end).toBe(d(7, 9, 30).toISOString());
  });

  // Skipped on the merged head: with the no-top-up rule yielding on a day plan (no other in-window day), the first plan
  // already gives w 13:30-14:30, so this shape no longer has a half sitting; slot 2 is re-shaping it. The fuzz covers case 28.
  it.skip('a must-do weekly task with a hand-placed half hour today still gets its whole sitting: the no-top-up allowance yields to the sitting held for it', () => {
    // Fuzz seed 20261012 case 28. Monday 08:30-11:30 and 13:30-14:30 with a 10:00-11:00 standup, cap 2. w (weekly, 75-minute
    // sittings, afternoons) has a hand-placed 11:00-11:30; t1 (weekly, any) fills the rest. must_do w: t1's morning block
    // gives way and w takes the 75 minutes. Before, the on-track no-top-up rule zeroed w's allowance for the day, the gap went
    // to the daily morning task t0 instead, and every re-plan displaced t1 again.
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '08:30', end: '11:30' }, { days: [1, 2, 3, 4, 5], start: '13:30', end: '14:30' }], maxBlockMinutes: 90, maxTasksPerDay: 2 });
    store.addRecurring({ id: 'standup', title: 'Standup', days: [1, 2, 3, 4, 5], start: '10:00', end: '11:00' });
    store.upsertTask({ ...task('t1', 2, 420, 'week'), sessionMinutes: 75 });
    store.upsertTask({ ...task('t0', 3, 405), sessionMinutes: 45, preferredSegment: 'morning' });
    store.upsertTask({ ...task('w', 4, 120, 'week'), sessionMinutes: 75, preferredSegment: 'afternoon' });
    store.insertBlocks([{ ...block('hw', 'w', d(5, 11), d(5, 11, 30)), source: 'manual' }]);
    const first = plan(store, { now: d(5, 8) });
    expect(first.created.map((b) => [b.taskId, ...at(b)])).toEqual([['t1', 5, 8, 30, 9, 45], ['t1', 5, 13, 30, 14, 30]]);
    const r = plan(store, { now: d(5, 8), mustDo: ['w'] });
    expect(r.displaced.map(at)).toEqual([[5, 8, 30, 9, 45]]);
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['w', 5, 8, 30, 9, 45]]);
    const again = plan(store, { now: d(5, 8), mustDo: ['w'] });
    expect([again.created, again.displaced, again.extended, again.removed]).toEqual([[], [], [], 0]);
  });

  it('the split-sitting-beats-a-late-start rule fires at the window\'s first available minute, not at the first gap a re-plan finds free', () => {
    // Fuzz seed 20261012 case 86. Sunday evening, Monday 09:00-11:00 / 12:30-16:00 / 17:30-19:00 with a baseline block
    // 09:00-10:30. The first plan splits w's 90-minute sitting at 10:30 (30 before the gap, 60 later): the day's first
    // minute. On the identical second plan the first free minute is 12:30, behind w's kept 10:30-11:00; it must not count
    // as the window's start, or the extra weekly sweep takes a 30-minute scrap there and the plan is not idempotent.
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1], start: '09:00', end: '11:00' }, { days: [1], start: '12:30', end: '16:00' }, { days: [1], start: '17:30', end: '19:00' }, { days: [2, 3, 4, 5], start: '09:00', end: '12:00' }], maxBlockMinutes: 60, maxTasksPerDay: 4, segments: { morningEnd: '13:00', afternoonEnd: '17:00' } });
    store.upsertTask({ ...task('t0', 3, 75), sessionMinutes: 45, preferredSegment: 'afternoon' });
    store.upsertTask({ ...task('t1', 3, 180, 'week'), sessionMinutes: 105, preferredSegment: 'evening' });
    store.upsertTask({ ...task('t2', 6, 180, 'week'), sessionMinutes: 60, preferredSegment: 'evening' });
    store.upsertTask({ ...task('t3', 4, 270, 'week'), sessionMinutes: 90 });
    store.insertBlocks([{ ...block('bl', 't1', d(5, 9), d(5, 10, 30)), source: 'baseline' }]);
    const first = plan(store, { now: d(4, 19, 15) }); // Sunday 19:15: the plan runs on Monday
    expect(first.created.map((b) => [b.taskId, ...at(b)])).toEqual([['t3', 5, 10, 30, 11, 0], ['t0', 5, 13, 0, 13, 45], ['t0', 5, 13, 45, 14, 15], ['t3', 5, 14, 15, 15, 15]]);
    const again = plan(store, { now: d(4, 19, 15) });
    expect([again.created, again.removed]).toEqual([[], 0]);
  });

  it('a must-do task with no block on a full day displaces the lowest-priority planner blocks, adjacent ones when its sitting is longer', () => {
    store.upsertTask(task('a', 1, 300));
    store.upsertTask(task('b', 2, 240));
    plan(store, { now: d(7, 9) }); // a 09-14, b 14-18
    store.upsertTask({ ...task('g', 3, 120), sessionMinutes: 120 });
    const r = plan(store, { now: d(7, 9), mustDo: ['g'] });
    expect(r.displaced.map(at)).toEqual([[7, 14, 0, 15, 0], [7, 15, 0, 16, 0]]);
    expect(r.removed).toBe(0);
    expect(r.kept.length).toBe(7);
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['g', 7, 14, 0, 16, 0]]);
  });

  it('a must-do task on a week horizon displaces only on the first day; the other days stay as they were', () => {
    store.upsertTask(task('a', 1, 300));
    store.upsertTask(task('b', 2, 240));
    const week = plan(store, { now: d(5, 9), horizon: 'week' }); // every day full: a 09-14, b 14-18
    expect(week.created.length).toBe(45);
    store.upsertTask(task('g', 3, 60));
    const r = plan(store, { now: d(5, 9), horizon: 'week', mustDo: ['g'] });
    expect(r.displaced.map(at)).toEqual([[5, 14, 0, 15, 0]]);
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['g', 5, 14, 0, 15, 0]]);
    expect(r.kept.length).toBe(44);
    expect(r.removed).toBe(0);
  });

  it('two must-do tasks on a full day each get a sitting: the gap opened for one is not counted as room for the other', () => {
    store.upsertTask(task('a', 1, 300));
    store.upsertTask(task('b', 2, 240));
    plan(store, { now: d(7, 9) }); // a 09-14, b 14-18
    store.upsertTask(task('g', 3, 60));
    store.upsertTask(task('h', 4, 60));
    const r = plan(store, { now: d(7, 9), mustDo: ['g', 'h'] });
    expect(r.displaced.map(at)).toEqual([[7, 14, 0, 15, 0], [7, 15, 0, 16, 0]]);
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['g', 7, 14, 0, 15, 0], ['h', 7, 15, 0, 16, 0]]);
    expect(r.kept.length).toBe(7);
  });

  it('a must-do task whose grid-rounded sitting already fits a free gap displaces nothing', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:45' }] });
    store.upsertTask(task('a', 1, 480));
    plan(store, { now: d(7, 9) }); // a 09-17, 45 free minutes left
    store.upsertTask(task('g', 2, 50)); // the allocator places 45 of these 50 minutes
    const r = plan(store, { now: d(7, 9), mustDo: ['g'] });
    expect(r.displaced).toEqual([]);
    expect(r.kept.length).toBe(8);
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['g', 7, 17, 0, 17, 45]]);
  });

  it('a must-do task displaces the lowest-priority block that alone leaves room, not a shorter one plus its higher-priority neighbour', () => {
    store.upsertTask(task('low', 9, 60));
    store.upsertTask({ ...task('mid', 5, 120), sessionMinutes: 120 });
    store.upsertTask({ ...task('top', 1, 360), sessionMinutes: 120 });
    store.insertBlocks([
      block('l', 'low', d(7, 9), d(7, 10)), block('m', 'mid', d(7, 10), d(7, 12)),
      block('t1', 'top', d(7, 12), d(7, 14)), block('t2', 'top', d(7, 14), d(7, 16)), block('t3', 'top', d(7, 16), d(7, 18)),
    ]);
    store.upsertTask({ ...task('g', 2, 120), sessionMinutes: 120 });
    const r = plan(store, { now: d(7, 9), mustDo: ['g'] });
    expect(r.displaced.map((b) => b.id)).toEqual(['m']);
    expect(r.kept.map((b) => b.id)).toEqual(['l', 't1', 't2', 't3']);
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['g', 7, 10, 0, 12, 0]]);
  });

  it('when no single block holds the sitting, the cheapest adjacent run gives way: the run whose best task matters least, not the lowest block plus its neighbour', () => {
    for (const [p, h] of [[9, 9], [1, 10], [2, 11], [3, 12], [4, 13], [8, 14], [7, 15], [6, 16], [5, 17]]) {
      store.upsertTask(task(`p${p}`, p, 60));
      store.insertBlocks([block(`b${h}`, `p${p}`, d(7, h), d(7, h + 1))]);
    }
    store.upsertTask({ ...task('g', 10, 120), sessionMinutes: 120 });
    const r = plan(store, { now: d(7, 9), mustDo: ['g'] });
    // p9@09 plus p1@10 would also make room, but that run holds the top task's only hour; p8@14 plus p7@15 costs the least.
    expect(r.displaced.map((b) => b.id)).toEqual(['b14', 'b15']);
    expect(r.kept.map((b) => b.id)).toEqual(['b9', 'b10', 'b11', 'b12', 'b13', 'b16', 'b17']);
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['g', 7, 14, 0, 16, 0]]);
  });

  it('among victims of equal cost, a block whose task keeps another sitting in its period gives way before a task\'s only one', () => {
    store.upsertTask(task('solo', 5, 60));
    store.upsertTask(task('pair', 5, 120));
    store.upsertTask({ ...task('top', 1, 360), sessionMinutes: 120 });
    store.insertBlocks([
      block('s', 'solo', d(7, 9), d(7, 10)), block('p1', 'pair', d(7, 10), d(7, 11)), block('p2', 'pair', d(7, 11), d(7, 12)),
      block('t1', 'top', d(7, 12), d(7, 14)), block('t2', 'top', d(7, 14), d(7, 16)), block('t3', 'top', d(7, 16), d(7, 18)),
    ]);
    store.upsertTask(task('g', 3, 60));
    const r = plan(store, { now: d(7, 9), mustDo: ['g'] });
    // solo@09 is the earliest priority-5 block, but it is solo's only sitting today; pair keeps 11-12.
    expect(r.displaced.map((b) => b.id)).toEqual(['p1']);
    expect(r.kept.map((b) => b.id)).toEqual(['s', 'p2', 't1', 't2', 't3']);
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['g', 7, 10, 0, 11, 0]]);
  });

  it('the gap a block opened for a must-do task is not taken by a task that prefers that segment: the must-do gets it', () => {
    store.upsertTask(task('a', 1, 180));
    store.upsertTask(task('b', 2, 360));
    store.insertBlocks([9, 10, 11].map((h) => block(`a${h}`, 'a', d(7, h), d(7, h + 1))));
    store.insertBlocks([12, 13, 14, 15, 16, 17].map((h) => block(`b${h}`, 'b', d(7, h), d(7, h + 1))));
    store.upsertTask({ ...task('pm', 4, 60), preferredSegment: 'afternoon' }); // never got a block: the day was full
    store.upsertTask(task('g', 3, 60));
    const r = plan(store, { now: d(7, 9), mustDo: ['g'] });
    expect(r.displaced.map((b) => b.id)).toEqual(['b12']);
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['g', 7, 12, 0, 13, 0]]);
  });

  it('a run may span a free gap between its blocks: the gap counts toward the room the run makes', () => {
    store.upsertTask(task('x', 5, 60));
    store.upsertTask(task('y', 5, 60));
    store.upsertTask({ ...task('top', 1, 390), sessionMinutes: 150 });
    store.insertBlocks([
      block('x', 'x', d(7, 9), d(7, 10)), block('y', 'y', d(7, 10, 30), d(7, 11, 30)), // 10:00-10:30 is free: too short for the sitting on its own
      block('t1', 'top', d(7, 11, 30), d(7, 13, 30)), block('t2', 'top', d(7, 13, 30), d(7, 15, 30)), block('t3', 'top', d(7, 15, 30), d(7, 18)),
    ]);
    store.upsertTask({ ...task('g', 3, 120), sessionMinutes: 120 });
    const r = plan(store, { now: d(7, 9), mustDo: ['g'] });
    // x alone leaves 09:00-10:30, y alone 10:00-11:30, neither 120; x and y together leave 09:00-11:30, cheaper than any top block.
    expect(r.displaced.map((b) => b.id)).toEqual(['x', 'y']);
    expect(r.created.filter((b) => b.taskId === 'g').map(at)).toEqual([[7, 9, 0, 11, 0]]);
  });

  it('a run costs the sum over its blocks of 0.5 + priority score: one p5 sitting (1.0) gives way before p6 + p7 (1.625)', () => {
    store.upsertTask({ ...task('top', 1, 300), sessionMinutes: 120 });
    store.upsertTask({ ...task('five', 5, 120), sessionMinutes: 120 });
    store.upsertTask(task('six', 6, 60));
    store.upsertTask(task('seven', 7, 60));
    store.insertBlocks([
      block('t1', 'top', d(7, 9), d(7, 11)), block('f', 'five', d(7, 11), d(7, 13)), block('s', 'six', d(7, 13), d(7, 14)),
      block('e', 'seven', d(7, 14), d(7, 15)), block('t2', 'top', d(7, 15), d(7, 17)), block('t3', 'top', d(7, 17), d(7, 18)),
    ]);
    store.upsertTask({ ...task('g', 9, 120), sessionMinutes: 120 });
    const r = plan(store, { now: d(7, 9), mustDo: ['g'] });
    // Priority scores over priorities 1..9: p1 1, p5 0.5, p6 0.375, p7 0.25. The user wanted one task disrupted, not two.
    expect(r.displaced.map((b) => b.id)).toEqual(['f']);
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['g', 7, 11, 0, 13, 0]]);
  });

  it('two bottom hours cost less than one top sitting: p8 + p9 (1.125) give way before a p1 block (1.5)', () => {
    store.upsertTask({ ...task('top', 1, 420), sessionMinutes: 120 });
    store.upsertTask(task('eight', 8, 60));
    store.upsertTask(task('nine', 9, 60));
    store.insertBlocks([
      block('t1', 'top', d(7, 9), d(7, 11)), block('t2', 'top', d(7, 11), d(7, 13)), block('t3', 'top', d(7, 13), d(7, 15)),
      block('e', 'eight', d(7, 15), d(7, 16)), block('n', 'nine', d(7, 16), d(7, 17)), block('t4', 'top', d(7, 17), d(7, 18)),
    ]);
    store.upsertTask({ ...task('g', 3, 120), sessionMinutes: 120 });
    const r = plan(store, { now: d(7, 9), mustDo: ['g'] });
    expect(r.displaced.map((b) => b.id)).toEqual(['e', 'n']);
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['g', 7, 15, 0, 17, 0]]);
  });

  it('the gap opened for a must-do stays held through the first window day\'s segment pass: named at 22:00 for a full tomorrow, the afternoon task that gave way does not re-take its own gap', () => {
    store.upsertTask(task('a', 1, 300));
    store.upsertTask({ ...task('z', 2, 240), sessionMinutes: 120, preferredSegment: 'afternoon' });
    store.insertBlocks([9, 10, 11, 12, 13].map((h) => block(`a${h}`, 'a', d(8, h), d(8, h + 1))));
    store.insertBlocks([block('z14', 'z', d(8, 14), d(8, 16)), block('z16', 'z', d(8, 16), d(8, 18))]);
    store.upsertTask({ ...task('g', 3, 120), sessionMinutes: 120 });
    const r = plan(store, { now: d(7, 22), mustDo: ['g'] }); // after hours: the window is Thursday
    expect(r.displaced.map((b) => b.id)).toEqual(['z14']);
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['g', 8, 14, 0, 16, 0]]);
  });

  describe('a must-do lands on the first window day whenever a displacement happened or free room existed', () => {
    // Thursday the 8th full: a 09:00-14:00 by the hour, z (afternoons, 120-minute sittings) 14:00-18:00.
    const fullThursday = (free?: 'afternoon') => {
      store.upsertTask(task('a', 1, 300));
      store.upsertTask({ ...task('z', 2, 240), sessionMinutes: 120, preferredSegment: 'afternoon' });
      store.insertBlocks([9, 10, 11, 12, 13].map((h) => block(`a${h}`, 'a', d(8, h), d(8, h + 1))));
      store.insertBlocks(free ? [block('z16', 'z', d(8, 16), d(8, 18))] : [block('z14', 'z', d(8, 14), d(8, 16)), block('z16', 'z', d(8, 16), d(8, 18))]);
    };
    const minutesOn = (r: ReturnType<typeof plan>, id: string, day: number) => r.created.filter((b) => b.taskId === id && new Date(b.start).getDate() === day).reduce((n, b) => n + (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000, 0);
    const shapes: Array<[name: string, setup: () => void, opts: Parameters<typeof plan>[1], wants: Array<[id: string, minutes: number]>]> = [
      ['at 09:00 on a full day', () => { fullThursday(); store.upsertTask({ ...task('g', 3, 120), sessionMinutes: 120 }); }, { now: d(8, 9), mustDo: ['g'] }, [['g', 120]]],
      ['at 22:00 the night before a full day', () => { fullThursday(); store.upsertTask({ ...task('g', 3, 120), sessionMinutes: 120 }); }, { now: d(7, 22), mustDo: ['g'] }, [['g', 120]]],
      ['on a week horizon the night before a full day', () => { fullThursday(); store.upsertTask({ ...task('g', 3, 120), sessionMinutes: 120 }); }, { now: d(7, 22), horizon: 'week', mustDo: ['g'] }, [['g', 120]]],
      ['a morning task named at 13:00 with its morning past', () => { fullThursday(); store.upsertTask({ ...task('g', 3, 120), sessionMinutes: 120, preferredSegment: 'morning' }); }, { now: d(8, 13), mustDo: ['g'] }, [['g', 120]]],
      ['two must-dos the night before a full day', () => { fullThursday(); store.upsertTask({ ...task('g', 3, 120), sessionMinutes: 120 }); store.upsertTask(task('h', 4, 60)); }, { now: d(7, 22), mustDo: ['g', 'h'] }, [['g', 120], ['h', 60]]],
      ['free room the night before, which the afternoon task would otherwise take in its segment pass', () => { fullThursday('afternoon'); store.upsertTask({ ...task('g', 3, 120), sessionMinutes: 120 }); }, { now: d(7, 22), mustDo: ['g'] }, [['g', 120]]],
      ['at 10:30 with a block in progress on a full day', () => { fullThursday(); store.upsertTask({ ...task('g', 3, 120), sessionMinutes: 120 }); }, { now: d(8, 10, 30), mustDo: ['g'] }, [['g', 120]]],
    ];
    it.each(shapes)('%s', (_name, setup, opts, wants) => {
      setup();
      const r = plan(store, opts);
      const room = freeIntervals({ start: d(8, 0), end: d(9, 0) }, [], store.getSettings()).length > 0;
      expect(r.displaced.length > 0 || room).toBe(true);
      for (const [id, minutes] of wants) expect(minutesOn(r, id, 8), id).toBeGreaterThanOrEqual(minutes);
      // What gave way is not re-created where it was.
      for (const v of r.displaced) expect(r.created.some((b) => b.taskId === v.taskId && b.start === v.start)).toBe(false);
    });
  });

  it('a must-do task never displaces manual or baseline blocks', () => {
    store.upsertTask(task('a', 1, 540));
    store.upsertTask(task('g', 2, 60));
    store.insertBlocks([{ ...block('m', 'a', d(7, 9), d(7, 13, 30)), source: 'manual' }, { ...block('s', 'a', d(7, 13, 30), d(7, 18)), source: 'baseline' }]);
    const r = plan(store, { now: d(7, 9), mustDo: ['g'] });
    expect(r.created).toEqual([]);
    expect(r.displaced).toEqual([]);
    expect(store.listBlocks().map((b) => b.id).sort()).toEqual(['m', 's']);
  });
});

describe('a re-plan fills the free time of later planned days add-only', () => {
  const at = (b: Block) => [new Date(b.start).getDate(), new Date(b.start).getHours(), new Date(b.start).getMinutes(), new Date(b.end).getHours(), new Date(b.end).getMinutes()];
  const same = (b: Block) => [b.id, b.start, b.end];

  it('a weekly budget reopened by missed days lands on later planned days; their blocks keep ids and times', () => {
    store.upsertTask(task('a', 1, 60));
    store.upsertTask(task('w', 2, 180, 'week'));
    const week = plan(store, { now: d(5, 9), horizon: 'week' }); // a 09-10 every day; w's three sittings paced Mon, Wed, Fri at 10-11
    expect(week.created.map((b) => [b.taskId, ...at(b)])).toEqual([
      ['a', 5, 9, 0, 10, 0], ['w', 5, 10, 0, 11, 0], ['a', 6, 9, 0, 10, 0], ['a', 7, 9, 0, 10, 0], ['w', 7, 10, 0, 11, 0], ['a', 8, 9, 0, 10, 0], ['a', 9, 9, 0, 10, 0], ['w', 9, 10, 0, 11, 0],
    ]);
    const later = week.created.filter((b) => new Date(b.start).getDate() > 7);
    // Wednesday 09:00, Monday and Tuesday never marked: w owes Monday's hour again. Wednesday already holds its sitting,
    // so the hour lands on Thursday, the later planned day with nothing of w.
    const r = plan(store, { now: d(7, 9), until: d(7, 18) });
    expect(r.missed.length).toBe(3);
    expect(r.kept.map((b) => b.taskId)).toEqual(['a', 'w']);
    expect(r.created).toEqual([]);
    expect(r.later.map((b) => [b.taskId, ...at(b)])).toEqual([['w', 8, 10, 0, 11, 0]]);
    expect(store.listBlocks({ from: d(8, 0) }).filter((b) => b.taskId === 'a').map(same)).toEqual(later.filter((b) => b.taskId === 'a').map(same));
    expect(store.listBlocks().filter((b) => b.status === 'pending').length).toBe(6);
  });

  it('a later block that a commitment added since covers is removed on any re-plan, and that day\'s free time is refilled add-only', () => {
    // Before, such a block was left alone (a Thursday block under a Thursday call until Thursday was planned); now it is
    // stale on any re-plan, day or week. Removing it is not churn: a block under a commitment is no longer valid.
    store.upsertTask(task('a', 1, 60));
    store.upsertTask(task('w', 2, 180, 'week'));
    const week = plan(store, { now: d(5, 9), horizon: 'week' }); // w paced Mon, Wed, Fri
    const thursday = week.created.find((b) => new Date(b.start).getDate() === 8)!; // a 09:00-10:00
    store.addCommitment({ id: 'c', title: 'Call', start: d(8, 9).toISOString(), end: d(8, 10).toISOString() });
    const r = plan(store, { now: d(7, 9), until: d(7, 18) });
    expect(r.removed).toBe(1);
    expect(store.getBlock(thursday.id)).toBeUndefined();
    // Thursday's hour of a is placed again after the call, and w (reopened by the missed Monday) is added: w
    // keeps the 10:00 it sits at on the other days (a day with room for both moves only the task the call displaced).
    expect(r.later.map((b) => [b.taskId, ...at(b)])).toEqual([['w', 8, 10, 0, 11, 0], ['a', 8, 11, 0, 12, 0]]);
    expect(store.listBlocks().filter((b) => b.status === 'pending').every((b) => new Date(b.end) <= d(8, 9) || new Date(b.start) >= d(8, 10))).toBe(true);
  });

  it('later days take whole sittings only: a task that already has part of its sitting there gets no scrap', () => {
    store.upsertTask(task('a', 1, 60));
    store.upsertTask({ ...task('w', 2, 360, 'week'), sessionMinutes: 120 });
    plan(store, { now: d(5, 9), horizon: 'week' }); // a 09-10 every day; w 10-12 paced Mon, Wed, Fri
    store.insertBlocks([{ ...block('hand', 'w', d(8, 10), d(8, 11)), source: 'manual' }]);
    const r = plan(store, { now: d(7, 9), until: d(7, 18) }); // Mon missed: w has 60 left, Wed's sitting is kept
    expect(r.kept.map((b) => b.taskId)).toEqual(['a', 'w']);
    // Thursday already has an hour of w: a 60-minute top-up there would be a scrap, and Friday holds its sitting. No later
    // day can take the last 60 of the week's budget, so it closes Wednesday, the day asked for, beside the kept sitting.
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['w', 7, 12, 0, 13, 0]]);
    expect(r.later).toEqual([]);
  });

  it('must-do means today: on later days the usual ranking decides', () => {
    store.upsertTask(task('a', 1, 60));
    store.upsertTask(task('w', 2, 120, 'week'));
    store.upsertTask(task('m', 3, 120, 'week'));
    store.insertBlocks([7, 8, 9].map((day) => ({ ...block(`a${day}`, 'a', d(day, 9), d(day, 10)), source: 'planner' as const }))); // Wed..Fri planned: a 09-10
    const r = plan(store, { now: d(7, 9), until: d(7, 18), mustDo: ['m'] }); // Wednesday: w and m owe two sittings each
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['m', 7, 10, 0, 11, 0], ['w', 7, 11, 0, 12, 0]]);
    expect(r.later.map((b) => [b.taskId, ...at(b)])).toEqual([['w', 8, 10, 0, 11, 0], ['m', 8, 11, 0, 12, 0]]);
  });

  it('days after the window with nothing planned stay unplanned', () => {
    store.upsertTask(task('a', 1, 60));
    store.upsertTask(task('w', 2, 300, 'week'));
    const r = plan(store, { now: d(5, 9) }); // w: five sittings paced over five days, one today
    expect(r.created.map((b) => [b.taskId, ...at(b)])).toEqual([['a', 5, 9, 0, 10, 0], ['w', 5, 10, 0, 11, 0]]);
    expect(r.later).toEqual([]);
    expect(store.listBlocks().every((b) => new Date(b.start).getDate() === 5)).toBe(true);
  });

  it('until means until: the rest of its own day is not filled even with budget left', () => {
    store.upsertTask(task('a', 1, 60));
    plan(store, { now: d(5, 9), horizon: 'week' }); // a 09-10 on each of Mon..Fri
    store.addCommitment({ id: 'c', title: 'Call', start: d(7, 9).toISOString(), end: d(7, 10).toISOString() });
    const r = plan(store, { now: d(7, 9), until: d(7, 9, 30) });
    expect(r.removed).toBe(1);
    expect(r.created).toEqual([]);
    expect(r.later).toEqual([]);
    expect(store.listBlocks({ from: d(7, 0), to: d(8, 0) }).filter((b) => b.status === 'pending')).toEqual([]);
  });
});

describe('the window edges', () => {
  const at = (b: Block) => [new Date(b.start).getDate(), new Date(b.start).getHours(), new Date(b.start).getMinutes(), new Date(b.end).getHours(), new Date(b.end).getMinutes()];

  it('a week plan asked on a Saturday with no weekend availability rolls to Monday and plans that week', () => {
    store.upsertTask(task('a', 1, 60));
    store.upsertTask(task('w', 2, 300, 'week')); // five 60-minute sessions, one a day
    const r = plan(store, { now: d(10, 10), horizon: 'week' }); // Saturday 10 October
    expect(r.window.end).toEqual(d(16, 18));
    expect([...new Set(r.created.map((b) => new Date(b.start).getDate()))]).toEqual([12, 13, 14, 15, 16]);
    for (const day of [12, 13, 14, 15, 16]) {
      expect(r.created.filter((b) => b.taskId === 'a' && new Date(b.start).getDate() === day).map(at)).toEqual([[day, 9, 0, 10, 0]]);
      expect(r.created.filter((b) => b.taskId === 'w' && new Date(b.start).getDate() === day).map(at)).toEqual([[day, 10, 0, 11, 0]]);
    }
  });

  it('a day plan asked at 22:00 on a Friday with only Monday availability lands on Monday', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1], start: '09:00', end: '18:00' }] });
    store.upsertTask(task('a', 1, 60));
    const r = plan(store, { now: d(9, 22) });
    expect(r.window.end).toEqual(d(12, 18));
    expect(r.created.map(at)).toEqual([[12, 9, 0, 10, 0]]);
  });

  it('the next available day is searched a fortnight ahead: Saturday-only availability asked on Sunday night lands on the coming Saturday, for a day or a week plan', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [6], start: '10:00', end: '13:00' }] });
    store.upsertTask(task('a', 1, 60));
    expect(resolveUntil(d(11, 22), store.getSettings(), 'week')).toEqual(d(17, 13)); // this week's Saturday is over: next week's
    const r = plan(store, { now: d(11, 22) });
    expect(r.window.end).toEqual(d(17, 13));
    expect(r.created.map(at)).toEqual([[17, 10, 0, 11, 0]]);
  });
});

describe('a skipped block means not today', () => {
  const skip = (taskId: string, day: number) => {
    const b = store.listBlocks().find((x) => x.taskId === taskId && new Date(x.start).getDate() === day)!;
    store.updateBlock(b.id, { status: 'skipped', statusChangedAt: d(day, 9, 5).toISOString() });
    return b;
  };

  it('a daily task whose block was skipped is not re-placed today, even with free time left', () => {
    store.upsertTask(task('a', 1, 60));
    store.upsertTask(task('b', 2, 120));
    plan(store, { now: d(7, 9) }); // a 09-10, b 10-11 and 11-12
    skip('a', 7);
    const r = plan(store, { now: d(7, 9, 5), until: d(7, 18) });
    expect(r.created.filter((b) => b.taskId === 'a')).toEqual([]);
    expect(r.kept.filter((b) => b.taskId === 'b')).toHaveLength(2);
    expect(remainingMinutes(store.getTask('a')!, store.listBlocks(), d(7, 9, 5), store.getSettings())).toBe(60); // the budget is untouched; only the day is over
  });

  it('a skipped weekly sitting is not re-placed on its day; the week still owes it on another day', () => {
    store.upsertTask(task('w', 1, 240, 'week'));
    plan(store, { now: d(5, 9), horizon: 'week' }); // one 60-minute sitting Mon-Thu
    skip('w', 5);
    const r = plan(store, { now: d(5, 9, 5), until: d(5, 18) });
    expect(r.created.filter((b) => b.taskId === 'w' && new Date(b.start).getDate() === 5)).toEqual([]);
    expect(store.listBlocks().filter((b) => b.taskId === 'w' && b.status === 'pending')).toHaveLength(3);
    expect(remainingMinutes(store.getTask('w')!, store.listBlocks(), d(5, 9, 5), store.getSettings())).toBe(60);
  });

  it('a daily task with more day share than the skipped block is not refilled with a scrap of the freed slot', () => {
    store.upsertTask(task('a', 1, 120));
    store.addCommitment({ id: 'c', title: 'Busy', start: d(7, 10).toISOString(), end: d(7, 18).toISOString() });
    plan(store, { now: d(7, 9) }); // a 09-10 is all the free time there is
    skip('a', 7);
    const r = plan(store, { now: d(7, 9, 5), until: d(7, 18) });
    expect(r.created.filter((b) => b.taskId === 'a')).toEqual([]);
  });

  it('a weekly task behind schedule whose sitting was skipped is not refilled with a scrap of the freed slot', () => {
    store.upsertTask(task('w', 1, 240, 'week'));
    store.addCommitment({ id: 'c', title: 'Busy', start: d(8, 10).toISOString(), end: d(8, 18).toISOString() });
    plan(store, { now: d(8, 9) }); // Thursday, 240 left over two days: a sitting at 09-10
    skip('w', 8);
    const r = plan(store, { now: d(8, 9, 5), until: d(8, 18) });
    expect(r.created.filter((b) => b.taskId === 'w' && new Date(b.start).getDate() === 8)).toEqual([]);
  });

  it('naming a skipped task as a must-do today overrides the skip: it gets a whole sitting again', () => {
    store.upsertTask(task('a', 1, 60));
    store.upsertTask(task('b', 2, 120));
    plan(store, { now: d(7, 9) });
    skip('a', 7);
    const r = plan(store, { now: d(7, 9, 5), until: d(7, 18), mustDo: ['a'] });
    expect(r.created.filter((b) => b.taskId === 'a').map((b) => [new Date(b.start).getHours(), new Date(b.end).getHours()])).toEqual([[9, 10]]);
  });
});

describe('a missed block means not today', () => {
  const hours = (r: { created: Block[] }, id: string) => r.created.filter((b) => b.taskId === id).map((b) => [new Date(b.start).getHours(), new Date(b.end).getHours()]);

  it('a daily task whose block ended unmarked is missed and not re-placed the same day', () => {
    store.upsertTask(task('a', 1, 60));
    store.upsertTask(task('b', 2, 120));
    plan(store, { now: d(7, 9) }); // a 09-10, b 10-12
    const r = plan(store, { now: d(7, 10, 6), until: d(7, 18) }); // a's block ended and was never marked
    expect(store.listBlocks().filter((b) => b.taskId === 'a').map((b) => b.status)).toEqual(['missed']);
    expect(hours(r, 'a')).toEqual([]);
    expect(remainingMinutes(store.getTask('a')!, store.listBlocks(), d(7, 10, 6), store.getSettings())).toBe(60); // still owed to the period
  });

  it('naming the task as a must-do redoes the block: a whole sitting today', () => {
    store.upsertTask(task('a', 1, 60));
    store.upsertTask(task('b', 2, 120));
    plan(store, { now: d(7, 9) });
    const r = plan(store, { now: d(7, 10, 6), until: d(7, 18), mustDo: ['a'] });
    expect(hours(r, 'a')).toEqual([[12, 13]]); // b keeps 10-12; a gets a whole sitting after it
  });

  it('a weekly sitting that ended unmarked is owed to the week and not re-placed that day', () => {
    store.upsertTask(task('w', 1, 240, 'week'));
    plan(store, { now: d(5, 9), horizon: 'week' }); // one 60-minute sitting Mon-Thu
    const r = plan(store, { now: d(5, 10, 6), until: d(5, 18) });
    expect(store.listBlocks().filter((b) => b.taskId === 'w' && new Date(b.start).getDate() === 5).map((b) => b.status)).toEqual(['missed']);
    expect(hours(r, 'w')).toEqual([]);
    expect(remainingMinutes(store.getTask('w')!, store.listBlocks(), d(5, 10, 6), store.getSettings())).toBe(60); // the three later sittings are pending; the missed one is still owed
  });
});

describe('the per-day cap is a cap', () => {
  // Four daily tasks of an hour each and two weekly tasks of two sittings each, on 09:00-18:00 weekdays.
  const fixture = (cap: number, availability = STANDARD_WEEK) => {
    store.saveSettings({ ...store.getSettings(), availability, maxTasksPerDay: cap });
    for (const [i, id] of ['d1', 'd2', 'd3', 'd4'].entries()) store.upsertTask(task(id, i + 1, 60));
    store.upsertTask(task('w1', 5, 120, 'week'));
    store.upsertTask(task('w2', 6, 120, 'week'));
  };
  const tasksOn = (blocks: Block[], day: number) => new Set(blocks.filter((b) => new Date(b.start).getDate() === day).map((b) => b.taskId));
  const daysOf = (blocks: Block[], id: string) => blocks.filter((b) => b.taskId === id).map((b) => new Date(b.start).getDate());

  it('four daily tasks fill a cap of 4: each day still admits one weekly task, and the two weekly tasks alternate days', () => {
    fixture(4);
    store.upsertTask(task('w1', 5, 180, 'week')); // three sittings each: paced Mon, Wed, Fri and Tue, Thu, Fri
    store.upsertTask(task('w2', 6, 180, 'week'));
    const r = plan(store, { now: d(5, 9), horizon: 'week' });
    for (const day of [5, 6, 7, 8, 9]) {
      const on = tasksOn(r.created, day);
      for (const id of ['d1', 'd2', 'd3', 'd4']) expect(on.has(id), `${id} on day ${day}`).toBe(true);
      expect([...on].filter((id) => id.startsWith('w')), `day ${day}`).toHaveLength(1);
    }
    expect(daysOf(r.created, 'w1')).toEqual([5, 7, 9]);
    expect(daysOf(r.created, 'w2')).toEqual([6, 8]); // Friday's place is w1's: w2's third sitting stays unmet
    expect(r.overCap).toEqual([]);
  });

  it('a third weekly task the one weekly place a day keeps out every day is reported', () => {
    fixture(4);
    store.upsertTask(task('w1', 5, 180, 'week'));
    store.upsertTask(task('w2', 6, 180, 'week'));
    store.upsertTask(task('w3', 20, 120, 'week')); // far below the others: it never outranks them for the one weekly place
    const r = plan(store, { now: d(5, 9), horizon: 'week' });
    expect(r.created.filter((b) => b.taskId === 'w3')).toEqual([]);
    expect(r.overCap.map((t) => t.id)).toEqual(['w3']);
    expect(r.unplaced.map((t) => t.id)).toContain('w3');
  });

  it('with a cap of 5 each day holds the four dailies and at most one weekly task, and the weekly tasks alternate days', () => {
    fixture(5);
    const r = plan(store, { now: d(5, 9), horizon: 'week' });
    for (const day of [5, 6, 7, 8, 9]) {
      const on = tasksOn(r.created, day);
      expect(on.size, `day ${day}`).toBeLessThanOrEqual(5);
      for (const id of ['d1', 'd2', 'd3', 'd4']) expect(on.has(id), `${id} on day ${day}`).toBe(true);
    }
    expect(daysOf(r.created, 'w1')).toEqual([6, 8]);
    expect(daysOf(r.created, 'w2')).toEqual([7, 9]);
    expect(r.unplaced).toEqual([]);
    expect(r.overCap).toEqual([]);
  });

  it('a must-do still displaces on a day at the cap', () => {
    fixture(4, [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '13:00' }]);
    plan(store, { now: d(5, 9) }); // the four dailies fill Monday 09:00-13:00
    const r = plan(store, { now: d(5, 9), mustDo: ['w1'] });
    expect(r.displaced).toHaveLength(1);
    expect(r.created.filter((b) => b.taskId === 'w1').map((b) => new Date(b.start).getDate())).toEqual([5]);
  });
});

describe('a plan repeats its passes until they add nothing, at most three times', () => {
  it('a store that keeps nothing a pass adds stops the plan after four passes', () => {
    class Forgetful extends MemoryStore { passes = 0; override insertBlocks(blocks: Block[]) { this.passes += 1; void blocks; } }
    const forgetful = new Forgetful();
    forgetful.saveSettings(store.getSettings());
    forgetful.upsertTask(task('a', 1, 60));
    const r = plan(forgetful, { now: d(7, 9) }); // every pass finds the day empty and adds the hour again
    expect(forgetful.passes).toBe(4);
    expect(r.created.map((b) => [new Date(b.start).getHours(), new Date(b.end).getHours()])).toEqual([[9, 10]]); // the merged report lists the hour once
  });
});
