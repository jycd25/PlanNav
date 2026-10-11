import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/store.js';
import { plan } from '../src/plan.js';
import { createBlock, moveBlock } from '../src/mark.js';
import { runTool } from '../src/tools.js';
import { DEFAULT_SETTINGS, STANDARD_WEEK, type Baseline, type BaselineSlot, type Task } from '../src/types.js';
import { applyToWeek, availabilityFrom, budgetsFrom, normalizeBaseline, usableSpans } from '../src/baseline.js';

const d = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m); // Oct 2026: 5 Mon .. 9 Fri, 12 next Mon
const task = (id: string, name = id): Task => ({ id, name, color: '#000', priority: 1, budgetMinutes: 120, budgetPeriod: 'day', archived: false, createdAt: '' });
let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
  store.saveSettings({ ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, maxBlockMinutes: 60, minBlockMinutes: 30, slotMinutes: 15 });
  store.upsertTask(task('a'));
  store.upsertTask(task('b'));
});

describe('block sources', () => {
  it('planner blocks are source planner; hand-made blocks are manual; moving a block makes it manual', () => {
    const r = plan(store, { now: d(7, 9), until: d(7, 11) });
    expect(r.created.every((b) => (b.source ?? 'planner') === 'planner')).toBe(true);
    const hand = createBlock(store, 'b', d(7, 14), d(7, 15), d(7, 9));
    expect(hand.source).toBe('manual');
    const moved = moveBlock(store, r.created[0].id, d(7, 12), d(7, 13));
    expect(moved.source).toBe('manual');
  });

  it('re-planning keeps manual blocks and plans around them', () => {
    createBlock(store, 'b', d(7, 10), d(7, 11), d(7, 9));
    const r = plan(store, { now: d(7, 9), until: d(7, 12) });
    expect(r.removed).toBe(0);
    const all = store.listBlocks({ from: d(7, 0), to: d(8, 0) }).map((b) => [b.taskId, b.start, b.source ?? 'planner']);
    expect(all).toContainEqual(['b', d(7, 10).toISOString(), 'manual']);
    expect(all.filter((x) => x[2] === 'planner').every((x) => x[1] !== d(7, 10).toISOString())).toBe(true);
    const again = plan(store, { now: d(7, 9), until: d(7, 12) });
    expect(again.removed).toBe(0); // the planner's own blocks still fit, so they stay as they are
    expect(again.kept.length).toBe(r.created.length);
    expect(again.created).toEqual([]);
  });
});

