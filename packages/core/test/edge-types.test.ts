import { describe, it, expect } from 'vitest';
import { availableDays, DEFAULT_SEGMENTS, DEFAULT_SETTINGS, DEFAULT_WEIGHTS, isAvailabilityWindow, MEMORY_MAX, normalizeSettings, STANDARD_WEEK } from '../src/types.js';

describe('normalizeSettings: garbage in, defaults out', () => {
  it('anything that is not an object gives the defaults, as a fresh copy', () => {
    for (const junk of [null, undefined, 0, 42, 'settings', true, [], () => 1]) {
      const s = normalizeSettings(junk);
      expect(s, String(junk)).toEqual(DEFAULT_SETTINGS);
      expect(s).not.toBe(DEFAULT_SETTINGS);
      expect(s.segments).not.toBe(DEFAULT_SETTINGS.segments);
    }
  });
  it('an empty object gives the defaults, and the output has exactly the settings keys', () => {
    const s = normalizeSettings({});
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(Object.keys(s).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    expect(Object.keys(normalizeSettings({ extra: 1, availability: STANDARD_WEEK })).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });
  it('does not mutate what it is given', () => {
    const raw = { availability: [{ days: [5, 1], start: '09:00', end: '10:00' }], memory: '  m  ' };
    normalizeSettings(raw);
    expect(raw.availability[0].days).toEqual([5, 1]);
    expect(raw.memory).toBe('  m  ');
  });
});

describe('normalizeSettings: the legacy { workingHours, workDays } shape', () => {
  it('becomes one availability window on the given days', () => {
    expect(normalizeSettings({ workingHours: { start: '08:00', end: '16:00' }, workDays: [3, 1] }).availability).toEqual([{ days: [1, 3], start: '08:00', end: '16:00' }]);
  });
  it('defaults the days to Monday to Friday when workDays is missing or invalid', () => {
    expect(normalizeSettings({ workingHours: { start: '08:00', end: '16:00' } }).availability).toEqual([{ days: [1, 2, 3, 4, 5], start: '08:00', end: '16:00' }]);
    expect(normalizeSettings({ workingHours: { start: '08:00', end: '16:00' }, workDays: [7] }).availability).toEqual([{ days: [1, 2, 3, 4, 5], start: '08:00', end: '16:00' }]);
    expect(normalizeSettings({ workingHours: { start: '08:00', end: '16:00' }, workDays: 'weekdays' }).availability).toEqual([{ days: [1, 2, 3, 4, 5], start: '08:00', end: '16:00' }]);
  });
  it('invalid working hours give no availability; a string workingHours is ignored', () => {
    expect(normalizeSettings({ workingHours: { start: '16:00', end: '08:00' } }).availability).toEqual([]);
    expect(normalizeSettings({ workingHours: { start: '8:00', end: '16:00' } }).availability).toEqual([]);
    expect(normalizeSettings({ workingHours: { start: '08:00' } }).availability).toEqual([]);
    expect(normalizeSettings({ workingHours: '08:00-16:00', workDays: [1] }).availability).toEqual([]);
  });
  it('an availability array wins over the legacy fields, even when empty', () => {
    expect(normalizeSettings({ availability: [], workingHours: { start: '08:00', end: '16:00' } }).availability).toEqual([]);
  });
});

describe('normalizeSettings: availability windows', () => {
  it('keeps only valid windows and sorts their days', () => {
    const s = normalizeSettings({ availability: [
      { days: [5, 1], start: '09:00', end: '17:00' },
      { days: [1], start: '09:00', end: '09:00' },
      { days: [1], start: '09:00', end: '24:00' },
      { days: [1], start: '9:00', end: '17:00' },
      { days: ['mon'], start: '09:00', end: '17:00' },
      { days: [1, 8], start: '09:00', end: '17:00' },
      null, 'window', 42,
      { days: [6], start: '23:00', end: '23:59' },
    ] });
    expect(s.availability).toEqual([{ days: [1, 5], start: '09:00', end: '17:00' }, { days: [6], start: '23:00', end: '23:59' }]);
  });
  it('a window with no days or repeated days passes the check as it is', () => {
    expect(normalizeSettings({ availability: [{ days: [], start: '09:00', end: '10:00' }] }).availability).toEqual([{ days: [], start: '09:00', end: '10:00' }]);
    expect(normalizeSettings({ availability: [{ days: [1, 1], start: '09:00', end: '10:00' }] }).availability).toEqual([{ days: [1, 1], start: '09:00', end: '10:00' }]);
  });
  it('a non-array availability without legacy fields is empty', () => {
    expect(normalizeSettings({ availability: { days: [1], start: '09:00', end: '10:00' } }).availability).toEqual([]);
    expect(normalizeSettings({ availability: 'always' }).availability).toEqual([]);
  });
});

describe('normalizeSettings: numbers, segments, weights, enums', () => {
  it('slot, min and max block minutes must be numbers of at least 5; strings and NaN fall back', () => {
    expect(normalizeSettings({ slotMinutes: 5, minBlockMinutes: 5, maxBlockMinutes: 5 })).toMatchObject({ slotMinutes: 5, minBlockMinutes: 5, maxBlockMinutes: 5 });
    expect(normalizeSettings({ slotMinutes: 4, minBlockMinutes: 0, maxBlockMinutes: -1 })).toMatchObject({ slotMinutes: 15, minBlockMinutes: 30, maxBlockMinutes: 90 });
    expect(normalizeSettings({ slotMinutes: '15', minBlockMinutes: NaN, maxBlockMinutes: null })).toMatchObject({ slotMinutes: 15, minBlockMinutes: 30, maxBlockMinutes: 90 });
    expect(normalizeSettings({ slotMinutes: 7.5 }).slotMinutes).toBe(7.5);
    // No cross-check: a minimum above the maximum is stored as given.
    expect(normalizeSettings({ minBlockMinutes: 200, maxBlockMinutes: 60 })).toMatchObject({ minBlockMinutes: 200, maxBlockMinutes: 60 });
  });
  // Regression (fixed 2026-10-12): normalizeSettings (types.ts:139 and :157) checks only `typeof === 'number'` and the lower bound, so Infinity
  // passes as slotMinutes (ceilToSlot then divides by it) and 1.5 passes as weekStartsOn (startOfWeek subtracts a
  // fractional day count). Expected: the defaults (15 and 0), as for any other garbage.
  it('rejects Infinity minutes and a fractional week start', () => {
    expect(normalizeSettings({ slotMinutes: Infinity }).slotMinutes).toBe(15);
    expect(normalizeSettings({ weekStartsOn: 1.5 }).weekStartsOn).toBe(0);
  });
  it('segments need both HH:MM values in order, else both default', () => {
    expect(normalizeSettings({ segments: { morningEnd: '11:30', afternoonEnd: '18:00' } }).segments).toEqual({ morningEnd: '11:30', afternoonEnd: '18:00' });
    expect(normalizeSettings({ segments: { morningEnd: '12:00', afternoonEnd: '12:00' } }).segments).toEqual(DEFAULT_SEGMENTS);
    expect(normalizeSettings({ segments: { morningEnd: '13:00', afternoonEnd: '12:00' } }).segments).toEqual(DEFAULT_SEGMENTS);
    expect(normalizeSettings({ segments: { morningEnd: '11:30' } }).segments).toEqual(DEFAULT_SEGMENTS);
    expect(normalizeSettings({ segments: { morningEnd: '9:30', afternoonEnd: '17:00' } }).segments).toEqual(DEFAULT_SEGMENTS);
    expect(normalizeSettings({ segments: 'noon' }).segments).toEqual(DEFAULT_SEGMENTS);
  });
  it('weights need both numbers in 0..1 and a positive sum, else both default', () => {
    expect(normalizeSettings({ weights: { priority: 1, deficit: 0 } }).weights).toEqual({ priority: 1, deficit: 0 });
    expect(normalizeSettings({ weights: { priority: 0, deficit: 0 } }).weights).toEqual(DEFAULT_WEIGHTS);
    expect(normalizeSettings({ weights: { priority: 1.5, deficit: 0.5 } }).weights).toEqual(DEFAULT_WEIGHTS);
    expect(normalizeSettings({ weights: { priority: 0.5 } }).weights).toEqual(DEFAULT_WEIGHTS);
    expect(normalizeSettings({ weights: { priority: '0.5', deficit: '0.5' } }).weights).toEqual(DEFAULT_WEIGHTS);
  });
  it('weekStartsOn is 0..6; reviewWindow is day or week; maxTasksPerDay is floored into 1..50; workStyle is one of three', () => {
    expect(normalizeSettings({ weekStartsOn: 6 }).weekStartsOn).toBe(6);
    expect(normalizeSettings({ weekStartsOn: 7 }).weekStartsOn).toBe(0);
    expect(normalizeSettings({ weekStartsOn: -1 }).weekStartsOn).toBe(0);
    expect(normalizeSettings({ weekStartsOn: '1' }).weekStartsOn).toBe(0);
    expect(normalizeSettings({ reviewWindow: 'day' }).reviewWindow).toBe('day');
    expect(normalizeSettings({ reviewWindow: 'month' }).reviewWindow).toBe('week');
    expect(normalizeSettings({ maxTasksPerDay: 2.7 }).maxTasksPerDay).toBe(2);
    expect(normalizeSettings({ maxTasksPerDay: 0.5 }).maxTasksPerDay).toBe(5);
    expect(normalizeSettings({ maxTasksPerDay: 50 }).maxTasksPerDay).toBe(50);
    expect(normalizeSettings({ maxTasksPerDay: 51 }).maxTasksPerDay).toBe(5);
    expect(normalizeSettings({ maxTasksPerDay: '3' }).maxTasksPerDay).toBe(5);
    expect(normalizeSettings({ workStyle: 'balanced' }).workStyle).toBe('balanced');
    expect(normalizeSettings({ workStyle: 'DEEP' }).workStyle).toBe('unknown');
    expect(normalizeSettings({ workStyle: 'unknown' }).workStyle).toBe('unknown');
  });
});

describe('normalizeSettings: the memory note', () => {
  it('MEMORY_MAX is 2000 characters', () => {
    expect(MEMORY_MAX).toBe(2000);
  });
  it('a non-string memory is empty', () => {
    for (const junk of [42, null, undefined, ['a'], { text: 'a' }, true]) expect(normalizeSettings({ memory: junk }).memory, String(junk)).toBe('');
  });
  it('trims, then caps at 2000: exactly 2000 is kept whole, 2001 loses one, padding does not count', () => {
    expect(normalizeSettings({ memory: 'x'.repeat(2000) }).memory).toBe('x'.repeat(2000));
    expect(normalizeSettings({ memory: 'x'.repeat(2001) }).memory).toBe('x'.repeat(2000));
    expect(normalizeSettings({ memory: `   ${'x'.repeat(2000)}   ` }).memory).toBe('x'.repeat(2000));
    expect(normalizeSettings({ memory: `${'x'.repeat(1999)}  ` }).memory).toHaveLength(1999);
  });
  it('keeps inner newlines, quotes and angle brackets; whitespace-only is empty', () => {
    expect(normalizeSettings({ memory: '\n- "a" <b>\n- c\n' }).memory).toBe('- "a" <b>\n- c');
    expect(normalizeSettings({ memory: ' \n\t ' }).memory).toBe('');
  });
});

describe('isAvailabilityWindow and availableDays', () => {
  it('needs an integer day list and zero-padded HH:MM times in order', () => {
    expect(isAvailabilityWindow({ days: [1], start: '09:00', end: '17:00' })).toBe(true);
    expect(isAvailabilityWindow({ days: [1], start: '00:00', end: '23:59' })).toBe(true);
    expect(isAvailabilityWindow({ days: [], start: '09:00', end: '17:00' })).toBe(true);
    expect(isAvailabilityWindow({ days: [1], start: '9:00', end: '17:00' })).toBe(false);
    expect(isAvailabilityWindow({ days: [1], start: '09:00', end: '24:00' })).toBe(false);
    expect(isAvailabilityWindow({ days: [1], start: '09:00', end: '09:00' })).toBe(false);
    expect(isAvailabilityWindow({ days: [1.5], start: '09:00', end: '17:00' })).toBe(false);
    expect(isAvailabilityWindow({ days: 'mon', start: '09:00', end: '17:00' })).toBe(false);
    expect(isAvailabilityWindow({ days: [1], start: 900, end: '17:00' })).toBe(false);
    expect(isAvailabilityWindow(null)).toBe(false);
    expect(isAvailabilityWindow('09:00-17:00')).toBe(false);
  });
  it('availableDays dedupes and sorts across windows', () => {
    expect(availableDays({ ...DEFAULT_SETTINGS, availability: [{ days: [5, 1], start: '09:00', end: '10:00' }, { days: [1, 0], start: '20:00', end: '21:00' }] })).toEqual([0, 1, 5]);
    expect(availableDays(DEFAULT_SETTINGS)).toEqual([]);
  });
});
