import { describe, it, expect } from 'vitest';
import { layoutDay, snap, timeRangeFromPx, startsToday, HOUR_PX } from '../src/calendar/layout.js';

const day = new Date(2026, 9, 7);
const at = (h: number, m = 0) => new Date(2026, 9, 7, h, m).toISOString();

describe('layoutDay', () => {
  it('positions items by minutes and assigns columns to overlaps', () => {
    const r = layoutDay([
      { id: 'a', start: at(9), end: at(10) },
      { id: 'b', start: at(9, 30), end: at(11) },
      { id: 'c', start: at(13), end: at(14) },
    ], day);
    const byId = Object.fromEntries(r.map((p) => [p.id, p]));
    expect(byId.a.top).toBe(9 * HOUR_PX);
    expect(byId.a.height).toBe(HOUR_PX);
    expect(byId.a.col).toBe(0); expect(byId.a.cols).toBe(2);
    expect(byId.b.col).toBe(1); expect(byId.b.cols).toBe(2);
    expect(byId.c.col).toBe(0); expect(byId.c.cols).toBe(1);
  });
  it('clips to the day and drops items outside it', () => {
    const r = layoutDay([
      { id: 'x', start: new Date(2026, 9, 6, 23).toISOString(), end: at(1) },
      { id: 'y', start: new Date(2026, 9, 8, 9).toISOString(), end: new Date(2026, 9, 8, 10).toISOString() },
    ], day);
    expect(r.map((p) => p.id)).toEqual(['x']);
    expect(r[0].top).toBe(0);
    expect(r[0].height).toBe(HOUR_PX);
  });
});

describe('snap and timeRangeFromPx', () => {
  it('snaps minutes and converts pixels back to a time range', () => {
    expect(snap(37, 15)).toBe(30);
    expect(snap(38, 15)).toBe(45);
    const r = timeRangeFromPx(day, 9.5 * HOUR_PX, HOUR_PX, 15);
    expect(r.start).toEqual(new Date(2026, 9, 7, 9, 30));
    expect(r.end).toEqual(new Date(2026, 9, 7, 10, 30));
  });
  it('keeps a minimum of one slot and stays inside the day', () => {
    const r = timeRangeFromPx(day, 23.9 * HOUR_PX, 2, 15);
    expect(r.start).toEqual(new Date(2026, 9, 7, 23, 45));
    expect(r.end).toEqual(new Date(2026, 9, 8, 0, 0));
  });
});

describe('startsToday', () => {
  it('is true for any block of the same calendar day, earlier or later, false for another day', () => {
    const now = new Date(2026, 9, 7, 9, 0);
    expect(startsToday(at(8), now)).toBe(true);
    expect(startsToday(at(9, 16), now)).toBe(true);
    expect(startsToday(at(23, 45), now)).toBe(true);
    expect(startsToday(new Date(2026, 9, 7, 0, 0).toISOString(), now)).toBe(true);
    expect(startsToday(new Date(2026, 9, 8, 0, 0).toISOString(), now)).toBe(false);
    expect(startsToday(new Date(2026, 9, 8, 9).toISOString(), now)).toBe(false);
    expect(startsToday(new Date(2026, 9, 6, 23, 45).toISOString(), now)).toBe(false);
  });
});
