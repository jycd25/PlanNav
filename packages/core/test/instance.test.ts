import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/store.js';
import { carryOver, carveOut, shiftDay } from '../src/instance.js';
import { applyToWeek } from '../src/baseline.js';
import { DEFAULT_SETTINGS, type Block, type BaselineSlot, type Task } from '../src/types.js';

const d = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m); // Oct 2026: 5 Mon, 7 Wed, 8 Thu, 9 Fri
const hm = (iso: string) => { const x = new Date(iso); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; };
const span = (b: { start: string; end: string }) => `${hm(b.start)}-${hm(b.end)}`;
const task = (id: string, priority: number, name = id): Task => ({ id, name, color: '#000', priority, budgetMinutes: 300, budgetPeriod: 'week', sessionMinutes: 60, archived: false, createdAt: '' });
const slot = (day: number, start: string, end: string, taskId?: string, title = 'Lunch'): BaselineSlot => taskId ? { day, start, end, kind: 'task', taskId } : { day, start, end, kind: 'busy', title };
const blk = (id: string, taskId: string, start: Date, end: Date, extra: Partial<Block> = {}): Block =>
  ({ id, taskId, start: start.toISOString(), end: end.toISOString(), status: 'pending', source: 'baseline', createdAt: '', statusChangedAt: null, ...extra });

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
  store.saveSettings({ ...DEFAULT_SETTINGS, availability: [], minBlockMinutes: 30, slotMinutes: 15, maxBlockMinutes: 60 });
});

// Weekdays: a 09-10, b 10-11, c 11-12, lunch 12-13, d 13-14, e 14-15, blank 15-17, f 17-18 -> usable 09:00-12:00 and 13:00-18:00.
function week() {
  for (const [id, p] of [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5], ['f', 6]] as const) store.upsertTask(task(id, p));
  store.setBaseline({ slots: [1, 2, 3, 4, 5].flatMap((day) => [slot(day, '09:00', '10:00', 'a'), slot(day, '10:00', '11:00', 'b'), slot(day, '11:00', '12:00', 'c'), slot(day, '12:00', '13:00'), slot(day, '13:00', '14:00', 'd'), slot(day, '14:00', '15:00', 'e'), slot(day, '17:00', '18:00', 'f')]) });
  store.addCommitment({ id: 'baseline:lunch', title: 'Lunch', start: d(7, 12).toISOString(), end: d(7, 13).toISOString() });
}
/** Wednesday's blocks as the baseline lays them, b to f (a is over by the time the operations run). */
function wednesday(overrides: Record<string, Partial<Block>> = {}) {
  const b = (id: string, s: number, e: number) => blk(id, id, d(7, s), d(7, e), overrides[id]);
  store.insertBlocks([b('a', 9, 10), b('b', 10, 11), b('c', 11, 12), b('d', 13, 14), b('e', 14, 15), b('f', 17, 18)]);
}
const at = (id: string) => span(store.getBlock(id)!);

