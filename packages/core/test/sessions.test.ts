import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/store.js';
import { plan } from '../src/plan.js';
import { runTool } from '../src/tools.js';
import { DEFAULT_SETTINGS, STANDARD_WEEK, type Task } from '../src/types.js';

const d = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m); // Oct 2026: 5 Mon .. 9 Fri
const task = (id: string, priority: number, budgetMinutes: number, budgetPeriod: 'day' | 'week', sessionMinutes?: number): Task => ({
  id, name: id, color: '#000', priority, budgetMinutes, budgetPeriod, sessionMinutes, archived: false, createdAt: '',
});
const hm = (iso: string) => { const x = new Date(iso); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; };
let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
  store.saveSettings({ ...DEFAULT_SETTINGS, availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '13:00' }], maxBlockMinutes: 90, minBlockMinutes: 30, slotMinutes: 15 });
});

describe('sessions', () => {
  it('a task is placed in sessions of its own length, not the global max block', () => {
    store.upsertTask(task('a', 1, 240, 'day', 120));
    const r = plan(store, { now: d(5, 9) });
    expect(r.created.map((b) => [hm(b.start), hm(b.end)])).toEqual([['09:00', '11:00'], ['11:00', '13:00']]);
  });

  it('weekly tasks get at most one session per day and alternate across days by deficit', () => {
    for (const id of ['a', 'b', 'c', 'd']) store.upsertTask(task(id, 1, 300, 'week', 120));
    const r = plan(store, { now: d(5, 9), horizon: 'week' });
    const byDay = new Map<number, string[]>();
    for (const b of r.created) { const day = new Date(b.start).getDate(); byDay.set(day, [...(byDay.get(day) ?? []), b.taskId]); }
    expect(byDay.get(5)).toEqual(['a', 'b']);
    expect(byDay.get(6)).toEqual(['c', 'd']);
    expect(byDay.get(7)).toEqual(['a', 'b']);
    expect(byDay.get(8)).toEqual(['c', 'd']);
    expect(r.created.filter((b) => new Date(b.start).getDate() <= 8).every((b) => (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000 === 120)).toBe(true);
  });

  it('places a sitting whole in its segment instead of cutting it at the lunch gap', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '07:00', end: '13:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }], maxBlockMinutes: 120 });
    store.upsertTask({ ...task('building', 1, 120, 'day', 120), preferredSegment: 'afternoon' });
    const r = plan(store, { now: d(5, 7) });
    expect(r.created.map((b) => [hm(b.start), hm(b.end)])).toEqual([['14:00', '16:00']]);
  });

  it('limits how many different tasks start on one day while those tasks fill the day', () => {
    store.saveSettings({ ...store.getSettings(), maxTasksPerDay: 3 });
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) store.upsertTask(task(id, 1, 90, 'day'));
    const r = plan(store, { now: d(5, 9) }); // 240 min of availability, three tasks fill it (90 + 90 + 60)
    expect(new Set(r.created.map((b) => b.taskId)).size).toBe(3);
  });

  it('the cap holds when free time and unmet budget remain: the free time stays free and the tasks it kept off are named', () => {
    store.saveSettings({ ...store.getSettings(), maxTasksPerDay: 3 });
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) store.upsertTask(task(id, 1, 30, 'day'));
    const r = plan(store, { now: d(5, 9) }); // 240 min of availability, the capped three use 90
    expect(new Set(r.created.map((b) => b.taskId)).size).toBe(3);
    expect(r.created.map((b) => [hm(b.start), hm(b.end)])).toEqual([['09:00', '09:30'], ['09:30', '10:00'], ['10:00', '10:30']]);
    expect(r.overCap.map((t) => t.id)).toEqual(['d', 'e', 'f']);
  });

  it('weekly tasks get days when the cap leaves room beside the daily tasks: every budget is met within the week', () => {
    store.saveSettings({
      ...store.getSettings(),
      availability: [{ days: [1, 2, 3, 4, 5], start: '07:00', end: '13:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }, { days: [1, 2, 3, 4, 5], start: '19:00', end: '21:00' }],
      maxBlockMinutes: 120, maxTasksPerDay: 7, // four daily tasks and three weekly ones a day: 15 weekly places for 12 sittings, so a remainder that cannot touch its sitting must close its own day
    });
    store.upsertTask({ ...task('lc', 1, 60, 'day', 60), preferredSegment: 'morning' });
    store.upsertTask(task('ai', 2, 60, 'day', 60));
    store.upsertTask({ ...task('build', 3, 120, 'day', 120), preferredSegment: 'afternoon' });
    store.upsertTask({ ...task('startup', 4, 120, 'day', 120), preferredSegment: 'evening' });
    store.upsertTask(task('beh', 5, 300, 'week', 120));
    store.upsertTask(task('ail', 6, 300, 'week', 120));
    store.upsertTask({ ...task('sd', 7, 300, 'week', 120), preferredSegment: 'morning' });
    store.upsertTask({ ...task('ml', 8, 300, 'week', 120), preferredSegment: 'morning' });
    const r = plan(store, { now: d(5, 7), horizon: 'week' });
    const minutes = (b: { start: string; end: string }) => (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000;
    const total = (id: string, day?: number) => r.created.filter((b) => b.taskId === id && (day === undefined || new Date(b.start).getDate() === day)).reduce((n, b) => n + minutes(b), 0);
    // The daily tasks still get their full budget every day, every weekly budget is met within the week, and no day
    // holds more than the cap.
    for (const day of [5, 6, 7, 8, 9]) expect([total('lc', day), total('ai', day), total('build', day), total('startup', day)]).toEqual([60, 60, 120, 120]);
    for (const id of ['beh', 'ail', 'sd', 'ml']) expect(total(id)).toBe(300);
    for (const day of [5, 6, 7, 8, 9]) expect(new Set(r.created.filter((b) => new Date(b.start).getDate() === day).map((b) => b.taskId)).size).toBeLessThanOrEqual(8);
  });

  it('a task that prefers a segment waits for a slot in it that holds a whole sitting instead of taking the first scrap', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '07:00', end: '13:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }], maxBlockMinutes: 120 });
    store.upsertTask({ ...task('build', 1, 120, 'day', 120), preferredSegment: 'afternoon' });
    const r = plan(store, { now: d(5, 7) }); // afternoon is 12:00-13:00 and 14:00-17:00: the sitting fits only in the second
    expect(r.created.map((b) => [hm(b.start), hm(b.end)])).toEqual([['14:00', '16:00']]);
  });

  it('a task that prefers a segment still takes scraps when no slot in it holds a whole sitting', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' }], maxBlockMinutes: 90 });
    store.addCommitment({ id: 'c', title: 'Standup', start: d(5, 10).toISOString(), end: d(5, 10, 30).toISOString() });
    store.upsertTask({ ...task('mli', 1, 120, 'day', 60), preferredSegment: 'morning' });
    const r = plan(store, { now: d(5, 9) });
    expect(r.created.map((b) => [hm(b.start), hm(b.end)])).toEqual([['09:00', '10:00'], ['10:30', '11:30']]);
  });

  it('a flexible task passes over a scrap when a longer slot comes later, and the scrap goes to a task it fits', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '10:00' }, { days: [1, 2, 3, 4, 5], start: '10:30', end: '13:00' }], maxBlockMinutes: 120 });
    store.upsertTask(task('a', 1, 120, 'day', 120));
    store.upsertTask(task('b', 2, 60, 'day', 60));
    const r = plan(store, { now: d(5, 9) });
    expect(r.created.map((b) => [b.taskId, hm(b.start), hm(b.end)])).toEqual([['b', '09:00', '10:00'], ['a', '10:30', '12:30']]);
  });

  it('a scrap at the start of the day that is more than half a sitting is taken, so the day still starts on time', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '13:00' }], maxBlockMinutes: 60 });
    store.addCommitment({ id: 'c', title: 'Standup', start: d(5, 9, 45).toISOString(), end: d(5, 10).toISOString() });
    store.upsertTask(task('a', 1, 120, 'day', 60));
    const r = plan(store, { now: d(5, 9) });
    expect(r.created.map((b) => [hm(b.start), hm(b.end)])).toEqual([['09:00', '09:45'], ['10:00', '11:00']]);
  });

  it('a split sitting beats a late start: the first free minutes of the window are taken when the rest of the sitting follows later in the day', () => {
    store.saveSettings({ ...store.getSettings(), maxBlockMinutes: 120 });
    store.addCommitment({ id: 'c', title: 'Standup', start: d(5, 9, 30).toISOString(), end: d(5, 9, 45).toISOString() });
    store.upsertTask(task('a', 1, 120, 'day', 120));
    const r = plan(store, { now: d(5, 9) }); // 09:00-09:30 is a scrap of the 120-minute sitting, but leaving it empty is a late start
    expect(r.created.map((b) => [hm(b.start), hm(b.end)])).toEqual([['09:00', '09:30'], ['09:45', '11:15']]);
  });

  it('a weekly task leaves a scrap today for a later day that holds its sitting whole', () => {
    store.saveSettings({ ...store.getSettings(), maxBlockMinutes: 120 });
    store.addCommitment({ id: 'c', title: 'Offsite', start: d(7, 9).toISOString(), end: d(7, 12, 30).toISOString() });
    store.upsertTask(task('w', 1, 120, 'week', 120));
    const r = plan(store, { now: d(5, 9), horizon: 'week' }); // its one sitting is due Wednesday, which has 30 minutes left after the offsite; Thursday is free
    expect(r.created.map((b) => [new Date(b.start).getDate(), hm(b.start), hm(b.end)])).toEqual([[8, '09:00', '11:00']]);
  });

  it('outside its segment a task takes leftover time only where its sitting fits whole; the scrap goes to a task that does not mind the hour', () => {
    // 21:15 on an evening window: Reading takes its evening half hour; the last 45 minutes cannot hold a whole sitting of
    // the interview prep the user keeps in the mornings, so they go to Leetcode, which has no preference.
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '20:00', end: '22:30' }] });
    store.upsertTask({ ...task('mli', 1, 120, 'day', 60), preferredSegment: 'morning' });
    store.upsertTask(task('lc', 2, 60, 'day', 60));
    store.upsertTask({ ...task('reading', 3, 30, 'day', 30), preferredSegment: 'evening' });
    const r = plan(store, { now: d(7, 21, 15), until: d(7, 22, 30) });
    expect(r.created.map((b) => [b.taskId, hm(b.start), hm(b.end)])).toEqual([['reading', '21:15', '21:45'], ['lc', '21:45', '22:30']]);
  });

  it('chooses which tasks get a day by score, so a high-priority daily task is not crowded out by low-priority preferred ones', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '07:00', end: '11:00' }], maxTasksPerDay: 3 });
    store.upsertTask({ ...task('lc', 1, 60, 'day', 60), preferredSegment: 'morning' });
    store.upsertTask(task('ai', 2, 60, 'day', 60));
    store.upsertTask({ ...task('sd', 7, 300, 'week', 120), preferredSegment: 'morning' });
    store.upsertTask({ ...task('ml', 8, 300, 'week', 120), preferredSegment: 'morning' });
    const r = plan(store, { now: d(5, 7), until: d(5, 11) }); // 240 min: lc 60 + ai 60 + sd 120 fill the day
    const names = new Set(r.created.map((b) => b.taskId));
    expect(names.has('lc')).toBe(true);
    expect(names.has('ai')).toBe(true);
    expect(names.size).toBe(3);
  });

  it('a sitting cut short by its segment edge runs to its full length when the time right after the edge is free', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '14:00' }], maxBlockMinutes: 120 });
    store.addCommitment({ id: 'c', title: 'Standup', start: d(5, 9).toISOString(), end: d(5, 10, 15).toISOString() });
    store.upsertTask(task('flex', 1, 60, 'day', 60));
    store.upsertTask({ ...task('sd', 2, 120, 'day', 120), preferredSegment: 'morning' });
    const r = plan(store, { now: d(5, 9) }); // the morning ends at 12:00: 105 minutes to the edge, 12:00-14:00 free
    expect(r.created.map((b) => [b.taskId, hm(b.start), hm(b.end)])).toEqual([['sd', '10:15', '12:15'], ['flex', '12:15', '13:15']]);
  });

  it('the overrun is at most half a session: a sitting that would mostly sit past the edge is an off-segment placement, and priority decides', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '14:00' }], maxBlockMinutes: 120 });
    store.addCommitment({ id: 'c', title: 'Offsite', start: d(5, 9).toISOString(), end: d(5, 11, 15).toISOString() });
    store.upsertTask(task('flex', 1, 60, 'day', 60));
    store.upsertTask({ ...task('sd', 2, 120, 'day', 120), preferredSegment: 'morning' });
    const r = plan(store, { now: d(5, 9) }); // 45 minutes to the edge: less than half of 120, so no overrun; flex outranks sd at 11:15
    expect(r.created.map((b) => [b.taskId, hm(b.start), hm(b.end)])).toEqual([['flex', '11:15', '12:15'], ['sd', '12:15', '14:00']]);
  });

  it('exactly half a session before the edge still runs whole', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '14:00' }], maxBlockMinutes: 120 });
    store.addCommitment({ id: 'c', title: 'Offsite', start: d(5, 9).toISOString(), end: d(5, 11).toISOString() });
    store.upsertTask(task('flex', 1, 60, 'day', 60));
    store.upsertTask({ ...task('sd', 2, 120, 'day', 120), preferredSegment: 'morning' });
    const r = plan(store, { now: d(5, 9) });
    expect(r.created.map((b) => [b.taskId, hm(b.start), hm(b.end)])).toEqual([['sd', '11:00', '13:00'], ['flex', '13:00', '14:00']]);
  });

  it('daily sittings come before weekly sittings on a day: the daily tasks keep their hour when two weekly tasks could fill the day', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '13:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }], maxBlockMinutes: 120, maxTasksPerDay: 4 });
    store.upsertTask(task('portfolio', 1, 300, 'week', 120));
    store.upsertTask(task('course', 2, 300, 'week', 120));
    store.upsertTask(task('lc', 3, 60, 'day', 60));
    store.upsertTask(task('reading', 4, 60, 'day', 60));
    const r = plan(store, { now: d(8, 9), horizon: 'week' }); // Thursday: two days left, 480 minutes each
    const minutes = (b: { start: string; end: string }) => (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000;
    const on = (day: number) => r.created.filter((b) => new Date(b.start).getDate() === day).sort((a, b) => a.start.localeCompare(b.start));
    for (const day of [8, 9]) {
      // Each daily task has its hour, and a daily task opens the day; the weekly sittings take what is left.
      expect(on(day).filter((b) => b.taskId === 'lc').map(minutes)).toEqual([60]);
      expect(on(day).filter((b) => b.taskId === 'reading').map(minutes)).toEqual([60]);
      expect(['lc', 'reading']).toContain(on(day)[0].taskId);
    }
    for (const id of ['portfolio', 'course']) expect(r.created.filter((b) => b.taskId === id).reduce((n, b) => n + minutes(b), 0)).toBe(300);
  });

  it('free time is not filled ahead of the pacing: midweek a weekly task takes its paced sitting; the week\'s last day takes what the week still needs, up to three sessions, in its segment', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '13:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }, { days: [1, 2, 3, 4, 5], start: '20:00', end: '22:30' }], maxBlockMinutes: 120 });
    store.upsertTask(task('thesis', 1, 120, 'day', 120));
    store.upsertTask({ ...task('reading', 2, 180, 'week', 60), preferredSegment: 'evening' });
    const r = plan(store, { now: d(7, 9) }); // Wednesday: three sittings over three days, one today; the evening stays free
    expect(r.created.filter((b) => b.taskId === 'reading').map((b) => [hm(b.start), hm(b.end)])).toEqual([['17:00', '18:00']]);
    store.deleteBlocks(store.listBlocks().map((b) => b.id));
    const friday = plan(store, { now: d(9, 9) }); // Friday, the week's last day: all three (two, plus the extra sweep's one where free time remains)
    expect(friday.created.filter((b) => b.taskId === 'reading').map((b) => [hm(b.start), hm(b.end)])).toEqual([['17:00', '18:00'], ['20:00', '21:00'], ['21:00', '22:00']]);
    expect(friday.weeklyUnmet).toEqual([]);
  });

  it('the extra sitting never takes a task past two sessions on a day: the remainder waits for the next day', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '13:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }], maxBlockMinutes: 120 });
    store.upsertTask(task('w', 1, 300, 'week', 120));
    const r = plan(store, { now: d(8, 9), horizon: 'week' }); // Thursday: two sittings today, the 60-minute remainder on Friday
    expect(r.created.map((b) => [new Date(b.start).getDate(), hm(b.start), hm(b.end)])).toEqual([[8, '09:00', '11:00'], [8, '11:00', '13:00'], [9, '09:00', '10:00']]);
  });

  it('a weekly task\'s remainder closes the day of its last whole sitting instead of opening a new day', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '13:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }], maxBlockMinutes: 120 });
    store.upsertTask(task('w', 1, 210, 'week', 90)); // two whole sittings and a 30-minute remainder
    const r = plan(store, { now: d(5, 9), horizon: 'week' });
    expect(r.created.map((b) => [new Date(b.start).getDate(), hm(b.start), hm(b.end)])).toEqual([[5, '09:00', '10:30'], [7, '09:00', '10:30'], [7, '10:30', '11:00']]); // paced Mon and Wed
  });

  it('upsert_task accepts session_minutes and update_settings accepts max_tasks_per_day', () => {
    const ctx = { now: () => d(5, 9) };
    const t = runTool(store, 'upsert_task', { name: 'Deep', priority: 1, budget_minutes: 240, budget_period: 'day', session_minutes: 120 }, ctx) as any;
    expect(t.sessionMinutes).toBe(120);
    expect(() => runTool(store, 'upsert_task', { name: 'X', priority: 1, budget_minutes: 60, budget_period: 'day', session_minutes: 5 }, ctx)).toThrow();
    const s = runTool(store, 'update_settings', { max_tasks_per_day: 4 }, ctx) as any;
    expect(s.settings.maxTasksPerDay).toBe(4);
  });
});

