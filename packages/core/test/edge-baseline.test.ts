import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/store.js';
import { createBlock } from '../src/mark.js';
import { applyToWeek, availabilityFrom, budgetsFrom, normalizeBaseline, refreshBudgets, usableSpans } from '../src/baseline.js';
import { DEFAULT_SETTINGS, STANDARD_WEEK, type Baseline, type BaselineSlot, type Block, type Task } from '../src/types.js';

const d = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m); // Oct 2026: 9 Fri, 11 Sun, 12 Mon, 14 Wed, 16 Fri, 19 Mon
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, name: id, color: '#000', priority: 1, budgetMinutes: 120, budgetPeriod: 'day', archived: false, createdAt: '', ...extra });
const slot = (day: number, start: string, end: string, taskId?: string, title?: string): BaselineSlot =>
  taskId ? { day, start, end, kind: 'task', taskId } : { day, start, end, kind: 'busy', ...(title ? { title } : {}) };
const v2 = (slots: BaselineSlot[]): Baseline => ({ version: 1, savedAt: '', slots });
const blk = (id: string, taskId: string, start: Date, end: Date, extra: Partial<Block> = {}): Block =>
  ({ id, taskId, start: start.toISOString(), end: end.toISOString(), status: 'pending', source: 'baseline', createdAt: '', statusChangedAt: null, ...extra });
const hm = (iso: string) => { const x = new Date(iso); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; };

describe('normalizeBaseline at the edges', () => {
  it('a slot from 00:00 to 00:00 is empty and dropped; 00:00 to 24:00 is the whole day', () => {
    const b = normalizeBaseline({ version: 1, savedAt: '', slots: [slot(1, '00:00', '00:00', 'a'), slot(2, '00:00', '24:00', 'a')] })!;
    expect(b.slots).toEqual([{ day: 2, start: '00:00', end: '24:00', kind: 'task', taskId: 'a' }]);
    expect(usableSpans(b, 2)).toEqual([{ start: 0, end: 1440 }]);
  });
  it('a title is trimmed and cut at 200 characters; a blank title is left out', () => {
    const long = 'x'.repeat(250);
    const b = normalizeBaseline({ version: 1, savedAt: '', slots: [{ day: 1, start: '12:00', end: '13:00', kind: 'busy', title: `  ${long}  ` }, { day: 2, start: '12:00', end: '13:00', kind: 'busy', title: '   ' }] })!;
    expect(b.slots[0].title).toBe('x'.repeat(200));
    expect('title' in b.slots[1]).toBe(false);
  });
  it('a blank taskId is no task: dropped for a task slot or an untyped slot, ignored for a busy one', () => {
    const b = normalizeBaseline({ version: 1, savedAt: '', slots: [
      { day: 1, start: '09:00', end: '10:00', kind: 'task', taskId: '   ' },
      { day: 1, start: '10:00', end: '11:00', taskId: '' },
      { day: 1, start: '12:00', end: '13:00', kind: 'busy', taskId: '  ', title: 'Lunch' },
      { day: 1, start: '14:00', end: '15:00', title: 'Untyped' },
    ] })!;
    expect(b.slots).toEqual([{ day: 1, start: '12:00', end: '13:00', kind: 'busy', title: 'Lunch' }]);
  });
  it('an untyped slot with a taskId is a task slot', () => {
    expect(normalizeBaseline({ version: 1, savedAt: '', slots: [{ day: 1, start: '09:00', end: '10:00', taskId: 'a' }] })!.slots).toEqual([slot(1, '09:00', '10:00', 'a')]);
  });
  it('legacy entries are always task slots, whatever kind they claim; when both shapes are present the v2 slots win', () => {
    expect(normalizeBaseline({ savedAt: '', blocks: [{ taskId: 'a', day: 1, start: '09:00', end: '10:00', kind: 'busy' }] })!.slots).toEqual([slot(1, '09:00', '10:00', 'a')]);
    const both = normalizeBaseline({ savedAt: '', version: 4, slots: [slot(2, '09:00', '10:00', 'b')], blocks: [{ taskId: 'a', day: 1, start: '09:00', end: '10:00' }] })!;
    expect(both).toEqual({ version: 4, savedAt: '', slots: [slot(2, '09:00', '10:00', 'b')] });
  });
  it('a version that is not a positive integer reads as 1; a savedAt that is not a string reads as empty', () => {
    expect(normalizeBaseline({ version: 2.5, savedAt: 5, slots: [] })).toEqual({ version: 1, savedAt: '', slots: [] });
    expect(normalizeBaseline({ version: 0, savedAt: null, slots: [] })!.version).toBe(1);
    expect(normalizeBaseline({ version: '3', savedAt: '', slots: [] })!.version).toBe(1);
    expect(normalizeBaseline({ savedAt: 'x', blocks: [] })).toEqual({ version: 1, savedAt: 'x', slots: [] });
  });
  it('slots with the same day and start sort by end', () => {
    const b = normalizeBaseline({ version: 1, savedAt: '', slots: [slot(1, '09:00', '11:00', 'a'), slot(1, '09:00', '10:00', 'b'), slot(0, '23:00', '24:00', 'a')] })!;
    expect(b.slots.map((s) => [s.day, s.start, s.end])).toEqual([[0, '23:00', '24:00'], [1, '09:00', '10:00'], [1, '09:00', '11:00']]);
  });
  it('a start of 24:00 is never valid, and a day outside 0..6 or not an integer is dropped', () => {
    const b = normalizeBaseline({ version: 1, savedAt: '', slots: [slot(1, '24:00', '24:00', 'a'), { ...slot(1, '09:00', '10:00', 'a'), day: 1.5 }, { ...slot(1, '09:00', '10:00', 'a'), day: -1 }] })!;
    expect(b.slots).toEqual([]);
  });
});

