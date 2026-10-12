import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/store.js';
import { applyTrack, elapsedMinutes, trackBlock } from '../src/track.js';
import { markBlock } from '../src/mark.js';
import { DEFAULT_SETTINGS, type Block } from '../src/types.js';

const d = (day: number, h: number, m = 0, s = 0) => new Date(2026, 9, day, h, m, s); // Oct 2026: 6 Tue, 7 Wed, 8 Thu
const block = (id: string, start: Date, end: Date, extra: Partial<Block> = {}): Block => ({ id, taskId: 't', start: start.toISOString(), end: end.toISOString(), status: 'pending', createdAt: '', statusChangedAt: null, ...extra });
const span = (b: { start: string; end: string }) => { const f = (iso: string) => { const x = new Date(iso); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; }; return `${f(b.start)}-${f(b.end)}`; };

let s: MemoryStore;
beforeEach(() => {
  s = new MemoryStore();
  s.saveSettings({ ...DEFAULT_SETTINGS, slotMinutes: 15 });
  s.insertBlocks([block('b', d(7, 9), d(7, 10))]);
});

describe('elapsedMinutes at the edges', () => {
  it('a clock started in the future adds nothing; rounding is to the nearest minute', () => {
    expect(elapsedMinutes({ trackedMinutes: 10, runningSince: d(7, 9, 30).toISOString() }, d(7, 9))).toBe(10);
    expect(elapsedMinutes({ runningSince: d(7, 9).toISOString() }, d(7, 9, 0, 29))).toBe(0);
    expect(elapsedMinutes({ runningSince: d(7, 9).toISOString() }, d(7, 9, 0, 30))).toBe(1);
    expect(elapsedMinutes({ trackedMinutes: 0.4, runningSince: null }, d(7, 9))).toBe(0);
    expect(elapsedMinutes({}, d(7, 9))).toBe(0);
  });
});

describe('start at the edges', () => {
  it('starting an already running block changes nothing: same clock, same first start, nothing paused', () => {
    trackBlock(s, 'b', 'start', d(7, 9, 2));
    const again = trackBlock(s, 'b', 'start', d(7, 9, 30));
    expect(again.block.runningSince).toBe(d(7, 9, 2).toISOString());
    expect(again.block.startedAt).toBe(d(7, 9, 2).toISOString());
    expect(again.paused).toEqual([]);
    expect(again.elapsedMinutes).toBe(28);
  });
  it('starting pauses a running block of another day, with the minutes it ran', () => {
    s.insertBlocks([block('y', d(6, 9), d(6, 10))]);
    trackBlock(s, 'y', 'start', d(7, 8));
    const r = trackBlock(s, 'b', 'start', d(7, 9));
    expect(r.paused.map((p) => [p.id, p.trackedMinutes, p.runningSince])).toEqual([['y', 60, null]]);
  });
  it('a block may be started after its own end; the clock runs from now', () => {
    const r = trackBlock(s, 'b', 'start', d(7, 11));
    expect(r.block.runningSince).toBe(d(7, 11).toISOString());
    expect(elapsedMinutes(r.block, d(7, 11, 20))).toBe(20);
  });
});

