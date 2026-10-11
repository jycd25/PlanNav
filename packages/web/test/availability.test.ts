import { describe, it, expect } from 'vitest';
import { offHoursForDay } from '../src/calendar/availability.js';

const win = (days: number[], start: string, end: string) => ({ days, start, end });

describe('offHoursForDay', () => {
  it('returns the gaps between availability windows as minute ranges', () => {
    const r = offHoursForDay([win([1, 2, 3, 4, 5], '09:00', '18:00'), win([1, 2, 3, 4], '20:00', '22:30')], 1);
    expect(r).toEqual([[0, 540], [1080, 1200], [1350, 1440]]);
  });
  it('covers the whole day when nothing is available', () => {
    expect(offHoursForDay([win([1], '09:00', '18:00')], 0)).toEqual([[0, 1440]]);
    expect(offHoursForDay([], 3)).toEqual([[0, 1440]]);
  });
  it('merges overlapping windows', () => {
    expect(offHoursForDay([win([1], '09:00', '12:00'), win([1], '11:00', '14:00')], 1)).toEqual([[0, 540], [840, 1440]]);
  });
});
