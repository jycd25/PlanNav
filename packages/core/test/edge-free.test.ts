import { describe, it, expect } from 'vitest';
import { effectiveAvailability, expandRecurring, freeIntervals, settingsWithBaseline, workingIntervals } from '../src/free.js';
import { DEFAULT_SETTINGS, STANDARD_WEEK, type Baseline, type Settings } from '../src/types.js';

const d = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m); // October 2026: 4 Sun, 5 Mon, 7 Wed, 10 Sat, 11 Sun
const WEEK: Settings = { ...DEFAULT_SETTINGS, availability: STANDARD_WEEK };
const withWindows = (availability: Settings['availability'], extra: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...extra, availability });

describe('workingIntervals at the edges', () => {
  it('an empty window, or a window ending exactly where the day\'s availability starts, has no working time', () => {
    expect(workingIntervals({ start: d(7, 10), end: d(7, 10) }, WEEK)).toEqual([]);
    expect(workingIntervals({ start: d(7, 0), end: d(7, 9) }, WEEK)).toEqual([]);
    expect(workingIntervals({ start: d(7, 18), end: d(8, 0) }, WEEK)).toEqual([]);
  });
  it('a window ending at midnight does not reach into the next day', () => {
    expect(workingIntervals({ start: d(7, 17), end: d(8, 0) }, WEEK)).toEqual([{ start: d(7, 17), end: d(7, 18) }]);
  });
  it('no availability means no working time at all', () => {
    expect(workingIntervals({ start: d(5, 0), end: d(12, 0) }, withWindows([]))).toEqual([]);
  });
  it('weekend windows: Sunday is day 0 and Saturday day 6', () => {
    const s = withWindows([{ days: [0, 6], start: '10:00', end: '12:00' }]);
    expect(workingIntervals({ start: d(9, 0), end: d(12, 0) }, s)).toEqual([{ start: d(10, 10), end: d(10, 12) }, { start: d(11, 10), end: d(11, 12) }]);
  });
  it('two windows on the same day that overlap or touch merge into one; a gap stays a gap', () => {
    const s = withWindows([{ days: [3], start: '09:00', end: '12:00' }, { days: [3], start: '11:00', end: '14:00' }, { days: [3], start: '14:00', end: '15:00' }, { days: [3], start: '16:00', end: '17:00' }]);
    expect(workingIntervals({ start: d(7, 0), end: d(8, 0) }, s)).toEqual([{ start: d(7, 9), end: d(7, 15) }, { start: d(7, 16), end: d(7, 17) }]);
  });
  it('a window to 23:59 ends a minute before midnight', () => {
    const s = withWindows([{ days: [3], start: '00:00', end: '23:59' }]);
    expect(workingIntervals({ start: d(7, 0), end: d(8, 0) }, s)).toEqual([{ start: d(7, 0), end: d(7, 23, 59) }]);
  });
  it('a baseline slot ending at 24:00 runs to the next midnight and is clipped by the window', () => {
    const b: Baseline = { version: 1, savedAt: '', slots: [{ day: 3, start: '20:00', end: '24:00', kind: 'task', taskId: 'a' }] };
    expect(workingIntervals({ start: d(7, 0), end: d(8, 0) }, WEEK, b)).toEqual([{ start: d(7, 20), end: d(8, 0) }]);
    expect(workingIntervals({ start: d(7, 0), end: d(7, 22) }, WEEK, b)).toEqual([{ start: d(7, 20), end: d(7, 22) }]);
  });
  it('a baseline with task slots on other weekdays only leaves this day empty, even when the settings would have given it hours', () => {
    const b: Baseline = { version: 1, savedAt: '', slots: [{ day: 1, start: '09:00', end: '10:00', kind: 'task', taskId: 'a' }] };
    expect(workingIntervals({ start: d(7, 0), end: d(8, 0) }, WEEK, b)).toEqual([]);
  });
  it('a baseline whose busy slot covers its task slot gives no working time that day', () => {
    const b: Baseline = { version: 1, savedAt: '', slots: [{ day: 3, start: '09:00', end: '10:00', kind: 'task', taskId: 'a' }, { day: 3, start: '08:00', end: '11:00', kind: 'busy', title: 'Off' }] };
    expect(workingIntervals({ start: d(7, 0), end: d(8, 0) }, WEEK, b)).toEqual([]);
  });
});

describe('effectiveAvailability and settingsWithBaseline', () => {
  it('a busy-only baseline leaves the settings alone; one with a task slot replaces the windows and nothing else', () => {
    const busyOnly: Baseline = { version: 1, savedAt: '', slots: [{ day: 3, start: '12:00', end: '13:00', kind: 'busy' }] };
    expect(effectiveAvailability(WEEK, busyOnly)).toEqual(STANDARD_WEEK);
    expect(effectiveAvailability(WEEK, undefined)).toEqual(STANDARD_WEEK);
    const b: Baseline = { version: 1, savedAt: '', slots: [{ day: 3, start: '07:00', end: '08:00', kind: 'task', taskId: 'a' }] };
    const s = settingsWithBaseline({ ...WEEK, slotMinutes: 5, memory: 'note' }, b);
    expect(s.availability).toEqual([{ days: [3], start: '07:00', end: '08:00' }]);
    expect(s.slotMinutes).toBe(5);
    expect(s.memory).toBe('note');
  });
  it('an empty baseline (no slots) is no baseline', () => {
    expect(effectiveAvailability(WEEK, { version: 1, savedAt: '', slots: [] })).toEqual(STANDARD_WEEK);
  });
});

