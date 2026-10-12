import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { addDays, elapsedMinutes, fmtMinutes, fmtRangeLabel, fmtTime, hourLabel, isSameDay, isoDate, startOfDay, startOfWeek } from '../src/time.js';

// Daylight saving in America/New_York, 2026: forward on Sunday March 8 (02:00 → 03:00), back on Sunday November 1 (02:00 → 01:00).
// Node re-reads TZ when process.env.TZ changes; the original value is restored after this file.
// The web tsconfig has no Node types (it types the browser bundle), so the one Node global used here is declared locally.
declare const process: { env: Record<string, string | undefined> };
const originalTz = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/New_York'; });
afterAll(() => { if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz; });

const H = 3_600_000;

describe('daylight saving (America/New_York)', () => {
  it('the clocks really move: the spring-forward day is 23 hours long, the fall-back day 25', () => {
    expect(new Date(2026, 2, 9).getTime() - new Date(2026, 2, 8).getTime()).toBe(23 * H);
    expect(new Date(2026, 10, 2).getTime() - new Date(2026, 10, 1).getTime()).toBe(25 * H);
  });
  it('addDays keeps the wall-clock time across both changes', () => {
    const spring = addDays(new Date(2026, 2, 7, 12), 1);
    expect([spring.getMonth(), spring.getDate(), spring.getHours(), spring.getMinutes()]).toEqual([2, 8, 12, 0]);
    expect(spring.getTime() - new Date(2026, 2, 7, 12).getTime()).toBe(23 * H);
    const fall = addDays(new Date(2026, 9, 31, 12), 1);
    expect([fall.getMonth(), fall.getDate(), fall.getHours()]).toEqual([10, 1, 12]);
    expect(fall.getTime() - new Date(2026, 9, 31, 12).getTime()).toBe(25 * H);
  });
  it('startOfDay on a change day is local midnight, not 23:00 or 01:00', () => {
    expect(startOfDay(new Date(2026, 2, 8, 15, 30))).toEqual(new Date(2026, 2, 8, 0, 0, 0, 0));
    expect(startOfDay(new Date(2026, 2, 8, 15, 30)).getHours()).toBe(0);
    expect(startOfDay(new Date(2026, 10, 1, 23, 59))).toEqual(new Date(2026, 10, 1));
  });
  it('startOfWeek lands on local midnight of the change Sunday, for week start 0 and 1', () => {
    expect(startOfWeek(new Date(2026, 2, 10, 9))).toEqual(new Date(2026, 2, 8));
    expect(startOfWeek(new Date(2026, 2, 10, 9)).getHours()).toBe(0);
    expect(startOfWeek(new Date(2026, 2, 10, 9), 1)).toEqual(new Date(2026, 2, 9));
    expect(startOfWeek(new Date(2026, 10, 1, 1, 30))).toEqual(new Date(2026, 10, 1));
    expect(startOfWeek(new Date(2026, 10, 1, 1, 30), 1)).toEqual(new Date(2026, 9, 26));
  });
  it('isoDate is the local date even for an instant that is another date in UTC', () => {
    expect(isoDate(new Date('2026-10-08T03:30:00.000Z'))).toBe('2026-10-07'); // 23:30 EDT on the 7th
    expect(isoDate(new Date('2026-03-08T04:59:59.000Z'))).toBe('2026-03-07'); // 23:59:59 EST on the 7th
    expect(isoDate(new Date('2026-03-08T05:00:00.000Z'))).toBe('2026-03-08');
  });
  it('elapsedMinutes counts real minutes across the spring-forward hour', () => {
    expect(elapsedMinutes({ trackedMinutes: 0, runningSince: '2026-03-08T06:00:00.000Z' }, new Date('2026-03-08T08:00:00.000Z'))).toBe(120); // 01:00 EST → 04:00 EDT
  });
  it('isSameDay across the fall-back hour: 01:30 happens twice, both on November 1', () => {
    const first = new Date('2026-11-01T05:30:00.000Z');  // 01:30 EDT
    const second = new Date('2026-11-01T06:30:00.000Z'); // 01:30 EST
    expect(fmtTime(first)).toBe('01:30');
    expect(fmtTime(second)).toBe('01:30');
    expect(isSameDay(first, second)).toBe(true);
  });
  it('fmtTime pads hours and minutes', () => {
    expect(fmtTime(new Date(2026, 9, 7, 9, 5))).toBe('09:05');
    expect(fmtTime(new Date(2026, 9, 7, 0, 0))).toBe('00:00');
  });
});

