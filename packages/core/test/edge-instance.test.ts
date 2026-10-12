import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/store.js';
import { carryOver, carveOut, shiftDay } from '../src/instance.js';
import { markBlock } from '../src/mark.js';
import { DEFAULT_SETTINGS, type Block, type BaselineSlot, type Task } from '../src/types.js';

const d = (day: number, h: number, m = 0, s = 0) => new Date(2026, 9, day, h, m, s); // Oct 2026: 5 Mon, 6 Tue, 7 Wed, 8 Thu, 9 Fri, 11 Sun, 12 Mon
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
function wednesday(overrides: Record<string, Partial<Block>> = {}) {
  const b = (id: string, s: number, e: number) => blk(id, id, d(7, s), d(7, e), overrides[id]);
  store.insertBlocks([b('a', 9, 10), b('b', 10, 11), b('c', 11, 12), b('d', 13, 14), b('e', 14, 15), b('f', 17, 18)]);
}
const at = (id: string) => span(store.getBlock(id)!);
const wedBlocks = () => store.listBlocks({ from: d(7, 0), to: d(8, 0) }).map((b) => [b.id, span(b), b.status, b.source]);

describe('shiftDay at the edges', () => {
  beforeEach(() => { week(); wednesday(); });

  it('said exactly when a block starts, the block that just ended is missed and nothing is shifted', () => {
    const r = shiftDay(store, d(7, 10));
    expect(r.summary).toBe('Nothing to shift: b starts at 10:00.');
    expect(store.getBlock('a')!.status).toBe('missed');
    expect(at('b')).toBe('10:00-11:00');
  });

  it('said exactly when a block ends, that block is over (missed) and the next one is not yet late', () => {
    const r = shiftDay(store, d(7, 11));
    expect(r.summary).toBe('Nothing to shift: c starts at 11:00.');
    expect(['a', 'b'].map((id) => store.getBlock(id)!.status)).toEqual(['missed', 'missed']);
  });

  it('a delay of one minute still cascades past lunch (nothing moves earlier), and the question says "1 min"', () => {
    const ask = shiftDay(store, d(7, 10, 1));
    expect(ask.needsConfirmation).toBe(true);
    expect(ask.summary).toBe('Shifting 5 blocks by 1 min keeps your breaks (15:00-17:00) but ends the day at 19:00, past 18:00. Waive the breaks to end at 18:00, or keep them and end later?');
    const r = shiftDay(store, d(7, 10, 1), { breaks: 'waive' });
    expect(r.moved.map((x) => [x.id, span(x)])).toEqual([['b', '10:01-11:01'], ['c', '13:00-14:00'], ['d', '14:00-15:00'], ['e', '15:00-16:00']]);
    expect(r.summary).toBe('Shifted 4 blocks by 1 min, breaks waived; the day ends at 18:00.');
  });

  it('seconds are dropped: said at 10:20:59 the delay is 20 minutes and the block starts at 10:20', () => {
    const r = shiftDay(store, d(7, 10, 20, 59), { breaks: 'waive' });
    expect(r.moved[0]).toMatchObject({ id: 'b', start: d(7, 10, 20).toISOString() });
    expect(r.summary).toBe('Shifted 4 blocks by 20 min, breaks waived; the day ends at 18:00.');
  });

  it('every block hand-placed: nothing to shift, and the one that is over is still missed', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) store.updateBlock(id, { source: 'manual' });
    expect(shiftDay(store, d(7, 10, 20))).toEqual({ moved: [], shortened: [], dropped: [], created: [], summary: 'Nothing to shift today.' });
    expect(store.getBlock('a')!.status).toBe('missed');
    expect(at('b')).toBe('10:00-11:00');
  });

  it('overlapping blocks are laid one after the other, in start order', () => {
    store.insertBlocks([blk('x', 'a', d(7, 10, 30), d(7, 11, 30))]); // over b and c
    const r = shiftDay(store, d(7, 10, 20), { breaks: 'waive' });
    expect(r.moved.map((m) => [m.id, span(m)])).toEqual([['b', '10:20-11:20'], ['x', '13:00-14:00'], ['c', '14:00-15:00'], ['d', '15:00-16:00'], ['e', '16:00-17:00']]);
    expect(at('f')).toBe('17:00-18:00');
    expect(r.summary).toBe('Shifted 5 blocks by 20 min, breaks waived; the day ends at 18:00.');
  });

  it('a commitment over the whole day: keeping the breaks lays the blocks after it (up to midnight); waiving them drops everything', () => {
    store.addCommitment({ id: 'off', title: 'Offsite', start: d(7, 9).toISOString(), end: d(7, 18).toISOString() });
    const ask = shiftDay(store, d(7, 10, 20));
    expect(ask.needsConfirmation).toBe(true);
    expect(ask.summary).toBe('Shifting 5 blocks by 20 min ends the day at 23:00, past 18:00, and there is no break to waive. Drop f, e, d, c, b to end by 18:00, or shift everything?');
    expect(['b', 'c', 'd', 'e', 'f'].map((id) => store.getBlock(id)!.status)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending']);
    const r = shiftDay(store, d(7, 10, 20), { breaks: 'waive' });
    expect(r.dropped.map((x) => x.id)).toEqual(['f', 'e', 'd', 'c', 'b']);
    expect(r.summary).toBe('Nothing to shift; dropped f, e, d, c, b (no room before 18:00).');
    expect(wedBlocks()).toEqual([
      ['a', '09:00-10:00', 'missed', 'baseline'], ['b', '10:00-11:00', 'missed', 'baseline'], ['c', '11:00-12:00', 'missed', 'baseline'],
      ['d', '13:00-14:00', 'missed', 'baseline'], ['e', '14:00-15:00', 'missed', 'baseline'], ['f', '17:00-18:00', 'missed', 'baseline'],
    ]);
  });

  it('a commitment over the whole day, breaks kept: every block lands after it, back to back, the evening blank gone (busy time is not a break)', () => {
    store.addCommitment({ id: 'off', title: 'Offsite', start: d(7, 9).toISOString(), end: d(7, 18).toISOString() });
    const r = shiftDay(store, d(7, 10, 20), { breaks: 'keep' });
    expect(r.moved.map((m) => [m.id, span(m)])).toEqual([['b', '18:00-19:00'], ['c', '19:00-20:00'], ['d', '20:00-21:00'], ['e', '21:00-22:00'], ['f', '22:00-23:00']]);
    expect(r.dropped).toEqual([]);
    expect(r.summary).toBe('Shifted 5 blocks by 20 min; the day ends at 23:00.');
  });

  it('the block in progress is moved whole when neither its whole length nor its rest fits before busy time', () => {
    store.addCommitment({ id: 'call', title: 'Call', start: d(7, 10, 40).toISOString(), end: d(7, 11).toISOString() });
    const r = shiftDay(store, d(7, 10, 20), { breaks: 'waive' });
    expect(r.moved.map((m) => [m.id, span(m)])).toEqual([['b', '11:00-12:00'], ['c', '13:00-14:00'], ['d', '14:00-15:00'], ['e', '15:00-16:00']]);
    expect(r.shortened).toEqual([]);
    expect(r.summary).toBe('Shifted 4 blocks by 20 min, breaks waived; the day ends at 18:00.');
  });

  it('shifting again in the same minute is a no-op; a few minutes later only the block in progress moves', () => {
    shiftDay(store, d(7, 10, 20), { breaks: 'waive' });
    const before = wedBlocks();
    const same = shiftDay(store, d(7, 10, 20));
    expect(same.summary).toBe('Nothing to shift: b starts at 10:20.');
    expect(wedBlocks()).toEqual(before);
    const later = shiftDay(store, d(7, 10, 25), { breaks: 'waive' });
    expect(later.moved.map((m) => [m.id, span(m)])).toEqual([['b', '10:25-11:25']]);
    expect(later.summary).toBe('Shifted 1 block by 5 min, breaks waived; the day ends at 18:00.');
    expect(['c', 'd', 'e', 'f'].map(at)).toEqual(['13:00-14:00', '14:00-15:00', '15:00-16:00', '17:00-18:00']);
  });

  it('with a busy-only baseline and no settings availability the day runs to midnight: the shift is made at once', () => {
    store.setBaseline({ slots: [slot(3, '12:00', '13:00')] });
    const r = shiftDay(store, d(7, 10, 20));
    expect(r.needsConfirmation).toBeUndefined();
    expect(r.moved.map((m) => [m.id, span(m)])).toEqual([['b', '10:20-11:20'], ['c', '13:00-14:00'], ['d', '14:00-15:00'], ['e', '15:00-16:00'], ['f', '18:00-19:00']]);
    expect(r.summary).toBe('Shifted 5 blocks by 20 min, breaks kept; the day ends at 19:00.');
  });

  it('shift, then carve, then carry: the operations compose and the carried block is remembered', () => {
    shiftDay(store, d(7, 10, 20), { breaks: 'waive' }); // b 10:20-11:20, c 13-14, d 14-15, e 15-16, f 17-18; a missed
    const carve = carveOut(store, d(7, 13, 30), d(7, 14), 'Call');
    expect(carve.summary).toBe('Carved out Call 13:30-14:00; split c: 13:00-13:30 kept, 30 min to 14:00-14:30; moved d to 14:30-15:30, e to 15:30-16:30.');
    const carry = carryOver(store, 'a', d(7, 14, 35));
    expect(carry.summary).toBe('a: 60 min carried to Thu 10:00 (slot extended).'); // 16:30-17:00 is too short for the hour
    expect(carry.created.map((x) => [new Date(x.start).getDate(), span(x), x.source])).toEqual([[8, '10:00-11:00', 'adjusted']]);
    expect(carryOver(store, 'a', d(7, 14, 36)).summary).toBe('a: already carried to Thu 10:00-11:00.');
  });
});

