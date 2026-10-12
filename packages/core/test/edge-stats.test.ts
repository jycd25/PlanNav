import { describe, it, expect } from 'vitest';
import { summarize } from '../src/stats.js';
import type { Block, Task } from '../src/types.js';

const d = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m);
const task = (id: string): Task => ({ id, name: id, color: '#000', priority: 1, budgetMinutes: 300, budgetPeriod: 'week', archived: false, createdAt: '' });
const block = (id: string, taskId: string, start: Date, end: Date, status: Block['status'], extra: Partial<Block> = {}): Block => ({ id, taskId, start: start.toISOString(), end: end.toISOString(), status, createdAt: '', statusChangedAt: null, ...extra });
const week = { start: d(4, 0), end: d(11, 0) }; // Sun 4 .. Sat 10

describe('summarize at the window edges', () => {
  it('a block straddling the window start counts its minutes inside only, but counts as one block', () => {
    const r = summarize([task('a')], [block('n', 'a', d(3, 23), d(4, 1), 'done')], week);
    expect(r[0]).toMatchObject({ scheduledMinutes: 60, doneMinutes: 60, counts: { pending: 0, done: 1, skipped: 0, missed: 0 }, completionRate: 1 });
  });
  it('a block straddling the window end is clipped too; one ending exactly at the start, or starting at the end, is out', () => {
    const r = summarize([task('a')], [block('e', 'a', d(10, 23), d(11, 1), 'pending'), block('out1', 'a', d(3, 23), d(4, 0), 'done'), block('out2', 'a', d(11, 0), d(11, 1), 'done')], week);
    expect(r[0]).toMatchObject({ scheduledMinutes: 60, doneMinutes: 0, counts: { pending: 1, done: 0, skipped: 0, missed: 0 }, completionRate: null });
  });
  it('tracked minutes follow the block\'s start: a block starting before the window is not counted even if it runs into it', () => {
    const r = summarize([task('a')], [block('n', 'a', d(3, 23), d(4, 1), 'done', { trackedMinutes: 100 }), block('in', 'a', d(10, 23, 59), d(11, 1), 'pending', { trackedMinutes: 7 })], week);
    expect(r[0].trackedMinutes).toBe(7);
  });
  it('a tracked block that starts in the window but lies past the end still adds its minutes, not its schedule', () => {
    // Start inside, end inside: counted. Start inside at 23:59 on the last day: clipped to a minute of schedule, all its tracked minutes.
    const r = summarize([task('a')], [block('x', 'a', d(10, 23, 59), d(11, 2), 'done', { trackedMinutes: 120 })], week);
    expect(r[0]).toMatchObject({ scheduledMinutes: 1, doneMinutes: 1, trackedMinutes: 120 });
  });
  it('all decided blocks missed or skipped gives a completion rate of 0; none decided gives null; no blocks gives zeros', () => {
    const r = summarize([task('a'), task('b'), task('c')], [block('m', 'a', d(5, 9), d(5, 10), 'missed'), block('s', 'a', d(6, 9), d(6, 10), 'skipped'), block('p', 'b', d(5, 9), d(5, 10), 'pending')], week);
    expect(r.map((s) => [s.taskId, s.completionRate, s.scheduledMinutes])).toEqual([['a', 0, 120], ['b', null, 60], ['c', null, 0]]);
    expect(r[2]).toEqual({ taskId: 'c', name: 'c', budgetMinutes: 300, budgetPeriod: 'week', scheduledMinutes: 0, doneMinutes: 0, trackedMinutes: 0, counts: { pending: 0, done: 0, skipped: 0, missed: 0 }, completionRate: null });
  });
  it('an empty window counts nothing', () => {
    const r = summarize([task('a')], [block('b', 'a', d(5, 9), d(5, 10), 'done', { trackedMinutes: 30 })], { start: d(5, 9), end: d(5, 9) });
    expect(r[0]).toMatchObject({ scheduledMinutes: 0, doneMinutes: 0, trackedMinutes: 0, completionRate: null });
  });
  it('blocks of other tasks, and the order of the tasks given, are respected', () => {
    const r = summarize([task('b'), task('a')], [block('x', 'a', d(5, 9), d(5, 10), 'done')], week);
    expect(r.map((s) => [s.taskId, s.doneMinutes])).toEqual([['b', 0], ['a', 60]]);
  });
  it('an early-finished block counts its shortened minutes in the schedule, not the planned ones', () => {
    const r = summarize([task('a')], [block('x', 'a', d(5, 9), d(5, 9, 40), 'done', { plannedMinutes: 60, trackedMinutes: 40 })], week);
    expect(r[0]).toMatchObject({ scheduledMinutes: 40, doneMinutes: 40, trackedMinutes: 40 });
  });
});