describe('a long run yields to another task', () => {
  it('on the last day two weekly tasks alternate: neither runs longer than two sessions while the other could take the slot, and both budgets are met (the third session each in the free evening)', () => {
    store.saveSettings({ ...store.getSettings(), availability: [
      { days: [1, 2, 3, 4, 5], start: '07:00', end: '13:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }, { days: [1, 2, 3, 4, 5], start: '19:00', end: '21:00' },
    ], maxBlockMinutes: 120, maxTasksPerDay: 4 });
    store.upsertTask(task('beh', 1, 300, 'week', 120));
    store.upsertTask(task('ail', 2, 300, 'week', 120));
    store.upsertTask(task('lc', 3, 60, 'day', 60));
    const r = plan(store, { now: d(9, 7) }); // Friday, the week's last day; 12 hours of availability, 11 hours owed
    const minutes = (id: string) => r.created.filter((b) => b.taskId === id).reduce((n, b) => n + (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000, 0);
    expect(minutes('beh')).toBe(300);
    expect(minutes('ail')).toBe(300);
    expect(r.weeklyUnmet).toEqual([]);
    expect(minutes('lc')).toBe(60);
    // No stretch of one task longer than two sessions (240 minutes): consecutive blocks of one task, touching, summed.
    const sorted = [...r.created].sort((a, b) => a.start.localeCompare(b.start));
    let run = 0; let last: typeof sorted[number] | undefined;
    for (const b of sorted) {
      run = last && last.taskId === b.taskId && last.end === b.start ? run + (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000 : (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000;
      expect(run, `${b.taskId} run at ${hm(b.start)}`).toBeLessThanOrEqual(240);
      last = b;
    }
  });

  it('the run continues when no other task can take the slot: on the last day the third session follows, so a budget is not left unmet to avoid a long stretch', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '14:00' }], maxBlockMinutes: 120 });
    store.upsertTask(task('solo', 1, 300, 'week', 120));
    const r = plan(store, { now: d(9, 8) }); // Friday, only one task: 08:00-13:00 in a row
    expect(r.created.map((b) => [hm(b.start), hm(b.end)])).toEqual([['08:00', '10:00'], ['10:00', '12:00'], ['12:00', '13:00']]);
    expect(r.weeklyUnmet).toEqual([]);
  });

  it.each([['a hand-placed block still ahead', d(9, 8), 'pending'], ['a block already done', d(9, 10), 'done']] as const)('%s counts toward the run: a weekly task that sat two sessions up to the cursor yields it to a task that can take it', (_label, now, status) => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '13:00' }], maxBlockMinutes: 60 });
    store.upsertTask(task('w', 1, 600, 'week', 60));
    store.upsertTask(task('x', 2, 60, 'week', 60));
    store.insertBlocks([{ id: 'hand', taskId: 'w', start: d(9, 8).toISOString(), end: d(9, 10).toISOString(), status, source: 'manual', createdAt: '', statusChangedAt: null }]);
    const r = plan(store, { now }); // Friday, the week's last day: w sits 08:00-10:00, two sessions of 60, up to the cursor at 10:00
    expect(r.created.find((b) => hm(b.start) === '10:00')?.taskId).toBe('x');
  });
});

