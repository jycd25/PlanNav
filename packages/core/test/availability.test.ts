import { describe, it, expect } from 'vitest';
import { expandRecurring, workingIntervals } from '../src/free.js';
import { DEFAULT_SETTINGS, STANDARD_WEEK, normalizeSettings, type RecurringCommitment, type Settings } from '../src/types.js';

const d = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m); // Oct 2026: 4 Sun, 5 Mon .. 10 Sat, 11 Sun
const settings: Settings = {
  ...DEFAULT_SETTINGS,
  availability: [
    { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
    { days: [1, 2, 3, 4], start: '20:00', end: '22:30' },
    { days: [6], start: '10:00', end: '13:00' },
  ],
};

describe('workingIntervals from availability', () => {
  it('yields every window of each day, in order, clipped to the range', () => {
    const r = workingIntervals({ start: d(5, 12), end: d(6, 21) }, settings); // Mon noon -> Tue 21:00
    expect(r).toEqual([
      { start: d(5, 12), end: d(5, 18) },
      { start: d(5, 20), end: d(5, 22, 30) },
      { start: d(6, 9), end: d(6, 18) },
      { start: d(6, 20), end: d(6, 21) },
    ]);
  });
  it('includes weekend windows and skips days with none', () => {
    const r = workingIntervals({ start: d(9, 19), end: d(12, 0) }, settings); // Fri evening -> Mon 00:00
    expect(r).toEqual([{ start: d(10, 10), end: d(10, 13) }]);
  });
  it('merges overlapping windows on the same day', () => {
    const s = { ...settings, availability: [{ days: [1], start: '09:00', end: '12:00' }, { days: [1], start: '11:00', end: '14:00' }] };
    expect(workingIntervals({ start: d(5, 0), end: d(6, 0) }, s)).toEqual([{ start: d(5, 9), end: d(5, 14) }]);
  });
  it('returns nothing when there is no availability', () => {
    expect(workingIntervals({ start: d(5, 0), end: d(12, 0) }, { ...settings, availability: [] })).toEqual([]);
  });
});

describe('expandRecurring', () => {
  const recurring: RecurringCommitment[] = [
    { id: 'standup', title: 'Standup', days: [1, 2, 3, 4, 5], start: '10:00', end: '10:30' },
    { id: 'gym', title: 'Gym', days: [0, 2], start: '18:00', end: '19:00' },
  ];
  it('expands each rule onto matching days inside the range, clipped', () => {
    const r = expandRecurring(recurring, { start: d(5, 10, 15), end: d(6, 18, 30) });
    expect(r.map((x) => [x.title, x.start, x.end])).toEqual([
      ['Standup', d(5, 10, 15), d(5, 10, 30)],
      ['Standup', d(6, 10), d(6, 10, 30)],
      ['Gym', d(6, 18), d(6, 18, 30)],
    ]);
    expect(r[0].recurringId).toBe('standup');
  });
  it('is harmless on days with no availability', () => {
    const r = expandRecurring(recurring, { start: d(4, 0), end: d(5, 0) }); // Sunday
    expect(r.map((x) => x.title)).toEqual(['Gym']);
  });
});

describe('normalizeSettings', () => {
  it('the default week starts on Sunday (0), as in Apple Calendar and Google Calendar; a stored choice is kept', () => {
    expect(DEFAULT_SETTINGS.weekStartsOn).toBe(0);
    expect(normalizeSettings({}).weekStartsOn).toBe(0);
    expect(normalizeSettings({ weekStartsOn: 1 }).weekStartsOn).toBe(1);
  });
  it('migrates the old workingHours/workDays shape', () => {
    const s = normalizeSettings({ workingHours: { start: '08:00', end: '17:00' }, workDays: [1, 3, 5], slotMinutes: 30 });
    expect(s.availability).toEqual([{ days: [1, 3, 5], start: '08:00', end: '17:00' }]);
    expect(s.slotMinutes).toBe(30);
    expect(s.maxBlockMinutes).toBe(DEFAULT_SETTINGS.maxBlockMinutes);
  });
  it('keeps the new shape and fills defaults', () => {
    expect(normalizeSettings({ availability: STANDARD_WEEK }).availability).toEqual(STANDARD_WEEK);
    expect(normalizeSettings(undefined).availability).toEqual([]);
    expect(normalizeSettings({ availability: 'junk' }).availability).toEqual([]);
  });
});