describe('shiftDay', () => {
  beforeEach(week);

  // Wednesday at 10:20, b is 20 minutes in. Keeping the breaks moves every block 20 minutes later; c lands after lunch
  // (11:20-12:20 would cross it), the blank 15:00-17:00 stays a break, so f would end at 19:00, past the day's 18:00.
  it('asks before ending the day past its last usable minute: nothing changes, and the question names the breaks, the late end, and what waiving them gives', () => {
    wednesday();
    const r = shiftDay(store, d(7, 10, 20));
    expect(r.needsConfirmation).toBe(true);
    expect(r.summary).toBe('Shifting 5 blocks by 20 min keeps your breaks (15:00-17:00) but ends the day at 19:00, past 18:00. Waive the breaks to end at 18:00, or keep them and end later?');
    expect(['b', 'c', 'd', 'e', 'f'].map(at)).toEqual(['10:00-11:00', '11:00-12:00', '13:00-14:00', '14:00-15:00', '17:00-18:00']);
    expect([r.moved, r.shortened, r.dropped, r.created]).toEqual([[], [], [], []]);
    expect(store.getBlock('a')!.status).toBe('missed'); // over at 10:20 and never marked
  });

  it('breaks waived: each break shrinks to absorb the delay, no block moves earlier than its slot, and the day ends at its usual time', () => {
    wednesday();
    const r = shiftDay(store, d(7, 10, 20), { breaks: 'waive' });
    expect(r.needsConfirmation).toBeUndefined();
    expect(r.moved.map((x) => [x.id, span(x)])).toEqual([['b', '10:20-11:20'], ['c', '13:00-14:00'], ['d', '14:00-15:00'], ['e', '15:00-16:00']]);
    expect(at('f')).toBe('17:00-18:00'); // the two-hour break before it absorbed the push
    expect([r.shortened, r.dropped, r.created]).toEqual([[], [], []]);
    expect(r.summary).toBe('Shifted 4 blocks by 20 min, breaks waived; the day ends at 18:00.');
    expect(['b', 'c', 'd', 'e', 'f'].map((id) => store.getBlock(id)!.source)).toEqual(['adjusted', 'adjusted', 'adjusted', 'adjusted', 'baseline']); // adjusted: a re-apply keeps them, a later operation may move them
  });

  it('breaks kept: every block moves by the delay, the blank stretch stays, and the day ends later than the baseline', () => {
    wednesday();
    const r = shiftDay(store, d(7, 10, 20), { breaks: 'keep' });
    expect(r.moved.map((x) => [x.id, span(x)])).toEqual([['b', '10:20-11:20'], ['c', '13:00-14:00'], ['d', '14:00-15:00'], ['e', '15:00-16:00'], ['f', '18:00-19:00']]);
    expect(r.summary).toBe('Shifted 5 blocks by 20 min, breaks kept; the day ends at 19:00.');
  });

  it('when the shifted day still ends by its last usable minute it is made at once, breaks kept', () => {
    wednesday();
    store.deleteBlocks(['f']);
    store.updateBlock('e', { start: d(7, 15, 30).toISOString(), end: d(7, 16, 30).toISOString() }); // a 90-minute break before e
    const r = shiftDay(store, d(7, 10, 20));
    expect(r.needsConfirmation).toBeUndefined();
    expect(r.moved.map((x) => [x.id, span(x)])).toEqual([['b', '10:20-11:20'], ['c', '13:00-14:00'], ['d', '14:00-15:00'], ['e', '16:30-17:30']]);
    expect(r.summary).toBe('Shifted 4 blocks by 20 min, breaks kept; the day ends at 17:30.');
  });

  it('with no break between the blocks the summary says so by leaving it out', () => {
    wednesday();
    store.deleteBlocks(['f']);
    expect(shiftDay(store, d(7, 10, 20)).summary).toBe('Shifted 4 blocks by 20 min; the day ends at 16:00.');
  });

  it('never moves a block earlier: said before the next block starts, nothing is shifted', () => {
    wednesday();
    const r = shiftDay(store, d(7, 12, 30));
    expect(r.summary).toBe('Nothing to shift: d starts at 13:00.');
    expect(r.needsConfirmation).toBeUndefined();
    expect(at('d')).toBe('13:00-14:00');
  });

  it('the block in progress keeps its end when its whole length no longer fits before busy time (the minutes before now are forfeited)', () => {
    wednesday({ c: { source: 'manual' } });
    const r = shiftDay(store, d(7, 10, 20), { breaks: 'waive' });
    expect(r.shortened.map((x) => [x.id, span(x)])).toEqual([['b', '10:20-11:00']]);
    expect(at('c')).toBe('11:00-12:00');
  });

  it('with no baseline the settings\' availability bounds the day; when waiving the breaks would still drop a block, the question says so', () => {
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [3], start: '09:00', end: '15:30' }] });
    store.setBaseline({ slots: [] });
    wednesday();
    const ask = shiftDay(store, d(7, 14, 30));
    expect(ask.needsConfirmation).toBe(true);
    expect(ask.summary).toBe('Shifting 2 blocks by 30 min keeps your breaks (15:00-17:00) but ends the day at 18:30, past 15:30. Waiving the breaks would still drop f; waive them, or keep them and end later?');
    expect(at('e')).toBe('14:00-15:00');
    const r = shiftDay(store, d(7, 14, 30), { breaks: 'waive' });
    expect(at('e')).toBe('14:30-15:30');
    expect(r.dropped.map((x) => x.id)).toEqual(['f']);
    expect(store.getBlock('f')).toMatchObject({ status: 'missed', start: d(7, 17).toISOString() }); // kept as missed at its time, so carry_over can owe it
    expect(r.summary).toBe('Shifted 1 block by 30 min, breaks waived; the day ends at 15:30; dropped f (no room before 15:30).');
  });

  it('breaks kept past the baseline: what would end after midnight is dropped', () => {
    store.setBaseline({ slots: [slot(3, '09:00', '10:00', 'a'), slot(3, '22:00', '23:30', 'b')] });
    store.insertBlocks([blk('a', 'a', d(7, 9), d(7, 10)), blk('b', 'b', d(7, 22), d(7, 23, 30))]);
    const ask = shiftDay(store, d(7, 9, 45));
    expect(ask.summary).toBe('Shifting 2 blocks by 45 min keeps your breaks (10:00-22:00) but drops b (no room before midnight). Waive the breaks to end at 23:30, or keep them?');
    const r = shiftDay(store, d(7, 9, 45), { breaks: 'keep' });
    expect(r.summary).toBe('Shifted 1 block by 45 min, breaks kept; the day ends at 10:45; dropped b (no room before midnight).');
  });

  it('a dropped block is missed, and carry_over owes it though its time has not come: to a gap today, else the next slot extended', () => {
    wednesday();
    store.addCommitment({ id: 'call', title: 'Call', start: d(7, 17).toISOString(), end: d(7, 17, 30).toISOString() });
    expect(shiftDay(store, d(7, 14, 30), { breaks: 'waive' }).summary).toBe('Shifted 1 block by 30 min, breaks waived; the day ends at 15:30; dropped f (no room before 18:00).'); // f after the call would end 18:30
    expect(store.listBlocks().filter((b) => b.status === 'pending' || b.status === 'done').some((b) => b.id === 'f')).toBe(false); // not live: busy to nothing
    expect(carryOver(store, 'f', d(7, 14, 30)).summary).toBe('f: 60 min carried to 15:30-16:30.'); // the blank stretch after the shifted e
    expect(carryOver(store, 'f', d(7, 14, 31)).summary).toBe('f: already carried to 15:30-16:30.');
  });

  it('a dropped block with no gap left today is carried to its next slot this week, extended', () => {
    wednesday();
    store.addCommitment({ id: 'call', title: 'Call', start: d(7, 17).toISOString(), end: d(7, 17, 30).toISOString() });
    store.insertBlocks([blk('m', 'a', d(7, 15, 30), d(7, 17), { source: 'manual' })]); // 15:30-17:00 is taken by hand
    shiftDay(store, d(7, 14, 30), { breaks: 'waive' });
    expect(carryOver(store, 'f', d(7, 14, 30)).summary).toBe('f: 60 min carried to Thu 16:00 (slot extended).'); // 17:30-18:00 is too short; Thursday is not applied
  });

  it('a block a shift dropped, carried once the evening frees up, lands in the gap today', () => {
    wednesday();
    store.addCommitment({ id: 'call', title: 'Call', start: d(7, 17).toISOString(), end: d(7, 17, 30).toISOString() });
    store.insertBlocks([blk('m', 'a', d(7, 15, 30), d(7, 17), { source: 'manual' })]);
    shiftDay(store, d(7, 14, 30), { breaks: 'waive' });
    store.deleteCommitment('call');
    expect(carryOver(store, 'f', d(7, 14, 40)).summary).toBe('f: 60 min carried to 17:00-18:00.');
  });

  it('drops the lowest-priority block first when not everything fits, even when it came earlier in the day', () => {
    store.setBaseline({ slots: [slot(3, '09:00', '10:00', 'a'), slot(3, '10:00', '11:00', 'b'), slot(3, '11:00', '12:00', 'c')] }); // Wednesday ends at 12:00
    store.insertBlocks([blk('b', 'b', d(7, 10), d(7, 11)), blk('x', 'f', d(7, 11), d(7, 11, 30)), blk('c', 'c', d(7, 11, 30), d(7, 12))]);
    store.addCommitment({ id: 'call', title: 'Call', start: d(7, 11).toISOString(), end: d(7, 11, 30).toISOString() });
    const r = shiftDay(store, d(7, 10, 20), { breaks: 'waive' });
    expect(at('b')).toBe('10:20-11:00'); // its whole hour would run into the call
    expect(r.dropped.map((x) => x.id)).toEqual(['x']); // priority 6 gives way so that c (priority 3) keeps its half hour
    expect(at('c')).toBe('11:30-12:00');
    expect(r.summary).toBe('Shifted 1 block by 20 min; the day ends at 12:00; dropped f (no room before 12:00).');
  });

  it('done, skipped and manual blocks are not moved, nor a block whose clock is running', () => {
    wednesday({ c: { source: 'manual' }, d: { status: 'done' } });
    const r = shiftDay(store, d(7, 10, 20), { breaks: 'waive' });
    expect(['b', 'c', 'd', 'e', 'f'].map(at)).toEqual(['10:20-11:00', '11:00-12:00', '13:00-14:00', '14:00-15:00', '17:00-18:00']);
    expect(r.moved).toEqual([]);
    expect(r.shortened.map((x) => x.id)).toEqual(['b']);
    expect(r.summary).toBe('Shifted 1 block by 20 min, breaks waived; the day ends at 18:00.');
    store.updateBlock('b', { runningSince: d(7, 10, 5).toISOString() });
    expect(shiftDay(store, d(7, 10, 25)).summary).toBe('Nothing to shift: e starts at 14:00.');
    store.updateBlock('e', { status: 'skipped' });
    store.updateBlock('f', { status: 'skipped' });
    expect(shiftDay(store, d(7, 10, 25)).summary).toBe('Nothing to shift today.');
  });

  it('with no block left today there is nothing to shift', () => {
    expect(shiftDay(store, d(7, 10, 20))).toEqual({ moved: [], shortened: [], dropped: [], created: [], summary: 'Nothing to shift today.' });
  });
});

