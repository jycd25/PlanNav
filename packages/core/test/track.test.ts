import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/store.js';
import { trackBlock, elapsedMinutes } from '../src/track.js';
import { markBlock, materializeMissed } from '../src/mark.js';
import { usedMinutes } from '../src/budget.js';
import { DEFAULT_SETTINGS, STANDARD_WEEK, type Task, type Block } from '../src/types.js';

const d = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m);
const task = (id: string, budgetMinutes = 60): Task => ({ id, name: id, color: '#000', priority: 1, budgetMinutes, budgetPeriod: 'day', archived: false, createdAt: '' });
const block = (id: string, taskId: string, start: Date, end: Date): Block => ({ id, taskId, start: start.toISOString(), end: end.toISOString(), status: 'pending', createdAt: start.toISOString(), statusChangedAt: null });

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
  store.saveSettings({ ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, slotMinutes: 15 });
  store.upsertTask(task('a')); store.upsertTask(task('b'));
  store.insertBlocks([block('a1', 'a', d(7, 9), d(7, 10)), block('b1', 'b', d(7, 10), d(7, 11))]);
});

describe('trackBlock', () => {
  it('start sets the clock; pause adds the stretch; elapsed counts the running stretch', () => {
    const started = trackBlock(store, 'a1', 'start', d(7, 9, 2));
    expect(started.block.runningSince).toBe(d(7, 9, 2).toISOString());
    expect(elapsedMinutes(started.block, d(7, 9, 12))).toBe(10);
    const paused = trackBlock(store, 'a1', 'pause', d(7, 9, 22));
    expect(paused.block.runningSince).toBeNull();
    expect(paused.block.trackedMinutes).toBe(20);
    expect(paused.block.status).toBe('pending');
  });
  it('starting one block pauses any other running block and keeps its minutes', () => {
    trackBlock(store, 'a1', 'start', d(7, 9));
    const r = trackBlock(store, 'b1', 'start', d(7, 9, 45));
    expect(r.paused.map((b) => [b.id, b.trackedMinutes, b.runningSince])).toEqual([['a1', 45, null]]);
    expect(store.getBlock('b1')!.runningSince).toBe(d(7, 9, 45).toISOString());
  });
  it('finish early marks done, shortens the block to now (at least one slot) and keeps the planned length', () => {
    trackBlock(store, 'a1', 'start', d(7, 9));
    const r = trackBlock(store, 'a1', 'finish', d(7, 9, 40));
    expect(r.block.status).toBe('done');
    expect(r.block.end).toBe(d(7, 9, 40).toISOString());
    expect(r.block.plannedMinutes).toBe(60);
    expect(r.block.trackedMinutes).toBe(40);
    expect(r.block.runningSince).toBeNull();
    const tiny = trackBlock(store, 'b1', 'finish', d(7, 10, 1)); // never started: no clock, end stays one slot after start
    expect(tiny.block.end).toBe(d(7, 10, 15).toISOString());
    expect(tiny.block.trackedMinutes).toBeUndefined();
  });
  it('finish after the end keeps the times and records the minutes; pause then finish sums the stretches', () => {
    trackBlock(store, 'a1', 'start', d(7, 9));
    trackBlock(store, 'a1', 'pause', d(7, 9, 20));
    trackBlock(store, 'a1', 'start', d(7, 9, 40));
    const r = trackBlock(store, 'a1', 'finish', d(7, 10, 10));
    expect(r.block.end).toBe(d(7, 10).toISOString());
    expect(r.block.trackedMinutes).toBe(50);
    expect(r.block.plannedMinutes).toBeUndefined();
  });
  it('set replaces the tracked minutes without changing status; it rejects negatives and more than a day', () => {
    trackBlock(store, 'a1', 'start', d(7, 9)); trackBlock(store, 'a1', 'pause', d(7, 9, 20));
    expect(trackBlock(store, 'a1', 'set', d(7, 12), 45).block.trackedMinutes).toBe(45);
    expect(store.getBlock('a1')!.status).toBe('pending');
    expect(trackBlock(store, 'a1', 'set', d(7, 12), 0).block.trackedMinutes).toBe(0);
    expect(() => trackBlock(store, 'a1', 'set', d(7, 12), -1)).toThrow(/minutes/i);
    expect(() => trackBlock(store, 'a1', 'set', d(7, 12), 24 * 60 + 1)).toThrow(/minutes/i);
    expect(() => trackBlock(store, 'a1', 'set', d(7, 12))).toThrow(/minutes/i);
  });
  it('a running block that passed its end is finished at its end by materializeMissed once its day is over, not marked missed', () => {
    trackBlock(store, 'a1', 'start', d(7, 9, 5));
    const out = materializeMissed(store, d(8, 9));
    const a1 = store.getBlock('a1')!;
    expect(a1.status).toBe('done');
    expect(a1.trackedMinutes).toBe(55);
    expect(a1.runningSince).toBeNull();
    expect(a1.end).toBe(d(7, 10).toISOString());
    expect(out.find((b) => b.id === 'b1')?.status).toBe('missed'); // the never-started one is missed as before
  });
  it('a running clock is left alone while its block\'s day is still today, so the overrun is kept', () => {
    store.insertBlocks([block('e1', 'a', d(7, 20), d(7, 21))]);
    trackBlock(store, 'e1', 'start', d(7, 20));
    const out = materializeMissed(store, d(7, 21, 10));
    const e1 = store.getBlock('e1')!;
    expect(e1.status).toBe('pending');
    expect(e1.runningSince).toBe(d(7, 20).toISOString());
    expect(out.find((b) => b.id === 'e1')).toBeUndefined();
    expect(elapsedMinutes(e1, d(7, 21, 10))).toBe(70);
    // the next morning the day is over: stopped at the block end, minutes counted to 21:00
    materializeMissed(store, d(8, 9));
    const next = store.getBlock('e1')!;
    expect(next.status).toBe('done');
    expect(next.trackedMinutes).toBe(60);
    expect(next.runningSince).toBeNull();
    expect(next.end).toBe(d(7, 21).toISOString());
  });
  it('a past pending block with tracked minutes and no clock is finished the same day; a never-tracked one is missed', () => {
    trackBlock(store, 'a1', 'set', d(7, 9), 30);
    const out = materializeMissed(store, d(7, 12));
    expect(store.getBlock('a1')!.status).toBe('done');
    expect(store.getBlock('a1')!.trackedMinutes).toBe(30);
    expect(out.find((b) => b.id === 'b1')?.status).toBe('missed');
  });
  it('a done block shortened by an early finish still counts its planned minutes toward the budget', () => {
    trackBlock(store, 'a1', 'start', d(7, 9));
    trackBlock(store, 'a1', 'finish', d(7, 9, 30));
    expect(usedMinutes(store.getTask('a')!, store.listBlocks(), { start: d(7, 0), end: d(8, 0) })).toBe(60);
  });
  it('a pause after the end records the real stretch; materializeMissed then finishes it instead of marking it missed', () => {
    trackBlock(store, 'a1', 'start', d(7, 9, 5));
    const p = trackBlock(store, 'a1', 'pause', d(7, 12));
    expect(p.block.trackedMinutes).toBe(175);
    expect(p.block.status).toBe('pending');
    const out = materializeMissed(store, d(7, 12, 30));
    const a1 = store.getBlock('a1')!;
    expect(a1.status).toBe('done');
    expect(a1.end).toBe(d(7, 10).toISOString());
    expect(a1.trackedMinutes).toBe(175);
    expect(out.find((b) => b.id === 'b1')?.status).toBe('missed');
  });
  it('starting another block after the end pauses the overrun block with its real minutes; it is then finished, not missed', () => {
    trackBlock(store, 'a1', 'start', d(7, 9, 5));
    const r = trackBlock(store, 'b1', 'start', d(7, 12));
    expect(r.paused.map((b) => [b.id, b.trackedMinutes])).toEqual([['a1', 175]]);
    materializeMissed(store, d(7, 12, 30));
    const a1 = store.getBlock('a1')!;
    expect(a1.status).toBe('done');
    expect(a1.trackedMinutes).toBe(175);
    expect(a1.end).toBe(d(7, 10).toISOString());
  });
  it('only a pending block can be started; set on a done block is still a correction', () => {
    trackBlock(store, 'a1', 'finish', d(7, 9, 30));
    expect(() => trackBlock(store, 'a1', 'start', d(7, 9, 31))).toThrow(/pending/i);
    expect(trackBlock(store, 'a1', 'set', d(7, 12), 25).block.trackedMinutes).toBe(25);
    store.updateBlock('b1', { status: 'skipped' });
    expect(() => trackBlock(store, 'b1', 'start', d(7, 10))).toThrow(/pending/i);
    store.updateBlock('b1', { status: 'missed' });
    expect(() => trackBlock(store, 'b1', 'start', d(7, 10))).toThrow(/pending/i);
  });
  it('finish at a time before the block start ends it one slot after its start', () => {
    const r = trackBlock(store, 'b1', 'finish', d(7, 9, 50));
    expect(r.block.end).toBe(d(7, 10, 15).toISOString());
    expect(r.block.status).toBe('done');
  });
  it('finish on a block of another day that was never started is refused, whichever side of today it sits', () => {
    store.insertBlocks([block('t1', 'a', d(8, 9), d(8, 10)), block('y1', 'a', d(6, 9), d(6, 10))]);
    expect(() => trackBlock(store, 't1', 'finish', d(7, 9))).toThrow('That block is not today and was never started; start it or mark it done.');
    expect(() => trackBlock(store, 'y1', 'finish', d(7, 9))).toThrow(/not today/);
    expect(store.getBlock('t1')!.runningSince ?? null).toBeNull();
    expect(store.getBlock('t1')!.status).toBe('pending');
  });
  it('starting a block of another day runs its clock where it is (planned time untouched) and records the actual start; finish then records the actual end', () => {
    store.insertBlocks([block('t1', 'a', d(8, 9), d(8, 10, 30)), block('y1', 'a', d(6, 9), d(6, 10))]);
    const r = trackBlock(store, 't1', 'start', d(7, 9, 7));
    expect(r.block.start).toBe(d(8, 9).toISOString());
    expect(r.block.end).toBe(d(8, 10, 30).toISOString());
    expect(r.block.source ?? 'planner').toBe('planner');
    expect(r.block.runningSince).toBe(d(7, 9, 7).toISOString());
    expect(r.block.startedAt).toBe(d(7, 9, 7).toISOString());
    const y = trackBlock(store, 'y1', 'start', d(7, 14)); // yesterday's block, started today: pauses t1
    expect(y.block.start).toBe(d(6, 9).toISOString());
    expect(y.paused.map((b) => b.id)).toEqual(['t1']);
    expect(store.getBlock('t1')!.runningSince ?? null).toBeNull();
    const fin = trackBlock(store, 'y1', 'finish', d(7, 14, 50)).block; // started, so finish is allowed; its times stay (no shortening off its day)
    expect(fin.status).toBe('done');
    expect(fin.start).toBe(d(6, 9).toISOString()); expect(fin.end).toBe(d(6, 10).toISOString());
    expect(fin.finishedAt).toBe(d(7, 14, 50).toISOString());
    expect(fin.trackedMinutes).toBe(50);
  });
  it('startedAt is the first start and survives pause and restart; finish records finishedAt', () => {
    trackBlock(store, 'a1', 'start', d(7, 9, 3));
    trackBlock(store, 'a1', 'pause', d(7, 9, 20));
    expect(trackBlock(store, 'a1', 'start', d(7, 9, 30)).block.startedAt).toBe(d(7, 9, 3).toISOString());
    const fin = trackBlock(store, 'a1', 'finish', d(7, 9, 58)).block;
    expect(fin.startedAt).toBe(d(7, 9, 3).toISOString());
    expect(fin.finishedAt).toBe(d(7, 9, 58).toISOString());
    expect(fin.trackedMinutes).toBe(45);
  });
  it('materializeMissed still finishes a worked block that ends at midnight (its end is the next calendar day)', () => {
    store.insertBlocks([block('n1', 'a', d(7, 23), d(8, 0))]);
    trackBlock(store, 'n1', 'set', d(7, 23, 30), 40);
    const out = materializeMissed(store, d(8, 9));
    expect(out.find((b) => b.id === 'n1')!.status).toBe('done');
    expect(store.getBlock('n1')!.trackedMinutes).toBe(40);
  });
  it('a block later today may be started early (the user begins the next thing now)', () => {
    store.insertBlocks([block('m1', 'a', d(7, 8), d(7, 9))]);
    expect(trackBlock(store, 'm1', 'start', d(7, 7, 30)).block.runningSince).toBe(d(7, 7, 30).toISOString());
    expect(trackBlock(store, 'b1', 'start', d(7, 9, 44)).block.runningSince).toBe(d(7, 9, 44).toISOString()); // 16 minutes ahead
  });
  it('a block later today may be finished early; pause and set are never refused, even on another day', () => {
    expect(trackBlock(store, 'b1', 'finish', d(7, 9, 45)).block.status).toBe('done');
    store.insertBlocks([block('t1', 'a', d(8, 9), d(8, 10))]);
    expect(trackBlock(store, 't1', 'set', d(7, 9), 20).block.trackedMinutes).toBe(20);
    expect(trackBlock(store, 't1', 'pause', d(7, 9)).block.trackedMinutes).toBe(20);
  });
  it('pause on a block that is not running is a no-op', () => {
    trackBlock(store, 'a1', 'set', d(7, 9), 20);
    const r = trackBlock(store, 'a1', 'pause', d(7, 9, 30));
    expect(r.block.trackedMinutes).toBe(20);
    expect(r.block.runningSince ?? null).toBeNull();
    expect(r.block.status).toBe('pending');
  });
});