describe('shiftDay on a day that ends at midnight', () => {
  beforeEach(() => {
    store.upsertTask(task('a', 1));
    store.upsertTask(task('b', 2));
    store.setBaseline({ slots: [slot(3, '21:00', '22:30', 'a'), slot(3, '22:30', '24:00', 'b')] });
    store.insertBlocks([blk('a', 'a', d(7, 21), d(7, 22, 30)), blk('b', 'b', d(7, 22, 30), d(8, 0))]);
  });

  it('a block that would run past midnight is dropped; the wall is named as midnight in the question and the summary alike', () => {
    const ask = shiftDay(store, d(7, 21, 30));
    expect(ask.needsConfirmation).toBe(true);
    expect(ask.summary).toBe('Shifting 2 blocks by 30 min drops b (no room before midnight), and there is no break to waive. Drop b to end by midnight, or shift everything?');
    const r = shiftDay(store, d(7, 21, 30), { breaks: 'waive' });
    expect(r.moved.map((m) => [m.id, span(m)])).toEqual([['a', '21:30-23:00']]);
    expect(r.dropped.map((x) => x.id)).toEqual(['b']);
    expect(r.summary).toBe('Shifted 1 block by 30 min; the day ends at 23:00; dropped b (no room before midnight).');
    expect(store.getBlock('b')).toMatchObject({ status: 'missed', start: d(7, 22, 30).toISOString(), end: d(8, 0).toISOString() });
  });

  it('a block spanning midnight is in progress on the new day: said after midnight it starts now, whole; a day with no baseline spans ends at the next midnight', () => {
    store.insertBlocks([blk('n', 'a', d(7, 23, 30), d(8, 1))]);
    const r = shiftDay(store, d(8, 0, 10)); // Thursday has no slots in this baseline, so its usable time falls back to the whole day
    expect(r.moved.map((m) => [m.id, span(m), m.source])).toEqual([['n', '00:10-01:40', 'adjusted']]);
    expect(r.summary).toBe('Shifted 1 block by 40 min; the day ends at 01:40.');
    expect(['a', 'b'].map(at)).toEqual(['21:00-22:30', '22:30-00:00']); // Wednesday's blocks are over: missed, not moved
    expect(['a', 'b'].map((id) => store.getBlock(id)!.status)).toEqual(['missed', 'missed']);
  });
});