describe('carveOut', () => {
  beforeEach(() => { week(); wednesday(); });

  it('adds the commitment and pushes the overlapped block and every pending block after it later by the carved length, in order, skipping busy time', () => {
    const r = carveOut(store, d(7, 10), d(7, 10, 30), 'Call');
    expect(store.listCommitments({ from: d(7, 10), to: d(7, 10, 30) }).map((c) => [c.title, span(c)])).toEqual([['Call', '10:00-10:30']]);
    expect(r.moved.map((x) => [x.id, span(x)])).toEqual([['b', '10:30-11:30'], ['c', '13:00-14:00'], ['d', '14:00-15:00'], ['e', '15:00-16:00']]);
    // b whole after the call (10:00-10:00 is no part to keep); c's 11:30-12:30 crosses the lunch edge, so it lands at 13:00; d and e
    // follow in order; the blank 16:00-17:00 absorbs the push, so f stays where it was.
    expect(at('f')).toBe('17:00-18:00');
    expect(r.shortened).toEqual([]);
    expect(r.dropped).toEqual([]);
    expect(r.summary).toBe('Carved out Call 10:00-10:30; moved b to 10:30-11:30, c to 13:00-14:00, d to 14:00-15:00, e to 15:00-16:00.');
  });

  it('a block only partly overlapped is split around the carve when both parts are at least the minimum block', () => {
    const r = carveOut(store, d(7, 10, 30), d(7, 11), 'Call');
    expect(r.shortened.map((x) => [x.id, span(x)])).toEqual([['b', '10:00-10:30']]);
    expect(r.created.map((x) => [x.taskId, span(x), x.source, x.status])).toEqual([['b', '11:00-11:30', 'adjusted', 'pending']]);
    expect(['b', 'c', 'd', 'e'].map((id) => store.getBlock(id)!.source)).toEqual(['adjusted', 'adjusted', 'adjusted', 'adjusted']);
    expect(store.getBlock('f')!.source).toBe('baseline'); // not moved
    expect(r.moved.map((x) => [x.id, span(x)])).toEqual([['c', '13:00-14:00'], ['d', '14:00-15:00'], ['e', '15:00-16:00']]);
    expect(r.summary).toBe('Carved out Call 10:30-11:00; split b: 10:00-10:30 kept, 30 min to 11:00-11:30; moved c to 13:00-14:00, d to 14:00-15:00, e to 15:00-16:00.');
  });

  it('a block whose part on either side would be shorter than the minimum block is moved whole', () => {
    const r = carveOut(store, d(7, 10, 45), d(7, 11), 'Call');
    expect(r.shortened).toEqual([]);
    expect(r.created).toEqual([]);
    expect(r.moved.map((x) => [x.id, span(x)])[0]).toEqual(['b', '11:00-12:00']);
  });

  it('what no longer fits is dropped from the lowest priority, whatever its place in the day', () => {
    store.insertBlocks([blk('m', 'a', d(7, 15), d(7, 17), { source: 'manual' })]); // the blank afternoon is taken by hand
    store.upsertTask(task('f', 1)); // f matters most now; e (5) least
    const r = carveOut(store, d(7, 10), d(7, 10, 30), 'Call');
    expect(r.dropped.map((x) => x.id)).toEqual(['e']); // e would have taken 17:00 in order and left f (priority 1) with no room
    expect(r.moved.map((x) => [x.id, span(x)])).toEqual([['b', '10:30-11:30'], ['c', '13:00-14:00'], ['d', '14:00-15:00']]);
    expect(at('f')).toBe('17:00-18:00');
    expect(store.getBlock('e')).toMatchObject({ status: 'missed', start: d(7, 14).toISOString() });
    expect(store.getBlock('m')).toMatchObject({ start: d(7, 15).toISOString(), end: d(7, 17).toISOString() });
    expect(r.summary).toBe('Carved out Call 10:00-10:30; moved b to 10:30-11:30, c to 13:00-14:00, d to 14:00-15:00; dropped e (no room before 18:00).');
  });

  it('a block a carve dropped is missed and carry_over owes it', () => {
    store.insertBlocks([blk('m', 'a', d(7, 15), d(7, 17), { source: 'manual' })]);
    store.upsertTask(task('f', 1));
    expect(carveOut(store, d(7, 10), d(7, 10, 30), 'Call').summary).toContain('dropped e (no room before 18:00)');
    expect(carryOver(store, 'e', d(7, 10, 30)).summary).toBe('e: 60 min carried to Thu 13:00 (slot extended).');
  });

  it('a split part that no longer fits is kept as missed too, so carry_over owes it', () => {
    store.insertBlocks([blk('m', 'a', d(7, 15), d(7, 17), { source: 'manual' })]);
    store.upsertTask(task('b', 9)); // b matters least now: its part gives way
    const r = carveOut(store, d(7, 10, 30), d(7, 11), 'Call');
    expect(r.summary).toContain('split b: 10:00-10:30 kept, 30 min dropped');
    expect(store.listBlocks().filter((x) => x.taskId === 'b').map((x) => [span(x), x.status])).toEqual([['10:00-10:30', 'pending'], ['11:00-11:30', 'missed']]);
    expect(carryOver(store, 'b', d(7, 10, 45)).summary).toBe('b: 60 min carried to Thu 09:00 (slot extended).'); // the kept 10:00-10:30, over and unmarked, and the dropped part
  });

  it('done, skipped and manual blocks stay; a carve over nothing moves nothing; the title defaults to Busy', () => {
    store.updateBlock('b', { status: 'done' });
    store.updateBlock('c', { source: 'manual' });
    const r = carveOut(store, d(7, 8), d(7, 8, 30));
    expect(r.moved).toEqual([]);
    expect(r.summary).toBe('Carved out Busy 08:00-08:30; nothing to move.');
    expect(store.listCommitments().map((c) => c.title)).toContain('Busy');
    const r2 = carveOut(store, d(7, 10, 30), d(7, 11), 'Call'); // over the done b
    expect(at('b')).toBe('10:00-11:00');
    expect(at('c')).toBe('11:00-12:00');
    expect(r2.moved).toEqual([]);
  });

  it('a commitment over a manual block pushes the baseline blocks after it around the manual one', () => {
    store.updateBlock('c', { source: 'manual' });
    const r = carveOut(store, d(7, 10), d(7, 10, 30), 'Call');
    expect(at('c')).toBe('11:00-12:00');
    expect(r.moved.map((x) => [x.id, span(x)])[0]).toEqual(['b', '13:00-14:00']); // 10:30-11:30 would overlap c, which stays
  });

  it('refuses an empty or backwards carve', () => {
    expect(() => carveOut(store, d(7, 11), d(7, 10), 'x')).toThrow(/end must be after start/i);
    expect(store.listCommitments().length).toBe(1);
  });
});

