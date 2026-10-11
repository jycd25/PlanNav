import { describe, it, expect } from 'vitest';
import { freeIntervals, workingIntervals } from '../src/free.js';
import { DEFAULT_SETTINGS, STANDARD_WEEK, type Baseline } from '../src/types.js';

const d = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m); // October 2026; 5 = Mon
const WEEK = { ...DEFAULT_SETTINGS, availability: STANDARD_WEEK };

describe('workingIntervals', () => {
  it('clips to working hours and skips weekends', () => {
    const r = workingIntervals({ start: d(9, 7), end: d(12, 23) }, WEEK); // Fri 07:00 -> Mon 23:00
    expect(r).toEqual([
      { start: d(9, 9), end: d(9, 18) },
      { start: d(12, 9), end: d(12, 18) },
    ]);
  });

  it('starts mid-day when the window starts mid-day', () => {
    const r = workingIntervals({ start: d(7, 14, 20), end: d(7, 23) }, WEEK);
    expect(r).toEqual([{ start: d(7, 14, 20), end: d(7, 18) }]);
  });
});

describe('freeIntervals', () => {
  it('removes busy time and snaps edges to the slot', () => {
    const r = freeIntervals(
      { start: d(7, 9, 7), end: d(7, 18) },
      [{ start: d(7, 11), end: d(7, 12, 10) }],
      WEEK,
    );
    expect(r).toEqual([
      { start: d(7, 9, 15), end: d(7, 11) },
      { start: d(7, 12, 15), end: d(7, 18) },
    ]);
  });

  it('drops gaps shorter than minBlockMinutes', () => {
    const r = freeIntervals(
      { start: d(7, 9), end: d(7, 18) },
      [{ start: d(7, 9, 20), end: d(7, 18) }],
      WEEK,
    );
    expect(r).toEqual([]);
  });

  it('returns nothing when a commitment covers the whole day', () => {
    const r = freeIntervals({ start: d(7, 9), end: d(7, 18) }, [{ start: d(7, 8), end: d(7, 19) }], WEEK);
    expect(r).toEqual([]);
  });
});

describe('workingIntervals with a baseline', () => {
  const baseline: Baseline = { version: 1, savedAt: '', slots: [
    { day: 3, start: '08:00', end: '10:00', kind: 'task', taskId: 'a' },
    { day: 3, start: '12:00', end: '13:00', kind: 'busy', title: 'Lunch' },
    { day: 3, start: '16:00', end: '17:00', kind: 'task', taskId: 'b' },
    { day: 4, start: '21:00', end: '24:00', kind: 'task', taskId: 'a' },
  ] };

  it('prefers the baseline\'s usable spans over the settings\' availability when one exists', () => {
    expect(workingIntervals({ start: d(7, 0), end: d(9, 0) }, WEEK, baseline)).toEqual([ // Wed and Thu
      { start: d(7, 8), end: d(7, 12) },
      { start: d(7, 13), end: d(7, 17) },
      { start: d(8, 21), end: d(9, 0) }, // a slot ending at midnight
    ]);
  });

  it('falls back to the settings when there is no baseline, or it has no task slot', () => {
    const settingsOnly = workingIntervals({ start: d(7, 0), end: d(8, 0) }, WEEK);
    expect(workingIntervals({ start: d(7, 0), end: d(8, 0) }, WEEK, undefined)).toEqual(settingsOnly);
    const busyOnly: Baseline = { version: 1, savedAt: '', slots: [{ day: 3, start: '12:00', end: '13:00', kind: 'busy' }] };
    expect(workingIntervals({ start: d(7, 0), end: d(8, 0) }, WEEK, busyOnly)).toEqual(settingsOnly);
  });

  it('freeIntervals passes the baseline through', () => {
    expect(freeIntervals({ start: d(7, 0), end: d(8, 0) }, [{ start: d(7, 9), end: d(7, 10) }], WEEK, baseline)).toEqual([
      { start: d(7, 8), end: d(7, 9) },
      { start: d(7, 10), end: d(7, 12) },
      { start: d(7, 13), end: d(7, 17) },
    ]);
  });
});
