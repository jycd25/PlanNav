import { describe, it, expect } from 'vitest';
import { subtractIntervals, mergeIntervals, ceilToSlot, floorToSlot, startOfWeek, atTime } from '../src/time.js';

const d = (h: number, m = 0) => new Date(2026, 9, 7, h, m); // Wed 2026-10-07 local

describe('time helpers', () => {
  it('merges overlapping intervals', () => {
    const r = mergeIntervals([
      { start: d(9), end: d(10) },
      { start: d(9, 30), end: d(11) },
      { start: d(12), end: d(13) },
    ]);
    expect(r).toEqual([{ start: d(9), end: d(11) }, { start: d(12), end: d(13) }]);
  });

  it('subtracts busy intervals from a base interval', () => {
    const r = subtractIntervals([{ start: d(9), end: d(18) }], [
      { start: d(10), end: d(11) },
      { start: d(12), end: d(13) },
    ]);
    expect(r).toEqual([
      { start: d(9), end: d(10) },
      { start: d(11), end: d(12) },
      { start: d(13), end: d(18) },
    ]);
  });

  it('returns nothing when busy covers the base', () => {
    expect(subtractIntervals([{ start: d(9), end: d(18) }], [{ start: d(8), end: d(19) }])).toEqual([]);
  });

  it('snaps to slots', () => {
    expect(ceilToSlot(d(9, 7), 15)).toEqual(d(9, 15));
    expect(ceilToSlot(d(9, 15), 15)).toEqual(d(9, 15));
    expect(floorToSlot(d(9, 59), 30)).toEqual(d(9, 30));
  });

  it('computes week start and times', () => {
    expect(startOfWeek(d(12), 1)).toEqual(new Date(2026, 9, 5));
    expect(atTime(d(15), '09:30')).toEqual(d(9, 30));
  });

  it('the week starts on Sunday by default, as in Apple Calendar and Google Calendar', () => {
    expect(startOfWeek(new Date(2026, 9, 12, 7))).toEqual(new Date(2026, 9, 11)); // Mon Oct 12 -> Sun Oct 11
    expect(startOfWeek(new Date(2026, 9, 11, 23))).toEqual(new Date(2026, 9, 11));
    expect(startOfWeek(new Date(2026, 9, 17, 12))).toEqual(new Date(2026, 9, 11)); // Saturday is the week's last day
    expect(startOfWeek(d(12))).toEqual(new Date(2026, 9, 4)); // Fri Oct 9 12:00 -> Sun Oct 4
  });
});