describe('carryOver', () => {
  const lc = (day: number, s: string, e: string) => slot(day, s, e, 'lc');
  beforeEach(() => {
    store.upsertTask(task('lc', 1, 'Leetcode'));
    store.upsertTask(task('rd', 2, 'Reading'));
    // Weekdays: Leetcode 10-11, Reading 13-14 -> usable 10:00-14:00.
    store.setBaseline({ slots: [1, 2, 3, 4, 5].flatMap((day) => [lc(day, '10:00', '11:00'), slot(day, '13:00', '14:00', 'rd')]) });
  });

  it('places the remaining minutes (planned minus tracked) in the first blank gap today after now that holds them whole', () => {
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 11), { trackedMinutes: 20 }), blk('r', 'rd', d(7, 13), d(7, 14))]);
    const r = carryOver(store, 'lc', d(7, 11, 30));
    expect(r.created.map((x) => [x.taskId, span(x), x.source, x.status])).toEqual([['lc', '11:30-12:10', 'adjusted', 'pending']]);
    expect(r.summary).toBe('Leetcode: 40 min carried to 11:30-12:10.');
    expect(store.getBlock('l')!.status).toBe('done'); // the tracked block is finished by the sweep, not missed
  });

  it('a block that ended unmarked owes all of its minutes; the gap must hold them whole and starts on the slot grid', () => {
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 11)), blk('r', 'rd', d(7, 13), d(7, 14))]);
    const r = carryOver(store, 'lc', d(7, 11, 50));
    expect(r.created.map((x) => span(x))).toEqual(['12:00-13:00']);
    expect(r.summary).toBe('Leetcode: 60 min carried to 12:00-13:00.');
  });

  it('a block still ahead today is not owed: only the blocks over by now count', () => {
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 11)), blk('l2', 'lc', d(7, 13), d(7, 14))]);
    const r = carryOver(store, 'lc', d(7, 11, 10));
    expect(r.created.map((x) => span(x))).toEqual(['11:15-12:15']); // 60 owed (not 120): 11:15-13:15 would not fit before the 13:00 block
    expect(r.summary).toBe('Leetcode: 60 min carried to 11:15-12:15.');
    expect(at('l2')).toBe('13:00-14:00');
  });

  it('an adjusted copy of the next slot is extended, not doubled', () => {
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 11)), blk('r', 'rd', d(7, 11), d(7, 14), { source: 'manual' }), blk('l8', 'lc', d(8, 10, 15), d(8, 11, 15), { source: 'adjusted' }), blk('r8', 'rd', d(8, 13), d(8, 14))]);
    const r = carryOver(store, 'lc', d(7, 11, 30));
    expect(r.created).toEqual([]);
    expect(r.moved.map((x) => [x.id, span(x), x.source])).toEqual([['l8', '10:15-12:15', 'adjusted']]);
    expect(r.summary).toBe('Leetcode: 60 min carried to Thu 11:15 (slot extended).');
  });

  it('with no gap today, extends the task\'s next baseline slot this week earlier or later within blank time (earlier first)', () => {
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 11)), blk('r', 'rd', d(7, 11), d(7, 14), { source: 'manual' }), blk('l8', 'lc', d(8, 10), d(8, 11)), blk('r8', 'rd', d(8, 13), d(8, 14))]);
    const r = carryOver(store, 'lc', d(7, 11, 30));
    expect(r.created).toEqual([]);
    expect(r.moved.map((x) => [x.id, span(x)])).toEqual([['l8', '10:00-12:00']]); // 09:00 is outside Thursday's usable span, so later
    expect(r.summary).toBe('Leetcode: 60 min carried to Thu 11:00 (slot extended).');
  });

  it('a baseline copy that is extended becomes adjusted, so a re-apply of the week keeps the extension and names the slot', () => {
    applyToWeek(store, store.getBaseline()!, d(5, 0), d(5, 8));
    store.insertBlocks([blk('r', 'rd', d(7, 11), d(7, 13), { source: 'manual' })]); // Wednesday has no gap left after 11:00
    expect(carryOver(store, 'lc', d(7, 11, 30)).summary).toBe('Leetcode: 60 min carried to Thu 11:00 (slot extended).');
    const thu = () => store.listBlocks({ from: d(8, 0), to: d(9, 0) }).filter((b) => b.taskId === 'lc').map((b) => [span(b), b.source]);
    expect(thu()).toEqual([['10:00-12:00', 'adjusted']]);
    const r = applyToWeek(store, store.getBaseline()!, d(5, 0), d(7, 11, 45));
    expect(thu()).toEqual([['10:00-12:00', 'adjusted']]);
    expect(r.skipped.filter((x) => x.slot.day === 4).map((x) => [x.slot.taskId, x.reason])).toEqual([['lc', 'already has Leetcode at 10:00']]);
  });

  it('extends earlier when the blank time before the slot holds the minutes', () => {
    store.setBaseline({ slots: [1, 2, 3, 4, 5].flatMap((day) => [slot(day, '09:00', '10:00', 'rd'), lc(day, '11:00', '12:00')]) }); // usable 09:00-12:00
    store.insertBlocks([blk('l', 'lc', d(7, 11), d(7, 11, 30), { trackedMinutes: 10 }), blk('m', 'rd', d(7, 11, 30), d(7, 12), { source: 'manual' }), blk('l8', 'lc', d(8, 11), d(8, 12))]);
    const r = carryOver(store, 'lc', d(7, 11, 40));
    expect(r.moved.map((x) => [x.id, span(x)])).toEqual([['l8', '10:40-12:00']]);
    expect(r.summary).toBe('Leetcode: 20 min carried to Thu 10:40 (slot extended).');
  });

  it('with the week not applied yet, the carried minutes sit beside the slot\'s time', () => {
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 11)), blk('r', 'rd', d(7, 11), d(7, 14), { source: 'manual' })]);
    const r = carryOver(store, 'lc', d(7, 11, 30));
    expect(r.moved).toEqual([]);
    expect(r.created.map((x) => [x.taskId, `${new Date(x.start).getDate()} ${span(x)}`, x.source])).toEqual([['lc', '8 11:00-12:00', 'adjusted']]);
    expect(r.summary).toBe('Leetcode: 60 min carried to Thu 11:00 (slot extended).');
  });

  it('reports no room when neither today nor a later slot of the week can take the minutes', () => {
    store.insertBlocks([blk('l', 'lc', d(9, 10), d(9, 11)), blk('r', 'rd', d(9, 11), d(9, 14), { source: 'manual' })]); // Friday: the week's last slot
    const r = carryOver(store, 'lc', d(9, 11, 30));
    expect(r).toEqual({ moved: [], shortened: [], dropped: [], created: [], summary: 'Leetcode: 60 min, no room this week.' });
  });

  it('nothing to carry when the task has no block over today, or its blocks were done or skipped', () => {
    expect(carryOver(store, 'lc', d(7, 11, 30)).summary).toBe('Leetcode: nothing to carry over today.');
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 11), { status: 'done' }), blk('s', 'lc', d(7, 9), d(7, 9, 30), { status: 'skipped' })]);
    expect(carryOver(store, 'lc', d(7, 11, 30)).summary).toBe('Leetcode: nothing to carry over today.');
    expect(store.listBlocks().length).toBe(2);
  });

  it('said mid-block: the block in progress is shortened to now and its rest carried to the first blank gap after its old end', () => {
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 11)), blk('r', 'rd', d(7, 13), d(7, 14))]);
    const r = carryOver(store, 'lc', d(7, 10, 30));
    expect(r.shortened.map((x) => [x.id, span(x), x.status])).toEqual([['l', '10:00-10:30', 'pending']]);
    expect(r.created.map((x) => [span(x), x.source])).toEqual([['11:00-11:30', 'adjusted']]);
    expect(r.summary).toBe('Leetcode: 30 min carried to 11:00-11:30.');
  });

  it('said mid-block with the clock running: the clock is paused at now, the block shortened, the rest carried', () => {
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 11), { runningSince: d(7, 10, 5).toISOString() }), blk('r', 'rd', d(7, 13), d(7, 14))]);
    const r = carryOver(store, 'lc', d(7, 10, 35));
    expect(store.getBlock('l')).toMatchObject({ end: d(7, 10, 35).toISOString(), runningSince: null, trackedMinutes: 30 });
    expect(r.created.map((x) => span(x))).toEqual(['11:00-11:25']);
    expect(r.summary).toBe('Leetcode: 25 min carried to 11:00-11:25.');
  });

  it('refuses an unknown task', () => {
    expect(() => carryOver(store, 'nope', d(7, 11))).toThrow(/Task not found/);
  });
});