describe('usableSpans at the edges', () => {
  it('a busy slot covering the task slot leaves no usable time; one equal to the whole span too', () => {
    expect(usableSpans(v2([slot(1, '09:00', '10:00', 'a'), slot(1, '08:00', '11:00')]), 1)).toEqual([]);
    expect(usableSpans(v2([slot(1, '09:00', '10:00', 'a'), slot(1, '09:00', '10:00')]), 1)).toEqual([]);
  });
  it('a busy slot before the first task slot opens the span at the busy slot and leaves the blank time after it usable', () => {
    expect(usableSpans(v2([slot(1, '07:00', '08:00'), slot(1, '09:00', '10:00', 'a')]), 1)).toEqual([{ start: 480, end: 600 }]);
  });
  it('busy slots touching the task slots on both sides leave exactly the task time', () => {
    expect(usableSpans(v2([slot(1, '09:00', '10:00', 'a'), slot(1, '10:00', '11:00'), slot(1, '11:00', '12:00', 'b')]), 1)).toEqual([{ start: 540, end: 600 }, { start: 660, end: 720 }]);
  });
  it('overlapping busy slots cut once; overlapping task slots form one span', () => {
    expect(usableSpans(v2([slot(1, '09:00', '12:00', 'a'), slot(1, '10:00', '11:00'), slot(1, '10:30', '11:30')]), 1)).toEqual([{ start: 540, end: 600 }, { start: 690, end: 720 }]);
    expect(usableSpans(v2([slot(1, '09:00', '11:00', 'a'), slot(1, '10:00', '12:00', 'b')]), 1)).toEqual([{ start: 540, end: 720 }]);
  });
  it('a busy slot that leaves a one-minute sliver keeps it', () => {
    expect(usableSpans(v2([slot(1, '09:00', '10:00', 'a'), slot(1, '09:01', '10:00')]), 1)).toEqual([{ start: 540, end: 541 }]);
  });
  it('the weekday is matched exactly: Sunday is 0 and Saturday 6; other days say nothing about this one', () => {
    const b = v2([slot(0, '09:00', '10:00', 'a'), slot(6, '21:00', '24:00', 'b')]);
    expect(usableSpans(b, 0)).toEqual([{ start: 540, end: 600 }]);
    expect(usableSpans(b, 6)).toEqual([{ start: 1260, end: 1440 }]);
    expect(usableSpans(b, 3)).toEqual([]);
  });
});

describe('availabilityFrom at the edges', () => {
  it('a day with two spans gives two windows on that day; identical spans on other days join them in day order', () => {
    const b = v2([slot(3, '09:00', '10:00', 'a'), slot(3, '12:00', '13:00'), slot(3, '14:00', '15:00', 'b'), slot(1, '09:00', '12:00', 'a'), slot(5, '13:00', '15:00', 'a')]);
    expect(availabilityFrom(b)).toEqual([
      { days: [1, 3], start: '09:00', end: '12:00' },
      { days: [3, 5], start: '13:00', end: '15:00' },
    ]);
  });
  it('a busy-only baseline gives no window', () => {
    expect(availabilityFrom(v2([slot(1, '12:00', '13:00'), slot(2, '12:00', '13:00')]))).toEqual([]);
  });
});