describe('expandRecurring at the edges', () => {
  const standup = { id: 's', title: 'Standup', days: [1, 2, 3, 4, 5], start: '09:00', end: '09:30' };
  it('an occurrence cut by the window start keeps only the part inside; one ending at the window start is left out', () => {
    expect(expandRecurring([standup], { start: d(7, 9, 10), end: d(7, 12) })).toEqual([{ start: d(7, 9, 10), end: d(7, 9, 30), title: 'Standup', recurringId: 's' }]);
    expect(expandRecurring([standup], { start: d(7, 9, 30), end: d(7, 12) })).toEqual([]);
  });
  it('a week gives one occurrence per listed day, sorted by start across commitments', () => {
    const gym = { id: 'g', title: 'Gym', days: [3], start: '07:00', end: '08:00' };
    const r = expandRecurring([standup, gym], { start: d(5, 0), end: d(12, 0) });
    expect(r.length).toBe(6);
    expect(r.slice(0, 4).map((o) => [o.title, o.start])).toEqual([['Standup', d(5, 9)], ['Standup', d(6, 9)], ['Gym', d(7, 7)], ['Standup', d(7, 9)]]);
  });
  it('no days, or an empty window, gives nothing', () => {
    expect(expandRecurring([{ ...standup, days: [] }], { start: d(5, 0), end: d(12, 0) })).toEqual([]);
    expect(expandRecurring([standup], { start: d(7, 9), end: d(7, 9) })).toEqual([]);
  });
  it('an occurrence to 23:59 on the last day of the window is whole', () => {
    const late = { id: 'l', title: 'Late', days: [3], start: '23:00', end: '23:59' };
    expect(expandRecurring([late], { start: d(7, 0), end: d(8, 0) })).toEqual([{ start: d(7, 23), end: d(7, 23, 59), title: 'Late', recurringId: 'l' }]);
  });
});

describe('freeIntervals at the edges', () => {
  it('busy time outside the working hours changes nothing', () => {
    expect(freeIntervals({ start: d(7, 0), end: d(8, 0) }, [{ start: d(7, 6), end: d(7, 9) }, { start: d(7, 18), end: d(7, 23) }], WEEK)).toEqual([{ start: d(7, 9), end: d(7, 18) }]);
  });
  it('a gap exactly as long as the minimum block is kept; one minute shorter is dropped', () => {
    const s = { ...WEEK, minBlockMinutes: 30, slotMinutes: 1 };
    expect(freeIntervals({ start: d(7, 9), end: d(7, 10) }, [{ start: d(7, 9, 30), end: d(7, 18) }], s)).toEqual([{ start: d(7, 9), end: d(7, 9, 30) }]);
    expect(freeIntervals({ start: d(7, 9), end: d(7, 10) }, [{ start: d(7, 9, 29), end: d(7, 18) }], s)).toEqual([]);
  });
  it('snapping to the grid can shrink a gap below the minimum and drop it', () => {
    // 09:01-09:44 is 43 minutes, but on the 15-minute grid it is 09:15-09:30: 15 minutes, under a 30-minute minimum.
    expect(freeIntervals({ start: d(7, 9, 1), end: d(7, 9, 44) }, [], WEEK)).toEqual([]);
    expect(freeIntervals({ start: d(7, 9, 1), end: d(7, 9, 44) }, [], { ...WEEK, slotMinutes: 1 })).toEqual([{ start: d(7, 9, 1), end: d(7, 9, 44) }]);
  });
  it('adjacent busy intervals leave no sliver between them', () => {
    expect(freeIntervals({ start: d(7, 9), end: d(7, 18) }, [{ start: d(7, 9), end: d(7, 12) }, { start: d(7, 12), end: d(7, 17) }], WEEK)).toEqual([{ start: d(7, 17), end: d(7, 18) }]);
  });
  it('a busy interval spanning midnight removes the end of one day and the start of the next', () => {
    const s = withWindows([{ days: [3, 4], start: '00:00', end: '23:59' }], { slotMinutes: 1, minBlockMinutes: 1 });
    expect(freeIntervals({ start: d(7, 22), end: d(8, 2) }, [{ start: d(7, 23), end: d(8, 1) }], s)).toEqual([{ start: d(7, 22), end: d(7, 23) }, { start: d(8, 1), end: d(8, 2) }]);
  });
  it('no availability, or a baseline with no task slot on the day, gives no free time however empty the day', () => {
    expect(freeIntervals({ start: d(7, 0), end: d(8, 0) }, [], withWindows([]))).toEqual([]);
    const b: Baseline = { version: 1, savedAt: '', slots: [{ day: 1, start: '09:00', end: '10:00', kind: 'task', taskId: 'a' }] };
    expect(freeIntervals({ start: d(7, 0), end: d(8, 0) }, [], WEEK, b)).toEqual([]);
  });
});