describe('carryOver is safe to repeat', () => {
  // Wednesday: a 09-10, b 10-11, b 13-14 (usable 09:00-14:00), the week applied on Monday morning.
  beforeEach(() => {
    store.upsertTask(task('a', 1));
    store.upsertTask(task('b', 2));
    store.setBaseline({ slots: [slot(3, '09:00', '10:00', 'a'), slot(3, '10:00', '11:00', 'b'), slot(3, '13:00', '14:00', 'b')] });
    applyToWeek(store, store.getBaseline()!, d(5, 0), d(5, 8));
  });
  const wed = () => store.listBlocks({ from: d(7, 0), to: d(8, 0) }).map((b) => [b.id, b.taskId, span(b)]);

  it('said again a minute later, or in the same minute, it answers "already carried" and changes nothing', () => {
    expect(carryOver(store, 'a', d(7, 11)).summary).toBe('a: 60 min carried to 11:00-12:00.');
    const after = wed();
    const again = carryOver(store, 'a', d(7, 11, 1)); // the carried block has just started: not "said mid-block"
    expect(again).toEqual({ moved: [], shortened: [], dropped: [], created: [], summary: 'a: already carried to 11:00-12:00.' });
    expect(wed()).toEqual(after);
    expect(carryOver(store, 'a', d(7, 11)).summary).toBe('a: already carried to 11:00-12:00.');
    expect(wed()).toEqual(after);
  });

  it('said mid-block, then again: the rest is carried once', () => {
    store.setBaseline({ slots: [slot(3, '09:00', '10:00', 'a'), slot(3, '13:00', '14:00', 'b')] });
    store.deleteBlocks(store.listBlocks({ from: d(7, 10), to: d(7, 11) }).filter((b) => b.taskId === 'b').map((b) => b.id));
    expect(carryOver(store, 'a', d(7, 9, 15)).summary).toBe('a: 45 min carried to 10:00-10:45.');
    expect(carryOver(store, 'a', d(7, 9, 16)).summary).toBe('a: already carried to 10:00-10:45.'); // the 09:00-09:15 part, now over, is not owed again
    expect(carryOver(store, 'a', d(7, 9, 50)).summary).toBe('a: already carried to 10:00-10:45.');
  });

  it('the carried block, said mid-block a slot or more after it started, carries its own rest and nothing more', () => {
    carryOver(store, 'a', d(7, 11));
    const r = carryOver(store, 'a', d(7, 11, 30));
    expect(r.shortened.map((x) => span(x))).toEqual(['11:00-11:30']);
    expect(r.summary).toBe('a: 30 min carried to 12:00-12:30.'); // the 09:00 block was carried already: only the rest of the carried block is owed
    expect(carryOver(store, 'a', d(7, 11, 31)).summary).toBe('a: already carried to 12:00-12:30.');
  });

  it('a carried block that ends unmarked is owed once, not on top of the block it was carried from', () => {
    store.setBaseline({ slots: [slot(3, '09:00', '10:00', 'a'), slot(3, '10:00', '11:00', 'b'), slot(3, '13:00', '14:00', 'b'), slot(3, '15:00', '16:00', 'a')] }); // usable 09:00-16:00
    carryOver(store, 'a', d(7, 11)); // 11:00-12:00, then never done
    expect(carryOver(store, 'a', d(7, 12, 30)).summary).toBe('a: 60 min carried to 14:00-15:00.');
  });

  it('an extension of a later slot is not made twice', () => {
    store.insertBlocks([blk('m', 'b', d(7, 11), d(7, 13), { source: 'manual' })]); // no gap today
    store.setBaseline({ slots: [slot(3, '09:00', '10:00', 'a'), slot(3, '10:00', '11:00', 'b'), slot(3, '13:00', '14:00', 'b'), slot(4, '09:00', '10:00', 'a'), slot(4, '11:00', '12:00', 'b')] });
    applyToWeek(store, store.getBaseline()!, d(5, 0), d(5, 8));
    expect(carryOver(store, 'a', d(7, 13, 30)).summary).toBe('a: 60 min carried to Thu 10:00 (slot extended).');
    const thu = () => store.listBlocks({ from: d(8, 0), to: d(9, 0) }).filter((b) => b.taskId === 'a').map(span);
    expect(thu()).toEqual(['09:00-11:00']);
    expect(carryOver(store, 'a', d(7, 13, 31)).summary).toBe('a: already carried to Thu 09:00-11:00.');
    expect(thu()).toEqual(['09:00-11:00']);
  });
});