describe('startOfWeek: week start 0 versus 1 for every weekday', () => {
  // Oct 11 2026 is a Sunday, Oct 12 a Monday, Oct 17 a Saturday.
  it('a Sunday belongs to the week starting that day (0) or the Monday six days before (1)', () => {
    expect(startOfWeek(new Date(2026, 9, 11, 12), 0)).toEqual(new Date(2026, 9, 11));
    expect(startOfWeek(new Date(2026, 9, 11, 12), 1)).toEqual(new Date(2026, 9, 5));
  });
  it('a Monday belongs to the Sunday before (0) or itself (1)', () => {
    expect(startOfWeek(new Date(2026, 9, 12, 12), 0)).toEqual(new Date(2026, 9, 11));
    expect(startOfWeek(new Date(2026, 9, 12, 12), 1)).toEqual(new Date(2026, 9, 12));
  });
  it('a Saturday goes back six days (0) or five (1)', () => {
    expect(startOfWeek(new Date(2026, 9, 17, 12), 0)).toEqual(new Date(2026, 9, 11));
    expect(startOfWeek(new Date(2026, 9, 17, 12), 1)).toEqual(new Date(2026, 9, 12));
  });
  it('every day of the week maps to the same start, for both conventions', () => {
    for (let i = 0; i < 7; i++) {
      expect(startOfWeek(new Date(2026, 9, 11 + i, 7), 0)).toEqual(new Date(2026, 9, 11));
      expect(startOfWeek(new Date(2026, 9, 12 + i, 7), 1)).toEqual(new Date(2026, 9, 12));
    }
  });
  it('a Saturday start (6) and a mid-week start (3) also work', () => {
    expect(startOfWeek(new Date(2026, 9, 16), 6)).toEqual(new Date(2026, 9, 10)); // Friday → previous Saturday
    expect(startOfWeek(new Date(2026, 9, 14), 3)).toEqual(new Date(2026, 9, 14)); // Wednesday → itself
    expect(startOfWeek(new Date(2026, 9, 13), 3)).toEqual(new Date(2026, 9, 7));  // Tuesday → the Wednesday before
  });
  it('crosses a month and a year boundary', () => {
    expect(startOfWeek(new Date(2026, 10, 3), 1)).toEqual(new Date(2026, 10, 2)); // Tue Nov 3 → Mon Nov 2
    expect(startOfWeek(new Date(2026, 10, 1), 1)).toEqual(new Date(2026, 9, 26)); // Sun Nov 1 → Mon Oct 26, across the month end
    expect(startOfWeek(new Date(2027, 0, 2), 0)).toEqual(new Date(2026, 11, 27)); // Sat Jan 2 2027 → Sun Dec 27 2026
  });
});

describe('addDays and isSameDay', () => {
  it('addDays crosses month and year ends and accepts negatives', () => {
    expect(addDays(new Date(2026, 11, 31, 8), 1)).toEqual(new Date(2027, 0, 1, 8));
    expect(addDays(new Date(2026, 0, 1), -1)).toEqual(new Date(2025, 11, 31));
    expect(addDays(new Date(2026, 1, 28), 1)).toEqual(new Date(2026, 2, 1)); // 2026 is not a leap year
    expect(addDays(new Date(2028, 1, 28), 1)).toEqual(new Date(2028, 1, 29)); // 2028 is
  });
  it('addDays(0) returns an equal but distinct Date', () => {
    const d = new Date(2026, 9, 7, 10);
    const r = addDays(d, 0);
    expect(r).toEqual(d);
    expect(r).not.toBe(d);
  });
  it('isSameDay: last millisecond of the day versus the next midnight, and the same date in another month or year', () => {
    expect(isSameDay(new Date(2026, 9, 7, 23, 59, 59, 999), new Date(2026, 9, 7, 0))).toBe(true);
    expect(isSameDay(new Date(2026, 9, 7, 23, 59, 59, 999), new Date(2026, 9, 8, 0))).toBe(false);
    expect(isSameDay(new Date(2026, 9, 7), new Date(2026, 10, 7))).toBe(false);
    expect(isSameDay(new Date(2026, 9, 7), new Date(2025, 9, 7))).toBe(false);
  });
});

describe('formatting edges', () => {
  it('fmtMinutes: 0, a whole day, one minute over an hour', () => {
    expect(fmtMinutes(0)).toBe('0 min');
    expect(fmtMinutes(59)).toBe('59 min');
    expect(fmtMinutes(61)).toBe('1 h 1 min');
    expect(fmtMinutes(120)).toBe('2 h');
    expect(fmtMinutes(1440)).toBe('24 h');
    expect(fmtMinutes(1441)).toBe('24 h 1 min');
  });
  it('hourLabel pads single digits', () => {
    expect(hourLabel(0)).toBe('00:00');
    expect(hourLabel(9)).toBe('09:00');
    expect(hourLabel(23)).toBe('23:00');
  });
  it('fmtRangeLabel across a year end and for two days', () => {
    const days = Array.from({ length: 7 }, (_, i) => new Date(2026, 11, 28 + i));
    expect(fmtRangeLabel(days)).toBe('December 28 – January 3, 2027');
    expect(fmtRangeLabel([new Date(2026, 9, 7), new Date(2026, 9, 8)])).toBe('October 7 – 8, 2026');
  });
  it('elapsedMinutes rounds, clamps a future runningSince to zero and treats missing fields as zero', () => {
    const now = new Date('2026-10-07T10:00:00.000Z');
    expect(elapsedMinutes({ trackedMinutes: 10, runningSince: '2026-10-07T10:05:00.000Z' }, now)).toBe(10);
    expect(elapsedMinutes({ trackedMinutes: 0, runningSince: '2026-10-07T09:30:30.000Z' }, now)).toBe(30); // 29.5 rounds up
    expect(elapsedMinutes({ trackedMinutes: 0, runningSince: '2026-10-07T09:30:31.000Z' }, now)).toBe(29);
    expect(elapsedMinutes({ runningSince: null }, now)).toBe(0);
    expect(elapsedMinutes({ trackedMinutes: 7.4 }, now)).toBe(7);
  });
});
