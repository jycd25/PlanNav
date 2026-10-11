import { describe, it, expect } from 'vitest';
import { elapsedMinutes, fmtMinutes, fmtRangeLabel, isoDate, startOfWeek } from '../src/time.js';

describe('fmtRangeLabel', () => {
  it('formats a week inside one month as "October 5 – 11, 2026"', () => {
    const days = Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 5 + i));
    expect(fmtRangeLabel(days)).toBe('October 5 – 11, 2026');
  });
  it('formats a week across months and a single day', () => {
    const days = Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 26 + i));
    expect(fmtRangeLabel(days)).toBe('October 26 – November 1, 2026');
    expect(fmtRangeLabel([new Date(2026, 9, 7)])).toBe('Wednesday, October 7, 2026');
  });
});

describe('elapsedMinutes', () => {
  const now = new Date('2026-10-07T10:30:00.000Z');
  it('elapsedMinutes adds the running stretch to the tracked minutes', () => {
    expect(elapsedMinutes({ trackedMinutes: 20, runningSince: '2026-10-07T10:20:00.000Z' }, now)).toBe(30);
    expect(elapsedMinutes({ trackedMinutes: 20 }, now)).toBe(20);
    expect(elapsedMinutes({}, now)).toBe(0);
  });
});

describe('fmtMinutes', () => {
  it('fmtMinutes formats hours and minutes', () => {
    expect(fmtMinutes(25)).toBe('25 min');
    expect(fmtMinutes(60)).toBe('1 h');
    expect(fmtMinutes(85)).toBe('1 h 25 min');
  });
});

describe('isoDate', () => {
  it('is the local calendar date as YYYY-MM-DD', () => {
    expect(isoDate(new Date(2026, 9, 5, 23, 59))).toBe('2026-10-05');
    expect(isoDate(new Date(2001, 0, 1))).toBe('2001-01-01');
  });
});

describe('startOfWeek', () => {
  it('starts the week on Sunday by default, as Apple Calendar and Google Calendar do', () => {
    expect(startOfWeek(new Date(2026, 9, 14, 10))).toEqual(new Date(2026, 9, 11));
    expect(startOfWeek(new Date(2026, 9, 14, 10), 1)).toEqual(new Date(2026, 9, 12));
  });
});