describe('instance edits survive a re-apply of the baseline', () => {
  beforeEach(week);

  it('a carve on next Tuesday, then the baseline applied to next week: nothing sits on the Call, and the slot under it is named', () => {
    const r = carveOut(store, d(13, 14), d(13, 15), 'Call'); // Tue 13 Oct, next week, nothing laid there yet
    expect(r.summary).toBe('Carved out Call 14:00-15:00; nothing to move.');
    const applied = applyToWeek(store, store.getBaseline()!, d(12, 0), d(7, 9));
    const tuesday = store.listBlocks({ from: d(13, 0), to: d(14, 0) });
    expect(tuesday.some((b) => new Date(b.start) < d(13, 15) && new Date(b.end) > d(13, 14))).toBe(false);
    expect(tuesday.map((b) => b.taskId)).toEqual(['a', 'b', 'c', 'd', 'f']);
    expect(applied.skipped.map((x) => [x.slot.day, x.slot.taskId, x.reason])).toEqual([[2, 'e', 'under "Call"']]);
    expect(store.listCommitments({ from: d(13, 0), to: d(14, 0) }).map((c) => c.title)).toEqual(['Lunch', 'Call']); // the baseline's busy slot, and the carve
  });

  it('shift_day, then the baseline re-applied to this week: the shifted day stays as it is', () => {
    wednesday();
    store.deleteBlocks(['a']);
    shiftDay(store, d(7, 10, 20), { breaks: 'waive' });
    const before = store.listBlocks({ from: d(7, 0), to: d(8, 0) }).map((b) => [b.taskId, span(b), b.source]);
    expect(before).toEqual([['b', '10:20-11:20', 'adjusted'], ['c', '13:00-14:00', 'adjusted'], ['d', '14:00-15:00', 'adjusted'], ['e', '15:00-16:00', 'adjusted'], ['f', '17:00-18:00', 'baseline']]); // the break before f absorbed the push
    const r = applyToWeek(store, store.getBaseline()!, d(5, 0), d(7, 10, 20));
    // The adjusted blocks stay and are the sittings: b's slot is claimed by the adjusted b over it, f's 17:00 slot by the f shifted to 15:00 (pairing, round 3); both named.
    expect(store.listBlocks({ from: d(7, 0), to: d(8, 0) }).map((b) => [b.taskId, span(b), b.source])).toEqual(before);
    expect(r.created.filter((b) => new Date(b.start) < d(8, 0)).map((b) => b.taskId)).toEqual(['f']); // f's unmoved copy is replaced by a fresh one
    expect(r.skipped.map((x) => [x.slot.taskId, x.reason])).toEqual([['b', 'already has b at 10:20'], ['c', 'already has c at 13:00'], ['d', 'already has d at 14:00'], ['e', 'already has e at 15:00']]);
  });
});