describe('a task keeps its slot across days', () => {
  it('a daily task lands at the same time every day of a week plan', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '07:00', end: '13:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }], maxBlockMinutes: 120, maxTasksPerDay: 4 });
    store.upsertTask(task('lc', 2, 60, 'day', 60));
    store.upsertTask(task('ail', 3, 60, 'day', 60));
    store.upsertTask(task('build', 1, 120, 'day', 120));
    store.upsertTask({ ...task('startup', 4, 300, 'week', 120), preferredSegment: 'morning' });
    store.upsertTask({ ...task('sd', 5, 300, 'week', 120), preferredSegment: 'morning' });
    const r = plan(store, { now: d(5, 7), horizon: 'week' }); // Monday 07:00
    const startsOf = (id: string) => new Set(r.created.filter((b) => b.taskId === id).map((b) => hm(b.start)));
    expect(startsOf('lc').size).toBe(1);
    expect(startsOf('ail').size).toBe(1);
    expect(startsOf('build').size).toBe(1);
  });

  it('a commitment moves the task only on that day; the saved baseline anchors the slot on a fresh plan', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '13:00' }], maxBlockMinutes: 60 });
    store.upsertTask(task('lc', 1, 60, 'day', 60));
    store.upsertTask(task('read', 2, 60, 'day', 60));
    // The baseline is the availability too (10:00-13:00 on weekdays): lc's slot is 10:00, read's 12:00, 11:00-12:00 is blank.
    store.setBaseline({ slots: [1, 2, 3, 4, 5].flatMap((day) => [{ taskId: 'lc', day, start: '10:00', end: '11:00', kind: 'task' as const }, { taskId: 'read', day, start: '12:00', end: '13:00', kind: 'task' as const }]) });
    store.addCommitment({ id: 'c', title: 'Dentist', start: d(7, 10).toISOString(), end: d(7, 11).toISOString() }); // Wednesday 10-11
    const r = plan(store, { now: d(5, 9), horizon: 'week' });
    const lc = (day: number) => r.created.filter((b) => b.taskId === 'lc' && new Date(b.start).getDate() === day).map((b) => hm(b.start));
    expect(lc(5)).toEqual(['10:00']); // the baseline slot
    expect(lc(6)).toEqual(['10:00']);
    expect(lc(7)).not.toEqual(['10:00']); // the dentist's day
    expect(lc(8)).toEqual(['10:00']);
  });

  it('a habit slot outside the task\'s preferred segment is not used', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }], maxBlockMinutes: 60 });
    store.upsertTask({ ...task('m', 1, 60, 'day', 60), preferredSegment: 'morning' });
    store.upsertTask(task('o', 2, 60, 'day', 60));
    // o's slot opens Monday at 09:00 so the baseline's usable span is 09:00-15:00; m's saved slot is in the afternoon.
    store.setBaseline({ slots: [{ taskId: 'o', day: 1, start: '09:00', end: '10:00', kind: 'task' }, { taskId: 'm', day: 1, start: '14:00', end: '15:00', kind: 'task' }] });
    const r = plan(store, { now: d(5, 9) });
    expect(r.created.filter((b) => b.taskId === 'm').map((b) => hm(b.start))).toEqual(['10:00']);
  });
  describe('a saved baseline slot is a reservation', () => {
    const fixture = () => {
      store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }], maxBlockMinutes: 60, maxTasksPerDay: 4 });
      store.upsertTask(task('new', 1, 60, 'day', 60)); // top-ranked, not in the baseline
      store.upsertTask(task('a', 2, 60, 'day', 60));
      store.upsertTask(task('b', 3, 60, 'day', 60));
      store.upsertTask(task('c', 4, 60, 'day', 60));
      const slot = (taskId: string, start: string, end: string) => [1, 2, 3, 4, 5].map((day) => ({ taskId, day, start, end }));
      store.setBaseline({ savedAt: '', blocks: [...slot('a', '11:00', '12:00'), ...slot('b', '14:00', '15:00'), ...slot('c', '15:00', '16:00')] });
    };
    const startsOn = (created: { taskId: string; start: string }[], day: number) =>
      Object.fromEntries(created.filter((b) => new Date(b.start).getDate() === day).map((b) => [b.taskId, hm(b.start)]));

    it('a new top-ranked task does not knock baseline tasks off their slots: a week plan', () => {
      fixture();
      const r = plan(store, { now: d(5, 9), horizon: 'week' });
      // The baseline is the availability too (11:00-16:00): the new task takes the first blank hour, 12:00, not a saved slot.
      for (const day of [5, 6, 7, 8, 9]) expect(startsOn(r.created, day), `day ${day}`).toEqual({ new: '12:00', a: '11:00', b: '14:00', c: '15:00' });
    });

    it('a new top-ranked task does not knock baseline tasks off their slots: a day plan', () => {
      fixture();
      const r = plan(store, { now: d(5, 9) });
      expect(startsOn(r.created, 5)).toEqual({ new: '12:00', a: '11:00', b: '14:00', c: '15:00' });
    });
  });

  it('a learned habit yields to a higher-ranked task that has no other room', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2], start: '09:00', end: '10:30' }], maxBlockMinutes: 60 });
    store.upsertTask(task('hi', 1, 60, 'day', 60));
    store.upsertTask(task('lo', 2, 60, 'day', 60));
    store.insertBlocks([{ id: 'hand', taskId: 'lo', start: d(6, 9).toISOString(), end: d(6, 10).toISOString(), status: 'pending', source: 'manual', createdAt: '', statusChangedAt: null }]);
    const r = plan(store, { now: d(5, 9), horizon: 'week' }); // lo sits at 09:00 on Tuesday; Monday has 90 minutes for hi (60) and lo (60)
    const monday = r.created.filter((b) => new Date(b.start).getDate() === 5);
    expect(monday.find((b) => b.taskId === 'hi')).toMatchObject({ start: d(5, 9).toISOString() });
  });

  describe('a learned habit yields only when the floaters lack room in time they accept', () => {
    const lunchGap = () => store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '16:00' }], maxBlockMinutes: 60 });
    const tuesday = (created: { taskId: string; start: string }[]) =>
      Object.fromEntries(created.filter((b) => new Date(b.start).getDate() === 6).map((b) => [b.taskId, hm(b.start)]));

    it('afternoon room does not count for morning-preferring floaters: the flexible task gives up its morning hour', () => {
      lunchGap();
      store.upsertTask({ ...task('hi', 1, 60, 'day', 60), preferredSegment: 'morning' });
      store.upsertTask({ ...task('mid', 2, 60, 'day', 60), preferredSegment: 'morning' });
      store.upsertTask(task('lo', 3, 60, 'day', 60)); // flexible: sits 11:00 on the other days, where Tuesday's meeting leaves one morning hour
      store.addCommitment({ id: 'c', title: 'Meeting', start: d(6, 9).toISOString(), end: d(6, 11).toISOString() });
      const r = plan(store, { now: d(5, 9), horizon: 'week' });
      expect(tuesday(r.created).hi).toBe('11:00');
      expect(tuesday(r.created).lo).not.toBe('11:00');
    });

    it('several floaters need room together: two morning floaters do not fit the hour that is left, so the habit yields', () => {
      lunchGap();
      store.upsertTask({ ...task('hi', 1, 60, 'day', 60), preferredSegment: 'morning' });
      store.upsertTask({ ...task('mid', 2, 60, 'day', 60), preferredSegment: 'morning' });
      store.upsertTask(task('lo', 3, 60, 'day', 60));
      // 09:30-10:30 takes the habitual hours of hi (09:00) and mid (10:00); lo's 11:00 is free and leaves 60 morning minutes
      // outside it: each floater would fit alone, the two together would not.
      store.addCommitment({ id: 'c', title: 'Meeting', start: d(6, 9, 30).toISOString(), end: d(6, 10, 30).toISOString() });
      const r = plan(store, { now: d(5, 9), horizon: 'week' });
      expect(tuesday(r.created).lo).not.toBe('11:00');
      expect(tuesday(r.created).hi).toBe('10:30');
    });

    it('room in an accepted segment keeps the habit: a flexible floater is fine with the afternoon', () => {
      lunchGap();
      store.upsertTask(task('hi', 1, 60, 'day', 60));
      store.upsertTask(task('mid', 2, 60, 'day', 60));
      store.upsertTask(task('lo', 3, 60, 'day', 60));
      store.addCommitment({ id: 'c', title: 'Meeting', start: d(6, 9).toISOString(), end: d(6, 11).toISOString() }); // hi and mid (flexible) can take the afternoon's two hours
      const r = plan(store, { now: d(5, 9), horizon: 'week' });
      expect(tuesday(r.created)).toMatchObject({ lo: '11:00' });
    });
  });

  describe('a weekly task that prefers a segment when its mornings are full', () => {
    const evenings = () => store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' }, { days: [1, 2, 3, 4, 5], start: '19:00', end: '21:00' }], maxBlockMinutes: 60 });
    const meet = (days: number[]) => days.forEach((day) => store.addCommitment({ id: `m${day}`, title: 'Meeting', start: d(day, 9).toISOString(), end: d(day, 12).toISOString() }));
    const sittings = (created: { taskId: string; start: string }[]) => created.filter((b) => b.taskId === 'learn').map((b) => `${new Date(b.start).getDate()} ${hm(b.start)}`);

    // Thursday morning rather than Monday evening. Tried on 2026-10-09 and reverted (it spread routine-week's three morning
    // tasks); with the weekly pacing a paced sitting waits for a day with room in its segment while one remains.
    it('its mornings full on Monday to Wednesday and free on Thursday: it lands Thursday morning, not Monday evening', () => {
      evenings();
      store.upsertTask({ ...task('learn', 1, 60, 'week', 60), preferredSegment: 'morning' });
      meet([5, 6, 7]);
      const r = plan(store, { now: d(5, 9), horizon: 'week' });
      expect(sittings(r.created)).toEqual(['8 09:00']);
    });

    it('no morning has room: it takes an evening, so the budget is never left unmet', () => {
      evenings();
      store.upsertTask({ ...task('learn', 1, 120, 'week', 60), preferredSegment: 'morning' });
      meet([5, 6, 7, 8, 9]);
      const r = plan(store, { now: d(5, 9), horizon: 'week' });
      expect(sittings(r.created).length).toBe(2);
    });
  });

  it('a saved slot shorter than the session is not overrun: the sitting at the habit is capped at the slot, so the next saved slot keeps its hour', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '13:00' }], maxBlockMinutes: 120 });
    store.upsertTask(task('a', 1, 120, 'day', 120));
    store.upsertTask(task('b', 2, 60, 'day', 60));
    store.upsertTask(task('c', 3, 60, 'day', 60)); // c's slot at 12:00 keeps the baseline's usable span at 09:00-13:00
    store.setBaseline({ slots: [1, 2, 3, 4, 5].flatMap((day) => [{ taskId: 'a', day, start: '09:00', end: '10:00', kind: 'task' as const }, { taskId: 'b', day, start: '10:00', end: '11:00', kind: 'task' as const }, { taskId: 'c', day, start: '12:00', end: '13:00', kind: 'task' as const }]) });
    const r = plan(store, { now: d(5, 9), horizon: 'week' });
    for (const day of [5, 6, 7, 8, 9]) {
      const spans = r.created.filter((b) => new Date(b.start).getDate() === day).map((b) => `${b.taskId} ${hm(b.start)}-${hm(b.end)}`);
      expect(spans, `day ${day}`).toContain('a 09:00-10:00');
      expect(spans, `day ${day}`).toContain('b 10:00-11:00');
      expect(r.created.filter((b) => b.taskId === 'a' && new Date(b.start).getDate() === day).reduce((n, b) => n + (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000, 0), `day ${day}`).toBe(120); // the rest of a's session still lands
    }
  });

  describe('a first day cut at now, or led by a must-do, is not habit evidence', () => {
    const onDate = (created: { taskId: string; start: string }[], day: number) => created.filter((b) => new Date(b.start).getDate() === day);
    it('a first day cut at now does not set the slot of the days after it', () => {
      store.upsertTask(task('a', 1, 60, 'day', 60));
      const r = plan(store, { now: d(5, 11), horizon: 'week' }); // Monday starts at 11:00 because it is 11:00
      expect(onDate(r.created, 5).map((b) => hm(b.start))).toEqual(['11:00']);
      for (const day of [6, 7, 8, 9]) expect(onDate(r.created, day).map((b) => hm(b.start)), `day ${day}`).toEqual(['09:00']);
    });

    it('a first day led by a must-do does not set the slots of the days after it', () => {
      store.upsertTask(task('deep', 1, 60, 'day', 60));
      store.upsertTask(task('email', 3, 60, 'day', 60));
      const r = plan(store, { now: d(5, 9), horizon: 'week', mustDo: ['email'] }); // email leads Monday
      expect(onDate(r.created, 5).map((b) => b.taskId)).toEqual(['email', 'deep']);
      for (const day of [6, 7, 8, 9]) expect(onDate(r.created, day).map((b) => b.taskId), `day ${day}`).toEqual(['deep', 'email']);
    });
  });
});