describe('budgetsFrom at the edges', () => {
  it('a slot to 24:00 counts to midnight; a three-way tie in session length goes to the longest', () => {
    const b = v2([slot(1, '22:00', '24:00', 'a'), slot(2, '09:00', '09:30', 'a'), slot(3, '09:00', '10:00', 'a')]);
    expect(budgetsFrom(b, 'a')).toEqual({ weeklyMinutes: 210, sessionMinutes: 120, days: [1, 2, 3] });
  });
  it('two slots on one day count the day once; a majority length wins over a longer minority', () => {
    const b = v2([slot(1, '09:00', '09:30', 'a'), slot(1, '14:00', '14:30', 'a'), slot(2, '09:00', '11:00', 'a')]);
    expect(budgetsFrom(b, 'a')).toEqual({ weeklyMinutes: 180, sessionMinutes: 30, days: [1, 2] });
  });
  it('a busy slot carrying the task\'s id (an un-normalized baseline) is not the task\'s', () => {
    const b: Baseline = { version: 1, savedAt: '', slots: [{ day: 1, start: '09:00', end: '10:00', kind: 'busy', taskId: 'a' } as BaselineSlot, slot(2, '09:00', '09:45', 'a')] };
    expect(budgetsFrom(b, 'a')).toEqual({ weeklyMinutes: 45, sessionMinutes: 45, days: [2] });
  });
});

describe('refreshBudgets at the edges', () => {
  let store: MemoryStore;
  beforeEach(() => { store = new MemoryStore(); store.upsertTask(task('a', { budgetMinutes: 999, budgetPeriod: 'day', sessionMinutes: 5 })); store.upsertTask(task('b', { budgetMinutes: 77 })); });
  it('a task with slots takes the slot sum, period week and the modal session; one without keeps its numbers; an unknown id is skipped', () => {
    const b = v2([slot(1, '09:00', '10:00', 'a'), slot(2, '09:00', '10:00', 'a'), slot(3, '09:00', '10:00', 'gone')]);
    const out = refreshBudgets(store, b);
    expect(out.map((t) => [t.id, t.budgetMinutes, t.budgetPeriod, t.sessionMinutes])).toEqual([['a', 120, 'week', 60]]);
    expect(store.getTask('b')).toMatchObject({ budgetMinutes: 77, budgetPeriod: 'day' });
    expect('sessionMinutes' in store.getTask('b')!).toBe(false);
  });
  it('is idempotent, and an archived task with a slot is refreshed too', () => {
    store.archiveTask('a');
    const b = v2([slot(1, '09:00', '10:30', 'a')]);
    refreshBudgets(store, b);
    const once = store.getTask('a');
    refreshBudgets(store, b);
    expect(store.getTask('a')).toEqual(once);
    expect(once).toMatchObject({ archived: true, budgetMinutes: 90, sessionMinutes: 90, budgetPeriod: 'week' });
  });
  it('a busy-only baseline refreshes nothing', () => {
    expect(refreshBudgets(store, v2([slot(1, '12:00', '13:00')]))).toEqual([]);
    expect(store.getTask('a')!.budgetMinutes).toBe(999);
  });
});