describe('instance operations compose', () => {
  beforeEach(() => { week(); wednesday(); });

  it('shift_day then carve_out: the shifted (adjusted) block under the call is moved, not left under it', () => {
    shiftDay(store, d(7, 10, 20), { breaks: 'waive' }); // b 10:20-11:20, c 13:00-14:00, d 14:00-15:00, e 15:00-16:00, f 17:00-18:00
    const r = carveOut(store, d(7, 10, 30), d(7, 11), 'Call');
    expect(r.moved[0]).toMatchObject({ id: 'b', source: 'adjusted' });
    expect(store.getBlock('b')).toMatchObject({ start: d(7, 11).toISOString(), end: d(7, 12).toISOString(), source: 'adjusted' }); // its hour moved whole: the 10 minutes before the call are under the minimum
    expect(r.summary).toBe('Carved out Call 10:30-11:00; moved b to 11:00-12:00.');
  });

  it('carve then carve: the block the first carve moved is moved again by the second', () => {
    const first = carveOut(store, d(7, 10), d(7, 10, 30), 'Call'); // b -> 10:30-11:30 adjusted
    expect(first.moved[0]).toMatchObject({ id: 'b', start: d(7, 10, 30).toISOString(), source: 'adjusted' });
    const second = carveOut(store, d(7, 10, 30), d(7, 11), 'Second call');
    expect(second.moved.map((x) => [x.id, span(x), x.source])[0]).toEqual(['b', '11:00-12:00', 'adjusted']);
  });

  it('a re-apply keeps adjusted blocks as it keeps manual ones', () => {
    carveOut(store, d(7, 10), d(7, 10, 30), 'Call');
    const adjusted = store.listBlocks({ from: d(7, 0), to: d(8, 0) }).filter((b) => b.source === 'adjusted').map((b) => [b.id, b.start, b.end]);
    expect(adjusted.length).toBeGreaterThan(0);
    applyToWeek(store, store.getBaseline()!, d(5, 0), d(7, 9));
    expect(store.listBlocks({ from: d(7, 0), to: d(8, 0) }).filter((b) => b.source === 'adjusted').map((b) => [b.id, b.start, b.end])).toEqual(adjusted);
  });
});