describe('weekly sittings are paced across the week', () => {
  // Availability 09:00-13:00 on weekdays (two 120-minute sittings a day), cap 5: the pacing alone decides the days.
  const paced = () => store.saveSettings({ ...store.getSettings(), maxBlockMinutes: 120, maxTasksPerDay: 5 });
  const days = (created: { taskId: string; start: string }[], id: string) => created.filter((b) => b.taskId === id).map((b) => new Date(b.start).getDate());
  const minutes = (created: { taskId: string; start: string; end: string }[], id: string) => created.filter((b) => b.taskId === id).reduce((n, b) => n + (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000, 0);

  it('one weekly task of three sittings over Monday to Friday sits Monday, Wednesday and Friday', () => {
    paced();
    store.upsertTask(task('w', 1, 360, 'week', 120));
    const r = plan(store, { now: d(5, 9), horizon: 'week' });
    expect(days(r.created, 'w')).toEqual([5, 7, 9]);
    expect(minutes(r.created, 'w')).toBe(360);
  });

  it('a second weekly task is staggered: Tuesday, Thursday and Friday', () => {
    paced();
    store.upsertTask(task('a', 1, 360, 'week', 120));
    store.upsertTask(task('b', 2, 360, 'week', 120));
    const r = plan(store, { now: d(5, 9), horizon: 'week' });
    expect(days(r.created, 'a')).toEqual([5, 7, 9]);
    expect(days(r.created, 'b')).toEqual([6, 8, 9]);
  });

  it('catch-up: Monday fully taken by a commitment, the first sitting lands Tuesday and the week still holds three', () => {
    paced();
    store.addCommitment({ id: 'c', title: 'Offsite', start: d(5, 9).toISOString(), end: d(5, 13).toISOString() });
    store.upsertTask(task('w', 1, 360, 'week', 120));
    const r = plan(store, { now: d(5, 9), horizon: 'week' });
    expect(days(r.created, 'w')).toEqual([6, 7, 9]); // Tuesday catches up Monday's sitting; Wednesday and Friday as paced
    expect(minutes(r.created, 'w')).toBe(360);
  });

  it('five sittings over five days take every day', () => {
    paced();
    store.upsertTask(task('w', 1, 600, 'week', 120));
    const r = plan(store, { now: d(5, 9), horizon: 'week' });
    expect(days(r.created, 'w')).toEqual([5, 6, 7, 8, 9]);
  });

  it('the stagger never starves: two weekly tasks of five sittings each both get every day', () => {
    paced();
    store.upsertTask(task('a', 1, 600, 'week', 120));
    store.upsertTask(task('b', 2, 600, 'week', 120));
    const r = plan(store, { now: d(5, 9), horizon: 'week' });
    expect(days(r.created, 'a')).toEqual([5, 6, 7, 8, 9]);
    expect(days(r.created, 'b')).toEqual([5, 6, 7, 8, 9]);
  });
});

describe('a paced weekly sitting waits for a day with room in its segment while one remains', () => {
  // Mornings 09:00-12:00 and afternoons 14:00-18:00; System design prefers the morning, two sittings paced Tue and Thu.
  const week = () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }], maxBlockMinutes: 120 });
    store.upsertTask({ ...task('sd', 1, 240, 'week', 120), preferredSegment: 'morning' });
  };
  const spots = (created: { taskId: string; start: string }[]) => created.filter((b) => b.taskId === 'sd').map((b) => `${new Date(b.start).getDate()} ${hm(b.start)}`);

  it('its Thursday morning taken, the sitting lands Friday morning, not Thursday afternoon', () => {
    week();
    store.addCommitment({ id: 'c', title: 'Workshop', start: d(8, 9).toISOString(), end: d(8, 12).toISOString() });
    const r = plan(store, { now: d(5, 9), horizon: 'week' });
    expect(spots(r.created)).toEqual(['6 09:00', '9 09:00']);
  });

  it('on the week\'s last day it takes what is free outside its segment, so the budget is still met', () => {
    week();
    for (const day of [8, 9]) store.addCommitment({ id: `c${day}`, title: 'Workshop', start: d(day, 9).toISOString(), end: d(day, 12).toISOString() });
    const r = plan(store, { now: d(5, 9), horizon: 'week' });
    expect(spots(r.created)).toEqual(['6 09:00', '9 14:00']);
  });
});