describe('finish at the edges', () => {
  it('finishing at exactly the start ends the block one slot in; at exactly the end leaves it whole with no planned length', () => {
    const atStart = trackBlock(s, 'b', 'finish', d(7, 9));
    expect([span(atStart.block), atStart.block.plannedMinutes]).toEqual(['09:00-09:15', 60]);
    s.insertBlocks([block('c', d(7, 10), d(7, 11))]);
    const atEnd = trackBlock(s, 'c', 'finish', d(7, 11));
    expect([span(atEnd.block), atEnd.block.plannedMinutes, atEnd.block.status]).toEqual(['10:00-11:00', undefined, 'done']);
  });
  it('finishing one minute before the end shortens by that minute and keeps the planned 60', () => {
    const r = trackBlock(s, 'b', 'finish', d(7, 9, 59));
    expect([span(r.block), r.block.plannedMinutes]).toEqual(['09:00-09:59', 60]);
  });
  it('a block shorter than a slot finished early keeps its end and still records its planned length', () => {
    s.saveSettings({ ...DEFAULT_SETTINGS, slotMinutes: 60 });
    s.insertBlocks([block('short', d(7, 12), d(7, 12, 30))]);
    const r = trackBlock(s, 'short', 'finish', d(7, 12, 10));
    expect([span(r.block), r.block.plannedMinutes]).toEqual(['12:00-12:30', 30]);
  });
  it('finishing twice: an earlier second finish shortens again, a later one leaves the shortened end; the planned length is the original', () => {
    trackBlock(s, 'b', 'finish', d(7, 9, 40));
    const later = trackBlock(s, 'b', 'finish', d(7, 9, 50));
    expect([span(later.block), later.block.plannedMinutes]).toEqual(['09:00-09:40', 60]);
    const earlier = trackBlock(s, 'b', 'finish', d(7, 9, 30));
    expect([span(earlier.block), earlier.block.plannedMinutes, earlier.block.finishedAt]).toEqual(['09:00-09:30', 60, d(7, 9, 30).toISOString()]);
  });
  it('a block across midnight: finished before midnight it is shortened; finished after midnight (its start\'s day over) it is left whole', () => {
    s.insertBlocks([block('n1', d(7, 23), d(8, 1)), block('n2', d(7, 23), d(8, 1))]);
    const before = trackBlock(s, 'n1', 'finish', d(7, 23, 30));
    expect([before.block.end, before.block.plannedMinutes]).toEqual([d(7, 23, 30).toISOString(), 120]);
    expect(() => trackBlock(s, 'n2', 'finish', d(8, 0, 30))).toThrow(/not today/); // after midnight the block is "another day's": it needs a start first
    trackBlock(s, 'n2', 'start', d(7, 23));
    const after = trackBlock(s, 'n2', 'finish', d(8, 0, 30));
    expect([after.block.end, after.block.plannedMinutes, after.block.status, after.block.trackedMinutes]).toEqual([d(8, 1).toISOString(), undefined, 'done', 90]);
  });
  it('finish on another day\'s block is allowed once anything was recorded on it: a start, or even "0 minutes"', () => {
    s.insertBlocks([block('t1', d(8, 9), d(8, 10)), block('t2', d(8, 9), d(8, 10)), block('t3', d(8, 9), d(8, 10))]);
    trackBlock(s, 't1', 'set', d(7, 9), 0);
    expect(trackBlock(s, 't1', 'finish', d(7, 9, 5)).block.status).toBe('done');
    s.updateBlock('t2', { startedAt: d(7, 8).toISOString() });
    expect(trackBlock(s, 't2', 'finish', d(7, 9, 5)).block.status).toBe('done');
    expect(() => trackBlock(s, 't3', 'finish', d(7, 9, 5))).toThrow(/not today/);
  });
  it('the sweep\'s path (applyTrack) has no day guard: it can finish another day\'s block never started', () => {
    s.insertBlocks([block('t1', d(8, 9), d(8, 10))]);
    expect(applyTrack(s, 't1', 'finish', d(7, 9)).block.status).toBe('done');
  });
  it('the elapsed minutes reported after a finish are the tracked ones, the clock stopped', () => {
    trackBlock(s, 'b', 'start', d(7, 9));
    const r = trackBlock(s, 'b', 'finish', d(7, 9, 45));
    expect([r.elapsedMinutes, r.block.trackedMinutes, r.block.runningSince]).toEqual([45, 45, null]);
  });
});

