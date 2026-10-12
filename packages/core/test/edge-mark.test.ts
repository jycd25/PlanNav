import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/store.js';
import { createBlock, findTaskBlock, markBlock, materializeMissed, moveBlock } from '../src/mark.js';
import { trackBlock } from '../src/track.js';
import { DEFAULT_SETTINGS, type Block } from '../src/types.js';

const d = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m); // Oct 2026: 6 Tue, 7 Wed, 8 Thu
const block = (id: string, start: Date, end: Date, extra: Partial<Block> = {}): Block => ({ id, taskId: 't', start: start.toISOString(), end: end.toISOString(), status: 'pending', createdAt: '', statusChangedAt: null, ...extra });
const span = (b: { start: string; end: string }) => { const f = (iso: string) => { const x = new Date(iso); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; }; return `${f(b.start)}-${f(b.end)}`; };

let s: MemoryStore;
beforeEach(() => {
  s = new MemoryStore();
  s.saveSettings({ ...DEFAULT_SETTINGS, slotMinutes: 15 });
  s.upsertTask({ id: 't', name: 'T', color: '#000', priority: 1, budgetMinutes: 60, budgetPeriod: 'day', archived: false, createdAt: '' });
});

describe('markBlock at the edges', () => {
  it('reset on a block that was never tracked clears nothing but keeps the planned end', () => {
    s.insertBlocks([block('b', d(7, 9), d(7, 10))]);
    const r = markBlock(s, 'b', 'pending', d(7, 9, 30));
    expect(r).toMatchObject({ status: 'pending', start: d(7, 9).toISOString(), end: d(7, 10).toISOString(), statusChangedAt: d(7, 9, 30).toISOString(), runningSince: null });
    expect(r.trackedMinutes).toBeUndefined();
    expect('startedAt' in r).toBe(false);
    expect('finishedAt' in r).toBe(false);
  });
  it('reset after finish restores the planned end; a second reset changes nothing more', () => {
    s.insertBlocks([block('b', d(7, 9), d(7, 10))]);
    trackBlock(s, 'b', 'start', d(7, 9));
    trackBlock(s, 'b', 'finish', d(7, 9, 20));
    expect(span(s.getBlock('b')!)).toBe('09:00-09:20');
    const once = markBlock(s, 'b', 'pending', d(7, 9, 25));
    const twice = markBlock(s, 'b', 'pending', d(7, 9, 26));
    expect(span(once)).toBe('09:00-10:00');
    expect(span(twice)).toBe('09:00-10:00');
    expect(twice.plannedMinutes).toBeUndefined();
    expect(twice.trackedMinutes).toBeUndefined();
  });
  it('reset on a block finished with a planned length but no shortening (finished after its end) keeps its end', () => {
    s.insertBlocks([block('b', d(7, 9), d(7, 10))]);
    trackBlock(s, 'b', 'finish', d(7, 10, 5));
    expect(s.getBlock('b')!.plannedMinutes).toBeUndefined();
    expect(span(markBlock(s, 'b', 'pending', d(7, 10, 6)))).toBe('09:00-10:00');
  });
  it('marking a running block of another day done pauses the clock with the minutes actually run', () => {
    s.insertBlocks([block('y', d(6, 9), d(6, 10))]);
    trackBlock(s, 'y', 'start', d(7, 14));
    const r = markBlock(s, 'y', 'done', d(7, 14, 25));
    expect(r).toMatchObject({ status: 'done', trackedMinutes: 25, runningSince: null, start: d(6, 9).toISOString(), end: d(6, 10).toISOString() });
  });
  it('a block can be marked missed by hand, skipped then done, and done then skipped, each stamping the time', () => {
    s.insertBlocks([block('b', d(7, 9), d(7, 10))]);
    expect(markBlock(s, 'b', 'missed', d(7, 11)).status).toBe('missed');
    expect(markBlock(s, 'b', 'skipped', d(7, 11, 1)).status).toBe('skipped');
    const done = markBlock(s, 'b', 'done', d(7, 11, 2));
    expect([done.status, done.statusChangedAt]).toEqual(['done', d(7, 11, 2).toISOString()]);
    expect(markBlock(s, 'b', 'skipped', d(7, 11, 3)).status).toBe('skipped');
  });
  it('marking done a block with a running clock whose start is in the future records zero minutes', () => {
    s.insertBlocks([block('b', d(7, 9), d(7, 10), { runningSince: d(7, 9, 50).toISOString() })]);
    const r = markBlock(s, 'b', 'done', d(7, 9, 40));
    expect(r.trackedMinutes).toBe(0);
    expect(r.runningSince).toBeNull();
  });
});

