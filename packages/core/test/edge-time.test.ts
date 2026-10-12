import { describe, it, expect } from 'vitest';
import { addDays, addMinutes, atTime, ceilToSlot, clip, floorToSlot, mergeIntervals, minutesBetween, overlaps, startOfDay, startOfWeek, subtractIntervals } from '../src/time.js';

const d = (h: number, m = 0) => new Date(2026, 9, 7, h, m); // Wed 2026-10-07 local
const day = (day: number, h = 0, m = 0) => new Date(2026, 9, day, h, m); // October 2026: 4 Sun, 5 Mon, 10 Sat, 11 Sun

describe('mergeIntervals at the edges', () => {
  it('drops zero-length and backwards intervals', () => {
    expect(mergeIntervals([{ start: d(9), end: d(9) }, { start: d(11), end: d(10) }])).toEqual([]);
  });
  it('touching intervals merge into one', () => {
    expect(mergeIntervals([{ start: d(10), end: d(11) }, { start: d(9), end: d(10) }])).toEqual([{ start: d(9), end: d(11) }]);
  });
  it('an interval inside another vanishes into it', () => {
    expect(mergeIntervals([{ start: d(9), end: d(12) }, { start: d(10), end: d(11) }])).toEqual([{ start: d(9), end: d(12) }]);
  });
  it('returns copies: the input dates are not shared', () => {
    const a = { start: d(9), end: d(10) };
    const [m] = mergeIntervals([a]);
    m.end.setHours(23);
    expect(a.end).toEqual(d(10));
  });
  it('an empty list merges to an empty list', () => {
    expect(mergeIntervals([])).toEqual([]);
  });
});

describe('subtractIntervals at the edges', () => {
  it('busy equal to the base leaves nothing', () => {
    expect(subtractIntervals([{ start: d(9), end: d(18) }], [{ start: d(9), end: d(18) }])).toEqual([]);
  });
  it('busy touching the base at either end leaves the base whole', () => {
    expect(subtractIntervals([{ start: d(9), end: d(18) }], [{ start: d(8), end: d(9) }, { start: d(18), end: d(19) }])).toEqual([{ start: d(9), end: d(18) }]);
  });
  it('a zero-length busy interval removes nothing', () => {
    expect(subtractIntervals([{ start: d(9), end: d(18) }], [{ start: d(12), end: d(12) }])).toEqual([{ start: d(9), end: d(18) }]);
  });
  it('overlapping busy intervals are removed once, as one hole', () => {
    expect(subtractIntervals([{ start: d(9), end: d(18) }], [{ start: d(10), end: d(12) }, { start: d(11), end: d(13) }])).toEqual([
      { start: d(9), end: d(10) }, { start: d(13), end: d(18) },
    ]);
  });
  it('a zero-length base yields nothing, and an empty busy list returns the merged base', () => {
    expect(subtractIntervals([{ start: d(9), end: d(9) }], [])).toEqual([]);
    expect(subtractIntervals([{ start: d(10), end: d(11) }, { start: d(9), end: d(10) }], [])).toEqual([{ start: d(9), end: d(11) }]);
  });
  it('a busy interval that straddles midnight cuts both days', () => {
    const r = subtractIntervals([{ start: d(20), end: day(8, 4) }], [{ start: d(23), end: day(8, 1) }]);
    expect(r).toEqual([{ start: d(20), end: d(23) }, { start: day(8, 1), end: day(8, 4) }]);
  });
});

describe('clip and overlaps at the edges', () => {
  it('clip of touching intervals is null, of identical intervals is the interval', () => {
    expect(clip({ start: d(9), end: d(10) }, { start: d(10), end: d(11) })).toBeNull();
    expect(clip({ start: d(9), end: d(10) }, { start: d(9), end: d(10) })).toEqual({ start: d(9), end: d(10) });
    expect(clip({ start: d(9), end: d(9) }, { start: d(8), end: d(10) })).toBeNull();
  });
  it('touching intervals do not overlap; identical ones do', () => {
    expect(overlaps({ start: d(9), end: d(10) }, { start: d(10), end: d(11) })).toBe(false);
    expect(overlaps({ start: d(9), end: d(10) }, { start: d(9), end: d(10) })).toBe(true);
  });
  it('a zero-length interval strictly inside another counts as overlapping; at the edge it does not', () => {
    expect(overlaps({ start: d(9, 30), end: d(9, 30) }, { start: d(9), end: d(10) })).toBe(true);
    expect(overlaps({ start: d(9), end: d(9) }, { start: d(9), end: d(10) })).toBe(false);
  });
});

