import { describe, it, expect } from 'vitest';
import { summarize } from '../src/stats.js';
import type { Block, Task } from '../src/types.js';

const d = (day: number, h: number) => new Date(2026, 9, day, h);
const task = (id: string): Task => ({ id, name: id, color: '#000', priority: 1, budgetMinutes: 300, budgetPeriod: 'week', archived: false, createdAt: '' });
const block = (taskId: string, day: number, h: number, status: Block['status']): Block => ({
  id: `${taskId}${day}${h}`, taskId, start: d(day, h).toISOString(), end: d(day, h + 1).toISOString(), status, createdAt: '', statusChangedAt: null,
});

describe('summarize', () => {
  it('counts blocks per status and computes a completion rate over decided blocks', () => {
    const blocks = [
      block('a', 5, 9, 'done'), block('a', 6, 9, 'missed'), block('a', 7, 9, 'skipped'), block('a', 8, 9, 'pending'),
      block('a', 1, 9, 'done'), // outside window
      block('b', 5, 9, 'pending'),
    ];
    const r = summarize([task('a'), task('b')], blocks, { start: d(5, 0), end: d(12, 0) });
    expect(r).toEqual([
      { taskId: 'a', name: 'a', budgetMinutes: 300, budgetPeriod: 'week', scheduledMinutes: 240, doneMinutes: 60, trackedMinutes: 0, counts: { pending: 1, done: 1, skipped: 1, missed: 1 }, completionRate: 1 / 3 },
      { taskId: 'b', name: 'b', budgetMinutes: 300, budgetPeriod: 'week', scheduledMinutes: 60, doneMinutes: 0, trackedMinutes: 0, counts: { pending: 1, done: 0, skipped: 0, missed: 0 }, completionRate: null },
    ]);
  });

  it('reports tracked minutes per task, counted by block start inside the window', () => {
    const tracked: Block = { ...block('a', 5, 9, 'done'), trackedMinutes: 50 };
    const outside: Block = { ...block('a', 1, 9, 'done'), trackedMinutes: 30 };
    const r = summarize([task('a'), task('b')], [tracked, outside, block('b', 5, 9, 'pending')], { start: d(5, 0), end: d(12, 0) });
    expect(r.map((s) => [s.taskId, s.trackedMinutes])).toEqual([['a', 50], ['b', 0]]);
  });
});