describe('a remainder that cannot touch its sitting closes its own day before travelling', () => {
  const minutesOf = (r: { created: { taskId: string; start: string; end: string }[] }, id: string) => r.created.filter((b) => b.taskId === id).reduce((n, b) => n + (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000, 0);

  it('its sitting ends at the lunch gap: the remainder takes a second spot the same day, after another task\'s block, not the next day', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' }, { days: [1, 2, 3, 4, 5], start: '13:00', end: '17:00' }], maxBlockMinutes: 120 });
    store.upsertTask(task('x', 1, 60, 'day', 60));
    store.upsertTask(task('w', 2, 180, 'week', 120));
    const r = plan(store, { now: d(8, 9), horizon: 'week' }); // Thursday: x opens the day, w's sitting runs to the lunch gap, its hour cannot touch it
    expect(r.created.map((b) => [b.taskId, new Date(b.start).getDate(), hm(b.start), hm(b.end)])).toEqual([
      ['x', 8, '09:00', '10:00'], ['w', 8, '10:00', '12:00'], ['w', 8, '13:00', '14:00'], ['x', 9, '09:00', '10:00'],
    ]);
  });

  it('a remainder that can touch its sitting still does, and never opens a day on its own', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '13:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }], maxBlockMinutes: 120 });
    store.upsertTask(task('w', 1, 180, 'week', 120));
    const r = plan(store, { now: d(8, 9), horizon: 'week' }); // Thursday: the hour follows the sitting
    expect(r.created.map((b) => [new Date(b.start).getDate(), hm(b.start), hm(b.end)])).toEqual([[8, '09:00', '11:00'], [8, '11:00', '12:00']]);
  });

  it('the routine week under a cap of 6: every weekly budget met but what capacity forbids, and no task kept off while a place and room were free', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '07:00', end: '13:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }, { days: [1, 2, 3, 4, 5], start: '19:00', end: '21:00' }], maxBlockMinutes: 120, maxTasksPerDay: 6 });
    store.upsertTask(task('lc', 2, 60, 'day', 60));
    store.upsertTask(task('ai', 3, 60, 'day', 60));
    store.upsertTask({ ...task('build', 1, 120, 'day', 120), preferredSegment: 'afternoon' });
    store.upsertTask(task('beh', 4, 120, 'day', 120));
    store.upsertTask({ ...task('startup', 5, 300, 'week', 120), preferredSegment: 'morning' });
    store.upsertTask({ ...task('sd', 6, 300, 'week', 120), preferredSegment: 'morning' });
    store.upsertTask({ ...task('ml', 7, 180, 'week', 60), preferredSegment: 'morning' });
    const r = plan(store, { now: d(5, 7), horizon: 'week' });
    expect([minutesOf(r, 'startup'), minutesOf(r, 'sd'), minutesOf(r, 'ml')]).toEqual([300, 300, 180]);
    expect(r.overCap).toEqual([]);
    expect(r.weeklyUnmet).toEqual([]);
    // Two weekly places a day (the cap less the four daily tasks), and no day over the cap.
    for (const day of [5, 6, 7, 8, 9]) {
      const on = r.created.filter((b) => new Date(b.start).getDate() === day);
      expect(new Set(on.map((b) => b.taskId)).size, `day ${day}`).toBeLessThanOrEqual(6);
      expect(new Set(on.filter((b) => ['startup', 'sd', 'ml'].includes(b.taskId)).map((b) => b.taskId)).size, `weekly tasks on day ${day}`).toBeLessThanOrEqual(2);
    }
    // Morning learning's sittings are mornings but for the week's last day, which takes what is free.
    expect(r.created.filter((b) => b.taskId === 'ml' && new Date(b.start).getDate() < 9).every((b) => new Date(b.start).getHours() < 12)).toBe(true);
    // Asking again changes nothing.
    const again = plan(store, { now: d(5, 7), horizon: 'week' });
    expect([again.created, again.removed]).toEqual([[], 0]);
  });
});