describe('save_baseline and apply_baseline', () => {
  it('saves the task blocks and one-off commitments of a week as a weekday template and applies it to another week', () => {
    createBlock(store, 'a', d(9, 7), d(9, 9), d(9, 6));   // Fri 07:00-09:00
    createBlock(store, 'b', d(9, 14), d(9, 15), d(9, 6)); // Fri 14:00-15:00
    store.addCommitment({ id: 'lunch', title: 'Lunch', start: d(9, 12).toISOString(), end: d(9, 13).toISOString() });
    store.addRecurring({ id: 'standup', title: 'Standup', days: [5], start: '10:00', end: '10:30' }); // weekly, not a one-off: not a slot
    const saved = runTool(store, 'save_baseline', { days: 'fri' }, { now: () => d(9, 12) }) as any;
    expect(saved.blocks).toEqual([
      { taskId: 'a', taskName: 'a', day: 5, start: '07:00', end: '09:00' },
      { taskId: 'b', taskName: 'b', day: 5, start: '14:00', end: '15:00' },
    ]);
    expect(saved.busy).toEqual([{ day: 5, start: '12:00', end: '13:00', title: 'Lunch' }]);
    expect(saved.version).toBe(1);
    expect(saved.summary).toBe('Saved 2 task slots and 1 busy slot on Fri as baseline v1.');
    expect(store.getBaseline()!.slots).toEqual([
      { day: 5, start: '07:00', end: '09:00', kind: 'task', taskId: 'a' },
      { day: 5, start: '12:00', end: '13:00', kind: 'busy', title: 'Lunch' },
      { day: 5, start: '14:00', end: '15:00', kind: 'task', taskId: 'b' },
    ]);
    const applied = runTool(store, 'apply_baseline', { week_of: 'next week' }, { now: () => d(9, 12) }) as any;
    expect(applied.created.map((b: any) => [b.taskName, b.start, b.source])).toEqual([
      ['a', d(16, 7).toISOString(), 'baseline'],
      ['b', d(16, 14).toISOString(), 'baseline'],
    ]);
    expect(applied.commitments.map((c: any) => [c.title, c.start])).toEqual([['Lunch', d(16, 12).toISOString()]]);
    expect(applied.summary).toBe('Copied 2 baseline blocks and 1 busy slot onto the week of Sun 2026-10-11.');
    // Applying again replaces the previous baseline copies rather than duplicating.
    const twice = runTool(store, 'apply_baseline', { week_of: 'next week' }, { now: () => d(9, 12) }) as any;
    expect(twice.replaced).toBe(2);
    expect(twice.summary).toBe('Copied 2 baseline blocks and 1 busy slot onto the week of Sun 2026-10-11, replacing 2.');
    expect(store.listBlocks({ from: d(12, 0), to: d(19, 0) }).length).toBe(2);
    expect(store.listCommitments({ from: d(12, 0), to: d(19, 0) }).length).toBe(1);
    // Planning next week keeps the baseline copies.
    const r = plan(store, { now: d(12, 9), horizon: 'week' });
    expect(r.removed).toBe(0);
    expect(store.listBlocks({ from: d(16, 0), to: d(17, 0) }).some((b) => b.source === 'baseline')).toBe(true);
    // A commitment added over a slot since: the slot is skipped and named; the planner's blocks of that week claim nothing (other tasks).
    store.addCommitment({ id: 'call', title: 'Call', start: d(16, 7).toISOString(), end: d(16, 8).toISOString() });
    const third = runTool(store, 'apply_baseline', { week_of: 'next week' }, { now: () => d(9, 12) }) as any;
    expect(third.summary).toBe('Copied 1 baseline block and 1 busy slot onto the week of Sun 2026-10-11, replacing 2; skipped a Fri 07:00 (under "Call").');
    expect(third.skipped.map((x: any) => x.reason)).toEqual(['under "Call"']);
    expect(store.listBlocks({ from: d(16, 0), to: d(17, 0) }).filter((b) => b.source === 'baseline').map((b) => b.taskId)).toEqual(['b']);
  });

  it('asks before saving when a day in the range is only partly planned, and accepts a days filter', () => {
    createBlock(store, 'a', d(8, 19), d(8, 20), d(8, 18));   // Thu evening only
    createBlock(store, 'a', d(9, 9), d(9, 12), d(9, 6));     // Fri morning
    createBlock(store, 'b', d(9, 14), d(9, 17), d(9, 6));    // Fri afternoon
    const first = runTool(store, 'save_baseline', {}, { now: () => d(9, 12) }) as any;
    expect(first.needsConfirmation).toBe(true);
    expect(first.partialDays).toEqual(['Thu']);
    expect(store.getBaseline()).toBeUndefined();
    const friday = runTool(store, 'save_baseline', { days: 'fri' }, { now: () => d(9, 12) }) as any;
    expect(friday.needsConfirmation).toBeUndefined();
    expect(friday.blocks.every((b: any) => b.day === 5)).toBe(true);
    const all = runTool(store, 'save_baseline', { confirm: true }, { now: () => d(9, 12) }) as any;
    expect(all.blocks.length).toBe(3);
  });

  it('explains when there is no baseline and when the week has no blocks', () => {
    expect(() => runTool(store, 'apply_baseline', {}, { now: () => d(9, 12) })).toThrow(/no baseline saved/i);
    expect(() => runTool(store, 'save_baseline', {}, { now: () => d(9, 12) })).toThrow(/no blocks/i);
  });
});