describe('moveBlock at the edges', () => {
  it('moves onto another block without complaint (the guard lives in the tools), and only the moved one becomes manual', () => {
    s.insertBlocks([block('a', d(7, 9), d(7, 10), { source: 'baseline' }), block('b', d(7, 11), d(7, 12), { source: 'baseline' })]);
    const r = moveBlock(s, 'a', d(7, 11), d(7, 12));
    expect([span(r), r.source]).toEqual(['11:00-12:00', 'manual']);
    expect(s.getBlock('b')).toMatchObject({ start: d(7, 11).toISOString(), source: 'baseline' });
  });
  it('a zero-length move is refused and the block is untouched', () => {
    s.insertBlocks([block('a', d(7, 9), d(7, 10), { source: 'baseline' })]);
    expect(() => moveBlock(s, 'a', d(7, 11), d(7, 11))).toThrow('end must be after start');
    expect(s.getBlock('a')).toMatchObject({ start: d(7, 9).toISOString(), end: d(7, 10).toISOString(), source: 'baseline' });
  });
  it('a block may be moved across midnight, to another day, and keeps its status and clock', () => {
    s.insertBlocks([block('a', d(7, 9), d(7, 10), { status: 'done', trackedMinutes: 30 })]);
    const r = moveBlock(s, 'a', d(7, 23), d(8, 1));
    expect([r.start, r.end, r.status, r.trackedMinutes]).toEqual([d(7, 23).toISOString(), d(8, 1).toISOString(), 'done', 30]);
    const again = moveBlock(s, 'a', d(9, 9), d(9, 10));
    expect(again.start).toBe(d(9, 9).toISOString());
  });
  it('moving to the same place still makes the block manual', () => {
    s.insertBlocks([block('a', d(7, 9), d(7, 10), { source: 'planner' })]);
    expect(moveBlock(s, 'a', d(7, 9), d(7, 10)).source).toBe('manual');
  });
  it('an unknown block is refused', () => {
    expect(() => moveBlock(s, 'nope', d(7, 9), d(7, 10))).toThrow('Block not found: nope');
  });
});

describe('findTaskBlock at the edges', () => {
  it('now exactly at a block\'s start means that block; exactly at its end means it too, as the latest one started', () => {
    s.insertBlocks([block('a', d(7, 9), d(7, 10)), block('b', d(7, 14), d(7, 15))]);
    expect(findTaskBlock(s, 't', d(7, 9))!.id).toBe('a');
    expect(findTaskBlock(s, 't', d(7, 10))!.id).toBe('a');
    expect(findTaskBlock(s, 't', d(7, 13, 59))!.id).toBe('a');
    expect(findTaskBlock(s, 't', d(7, 14))!.id).toBe('b');
  });
  it('two blocks back to back: at the join the second one is meant', () => {
    s.insertBlocks([block('a', d(7, 9), d(7, 10)), block('b', d(7, 10), d(7, 11))]);
    expect(findTaskBlock(s, 't', d(7, 10))!.id).toBe('b');
  });
  it('before any block today the earliest of the day is meant, even hours ahead', () => {
    s.insertBlocks([block('late', d(7, 20), d(7, 21)), block('early', d(7, 14), d(7, 15))]);
    expect(findTaskBlock(s, 't', d(7, 0))!.id).toBe('early');
  });
  it('a block that began yesterday and runs into today counts as today\'s all day; midnight itself belongs to a block starting then', () => {
    s.insertBlocks([block('n', d(6, 23), d(7, 1)), block('m', d(8, 0), d(8, 1))]);
    expect(findTaskBlock(s, 't', d(7, 0, 30))!.id).toBe('n');
    expect(findTaskBlock(s, 't', d(7, 23, 59))!.id).toBe('n'); // still the latest block that started before now among today's; tomorrow's m is not today's
    expect(findTaskBlock(s, 't', d(8, 0))!.id).toBe('m');
  });
  it('yesterday\'s blocks are never meant today, nor another task\'s', () => {
    s.insertBlocks([block('y', d(6, 9), d(6, 10)), { ...block('o', d(7, 9), d(7, 10)), taskId: 'other' }]);
    expect(findTaskBlock(s, 't', d(7, 9, 30))).toBeUndefined();
  });
  it('among blocks of every status the rule is the same: a done block containing now is still the one meant', () => {
    s.insertBlocks([block('a', d(7, 9), d(7, 10), { status: 'done' }), block('b', d(7, 9, 30), d(7, 10, 30), { status: 'skipped' })]);
    expect(findTaskBlock(s, 't', d(7, 9, 45))!.id).toBe('a'); // the earlier start, listed first
  });
});