describe('set at the edges', () => {
  it('rounds to the minute, accepts exactly a day, and stops the clock while keeping the first start', () => {
    trackBlock(s, 'b', 'start', d(7, 9, 3));
    expect(trackBlock(s, 'b', 'set', d(7, 9, 30), 12.4).block.trackedMinutes).toBe(12);
    expect(trackBlock(s, 'b', 'set', d(7, 9, 30), 12.5).block.trackedMinutes).toBe(13);
    const day = trackBlock(s, 'b', 'set', d(7, 9, 30), 24 * 60).block;
    expect([day.trackedMinutes, day.runningSince, day.startedAt]).toEqual([1440, null, d(7, 9, 3).toISOString()]);
  });
  it('refuses NaN and Infinity', () => {
    expect(() => trackBlock(s, 'b', 'set', d(7, 9), Number.NaN)).toThrow('minutes must be between 0 and 1440');
    expect(() => trackBlock(s, 'b', 'set', d(7, 9), Number.POSITIVE_INFINITY)).toThrow(/minutes/);
  });
  it('a correction followed by a new stretch adds up', () => {
    trackBlock(s, 'b', 'set', d(7, 9), 20);
    trackBlock(s, 'b', 'start', d(7, 9, 30));
    expect(trackBlock(s, 'b', 'pause', d(7, 9, 45)).block.trackedMinutes).toBe(35);
  });
  it('set on a missed block is still a correction; the status stays missed', () => {
    markBlock(s, 'b', 'missed', d(7, 11));
    const r = trackBlock(s, 'b', 'set', d(7, 11), 15).block;
    expect([r.status, r.trackedMinutes]).toEqual(['missed', 15]);
  });
});

describe('pause at the edges', () => {
  it('pause at the very minute the clock started records zero and stops it', () => {
    trackBlock(s, 'b', 'start', d(7, 9));
    const r = trackBlock(s, 'b', 'pause', d(7, 9)).block;
    expect([r.trackedMinutes, r.runningSince]).toEqual([0, null]);
  });
  it('pause and restart several times sums every stretch; the elapsed minutes mid-stretch include the running one', () => {
    trackBlock(s, 'b', 'start', d(7, 9)); trackBlock(s, 'b', 'pause', d(7, 9, 10));
    trackBlock(s, 'b', 'start', d(7, 9, 20)); trackBlock(s, 'b', 'pause', d(7, 9, 25));
    const r = trackBlock(s, 'b', 'start', d(7, 9, 40));
    expect(r.elapsedMinutes).toBe(15);
    expect(elapsedMinutes(r.block, d(7, 9, 50))).toBe(25);
  });
  it('pause on a done block with no clock is a no-op that reports its minutes', () => {
    trackBlock(s, 'b', 'start', d(7, 9));
    trackBlock(s, 'b', 'finish', d(7, 9, 30));
    const r = trackBlock(s, 'b', 'pause', d(7, 12));
    expect([r.block.status, r.block.trackedMinutes, r.elapsedMinutes]).toEqual(['done', 30, 30]);
  });
});

describe('reset after tracking', () => {
  it('reset after a finish of a block never started: planned end back, nothing tracked', () => {
    trackBlock(s, 'b', 'finish', d(7, 9, 20));
    const r = markBlock(s, 'b', 'pending', d(7, 9, 21));
    expect([span(r), r.plannedMinutes, r.trackedMinutes]).toEqual(['09:00-10:00', undefined, undefined]);
    expect('finishedAt' in r).toBe(false);
  });
  it('after a reset the block can be started afresh, with a new first start', () => {
    trackBlock(s, 'b', 'start', d(7, 9));
    trackBlock(s, 'b', 'finish', d(7, 9, 20));
    markBlock(s, 'b', 'pending', d(7, 9, 21));
    const r = trackBlock(s, 'b', 'start', d(7, 9, 30)).block;
    expect([r.startedAt, r.runningSince, r.trackedMinutes]).toEqual([d(7, 9, 30).toISOString(), d(7, 9, 30).toISOString(), undefined]);
  });
});