describe('settled schedules are edited, not regenerated', () => {
  it('save_baseline locks the planner\'s blocks in that week so a later re-plan keeps them', () => {
    const r = plan(store, { now: d(9, 9), until: d(9, 12) });
    expect(r.created.length).toBeGreaterThan(0);
    runTool(store, 'save_baseline', { confirm: true }, { now: () => d(9, 9, 30) });
    expect(store.listBlocks({ from: d(9, 0), to: d(10, 0) }).every((b) => b.source === 'baseline')).toBe(true);
    const again = plan(store, { now: d(9, 9), until: d(9, 12) });
    expect(again.removed).toBe(0);
    expect(again.created).toEqual([]);
  });

  it('move_block moves one block by task name or id and keeps it on later re-plans', () => {
    const r = plan(store, { now: d(9, 9), until: d(9, 11) });
    const first = r.created[0];
    const moved = runTool(store, 'move_block', { task: first.taskId, start: '13:00' }, { now: () => d(9, 9, 30) }) as any;
    expect(moved.start).toBe(d(9, 13).toISOString());
    expect(moved.end).toBe(new Date(d(9, 13).getTime() + (new Date(first.end).getTime() - new Date(first.start).getTime())).toISOString());
    expect(moved.source).toBe('manual');
    const byId = runTool(store, 'move_block', { block_id: moved.id, start: '14:00', end: '14:30' }, { now: () => d(9, 9, 30) }) as any;
    expect(byId.end).toBe(d(9, 14, 30).toISOString());
    const again = plan(store, { now: d(9, 9), until: d(9, 15) });
    expect(store.getBlock(moved.id)!.start).toBe(d(9, 14).toISOString());
    expect(again.created.every((b) => b.start !== d(9, 14).toISOString())).toBe(true);
    expect(() => runTool(store, 'move_block', { task: 'nope', start: '13:00' }, { now: () => d(9, 9, 30) })).toThrow(/No task matches/);
  });

  it('add_block and delete_block edit single blocks', () => {
    const added = runTool(store, 'add_block', { task: 'b', start: '15:00', end: '16:00' }, { now: () => d(9, 9) }) as any;
    expect(added.source).toBe('manual');
    expect(added.taskName).toBe('b');
    const del = runTool(store, 'delete_block', { block_id: added.id }, { now: () => d(9, 9) }) as any;
    expect(del.ok).toBe(true);
    expect(store.getBlock(added.id)).toBeUndefined();
    expect(() => runTool(store, 'delete_block', { block_id: 'nope' }, { now: () => d(9, 9) })).toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Baseline v2: a versioned template week of task and busy slots; availability and budgets derived from it.
// ---------------------------------------------------------------------------------------------------------------------
const slot = (day: number, start: string, end: string, taskId?: string): BaselineSlot =>
  taskId ? { day, start, end, kind: 'task', taskId } : { day, start, end, kind: 'busy', title: 'Lunch' };
const v2 = (slots: BaselineSlot[]): Baseline => ({ version: 1, savedAt: '', slots });

describe('normalizeBaseline', () => {
  it('reads the old shape ({ blocks }) as task slots, version 1', () => {
    const b = normalizeBaseline({ savedAt: '2026-10-01T00:00:00.000Z', blocks: [{ taskId: 'a', day: 1, start: '09:00', end: '10:00' }] });
    expect(b).toEqual({ version: 1, savedAt: '2026-10-01T00:00:00.000Z', slots: [{ day: 1, start: '09:00', end: '10:00', kind: 'task', taskId: 'a' }] });
  });

  it('keeps a v2 baseline as it is, slots sorted by day then start', () => {
    const raw = { version: 3, savedAt: 'x', slots: [slot(2, '09:00', '10:00', 'a'), slot(1, '12:00', '13:00'), slot(1, '09:00', '10:00', 'b')] };
    expect(normalizeBaseline(raw)).toEqual({ version: 3, savedAt: 'x', slots: [slot(1, '09:00', '10:00', 'b'), slot(1, '12:00', '13:00'), slot(2, '09:00', '10:00', 'a')] });
  });

  it('drops junk slots and rejects what is not a baseline at all', () => {
    expect(normalizeBaseline(undefined)).toBeUndefined();
    expect(normalizeBaseline(null)).toBeUndefined();
    expect(normalizeBaseline('baseline')).toBeUndefined();
    expect(normalizeBaseline({ savedAt: '' })).toBeUndefined();
    const b = normalizeBaseline({ version: -2, savedAt: 7, slots: [
      null, 'x', { day: 7, start: '09:00', end: '10:00', kind: 'task', taskId: 'a' }, { day: 1, start: '9:00', end: '10:00', kind: 'task', taskId: 'a' },
      { day: 1, start: '10:00', end: '09:00', kind: 'task', taskId: 'a' }, { day: 1, start: '09:00', end: '10:00', kind: 'task' },
      { day: 1, start: '09:00', end: '10:00', kind: 'nap' }, { day: 1, start: '25:00', end: '26:00', kind: 'busy' },
      { day: 1, start: '09:00', end: '10:00', kind: 'task', taskId: 'ok' },
    ] });
    expect(b).toEqual({ version: 1, savedAt: '', slots: [{ day: 1, start: '09:00', end: '10:00', kind: 'task', taskId: 'ok' }] });
  });

  it('a slot may end at midnight: 24:00, or 00:00 after a later start, both read as 24:00', () => {
    const b = normalizeBaseline({ version: 1, savedAt: '', slots: [slot(5, '22:00', '24:00', 'a'), { day: 6, start: '23:00', end: '00:00', kind: 'busy' }] })!;
    expect(b.slots.map((s) => s.end)).toEqual(['24:00', '24:00']);
    expect(normalizeBaseline({ version: 1, savedAt: '', slots: [slot(5, '24:00', '24:00', 'a')] })!.slots).toEqual([]);
  });

  it('a busy slot keeps its title and never carries a task', () => {
    const b = normalizeBaseline({ version: 1, savedAt: '', slots: [{ day: 1, start: '12:00', end: '13:00', kind: 'busy', taskId: 'a', title: 'Gym' }] })!;
    expect(b.slots).toEqual([{ day: 1, start: '12:00', end: '13:00', kind: 'busy', title: 'Gym' }]);
  });
});

describe('usableSpans', () => {
  it('runs from the first slot to the last, blank time inside included', () => {
    expect(usableSpans(v2([slot(1, '09:00', '10:00', 'a'), slot(1, '14:00', '15:00', 'b')]), 1)).toEqual([{ start: 540, end: 900 }]);
  });

  it('a busy slot in the middle cuts the span in two', () => {
    const b = v2([slot(1, '09:00', '10:00', 'a'), slot(1, '12:00', '13:00'), slot(1, '16:00', '17:00', 'b')]);
    expect(usableSpans(b, 1)).toEqual([{ start: 540, end: 720 }, { start: 780, end: 1020 }]);
  });

  it('a busy slot at the edge is not usable', () => {
    const b = v2([slot(1, '08:00', '09:00'), slot(1, '09:00', '10:00', 'a')]);
    expect(usableSpans(b, 1)).toEqual([{ start: 540, end: 600 }]);
  });

  it('a day with only busy slots, or none, has no usable span', () => {
    const b = v2([slot(1, '09:00', '10:00', 'a'), slot(6, '10:00', '12:00')]);
    expect(usableSpans(b, 6)).toEqual([]);
    expect(usableSpans(b, 0)).toEqual([]);
  });

  it('a slot ending at midnight ends the span at minute 1440', () => {
    expect(usableSpans(v2([slot(5, '20:00', '24:00', 'a')]), 5)).toEqual([{ start: 1200, end: 1440 }]);
  });
});

describe('availabilityFrom', () => {
  it('turns the usable spans into the availability windows the settings use, days with the same span sharing a window', () => {
    const week = [1, 2, 3, 4, 5].flatMap((day) => [slot(day, '09:00', '12:00', 'a'), slot(day, '15:00', '18:00', 'b')]);
    expect(availabilityFrom(v2(week))).toEqual(STANDARD_WEEK);
  });

  it('a busy slot splits the window; a busy-only day has none; midnight ends at 24:00', () => {
    const b = v2([slot(1, '09:00', '10:00', 'a'), slot(1, '12:00', '13:00'), slot(1, '16:00', '17:00', 'b'), slot(6, '10:00', '11:00'), slot(5, '21:00', '24:00', 'a')]);
    expect(availabilityFrom(b)).toEqual([
      { days: [1], start: '09:00', end: '12:00' },
      { days: [1], start: '13:00', end: '17:00' },
      { days: [5], start: '21:00', end: '24:00' },
    ]);
  });

  it('an empty baseline gives no windows', () => {
    expect(availabilityFrom(v2([]))).toEqual([]);
  });
});

describe('budgetsFrom', () => {
  it('sums the task\'s slots, takes the most common slot length as the session, and lists its days', () => {
    const b = v2([slot(1, '09:00', '10:00', 'a'), slot(2, '09:00', '10:00', 'a'), slot(4, '09:00', '11:00', 'a'), slot(4, '14:00', '15:00', 'b'), slot(3, '12:00', '13:00')]);
    expect(budgetsFrom(b, 'a')).toEqual({ weeklyMinutes: 240, sessionMinutes: 60, days: [1, 2, 4] });
    expect(budgetsFrom(b, 'b')).toEqual({ weeklyMinutes: 60, sessionMinutes: 60, days: [4] });
  });

  it('a tie between session lengths goes to the longer one', () => {
    expect(budgetsFrom(v2([slot(1, '09:00', '09:30', 'a'), slot(2, '09:00', '10:30', 'a')]), 'a').sessionMinutes).toBe(90);
  });

  it('a task without slots has nothing', () => {
    expect(budgetsFrom(v2([slot(1, '09:00', '10:00', 'a')]), 'z')).toEqual({ weeklyMinutes: 0, sessionMinutes: 0, days: [] });
  });
});

describe('store baseline versions', () => {
  it('setBaseline appends a version; getBaseline returns the latest; listBaselines returns them all', () => {
    const s = new MemoryStore();
    expect(s.getBaseline()).toBeUndefined();
    expect(s.listBaselines!()).toEqual([]);
    s.setBaseline({ savedAt: '2026-10-01T00:00:00.000Z', slots: [slot(1, '09:00', '10:00', 'a')] });
    s.setBaseline({ version: 99, savedAt: '', slots: [slot(1, '09:00', '11:00', 'a')] });
    expect(s.listBaselines!().map((b) => b.version)).toEqual([1, 2]);
    expect(s.getBaseline()!.version).toBe(2);
    expect(s.getBaseline()!.slots).toEqual([slot(1, '09:00', '11:00', 'a')]);
    expect(s.listBaselines!()[0].savedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(s.getBaseline()!.savedAt).not.toBe(''); // an empty savedAt is stamped
  });

  it('setBaseline reads the old shape, so earlier callers keep working', () => {
    const s = new MemoryStore();
    s.setBaseline({ savedAt: '', blocks: [{ taskId: 'a', day: 1, start: '09:00', end: '10:00' }] } as any);
    expect(s.getBaseline()!.slots).toEqual([slot(1, '09:00', '10:00', 'a')]);
  });

  it('a stored baseline is a copy: mutating what was returned changes nothing', () => {
    const s = new MemoryStore();
    s.setBaseline({ slots: [slot(1, '09:00', '10:00', 'a')] });
    s.getBaseline()!.slots.push(slot(2, '09:00', '10:00', 'a'));
    expect(s.getBaseline()!.slots.length).toBe(1);
  });
});

describe('applyToWeek', () => {
  const week = () => v2([slot(1, '09:00', '10:00', 'a'), slot(1, '12:00', '13:00'), slot(3, '14:00', '15:00', 'b'), slot(5, '22:00', '24:00', 'a')]);
  const weekOf12 = d(12, 0); // Monday 12 Oct 2026

  it('creates the task slots as dated baseline blocks and the busy slots as commitments', () => {
    const r = applyToWeek(store, week(), weekOf12, d(9, 12));
    expect(r.replaced).toBe(0);
    expect(r.created.map((b) => [b.taskId, b.start, b.end, b.status, b.source])).toEqual([
      ['a', d(12, 9).toISOString(), d(12, 10).toISOString(), 'pending', 'baseline'],
      ['b', d(14, 14).toISOString(), d(14, 15).toISOString(), 'pending', 'baseline'],
      ['a', d(16, 22).toISOString(), d(17, 0).toISOString(), 'pending', 'baseline'],
    ]);
    expect(r.commitments.map((c) => [c.title, c.start, c.end])).toEqual([['Lunch', d(12, 12).toISOString(), d(12, 13).toISOString()]]);
    expect(r.commitments.every((c) => c.id.startsWith('baseline:'))).toBe(true);
    expect(store.listBlocks({ from: d(12, 0), to: d(19, 0) }).length).toBe(3);
    expect(store.listCommitments({ from: d(12, 0), to: d(19, 0) }).length).toBe(1);
  });

  it('places the slots by weekday whatever day the week starts on', () => {
    const r = applyToWeek(store, week(), d(11, 0), d(9, 12)); // a Sunday-start week: Sun 11 .. Sat 17
    expect(r.created.map((b) => b.start)).toEqual([d(12, 9).toISOString(), d(14, 14).toISOString(), d(16, 22).toISOString()]);
  });

  it('re-applying replaces the earlier copies: same counts, new ids only for the baseline blocks', () => {
    const hand = createBlock(store, 'b', d(13, 9), d(13, 10), d(9, 12)); // manual
    const first = applyToWeek(store, week(), weekOf12, d(9, 12));
    const again = applyToWeek(store, week(), weekOf12, d(9, 12));
    expect(again.replaced).toBe(3);
    expect(again.created.length).toBe(first.created.length);
    expect(again.commitments.length).toBe(first.commitments.length);
    const ids = new Set(first.created.map((b) => b.id));
    expect(again.created.some((b) => ids.has(b.id))).toBe(false);
    const blocks = store.listBlocks({ from: d(12, 0), to: d(19, 0) });
    expect(blocks.length).toBe(4);
    expect(store.getBlock(hand.id)).toEqual(hand);
    expect(store.listCommitments({ from: d(12, 0), to: d(19, 0) }).length).toBe(1);
  });

  it('skips the slots already over, and keeps the earlier copies that are', () => {
    applyToWeek(store, week(), weekOf12, d(9, 12));
    const r = applyToWeek(store, week(), weekOf12, d(14, 14, 30)); // Wednesday 14:30: Monday is over, Wednesday's slot runs
    expect(r.created.map((b) => b.start)).toEqual([d(14, 14).toISOString(), d(16, 22).toISOString()]);
    expect(r.commitments).toEqual([]);
    expect(r.replaced).toBe(2);
    expect(store.listBlocks({ from: d(12, 0), to: d(13, 0) }).map((b) => b.start)).toEqual([d(12, 9).toISOString()]); // Monday's copy stays
    expect(store.listCommitments({ from: d(12, 0), to: d(13, 0) }).length).toBe(1);
  });

  it('never touches manual, planner or done blocks, and does not lay a copy over a kept baseline block of the same task', () => {
    const first = applyToWeek(store, week(), weekOf12, d(9, 12));
    const wed = first.created.find((b) => b.taskId === 'b')!;
    store.updateBlock(wed.id, { status: 'done', statusChangedAt: d(14, 14, 50).toISOString() });
    const planned = { ...wed, id: 'p1', taskId: 'a', start: d(15, 9).toISOString(), end: d(15, 10).toISOString(), status: 'pending' as const, source: 'planner' as const, statusChangedAt: null };
    store.insertBlocks([planned]);
    const r = applyToWeek(store, week(), weekOf12, d(14, 14, 55));
    expect(r.created.map((b) => [b.taskId, b.start])).toEqual([['a', d(16, 22).toISOString()]]); // Wednesday's done copy is not doubled
    expect(r.skipped.map((x) => x.reason)).toEqual(['already has b at 14:00']);
    expect(store.getBlock(wed.id)!.status).toBe('done');
    expect(store.getBlock('p1')).toEqual(planned);
  });

  it('a copy whose clock is running or that has tracked time is kept, not replaced and not doubled', () => {
    const first = applyToWeek(store, week(), weekOf12, d(9, 12));
    const mon = first.created[0];
    store.updateBlock(mon.id, { runningSince: d(12, 9, 5).toISOString() });
    const r = applyToWeek(store, week(), weekOf12, d(12, 9, 30));
    expect(r.replaced).toBe(2);
    expect(store.getBlock(mon.id)!.runningSince).toBe(d(12, 9, 5).toISOString());
    expect(store.listBlocks({ from: d(12, 0), to: d(13, 0) }).filter((b) => b.taskId === 'a').length).toBe(1);
  });

  it('never lays a block over a commitment or a live block: the slot is skipped, counted and named', () => {
    store.addCommitment({ id: 'call', title: 'Call', start: d(14, 14, 30).toISOString(), end: d(14, 15).toISOString() }); // over Wednesday's b slot
    store.insertBlocks([{ id: 'p', taskId: 'b', start: d(12, 9, 30).toISOString(), end: d(12, 10, 30).toISOString(), status: 'pending', source: 'planner', createdAt: '', statusChangedAt: null }]); // over Monday's a slot
    const r = applyToWeek(store, week(), weekOf12, d(9, 12));
    expect(r.created.map((b) => [b.taskId, b.start])).toEqual([['a', d(16, 22).toISOString()]]);
    expect(r.skipped.map((x) => [x.slot.day, x.slot.taskId, x.reason])).toEqual([[1, 'a', 'over a block of b'], [3, 'b', 'under "Call"']]);
    expect(store.listBlocks({ from: d(12, 0), to: d(19, 0) }).length).toBe(2);
  });

  it('a copy the user moved stays, and the slot is laid again only where no block of the task overlaps it', () => {
    const first = applyToWeek(store, week(), weekOf12, d(9, 12));
    const wed = first.created.find((b) => b.taskId === 'b')!;
    moveBlock(store, wed.id, d(14, 14, 30), d(14, 15, 30)); // manual now, still over the slot
    const again = applyToWeek(store, week(), weekOf12, d(9, 12));
    expect(again.replaced).toBe(2); // the two a copies; the moved b is the user's
    expect(again.created.map((b) => b.taskId)).toEqual(['a', 'a']);
    expect(again.skipped.map((x) => x.reason)).toEqual(['already has b at 14:30']);
    expect(store.listBlocks({ from: d(14, 0), to: d(15, 0) }).map((b) => [b.taskId, b.start, b.source])).toEqual([['b', d(14, 14, 30).toISOString(), 'manual']]);
  });

  it('a slot is suppressed only by a live block of its task that overlaps it, never by one elsewhere in the day', () => {
    // a at 09:00 and 14:00, c at 11:00 and 15:00 on Monday; a's 09:00 copy done; re-applied at 12:00 -> a 14:00 and c 15:00 are laid again.
    store.upsertTask(task('c'));
    const two = v2([slot(1, '09:00', '10:00', 'a'), slot(1, '11:00', '12:00', 'c'), slot(1, '14:00', '15:00', 'a'), slot(1, '15:00', '16:00', 'c')]);
    const first = applyToWeek(store, two, weekOf12, d(9, 12));
    expect(first.created.length).toBe(4);
    store.updateBlock(first.created[0].id, { status: 'done', statusChangedAt: d(12, 10).toISOString() });
    const again = applyToWeek(store, two, weekOf12, d(12, 12));
    expect(again.created.map((b) => [b.taskId, b.start])).toEqual([['a', d(12, 14).toISOString()], ['c', d(12, 15).toISOString()]]);
    expect(again.skipped).toEqual([]);
    expect(store.listBlocks({ from: d(12, 0), to: d(13, 0) }).map((b) => [b.taskId, b.start, b.status])).toEqual([
      ['a', d(12, 9).toISOString(), 'done'], ['c', d(12, 11).toISOString(), 'pending'], ['a', d(12, 14).toISOString(), 'pending'], ['c', d(12, 15).toISOString(), 'pending'],
    ]); // c's 11:00 copy is over at 12:00: kept as it is (the next read marks it missed), its slot not re-laid
  });

  it('an extra hand-placed sitting of a task replaces one baseline copy that day: it claims the nearest slot, and the summary names it', () => {
    // Pairing (round 3): each user-owned block of a task claims exactly one slot of that task that day, the one it overlaps
    // if any, else the nearest by start. A hand-placed a at 20:00 on Monday is a's Monday sitting: the 09:00 slot is not laid.
    createBlock(store, 'a', d(12, 20), d(12, 21), d(9, 12));
    const r = applyToWeek(store, week(), weekOf12, d(9, 12));
    expect(r.created.map((b) => [b.taskId, b.start])).toEqual([['b', d(14, 14).toISOString()], ['a', d(16, 22).toISOString()]]);
    expect(r.skipped.map((x) => [x.slot.day, x.reason])).toEqual([[1, 'already has a at 20:00']]);
    createBlock(store, 'b', d(14, 14, 30), d(14, 15, 30), d(9, 12)); // over Wednesday's b slot
    const again = applyToWeek(store, week(), weekOf12, d(9, 12));
    expect(again.created.map((b) => b.taskId)).toEqual(['a']);
    expect(again.skipped.map((x) => [x.slot.day, x.reason])).toEqual([[1, 'already has a at 20:00'], [3, 'already has b at 14:30']]);
  });

  describe('pairing: each user-owned block claims one slot of its task that day', () => {
    const two = () => v2([slot(1, '09:00', '10:00', 'a'), slot(1, '11:00', '12:00', 'c'), slot(1, '14:00', '15:00', 'a'), slot(1, '15:00', '16:00', 'c')]);
    beforeEach(() => store.upsertTask(task('c')));

    it('two slots and one moved block: the moved block claims the nearest slot, the other slot is still laid', () => {
      const first = applyToWeek(store, two(), weekOf12, d(9, 12));
      moveBlock(store, first.created[0].id, d(12, 12, 30), d(12, 13, 30)); // a's 09:00 copy to 12:30 (manual): nearer to the 14:00 slot, which it claims
      const again = applyToWeek(store, two(), weekOf12, d(9, 12));
      expect(again.created.map((b) => [b.taskId, b.start])).toEqual([['a', d(12, 9).toISOString()], ['c', d(12, 11).toISOString()], ['c', d(12, 15).toISOString()]]);
      expect(again.skipped.map((x) => [x.slot.start, x.reason])).toEqual([['14:00', 'already has a at 12:30']]);
      expect(store.listBlocks({ from: d(12, 0), to: d(13, 0) }).filter((b) => b.taskId === 'a').map((b) => b.start)).toEqual([d(12, 9).toISOString(), d(12, 12, 30).toISOString()]);
    });

    it('two slots and two moved blocks: both slots are claimed, nothing of the task is laid', () => {
      const first = applyToWeek(store, two(), weekOf12, d(9, 12));
      const [a9, a14] = first.created.filter((b) => b.taskId === 'a');
      moveBlock(store, a9.id, d(12, 10), d(12, 10, 45));
      moveBlock(store, a14.id, d(12, 12, 30), d(12, 13, 30));
      const again = applyToWeek(store, two(), weekOf12, d(9, 12));
      expect(again.created.map((b) => b.taskId)).toEqual(['c', 'c']);
      // Claims by block start: 10:00 takes 09:00 (nearest), then 12:30 takes 14:00.
      expect(again.skipped.map((x) => [x.slot.start, x.reason])).toEqual([['09:00', 'already has a at 10:00'], ['14:00', 'already has a at 12:30']]);
    });

    it('an overlapping claim is resolved first: a block over the 14:00 slot takes it even when an earlier block would be nearer', () => {
      const first = applyToWeek(store, two(), weekOf12, d(9, 12));
      const [a9, a14] = first.created.filter((b) => b.taskId === 'a');
      moveBlock(store, a9.id, d(12, 12, 30), d(12, 13, 30)); // nearer to 14:00 than to 09:00 by start, but 14:00 is taken by the overlap below
      moveBlock(store, a14.id, d(12, 13, 45), d(12, 14, 45)); // over the 14:00 slot
      const again = applyToWeek(store, two(), weekOf12, d(9, 12));
      expect(again.skipped.map((x) => [x.slot.start, x.reason])).toEqual([['09:00', 'already has a at 12:30'], ['14:00', 'already has a at 13:45']]);
      expect(again.created.map((b) => b.taskId)).toEqual(['c', 'c']);
    });

    it('a done copy claims the slot it overlaps, past or not, so it never takes a later slot of the task', () => {
      const first = applyToWeek(store, two(), weekOf12, d(9, 12));
      store.updateBlock(first.created[0].id, { status: 'done', statusChangedAt: d(12, 10).toISOString() }); // a 09:00 done
      const again = applyToWeek(store, two(), weekOf12, d(12, 12));
      expect(again.created.map((b) => [b.taskId, b.start])).toEqual([['a', d(12, 14).toISOString()], ['c', d(12, 15).toISOString()]]);
      expect(again.skipped).toEqual([]); // the 09:00 slot is past: not laid and not named
    });
  });

  it('a recurring commitment counts as a commitment: the slot under it is skipped and named', () => {
    store.addRecurring({ id: 'standup', title: 'Standup', days: [1], start: '09:30', end: '10:00' });
    const r = applyToWeek(store, week(), weekOf12, d(9, 12));
    expect(r.created.map((b) => b.taskId)).toEqual(['b', 'a']);
    expect(r.skipped.map((x) => [x.slot.day, x.reason])).toEqual([[1, 'under "Standup"']]);
  });

  it('skips a slot whose task no longer exists or is archived', () => {
    store.archiveTask('b');
    const r = applyToWeek(store, v2([slot(1, '09:00', '10:00', 'a'), slot(2, '09:00', '10:00', 'b'), slot(3, '09:00', '10:00', 'gone')]), weekOf12, d(9, 12));
    expect(r.created.map((b) => b.taskId)).toEqual(['a']);
  });
});