describe('materializeMissed at the edges', () => {
  it('a block ending exactly now is missed; one ending a minute later is still pending', () => {
    s.insertBlocks([block('now', d(7, 9), d(7, 10)), block('later', d(7, 9), d(7, 10, 1))]);
    expect(materializeMissed(s, d(7, 10)).map((b) => b.id)).toEqual(['now']);
    expect(s.getBlock('later')!.status).toBe('pending');
  });
  it('a block that ends at midnight is missed at midnight exactly, and is swept with the day before', () => {
    s.insertBlocks([block('n', d(7, 23), d(8, 0))]);
    expect(materializeMissed(s, d(7, 23, 59))).toEqual([]);
    expect(materializeMissed(s, d(8, 0)).map((b) => [b.id, b.status])).toEqual([['n', 'missed']]);
  });
  it('blocks from any earlier day are swept together, skipped and missed ones untouched, and the sweep is idempotent', () => {
    s.insertBlocks([block('mon', d(5, 9), d(5, 10)), block('tue', d(6, 9), d(6, 10)), block('sk', d(6, 10), d(6, 11), { status: 'skipped' }), block('mi', d(6, 11), d(6, 12), { status: 'missed', statusChangedAt: 'x' })]);
    const out = materializeMissed(s, d(7, 9));
    expect(out.map((b) => b.id).sort()).toEqual(['mon', 'tue']);
    expect(s.getBlock('sk')!.status).toBe('skipped');
    expect(s.getBlock('mi')!.statusChangedAt).toBe('x');
    expect(materializeMissed(s, d(7, 9))).toEqual([]);
  });
  it('a block with zero tracked minutes recorded by hand is missed, not finished', () => {
    s.insertBlocks([block('z', d(7, 9), d(7, 10), { trackedMinutes: 0 })]);
    expect(materializeMissed(s, d(7, 12))[0]).toMatchObject({ id: 'z', status: 'missed' });
  });
  it('a block with a minute tracked is finished at its planned end, keeping its times', () => {
    s.insertBlocks([block('o', d(7, 9), d(7, 10), { trackedMinutes: 1 })]);
    expect(materializeMissed(s, d(7, 12))[0]).toMatchObject({ id: 'o', status: 'done', end: d(7, 10).toISOString(), trackedMinutes: 1, finishedAt: d(7, 10).toISOString() });
  });
  it('a running clock on yesterday\'s block is stopped at the block\'s end with the stretch up to that end', () => {
    s.insertBlocks([block('y', d(6, 9), d(6, 10), { runningSince: d(6, 9, 30).toISOString() })]);
    expect(materializeMissed(s, d(7, 0))[0]).toMatchObject({ id: 'y', status: 'done', trackedMinutes: 30, runningSince: null });
  });
  // Regression (fixed 2026-10-12): a past block the user starts today ("Start" on yesterday's block, allowed by trackBlock and documented as recording
  // the actual start) is closed by the very next sweep: its clock is stopped at the block's own end, which lies before the
  // start, so the block ends up done with 0 tracked minutes and a finishedAt before its startedAt. Expected: the clock keeps
  // running (the sweep leaves a running clock alone until its session is over) or is stopped at now with the real minutes.
  it('a block of a past day started today keeps its running clock through a sweep', () => {
    s.insertBlocks([block('y', d(6, 9), d(6, 10))]);
    trackBlock(s, 'y', 'start', d(7, 14));
    materializeMissed(s, d(7, 14, 10));
    const y = s.getBlock('y')!;
    expect(y.status).toBe('pending');
    expect(y.runningSince).toBe(d(7, 14).toISOString());
  });
});

describe('createBlock at the edges', () => {
  it('a hand-placed block inside one slot grows to that slot; on-grid times stay as they are', () => {
    const tiny = createBlock(s, 't', d(7, 9, 7), d(7, 9, 8), d(7, 8));
    expect(span(tiny)).toBe('09:00-09:15');
    const exact = createBlock(s, 't', d(7, 10), d(7, 11), d(7, 8));
    expect(span(exact)).toBe('10:00-11:00');
    expect(exact.createdAt).toBe(d(7, 8).toISOString());
  });
  it('a zero-length block on the grid is refused; one off the grid is not, since the grid stretches it', () => {
    expect(() => createBlock(s, 't', d(7, 9), d(7, 9), d(7, 8))).toThrow('end must be after start');
    expect(span(createBlock(s, 't', d(7, 9, 1), d(7, 9, 1), d(7, 8)))).toBe('09:00-09:15');
  });
  it('a block across midnight snaps each end on its own day', () => {
    const b = createBlock(s, 't', d(7, 23, 50), d(8, 0, 10), d(7, 8));
    expect(b.start).toBe(d(7, 23, 45).toISOString());
    expect(b.end).toBe(d(8, 0, 15).toISOString());
  });
  it('a one-hour grid snaps to hours', () => {
    s.saveSettings({ ...DEFAULT_SETTINGS, slotMinutes: 60 });
    expect(span(createBlock(s, 't', d(7, 9, 59), d(7, 10, 1), d(7, 8)))).toBe('09:00-11:00');
  });
  it('an archived task can still take a hand-placed block (only an unknown one is refused)', () => {
    s.archiveTask('t');
    expect(createBlock(s, 't', d(7, 9), d(7, 10), d(7, 8)).taskId).toBe('t');
  });
});
