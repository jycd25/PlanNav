import { describe, it, expect } from 'vitest';
import { offHoursForDay } from '../src/calendar/availability.js';

const win = (days: number[], start: string, end: string) => ({ days, start, end });

describe('offHoursForDay: empty and whole-day windows', () => {
  it('no windows at all shades the whole day on every weekday', () => {
    for (let d = 0; d < 7; d++) expect(offHoursForDay([], d)).toEqual([[0, 1440]]);
  });
  it('a window with an empty day list applies to no weekday', () => {
    expect(offHoursForDay([win([], '09:00', '18:00')], 1)).toEqual([[0, 1440]]);
  });
  it('a window from 00:00 to 24:00 shades nothing', () => {
    expect(offHoursForDay([win([2], '00:00', '24:00')], 2)).toEqual([]);
  });
  it('a window ending at 24:00 leaves no trailing off-hours', () => {
    expect(offHoursForDay([win([5], '18:00', '24:00')], 5)).toEqual([[0, 1080]]);
  });
  it('a window starting at 00:00 leaves no leading off-hours', () => {
    expect(offHoursForDay([win([0], '00:00', '09:00')], 0)).toEqual([[540, 1440]]);
  });
  it('a window ending at 23:59 leaves a one-minute strip', () => {
    expect(offHoursForDay([win([0], '09:00', '23:59')], 0)).toEqual([[0, 540], [1439, 1440]]);
  });
});

describe('offHoursForDay: merging and ordering', () => {
  it('adjacent windows (end equals next start) merge into one', () => {
    expect(offHoursForDay([win([1], '09:00', '12:00'), win([1], '12:00', '14:00')], 1)).toEqual([[0, 540], [840, 1440]]);
  });
  it('a window contained in another adds nothing', () => {
    expect(offHoursForDay([win([1], '09:00', '18:00'), win([1], '10:00', '11:00')], 1)).toEqual([[0, 540], [1080, 1440]]);
  });
  it('unsorted windows are sorted before the gaps are computed', () => {
    expect(offHoursForDay([win([3], '14:00', '16:00'), win([3], '09:00', '12:00')], 3)).toEqual([[0, 540], [720, 840], [960, 1440]]);
  });
  it('windows on other weekdays are ignored, those listing this weekday among many count', () => {
    const windows = [win([0, 6], '10:00', '14:00'), win([1, 2, 3, 4, 5], '09:00', '18:00')];
    expect(offHoursForDay(windows, 6)).toEqual([[0, 600], [840, 1440]]);
    expect(offHoursForDay(windows, 3)).toEqual([[0, 540], [1080, 1440]]);
  });
  it('minute precision is kept', () => {
    expect(offHoursForDay([win([1], '09:30', '17:45')], 1)).toEqual([[0, 570], [1065, 1440]]);
  });
  it('a zero-length window splits the day at its minute without covering anything', () => {
    expect(offHoursForDay([win([1], '09:00', '09:00')], 1)).toEqual([[0, 540], [540, 1440]]);
  });
  it('three windows with a 24:00 end: two gaps, none trailing', () => {
    expect(offHoursForDay([win([4], '06:00', '08:00'), win([4], '09:00', '17:00'), win([4], '20:00', '24:00')], 4)).toEqual([[0, 360], [480, 540], [1020, 1200]]);
  });
  it('does not mutate the windows it is given', () => {
    const windows = [win([1], '11:00', '14:00'), win([1], '09:00', '12:00')];
    const copy = JSON.parse(JSON.stringify(windows));
    offHoursForDay(windows, 1);
    expect(windows).toEqual(copy);
  });
});