const dstEnds = new Date(2026, 9, 31, 12).getTimezoneOffset() !== new Date(2026, 10, 2, 12).getTimezoneOffset();
describe.skipIf(!dstEnds)('shiftDay on the 25-hour day daylight saving ends (Sun 1 Nov 2026)', () => {
  const nov = (h: number, m = 0) => new Date(2026, 10, 1, h, m);
  it('the baseline minutes and the blocks agree on the wall clock after the extra hour', () => {
    store.upsertTask(task('a', 1));
    store.upsertTask(task('b', 2));
    store.setBaseline({ slots: [slot(0, '09:00', '10:00', 'a'), slot(0, '10:00', '11:00', 'b')] });
    store.insertBlocks([blk('a', 'a', nov(9), nov(10)), blk('b', 'b', nov(10), nov(11))]);
    const r = shiftDay(store, nov(9, 20), { breaks: 'waive' });
    expect(r.moved.map((m) => [m.id, span(m)])).toEqual([['a', '09:20-10:20']]);
    expect(r.summary).toBe('Shifted 1 block by 20 min; the day ends at 10:20; dropped b (no room before 11:00).');
  });
});

describe('carveOut at the edges', () => {
  beforeEach(() => { week(); wednesday(); });

  it('a carve exactly over a block moves it whole to the carve\'s end and the rest follow', () => {
    const r = carveOut(store, d(7, 10), d(7, 11), 'Call');
    expect(r.summary).toBe('Carved out Call 10:00-11:00; moved b to 11:00-12:00, c to 13:00-14:00, d to 14:00-15:00, e to 15:00-16:00.');
    expect(r.shortened).toEqual([]);
    expect(r.created).toEqual([]);
  });

  it('a carve that only touches a block\'s end does not move it', () => {
    const r = carveOut(store, d(7, 11), d(7, 11, 30), 'Call');
    expect(at('b')).toBe('10:00-11:00');
    expect(store.getBlock('b')!.source).toBe('baseline');
    expect(r.summary).toBe('Carved out Call 11:00-11:30; moved c to 13:00-14:00, d to 14:00-15:00, e to 15:00-16:00.');
  });

  it('a carve ending exactly where the next block starts splits the one before and pushes the next', () => {
    const r = carveOut(store, d(7, 9, 30), d(7, 10), 'Call');
    expect(r.summary).toBe('Carved out Call 09:30-10:00; split a: 09:00-09:30 kept, 30 min to 10:00-10:30; moved b to 10:30-11:30, c to 13:00-14:00, d to 14:00-15:00, e to 15:00-16:00.');
    expect(r.created.map((x) => [x.taskId, span(x)])).toEqual([['a', '10:00-10:30']]);
    expect(at('f')).toBe('17:00-18:00');
  });

  it('a carve before the first block pushes everything from it, in order', () => {
    const r = carveOut(store, d(7, 8), d(7, 9, 30), 'Call');
    expect(r.summary).toBe('Carved out Call 08:00-09:30; moved a to 09:30-10:30, b to 10:30-11:30, c to 13:00-14:00, d to 14:00-15:00, e to 15:00-16:00.');
  });

  it('a commitment over the whole day drops every pending block, lowest priority first, and keeps them as missed', () => {
    const r = carveOut(store, d(7, 9), d(7, 18), 'Offsite');
    expect(r.dropped.map((x) => x.id)).toEqual(['f', 'e', 'd', 'c', 'b', 'a']);
    expect(r.summary).toBe('Carved out Offsite 09:00-18:00; dropped f, e, d, c, b, a (no room before 18:00).');
    expect(wedBlocks().map((x) => [x[0], x[1], x[2]])).toEqual([
      ['a', '09:00-10:00', 'missed'], ['b', '10:00-11:00', 'missed'], ['c', '11:00-12:00', 'missed'], ['d', '13:00-14:00', 'missed'], ['e', '14:00-15:00', 'missed'], ['f', '17:00-18:00', 'missed'],
    ]);
  });

  it('a carve across midnight is one commitment; only the day it starts on is looked at', () => {
    const r = carveOut(store, d(7, 23), d(8, 1));
    expect(r.summary).toBe('Carved out Busy 23:00-01:00; nothing to move.');
    expect(store.listCommitments({ from: d(8, 0), to: d(9, 0) }).map((c) => [c.title, c.start, c.end])).toEqual([['Busy', d(7, 23).toISOString(), d(8, 1).toISOString()]]);
  });

  it('a carve in blank time moves nothing, even with blocks later in the day', () => {
    const r = carveOut(store, d(7, 15, 30), d(7, 16, 30), 'Gym');
    expect(r).toMatchObject({ moved: [], shortened: [], dropped: [], created: [], summary: 'Carved out Gym 15:30-16:30; nothing to move.' });
    expect(at('f')).toBe('17:00-18:00');
  });

  it('the same carve twice adds a second commitment but finds nothing left to move', () => {
    carveOut(store, d(7, 10), d(7, 10, 30), 'Call');
    const again = carveOut(store, d(7, 10), d(7, 10, 30), 'Call');
    expect(again.summary).toBe('Carved out Call 10:00-10:30; nothing to move.');
    expect(store.listCommitments({ from: d(7, 10), to: d(7, 10, 30) }).map((c) => c.title)).toEqual(['Call', 'Call']);
    expect(at('b')).toBe('10:30-11:30');
  });

  it('with a minimum block longer than the maximum a partly covered block is never split', () => {
    store.saveSettings({ ...store.getSettings(), minBlockMinutes: 120, maxBlockMinutes: 60 });
    const r = carveOut(store, d(7, 10, 30), d(7, 11), 'Call');
    expect(r.shortened).toEqual([]);
    expect(r.created).toEqual([]);
    expect(r.summary).toBe('Carved out Call 10:30-11:00; moved b to 11:00-12:00, c to 13:00-14:00, d to 14:00-15:00, e to 15:00-16:00.');
  });

  it('a block of a task that no longer exists is moved as "Unknown task"', () => {
    store.insertBlocks([blk('z', 'zz', d(7, 15), d(7, 16))]);
    const r = carveOut(store, d(7, 15), d(7, 15, 30));
    expect(r.summary).toBe('Carved out Busy 15:00-15:30; moved Unknown task to 15:30-16:30.');
  });

  it('a one-minute carve at the start of a block moves the block whole (the part before it is nothing)', () => {
    const r = carveOut(store, d(7, 10), d(7, 10, 1), 'Ping');
    expect(r.moved[0]).toMatchObject({ id: 'b', start: d(7, 10, 1).toISOString(), end: d(7, 11, 1).toISOString() });
    expect(r.summary).toBe('Carved out Ping 10:00-10:01; moved b to 10:01-11:01, c to 13:00-14:00, d to 14:00-15:00, e to 15:00-16:00.');
  });

  it('a carve title of spaces is "Busy"', () => {
    expect(carveOut(store, d(7, 8), d(7, 8, 30), '   ').summary).toBe('Carved out Busy 08:00-08:30; nothing to move.');
  });
});

