import { describe, it, expect } from 'vitest';
import { availableDaysLeftInWeek, availableDaysOfPeriod, notTodayMinutes, periodRange, remainingMinutes, usedMinutes } from '../src/budget.js';
import { DEFAULT_SETTINGS, STANDARD_WEEK, type Block, type Settings, type Task } from '../src/types.js';

const d = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m); // Oct 2026: 4 Sun, 5 Mon, 10 Sat, 11 Sun
const task = (budgetMinutes: number, budgetPeriod: Task['budgetPeriod'] = 'week'): Task => ({ id: 't', name: 't', color: '#000', priority: 1, budgetMinutes, budgetPeriod, archived: false, createdAt: '' });
const block = (id: string, start: Date, end: Date, status: Block['status'] = 'pending', extra: Partial<Block> = {}): Block => ({ id, taskId: 't', start: start.toISOString(), end: end.toISOString(), status, createdAt: '', statusChangedAt: null, ...extra });
const sun: Settings = { ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, weekStartsOn: 0 };
const mon: Settings = { ...sun, weekStartsOn: 1 };

describe('periodRange', () => {
  it('a day runs midnight to midnight whatever the time given', () => {
    expect(periodRange('day', d(7, 23, 59), sun)).toEqual({ start: d(7, 0), end: d(8, 0) });
    expect(periodRange('day', d(7, 0), sun)).toEqual({ start: d(7, 0), end: d(8, 0) });
  });
  it('Sunday Oct 11 opens a Sunday week but closes a Monday week', () => {
    expect(periodRange('week', d(11, 12), sun)).toEqual({ start: d(11, 0), end: d(18, 0) });
    expect(periodRange('week', d(11, 12), mon)).toEqual({ start: d(5, 0), end: d(12, 0) });
  });
  it('Saturday Oct 10 closes a Sunday week', () => {
    expect(periodRange('week', d(10, 23, 59), sun)).toEqual({ start: d(4, 0), end: d(11, 0) });
    expect(periodRange('week', d(10, 23, 59), mon)).toEqual({ start: d(5, 0), end: d(12, 0) });
  });
});

describe('usedMinutes at the edges', () => {
  const weekOf4 = periodRange('week', d(7, 12), sun); // Sun 4 .. Sat 10
  const weekOf11 = periodRange('week', d(14, 12), sun);
  it('a block straddling the week edge is split between the weeks', () => {
    const blocks = [block('n', d(10, 23), d(11, 1), 'done')];
    expect(usedMinutes(task(300), blocks, weekOf4)).toBe(60);
    expect(usedMinutes(task(300), blocks, weekOf11)).toBe(60);
  });
  it('with the week starting on Monday the same block falls whole into one week', () => {
    const blocks = [block('n', d(10, 23), d(11, 1), 'done')];
    expect(usedMinutes(task(300), blocks, periodRange('week', d(7, 12), mon))).toBe(120);
    expect(usedMinutes(task(300), blocks, periodRange('week', d(14, 12), mon))).toBe(0);
  });
  it('an early-finished block counts its planned minutes by its start, never clipped and never counted twice', () => {
    const early = block('e', d(10, 23, 30), d(10, 23, 40), 'done', { plannedMinutes: 90, trackedMinutes: 10 });
    expect(usedMinutes(task(300), [early], weekOf4)).toBe(90);
    expect(usedMinutes(task(300), [early], weekOf11)).toBe(0);
  });
  it('missed and skipped blocks are not used; they are "not today"', () => {
    const blocks = [block('m', d(5, 9), d(5, 10), 'missed'), block('s', d(5, 10), d(5, 11), 'skipped'), block('p', d(5, 11), d(5, 12))];
    expect(usedMinutes(task(300), blocks, weekOf4)).toBe(60);
    expect(notTodayMinutes(task(300), blocks, weekOf4)).toBe(120);
    expect(notTodayMinutes(task(300), [block('m', d(10, 23), d(11, 1), 'missed')], weekOf4)).toBe(60);
  });
  it('blocks of another task never count', () => {
    expect(usedMinutes(task(300), [{ ...block('o', d(5, 9), d(5, 10), 'done'), taskId: 'other' }], weekOf4)).toBe(0);
  });
  it('a zero-length block adds nothing', () => {
    expect(usedMinutes(task(300), [block('z', d(5, 9), d(5, 9), 'done')], weekOf4)).toBe(0);
  });
});

describe('remainingMinutes at the edges', () => {
  it('never goes below zero, and a zero budget has nothing left', () => {
    expect(remainingMinutes(task(60), [block('b', d(7, 9), d(7, 11), 'done')], d(7, 12), sun)).toBe(0);
    expect(remainingMinutes(task(0), [], d(7, 12), sun)).toBe(0);
  });
  it('a very long budget is simply reduced by what is used', () => {
    expect(remainingMinutes(task(100_000), [block('b', d(7, 9), d(7, 11), 'done')], d(7, 12), sun)).toBe(99_880);
  });
  it('a day budget looks at the day only; a week budget at the week', () => {
    const blocks = [block('y', d(6, 9), d(6, 10), 'done'), block('t', d(7, 9), d(7, 10), 'done')];
    expect(remainingMinutes(task(180, 'day'), blocks, d(7, 12), sun)).toBe(120);
    expect(remainingMinutes(task(180, 'week'), blocks, d(7, 12), sun)).toBe(60);
  });
  it('the week start setting decides which blocks count: a Sunday block for a Monday at', () => {
    const blocks = [block('s', d(11, 9), d(11, 10), 'done')];
    expect(remainingMinutes(task(120), blocks, d(12, 12), sun)).toBe(60); // Sun 11 is in the Sunday week of Mon 12
    expect(remainingMinutes(task(120), blocks, d(12, 12), mon)).toBe(120); // but in the week before for a Monday start
  });
});

describe('availableDaysOfPeriod and availableDaysLeftInWeek', () => {
  it('from a Saturday with a Sunday week only Saturday remains, and it has no availability: the count is floored at 1', () => {
    expect(availableDaysOfPeriod(d(10, 12), 'week', sun)).toEqual([]);
    expect(availableDaysLeftInWeek(d(10, 12), sun)).toBe(1);
  });
  it('from a Sunday the Sunday week has all five weekdays ahead, the Monday week none', () => {
    expect(availableDaysOfPeriod(d(11, 12), 'week', sun).map((x) => x.getDate())).toEqual([12, 13, 14, 15, 16]);
    expect(availableDaysOfPeriod(d(11, 12), 'week', mon)).toEqual([]);
  });
  it('the from day is included when it has availability; a day period is at most that day', () => {
    expect(availableDaysOfPeriod(d(7, 23, 59), 'week', sun).map((x) => x.getDate())).toEqual([7, 8, 9]);
    expect(availableDaysOfPeriod(d(7, 12), 'day', sun)).toEqual([d(7, 0)]);
    expect(availableDaysOfPeriod(d(10, 12), 'day', sun)).toEqual([]);
  });
  it('no availability means no days, and the count is still 1', () => {
    expect(availableDaysOfPeriod(d(5, 9), 'week', { ...sun, availability: [] })).toEqual([]);
    expect(availableDaysLeftInWeek(d(5, 9), { ...sun, availability: [] })).toBe(1);
  });
});
