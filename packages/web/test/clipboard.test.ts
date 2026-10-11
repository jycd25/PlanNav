import { describe, it, expect } from 'vitest';
import { clipFromBlock, pasteRange } from '../src/calendar/clipboard.js';

const at = (h: number, m = 0) => new Date(2026, 9, 7, h, m);

describe('block clipboard', () => {
  it('copies the task and the length of a block, not its time or status', () => {
    const clip = clipFromBlock({ taskId: 't1', taskName: 'Leetcode', start: at(9).toISOString(), end: at(10, 30).toISOString() });
    expect(clip).toEqual({ taskId: 't1', taskName: 'Leetcode', minutes: 90 });
  });
  it('pastes at the clicked time on the slot grid, keeping the length; a paste that would run past midnight is pulled back to end at midnight', () => {
    const clip = { taskId: 't1', taskName: 'Leetcode', minutes: 90 };
    expect(pasteRange(clip, at(0), 14 * 60 + 7, 15)).toEqual({ start: at(14), end: at(15, 30) });
    expect(pasteRange(clip, at(0), 23 * 60 + 20, 15)).toEqual({ start: at(22, 30), end: new Date(2026, 9, 8) });
  });
});