describe('slot snapping at midnight', () => {
  it('midnight stays at midnight; 23:59 ceils to the next day; 00:07 floors to midnight', () => {
    expect(ceilToSlot(day(7), 15)).toEqual(day(7));
    expect(floorToSlot(day(7), 15)).toEqual(day(7));
    expect(ceilToSlot(d(23, 59), 15)).toEqual(day(8));
    expect(floorToSlot(day(7, 0, 7), 15)).toEqual(day(7));
  });
  it('seconds count: 09:00:01 ceils to 09:15 and floors to 09:00', () => {
    const t = new Date(2026, 9, 7, 9, 0, 1);
    expect(ceilToSlot(t, 15)).toEqual(d(9, 15));
    expect(floorToSlot(t, 15)).toEqual(d(9));
  });
  it('a slot of one minute snaps to the minute', () => {
    expect(ceilToSlot(new Date(2026, 9, 7, 9, 0, 30), 1)).toEqual(d(9, 1));
  });
});

describe('minutesBetween and addMinutes', () => {
  it('rounds half a minute up and is negative backwards', () => {
    expect(minutesBetween(d(9), new Date(2026, 9, 7, 9, 0, 30))).toBe(1);
    expect(minutesBetween(d(9), new Date(2026, 9, 7, 9, 0, 29))).toBe(0);
    expect(minutesBetween(d(10), d(9))).toBe(-60);
    expect(minutesBetween(d(9), d(9))).toBe(0);
  });
  it('addMinutes across midnight lands on the next date', () => {
    expect(addMinutes(d(23, 50), 20)).toEqual(day(8, 0, 10));
    expect(addMinutes(d(0, 10), -20)).toEqual(day(6, 23, 50));
  });
});

describe('startOfWeek with each week start', () => {
  it('Sunday Oct 11: the week starts that day with weekStartsOn 0, and the Monday before with 1', () => {
    expect(startOfWeek(day(11, 15), 0)).toEqual(day(11));
    expect(startOfWeek(day(11, 15), 1)).toEqual(day(5));
  });
  it('Saturday Oct 10: last day of a Sunday week, sixth day of a Monday week, first day of a Saturday week', () => {
    expect(startOfWeek(day(10, 23, 59), 0)).toEqual(day(4));
    expect(startOfWeek(day(10, 23, 59), 1)).toEqual(day(5));
    expect(startOfWeek(day(10, 23, 59), 6)).toEqual(day(10));
  });
  it('Monday at midnight is already its own Monday week', () => {
    expect(startOfWeek(day(5), 1)).toEqual(day(5));
    expect(startOfWeek(day(5), 0)).toEqual(day(4));
  });
});

describe('atTime and startOfDay at the edges', () => {
  it('"24:00" is the next midnight and "00:00" the day\'s own', () => {
    expect(atTime(d(15), '24:00')).toEqual(day(8));
    expect(atTime(d(15), '00:00')).toEqual(day(7));
  });
  it('atTime ignores the seconds and the time of the given day', () => {
    expect(atTime(new Date(2026, 9, 7, 23, 59, 59), '09:30')).toEqual(d(9, 30));
  });
  it('startOfDay one millisecond before midnight stays on its day', () => {
    expect(startOfDay(new Date(day(8).getTime() - 1))).toEqual(day(7));
  });
});

// The US ends daylight saving on Sun 1 Nov 2026: the day has 25 hours. Only meaningful where the machine observes it.
const dstEnds = new Date(2026, 9, 31, 12).getTimezoneOffset() !== new Date(2026, 10, 2, 12).getTimezoneOffset();
describe.skipIf(!dstEnds)('the day daylight saving ends (local time, 25 hours long)', () => {
  const nov = (day: number, h = 0, m = 0) => new Date(2026, 10, day, h, m);
  it('addDays keeps the wall-clock time: Oct 31 09:00 plus a day is Nov 1 09:00, 25 hours later', () => {
    const next = addDays(new Date(2026, 9, 31, 9), 1);
    expect(next).toEqual(nov(1, 9));
    expect((next.getTime() - new Date(2026, 9, 31, 9).getTime()) / 3_600_000).toBe(25);
  });
  it('startOfDay and startOfWeek land on the wall-clock midnight of Nov 1', () => {
    expect(startOfDay(nov(1, 10))).toEqual(nov(1));
    expect(startOfWeek(nov(4, 12), 0)).toEqual(nov(1));
    expect(minutesBetween(startOfDay(nov(1, 10)), nov(1, 10))).toBe(660); // ten hours on the clock, eleven elapsed
  });
  it('the slot grid stays on the wall clock after the extra hour, for slots that divide an hour', () => {
    expect(ceilToSlot(nov(1, 10, 7), 15)).toEqual(nov(1, 10, 15));
    expect(floorToSlot(nov(1, 10, 7), 30)).toEqual(nov(1, 10));
    expect(atTime(nov(1, 15), '10:00')).toEqual(nov(1, 10));
  });
  it('a stretch over the transition lasts its real length: 01:00 to 03:00 is 180 minutes', () => {
    expect(minutesBetween(nov(1, 1), nov(1, 3))).toBe(180);
  });
});