describe('carveOut with no baseline and no availability', () => {
  it('nothing fits anywhere: the overlapped block and every pending block after it are dropped as missed', () => {
    for (const [id, p] of [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5], ['f', 6]] as const) store.upsertTask(task(id, p));
    wednesday();
    const r = carveOut(store, d(7, 10), d(7, 10, 30), 'Call');
    expect(r.dropped.map((x) => x.id)).toEqual(['f', 'e', 'd', 'c', 'b']);
    expect(r.summary).toBe('Carved out Call 10:00-10:30; dropped f, e, d, c, b (no usable time today).');
    expect(store.getBlock('a')!.status).toBe('pending');
  });
});

describe('carryOver at the edges', () => {
  const lc = (day: number, s: string, e: string) => slot(day, s, e, 'lc');
  beforeEach(() => {
    store.upsertTask(task('lc', 1, 'Leetcode'));
    store.upsertTask(task('rd', 2, 'Reading'));
    // Weekdays: Leetcode 10-11, Reading 13-14 -> usable 10:00-14:00.
    store.setBaseline({ slots: [1, 2, 3, 4, 5].flatMap((day) => [lc(day, '10:00', '11:00'), slot(day, '13:00', '14:00', 'rd')]) });
  });

  it('more minutes tracked than planned: the block is finished by the sweep and nothing is owed', () => {
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 11), { trackedMinutes: 90 })]);
    expect(carryOver(store, 'lc', d(7, 11, 30)).summary).toBe('Leetcode: nothing to carry over today.');
    expect(store.getBlock('l')!.status).toBe('done');
    expect(store.listBlocks().length).toBe(1);
  });

  it('a done block with a clock owes the difference; a missed block with a clock too', () => {
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 11), { status: 'done', trackedMinutes: 20 })]);
    expect(carryOver(store, 'lc', d(7, 11, 30)).summary).toBe('Leetcode: 40 min carried to 11:30-12:10.');
    store.deleteBlocks(store.listBlocks().map((b) => b.id));
    store.insertBlocks([blk('m', 'lc', d(7, 10), d(7, 11), { status: 'missed', trackedMinutes: 15 })]);
    expect(carryOver(store, 'lc', d(7, 11, 30)).summary).toBe('Leetcode: 45 min carried to 11:30-12:15.');
  });

  it('an early-finished block owes its planned length minus what was tracked', () => {
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 10, 40), { status: 'done', plannedMinutes: 60, trackedMinutes: 40 })]);
    expect(carryOver(store, 'lc', d(7, 11, 30)).summary).toBe('Leetcode: 20 min carried to 11:30-11:50.');
  });

  it('said exactly at the block\'s start nothing is owed yet; exactly at its end the whole block is owed and lands right there', () => {
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 11)), blk('r', 'rd', d(7, 13), d(7, 14))]);
    expect(carryOver(store, 'lc', d(7, 10)).summary).toBe('Leetcode: nothing to carry over today.');
    expect(store.getBlock('l')).toMatchObject({ status: 'pending', end: d(7, 11).toISOString() });
    const r = carryOver(store, 'lc', d(7, 11));
    expect(r.created.map(span)).toEqual(['11:00-12:00']);
    expect(r.summary).toBe('Leetcode: 60 min carried to 11:00-12:00.');
  });

  it('said one minute into the block, the block keeps one minute and 59 are carried, off the grid at the end', () => {
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 11)), blk('r', 'rd', d(7, 13), d(7, 14))]);
    const r = carryOver(store, 'lc', d(7, 10, 1));
    expect(r.shortened.map(span)).toEqual(['10:00-10:01']);
    expect(r.created.map(span)).toEqual(['11:00-11:59']);
    expect(r.summary).toBe('Leetcode: 59 min carried to 11:00-11:59.');
  });

  it('seconds are dropped: said at 10:30:45 the block ends at 10:30', () => {
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 11))]);
    const r = carryOver(store, 'lc', d(7, 10, 30, 45));
    expect(r.shortened.map(span)).toEqual(['10:00-10:30']);
    expect(r.summary).toBe('Leetcode: 30 min carried to 11:00-11:30.');
  });

  it('when the block a carry made is deleted, the minutes are owed again; when it is marked done, they are not', () => {
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 11))]);
    const first = carryOver(store, 'lc', d(7, 11, 30));
    expect(first.summary).toBe('Leetcode: 60 min carried to 11:30-12:30.');
    store.deleteBlocks([first.created[0].id]);
    const second = carryOver(store, 'lc', d(7, 11, 30));
    expect(second.summary).toBe('Leetcode: 60 min carried to 11:30-12:30.');
    markBlock(store, second.created[0].id, 'done', d(7, 12, 30));
    expect(carryOver(store, 'lc', d(7, 12, 31)).summary).toBe('Leetcode: nothing to carry over today.');
    expect(store.listBlocks().length).toBe(2);
  });

  it('the week\'s end depends on weekStartsOn: on a Sunday the Sunday week has Monday ahead, the Monday week has nothing', () => {
    store.setBaseline({ slots: [lc(0, '10:00', '11:00'), lc(1, '10:00', '11:00'), slot(1, '13:00', '14:00', 'rd')] });
    store.insertBlocks([blk('l', 'lc', d(11, 10), d(11, 11))]); // Sunday 11 Oct, no gap after it (the day's usable time is the slot)
    store.saveSettings({ ...store.getSettings(), weekStartsOn: 1 });
    expect(carryOver(store, 'lc', d(11, 11, 30)).summary).toBe('Leetcode: 60 min, no room this week.');
    store.saveSettings({ ...store.getSettings(), weekStartsOn: 0 });
    const r = carryOver(store, 'lc', d(11, 11, 30));
    expect(r.summary).toBe('Leetcode: 60 min carried to Mon 11:00 (slot extended).');
    expect(r.created.map((x) => [new Date(x.start).getDate(), span(x)])).toEqual([[12, '11:00-12:00']]);
  });

  it('a hand-placed copy of the next slot is never extended: the minutes sit beside it as a new block', () => {
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 11)), blk('r', 'rd', d(7, 11), d(7, 14), { source: 'manual' }), blk('l8', 'lc', d(8, 10), d(8, 11), { source: 'manual' })]);
    const r = carryOver(store, 'lc', d(7, 11, 30));
    expect(r.moved).toEqual([]);
    expect(r.created.map((x) => [new Date(x.start).getDate(), span(x), x.source])).toEqual([[8, '11:00-12:00', 'adjusted']]);
    expect(r.summary).toBe('Leetcode: 60 min carried to Thu 11:00 (slot extended).');
    expect(store.getBlock('l8')).toMatchObject({ start: d(8, 10).toISOString(), end: d(8, 11).toISOString(), source: 'manual' });
  });

  it('a block that began yesterday and ended after midnight today is today\'s and owes its whole length', () => {
    store.insertBlocks([blk('n', 'lc', d(6, 23), d(7, 1)), blk('r', 'rd', d(7, 13), d(7, 14))]);
    const r = carryOver(store, 'lc', d(7, 11, 30));
    expect(store.getBlock('n')!.status).toBe('missed');
    expect(r.summary).toBe('Leetcode: 120 min carried to Thu 11:00 (slot extended).'); // two hours do not fit before Reading today
    expect(r.created.map((x) => [new Date(x.start).getDate(), span(x)])).toEqual([[8, '11:00-13:00']]);
  });

  it('a skipped block in progress is not shortened and owes nothing', () => {
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 11), { status: 'skipped' })]);
    expect(carryOver(store, 'lc', d(7, 10, 30)).summary).toBe('Leetcode: nothing to carry over today.');
    expect(at('l')).toBe('10:00-11:00');
  });

  it('two blocks over today owe their sum, carried as one block', () => {
    store.setBaseline({ slots: [lc(3, '08:00', '09:00'), lc(3, '10:00', '11:00'), slot(3, '13:00', '14:00', 'rd')] }); // usable 08:00-14:00
    store.insertBlocks([blk('l1', 'lc', d(7, 8), d(7, 9), { trackedMinutes: 30 }), blk('l2', 'lc', d(7, 10), d(7, 11))]);
    const r = carryOver(store, 'lc', d(7, 11, 10));
    expect(r.summary).toBe('Leetcode: 90 min carried to 11:15-12:45.');
    expect(store.listBlocks().filter((b) => b.taskId === 'lc').map((b) => [b.id === r.created[0].id ? 'new' : b.id, b.carriedTo === r.created[0].id])).toEqual([['l1', true], ['l2', true], ['new', false]]);
  });
});

describe('carryOver with no baseline', () => {
  beforeEach(() => {
    store.upsertTask(task('lc', 1, 'Leetcode'));
    store.saveSettings({ ...store.getSettings(), availability: [{ days: [3], start: '09:00', end: '18:00' }] });
  });
  it('the settings\' availability bounds the gap search', () => {
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 11))]);
    expect(carryOver(store, 'lc', d(7, 11, 30)).summary).toBe('Leetcode: 60 min carried to 11:30-12:30.');
  });
  it('with no gap and no baseline slot to extend, the week has no room', () => {
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 11)), blk('m', 'lc', d(7, 11, 30), d(7, 18), { source: 'manual' })]);
    expect(carryOver(store, 'lc', d(7, 11, 20))).toEqual({ moved: [], shortened: [], dropped: [], created: [], summary: 'Leetcode: 60 min, no room this week.' });
  });
  it('with no availability at all, nothing can take the minutes', () => {
    store.saveSettings({ ...store.getSettings(), availability: [] });
    store.insertBlocks([blk('l', 'lc', d(7, 10), d(7, 11))]);
    expect(carryOver(store, 'lc', d(7, 11, 30)).summary).toBe('Leetcode: 60 min, no room this week.');
  });
});