describe('the pacing is anchored on the period start, so "plan my day" each morning paces like a week plan', () => {
  // The user's week: four daily tasks and three morning-preferring weekly tasks, mornings 07:00-13:00, afternoons
  // 14:00-18:00, evenings 19:00-21:00, cap 6 (two weekly places a day beside the dailies).
  const userWeek = (cap: number) => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '07:00', end: '13:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }, { days: [1, 2, 3, 4, 5], start: '19:00', end: '21:00' }], maxBlockMinutes: 120, maxTasksPerDay: cap });
    store.upsertTask(task('Leetcode', 2, 60, 'day', 60));
    store.upsertTask(task('AI learning', 3, 60, 'day', 60));
    store.upsertTask({ ...task('Building', 1, 120, 'day', 120), preferredSegment: 'afternoon' });
    store.upsertTask(task('Behavioral', 4, 120, 'day', 120));
    store.upsertTask({ ...task('Startup learning', 5, 300, 'week', 120), preferredSegment: 'morning' });
    store.upsertTask({ ...task('System design', 6, 300, 'week', 120), preferredSegment: 'morning' });
    store.upsertTask({ ...task('Morning learning', 7, 180, 'week', 60), preferredSegment: 'morning' });
  };
  const weekly = ['Startup learning', 'System design', 'Morning learning'];
  const live = (from: Date, to: Date) => store.listBlocks({ from, to }).filter((b) => b.status === 'pending' || b.status === 'done');
  const totals = () => weekly.map((id) => live(d(5, 0), d(10, 0)).filter((b) => b.taskId === id).reduce((n, b) => n + (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000, 0));

  it('planned day by day Monday to Friday, the week holds what the week plan holds, every weekday has a weekly sitting while minutes are owed, and no summary blames the cap for a task that sat on another day', () => {
    userWeek(6);
    const summaries: string[] = [];
    for (const day of [5, 6, 7, 8, 9]) {
      const r = runTool(store, 'plan_schedule', {}, { now: () => d(day, 7) }) as { summary: string };
      summaries.push(r.summary);
      // Every weekly task still owes minutes on each weekday morning, and the cap of 6 leaves two weekly places beside the
      // four daily tasks: a day of dailies only would be the pacing restarting from today.
      const weeklyOnDay = new Set(live(d(day, 0), d(day + 1, 0)).filter((b) => weekly.includes(b.taskId)).map((b) => b.taskId));
      expect(weeklyOnDay.size, `weekly tasks on day ${day}`).toBeGreaterThan(0);
      for (const b of live(d(day, 0), d(day + 1, 0))) if (b.status === 'pending') store.updateBlock(b.id, { status: 'done' });
    }
    expect(totals()).toEqual([300, 300, 180]);
    // Each task sat on some day of the week, so no day's summary may say the cap kept it off.
    for (const s of summaries) expect(s).not.toMatch(/The cap of/);
  });

  it('under a cap of 5 the day-by-day week reads as the week plan does: Tuesday holds a weekly sitting and the week ends with the same totals', () => {
    userWeek(5);
    const week = plan(store, { now: d(5, 7), horizon: 'week' });
    const weekTotals = weekly.map((id) => week.created.filter((b) => b.taskId === id).reduce((n, b) => n + (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000, 0));
    store.deleteBlocks(week.created.map((b) => b.id));
    for (const day of [5, 6, 7, 8, 9]) {
      plan(store, { now: d(day, 7) });
      expect(live(d(day, 0), d(day + 1, 0)).some((b) => weekly.includes(b.taskId)), `a weekly sitting on day ${day}`).toBe(true);
      for (const b of live(d(day, 0), d(day + 1, 0))) if (b.status === 'pending') store.updateBlock(b.id, { status: 'done' });
    }
    expect(totals()).toEqual(weekTotals);
  });
});

describe('daily tasks lead across passes: a daily task\'s whole sitting is placed before a weekly task\'s segment pass takes the slot', () => {
  const userWeek = () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '07:00', end: '13:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }, { days: [1, 2, 3, 4, 5], start: '19:00', end: '21:00' }], maxBlockMinutes: 120, maxTasksPerDay: 6 });
    store.upsertTask(task('Leetcode', 2, 60, 'day', 60));
    store.upsertTask(task('AI learning', 3, 60, 'day', 60));
    store.upsertTask({ ...task('Building', 1, 120, 'day', 120), preferredSegment: 'afternoon' });
    store.upsertTask(task('Behavioral', 4, 120, 'day', 120));
    store.upsertTask({ ...task('Startup learning', 5, 300, 'week', 120), preferredSegment: 'morning' });
    store.upsertTask({ ...task('System design', 6, 300, 'week', 120), preferredSegment: 'morning' });
    store.upsertTask({ ...task('Morning learning', 7, 180, 'week', 60), preferredSegment: 'morning' });
  };
  const live = (from: Date, to: Date) => store.listBlocks({ from, to }).filter((b) => b.status === 'pending' || b.status === 'done');
  const minutes = (b: { start: string; end: string }) => (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000;

  it('the dentist shape: re-planned at 09:00 with a dentist at 10:30, Behavioral keeps the morning and the weekly morning task takes what the morning leaves', () => {
    userWeek();
    for (const day of [5, 6]) {
      plan(store, { now: d(day, 7) });
      for (const b of live(d(day, 0), d(day + 1, 0))) if (b.status === 'pending') store.updateBlock(b.id, { status: 'done' });
    }
    // Wednesday: Leetcode and AI learning done at 07:00-09:00, a dentist at 10:30-11:30, the rest of the day planned at 09:00.
    store.insertBlocks([
      { id: 'lc-w', taskId: 'Leetcode', start: d(7, 7).toISOString(), end: d(7, 8).toISOString(), status: 'done', source: 'manual', createdAt: '', statusChangedAt: null },
      { id: 'ai-w', taskId: 'AI learning', start: d(7, 8).toISOString(), end: d(7, 9).toISOString(), status: 'done', source: 'manual', createdAt: '', statusChangedAt: null },
    ]);
    store.addCommitment({ id: 'c', title: 'Dentist', start: d(7, 10, 30).toISOString(), end: d(7, 11, 30).toISOString() });
    const r = plan(store, { now: d(7, 9) });
    const beh = r.created.filter((b) => b.taskId === 'Behavioral').sort((a, b) => a.start.localeCompare(b.start));
    // Behavioral's whole sitting leads: it opens the window at 09:00 (a split sitting beats a late start) and has its two hours.
    expect(hm(beh[0].start)).toBe('09:00');
    expect(beh.reduce((n, b) => n + minutes(b), 0)).toBe(120);
    expect(beh.every((b) => new Date(b.start).getHours() < 19)).toBe(true);
    // The weekly morning tasks take what the morning leaves after the dentist, or wait for their paced day.
    const weeklyMorning = r.created.filter((b) => ['Startup learning', 'System design', 'Morning learning'].includes(b.taskId) && new Date(b.start).getHours() < 13);
    expect(weeklyMorning.every((b) => new Date(b.start) >= d(7, 11, 30))).toBe(true);
  });

  it('the plain shape: a weekly morning task does not take the window\'s first slot from a daily task\'s whole sitting', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }], maxBlockMinutes: 120 });
    store.upsertTask(task('beh', 1, 120, 'day', 120));
    store.upsertTask({ ...task('ml', 2, 180, 'week', 60), preferredSegment: 'morning' });
    const r = plan(store, { now: d(7, 9) }); // Wednesday, Morning learning due by the pacing
    expect(r.created.map((b) => [b.taskId, hm(b.start), hm(b.end)])).toEqual([['beh', '09:00', '11:00'], ['ml', '11:00', '12:00']]);
  });
});

describe('the week\'s last day holds up to three sessions of a weekly task', () => {
  it('two, plus one more where free time remains; the rest is reported as unmet', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '14:00' }], maxBlockMinutes: 120 });
    store.upsertTask(task('solo', 1, 480, 'week', 120));
    const r = plan(store, { now: d(9, 8) }); // Friday, 480 minutes owed, six hours free
    expect(r.created.map((b) => [hm(b.start), hm(b.end)])).toEqual([['08:00', '10:00'], ['10:00', '12:00'], ['12:00', '14:00']]);
    expect(r.weeklyUnmet.map((x) => [x.task.id, x.minutes])).toEqual([['solo', 120]]);
  });

  it('a day before the last stays at two sessions', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '14:00' }], maxBlockMinutes: 120 });
    store.upsertTask(task('solo', 1, 480, 'week', 120));
    const r = plan(store, { now: d(8, 8) }); // Thursday: two sessions, Friday's share is not taken ahead
    expect(r.created.map((b) => [hm(b.start), hm(b.end)])).toEqual([['08:00', '10:00'], ['10:00', '12:00']]);
  });
});