describe('applyToWeek at the edges', () => {
  let store: MemoryStore;
  const weekOf12 = d(12, 0);
  beforeEach(() => {
    store = new MemoryStore();
    store.saveSettings({ ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, slotMinutes: 15 });
    store.upsertTask(task('a'));
    store.upsertTask(task('b'));
  });
  const monday = () => v2([slot(1, '09:00', '10:00', 'a')]);

  it('a slot that ends exactly at now is skipped silently; one ending a minute later is laid, past as it mostly is', () => {
    expect(applyToWeek(store, monday(), weekOf12, d(12, 10))).toEqual({ created: [], commitments: [], replaced: 0, skipped: [] });
    const r = applyToWeek(store, monday(), weekOf12, d(12, 9, 59));
    expect(r.created.map((b) => [hm(b.start), hm(b.end)])).toEqual([['09:00', '10:00']]);
  });
  it('a busy slot that ends exactly at now is not made; a slot to 24:00 with now inside it is laid to the next midnight', () => {
    const b = v2([slot(1, '08:00', '09:00', undefined, 'Gym'), slot(1, '08:00', '09:01', undefined, 'Coffee'), slot(5, '22:00', '24:00', 'a')]);
    const r = applyToWeek(store, b, weekOf12, d(12, 9));
    expect(r.commitments.map((c) => c.title)).toEqual(['Coffee']);
    const late = applyToWeek(store, b, weekOf12, d(16, 23));
    expect(late.created.map((x) => [x.start, x.end])).toEqual([[d(16, 22).toISOString(), d(17, 0).toISOString()]]);
  });
  it('a week starting on a Wednesday runs Wed..Tue: Monday\'s slot lands on the following Monday; a weekStart with a time is floored to its day', () => {
    const b = v2([slot(1, '09:00', '10:00', 'a'), slot(3, '09:00', '10:00', 'b')]);
    const r = applyToWeek(store, b, d(14, 15, 30), d(9, 12));
    expect(r.created.map((x) => [x.taskId, x.start])).toEqual([[ 'a', d(19, 9).toISOString()], ['b', d(14, 9).toISOString()]]);
  });
  it('an empty baseline applied over an earlier copy removes the copies ahead of now and lays nothing', () => {
    const b = v2([slot(1, '09:00', '10:00', 'a'), slot(1, '12:00', '13:00', undefined, 'Lunch'), slot(3, '09:00', '10:00', 'b')]);
    applyToWeek(store, b, weekOf12, d(9, 12));
    const r = applyToWeek(store, v2([]), weekOf12, d(12, 9, 30)); // Monday 09:30: the 09:00 block is still ahead (ends at 10:00)
    expect(r).toEqual({ created: [], commitments: [], replaced: 2, skipped: [] });
    expect(store.listBlocks({ from: weekOf12, to: d(19, 0) })).toEqual([]);
    expect(store.listCommitments({ from: weekOf12, to: d(19, 0) })).toEqual([]);
  });
  it('a copy with tracked minutes, or with a running clock, survives a re-apply and claims its slot', () => {
    const b = v2([slot(1, '09:00', '10:00', 'a'), slot(3, '09:00', '10:00', 'b')]);
    const first = applyToWeek(store, b, weekOf12, d(9, 12));
    const [mon, wed] = first.created;
    store.updateBlock(mon.id, { trackedMinutes: 5 });
    store.updateBlock(wed.id, { runningSince: d(14, 9).toISOString() });
    const r = applyToWeek(store, b, weekOf12, d(9, 12));
    expect(r.replaced).toBe(0);
    expect(r.created).toEqual([]);
    expect(r.skipped.map((x) => [x.slot.day, x.reason])).toEqual([[1, 'already has a at 09:00'], [3, 'already has b at 09:00']]);
    expect(store.listBlocks({ from: weekOf12, to: d(19, 0) }).map((x) => x.id).sort()).toEqual([mon.id, wed.id].sort());
  });
  it('copies already over at now are kept with their ids, not replaced, and their slots are not laid again nor named', () => {
    const b = v2([slot(1, '09:00', '10:00', 'a'), slot(3, '09:00', '10:00', 'b'), slot(5, '09:00', '10:00', 'a')]);
    const first = applyToWeek(store, b, weekOf12, d(9, 12));
    const mon = first.created[0];
    const r = applyToWeek(store, b, weekOf12, d(13, 12)); // Tuesday noon
    expect(r.replaced).toBe(2);
    expect(r.created.map((x) => x.taskId)).toEqual(['b', 'a']);
    expect(r.skipped).toEqual([]);
    expect(store.getBlock(mon.id)).toMatchObject({ start: d(12, 9).toISOString(), status: 'pending' });
  });
  it('overlapping slots on one day: the second is laid over the first\'s block and skipped, same task or not', () => {
    const r = applyToWeek(store, v2([slot(1, '09:00', '10:00', 'a'), slot(1, '09:30', '10:30', 'a'), slot(1, '09:45', '11:00', 'b')]), weekOf12, d(9, 12));
    expect(r.created.map((x) => [x.taskId, hm(x.start)])).toEqual([['a', '09:00']]);
    expect(r.skipped.map((x) => [x.slot.start, x.reason])).toEqual([['09:30', 'over a block of a'], ['09:45', 'over a block of a']]);
  });
  it('a missed or skipped block of another task under a slot does not stop it; a done one does', () => {
    store.insertBlocks([
      blk('m', 'b', d(12, 9), d(12, 10), { status: 'missed', source: 'planner' }),
      blk('s', 'b', d(14, 9), d(14, 10), { status: 'skipped', source: 'planner' }),
      blk('dn', 'b', d(16, 9), d(16, 10), { status: 'done', source: 'planner' }),
    ]);
    const r = applyToWeek(store, v2([slot(1, '09:00', '10:00', 'a'), slot(3, '09:00', '10:00', 'a'), slot(5, '09:00', '10:00', 'a')]), weekOf12, d(9, 12));
    expect(r.created.map((x) => x.start)).toEqual([d(12, 9).toISOString(), d(14, 9).toISOString()]);
    expect(r.skipped.map((x) => [x.slot.day, x.reason])).toEqual([[5, 'over a block of b']]);
  });
  it('a busy slot without a title is "Busy", and a task slot under its own baseline\'s busy slot is skipped as under it', () => {
    const r = applyToWeek(store, v2([slot(1, '09:00', '10:00', 'a'), slot(1, '09:30', '10:30')]), weekOf12, d(9, 12));
    expect(r.commitments.map((c) => c.title)).toEqual(['Busy']);
    expect(r.created).toEqual([]);
    expect(r.skipped.map((x) => x.reason)).toEqual(['under "Busy"']);
  });
  it('a commitment that ends exactly when the slot starts, or starts exactly when it ends, does not cover it', () => {
    store.addCommitment({ id: 'c1', title: 'Before', start: d(12, 8).toISOString(), end: d(12, 9).toISOString() });
    store.addCommitment({ id: 'c2', title: 'After', start: d(12, 10).toISOString(), end: d(12, 11).toISOString() });
    const r = applyToWeek(store, monday(), weekOf12, d(9, 12));
    expect(r.created.length).toBe(1);
    expect(r.skipped).toEqual([]);
  });
  it('a hand-placed block on another day never claims a slot; a block equidistant from two slots claims the earlier', () => {
    createBlock(store, 'a', d(13, 9), d(13, 10), d(9, 12)); // Tuesday
    const two = v2([slot(1, '09:00', '10:00', 'a'), slot(1, '13:00', '14:00', 'a')]);
    expect(applyToWeek(store, two, weekOf12, d(9, 12)).created.map((x) => hm(x.start))).toEqual(['09:00', '13:00']);
    createBlock(store, 'a', d(12, 11), d(12, 12), d(9, 12)); // Monday 11:00: two hours from both slots
    const r = applyToWeek(store, two, weekOf12, d(9, 12));
    expect(r.created.map((x) => hm(x.start))).toEqual(['13:00']);
    expect(r.skipped.map((x) => [x.slot.start, x.reason])).toEqual([['09:00', 'already has a at 11:00']]);
  });
  it('a week entirely in the past lays nothing and replaces nothing', () => {
    const b = v2([slot(1, '09:00', '10:00', 'a'), slot(1, '12:00', '13:00')]);
    applyToWeek(store, b, weekOf12, d(9, 12));
    const r = applyToWeek(store, b, weekOf12, d(20, 0));
    expect(r).toEqual({ created: [], commitments: [], replaced: 0, skipped: [] });
    expect(store.listBlocks({ from: weekOf12, to: d(19, 0) }).length).toBe(1);
    expect(store.listCommitments({ from: weekOf12, to: d(19, 0) }).length).toBe(1);
  });
  it('the baseline is normalized on the way in: a slot ending 00:00 runs to midnight and junk is dropped', () => {
    const raw = { version: 1, savedAt: '', slots: [{ day: 1, start: '22:00', end: '00:00', kind: 'task', taskId: 'a' }, { day: 1, start: '10:00', end: '09:00', kind: 'task', taskId: 'a' }] } as unknown as Baseline;
    const r = applyToWeek(store, raw, weekOf12, d(9, 12));
    expect(r.created.map((x) => [x.start, x.end])).toEqual([[d(12, 22).toISOString(), d(13, 0).toISOString()]]);
  });
  it('two busy slots on one day make two commitments, and a re-apply replaces both rather than adding', () => {
    const b = v2([slot(1, '09:00', '10:00', 'a'), slot(1, '12:00', '13:00', undefined, 'Lunch'), slot(1, '15:00', '15:30', undefined, 'Coffee')]);
    applyToWeek(store, b, weekOf12, d(9, 12));
    applyToWeek(store, b, weekOf12, d(9, 12));
    expect(store.listCommitments({ from: weekOf12, to: d(19, 0) }).map((c) => c.title)).toEqual(['Lunch', 'Coffee']);
  });
  it('an archived task\'s slot is skipped without being named, and a slot for a task not in the store too', () => {
    store.archiveTask('b');
    const r = applyToWeek(store, v2([slot(1, '09:00', '10:00', 'a'), slot(1, '10:00', '11:00', 'b'), slot(1, '11:00', '12:00', 'zz')]), weekOf12, d(9, 12));
    expect(r.created.map((x) => x.taskId)).toEqual(['a']);
    expect(r.skipped).toEqual([]);
  });
  it('a recurring commitment that covers only the last minute of a slot still covers it', () => {
    store.addRecurring({ id: 'r', title: 'Standup', days: [1], start: '09:59', end: '10:15' });
    const r = applyToWeek(store, monday(), weekOf12, d(9, 12));
    expect(r.created).toEqual([]);
    expect(r.skipped.map((x) => x.reason)).toEqual(['under "Standup"']);
  });
});