describe('markBlock on a block with a running clock', () => {
  it('done stops the clock, records the minutes and keeps the planned end', () => {
    trackBlock(store, 'a1', 'start', d(7, 9));
    const b = markBlock(store, 'a1', 'done', d(7, 9, 40));
    expect(b.status).toBe('done');
    expect(b.runningSince).toBeNull();
    expect(b.trackedMinutes).toBe(40);
    expect(b.end).toBe(d(7, 10).toISOString());
    expect(b.statusChangedAt).toBe(d(7, 9, 40).toISOString());
  });
  it('skipped pauses the clock and keeps the minutes', () => {
    trackBlock(store, 'a1', 'start', d(7, 9));
    const b = markBlock(store, 'a1', 'skipped', d(7, 9, 20));
    expect(b.status).toBe('skipped');
    expect(b.runningSince).toBeNull();
    expect(b.trackedMinutes).toBe(20);
  });
  it('pending (Reset) stops the clock and undoes the start: no minutes, no start time', () => {
    trackBlock(store, 'a1', 'start', d(7, 9));
    const b = markBlock(store, 'a1', 'pending', d(7, 9, 10));
    expect(b.runningSince).toBeNull();
    expect(b.trackedMinutes).toBeUndefined();
    expect(b.startedAt ?? null).toBeNull();
  });
  it('reset (pending) undoes the clock: planned end restored, plannedMinutes, tracked minutes, start and finish times cleared', () => {
    trackBlock(store, 'a1', 'start', d(7, 9));
    const fin = trackBlock(store, 'a1', 'finish', d(7, 9, 40)).block;
    expect(fin.end).toBe(d(7, 9, 40).toISOString());
    expect(fin.plannedMinutes).toBe(60);
    const b = markBlock(store, 'a1', 'pending', d(7, 9, 50));
    expect(b.status).toBe('pending');
    expect(b.end).toBe(d(7, 10).toISOString());
    expect(b.plannedMinutes).toBeUndefined();
    expect(b.trackedMinutes).toBeUndefined();
    expect(b.startedAt ?? null).toBeNull(); expect(b.finishedAt ?? null).toBeNull(); expect(b.runningSince ?? null).toBeNull();
    // Reset on a block whose clock is running undoes the start too
    trackBlock(store, 'b1', 'start', d(7, 10, 2));
    const undone = markBlock(store, 'b1', 'pending', d(7, 10, 9));
    expect(undone.runningSince ?? null).toBeNull(); expect(undone.startedAt ?? null).toBeNull(); expect(undone.trackedMinutes).toBeUndefined();
    expect(store.getBlock('a1')!.end).toBe(d(7, 10).toISOString());
  });
  it('marking done or skipped leaves a shortened block as it is', () => {
    trackBlock(store, 'a1', 'finish', d(7, 9, 40));
    expect(markBlock(store, 'a1', 'skipped', d(7, 9, 50)).end).toBe(d(7, 9, 40).toISOString());
    expect(store.getBlock('a1')!.plannedMinutes).toBe(60);
  });
  it('a block with no clock is marked as before', () => {
    const b = markBlock(store, 'a1', 'done', d(7, 9, 40));
    expect(b.status).toBe('done');
    expect(b.trackedMinutes).toBeUndefined();
  });
});
