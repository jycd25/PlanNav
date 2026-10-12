import { describe, it, expect } from 'vitest';
import { DAY_MIN, HOUR_PX, layoutDay, minutesToPx, pxToMinutes, rangeFromClick, rangeFromDrag, snap, startsToday, timeRangeFromPx } from '../src/calendar/layout.js';

const day = new Date(2026, 9, 7);
const at = (h: number, m = 0, d = 7) => new Date(2026, 9, d, h, m).toISOString();
const byId = (r: ReturnType<typeof layoutDay>) => Object.fromEntries(r.map((p) => [p.id, p]));

describe('layoutDay: overlaps', () => {
  it('three mutually overlapping items in one cluster share the columns they need, not one each', () => {
    const r = byId(layoutDay([{ id: 'a', start: at(9), end: at(12) }, { id: 'b', start: at(10), end: at(11) }, { id: 'c', start: at(11), end: at(12) }], day));
    expect([r.a.col, r.b.col, r.c.col]).toEqual([0, 1, 1]);
    expect([r.a.cols, r.b.cols, r.c.cols]).toEqual([2, 2, 2]);
  });
  it('identical ranges get one column each in input order', () => {
    const r = layoutDay([{ id: 'x', start: at(9), end: at(10) }, { id: 'y', start: at(9), end: at(10) }, { id: 'z', start: at(9), end: at(10) }], day);
    expect(r.map((p) => [p.id, p.col, p.cols])).toEqual([['x', 0, 3], ['y', 1, 3], ['z', 2, 3]]);
  });
  it('an item starting exactly when another ends is a new cluster with its own single column', () => {
    const r = byId(layoutDay([{ id: 'a', start: at(9), end: at(10) }, { id: 'b', start: at(10), end: at(11) }], day));
    expect([r.a.col, r.a.cols, r.b.col, r.b.cols]).toEqual([0, 1, 0, 1]);
  });
  it('a long item bridges otherwise separate clusters so all of them share its column count', () => {
    const r = byId(layoutDay([{ id: 'long', start: at(8), end: at(18) }, { id: 'a', start: at(9), end: at(10) }, { id: 'b', start: at(15), end: at(16) }], day));
    expect([r.long.col, r.a.col, r.b.col]).toEqual([0, 1, 1]);
    expect([r.long.cols, r.a.cols, r.b.cols]).toEqual([2, 2, 2]);
  });
  it('sorts by start, then longer first, whatever the input order', () => {
    const r = layoutDay([{ id: 'short', start: at(9), end: at(9, 30) }, { id: 'late', start: at(8), end: at(8, 15) }, { id: 'long', start: at(9), end: at(11) }], day);
    expect(r.map((p) => p.id)).toEqual(['late', 'long', 'short']);
    expect(r.map((p) => p.col)).toEqual([0, 0, 1]);
  });
});

describe('layoutDay: degenerate and boundary items', () => {
  it('drops zero-length and inverted items', () => {
    expect(layoutDay([{ id: 'zero', start: at(9), end: at(9) }, { id: 'neg', start: at(10), end: at(9) }], day)).toEqual([]);
  });
  it('a block crossing midnight is clipped to 23:00–24:00 on its first day and 00:00–01:00 on the next', () => {
    const item = { id: 'x', start: at(23), end: at(1, 0, 8) };
    const first = layoutDay([item], day)[0];
    expect([first.startMin, first.endMin, first.top, first.height]).toEqual([1380, 1440, 23 * HOUR_PX, HOUR_PX]);
    const next = layoutDay([item], new Date(2026, 9, 8))[0];
    expect([next.startMin, next.endMin, next.top, next.height]).toEqual([0, 60, 0, HOUR_PX]);
  });
  it('a block spanning the whole day and beyond fills the day exactly', () => {
    const r = layoutDay([{ id: 'x', start: at(12, 0, 6), end: at(12, 0, 8) }], day)[0];
    expect([r.startMin, r.endMin, r.height]).toEqual([0, DAY_MIN, 24 * HOUR_PX]);
  });
  it('a block ending exactly at this midnight belongs to yesterday; one starting at next midnight belongs to tomorrow', () => {
    expect(layoutDay([{ id: 'before', start: at(23, 0, 6), end: at(0, 0, 7) }], day)).toEqual([]);
    expect(layoutDay([{ id: 'after', start: at(0, 0, 8), end: at(1, 0, 8) }], day)).toEqual([]);
  });
  it('a one-minute block is positioned to the minute', () => {
    const r = layoutDay([{ id: 'm', start: at(9, 1), end: at(9, 2) }], day)[0];
    expect(r.top).toBeCloseTo(minutesToPx(541), 10);
    expect(r.height).toBeCloseTo(HOUR_PX / 60, 10);
  });
  it('an empty list yields an empty layout', () => {
    expect(layoutDay([], day)).toEqual([]);
  });
});

describe('layoutDay: hundreds of blocks', () => {
  it('200 back-to-back blocks are all single-column and keep their order', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ id: `b${i}`, start: new Date(day.getTime() + i * 5 * 60_000).toISOString(), end: new Date(day.getTime() + (i + 1) * 5 * 60_000).toISOString() }));
    const r = layoutDay(items, day);
    expect(r).toHaveLength(200);
    expect(r.every((p) => p.col === 0 && p.cols === 1)).toBe(true);
    expect(r.map((p) => p.id)).toEqual(items.map((i) => i.id));
    expect(r[199].endMin).toBe(1000);
  });
  it('100 identical blocks need 100 columns', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, start: at(9), end: at(10) }));
    const r = layoutDay(items, day);
    expect(r.map((p) => p.col)).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(new Set(r.map((p) => p.cols))).toEqual(new Set([100]));
  });
  it('a staggered chain (every 10 min, 30 min long) cycles through three columns in one cluster', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, start: new Date(day.getTime() + i * 10 * 60_000).toISOString(), end: new Date(day.getTime() + (i * 10 + 30) * 60_000).toISOString() }));
    const r = layoutDay(items, day);
    expect(r.map((p) => p.col)).toEqual(items.map((_, i) => i % 3));
    expect(r.every((p) => p.cols === 3)).toBe(true);
  });
});

describe('pixel and minute conversions', () => {
  it('round-trip and snap edges', () => {
    expect(pxToMinutes(minutesToPx(1234))).toBeCloseTo(1234, 10);
    expect(minutesToPx(DAY_MIN)).toBe(24 * HOUR_PX);
    expect(snap(0, 15)).toBe(0);
    expect(snap(7, 15)).toBe(0);
    expect(snap(8, 15)).toBe(15);
    expect(snap(1439, 15)).toBe(1440);
    expect(snap(37, 1)).toBe(37);
  });
});

describe('timeRangeFromPx at the day\'s edges', () => {
  it('a negative top clamps to midnight and keeps one slot', () => {
    expect(timeRangeFromPx(day, -100, 1, 15)).toEqual({ start: new Date(2026, 9, 7, 0), end: new Date(2026, 9, 7, 0, 15) });
  });
  it('a range reaching past midnight is pulled back to end at 24:00', () => {
    expect(timeRangeFromPx(day, 23 * HOUR_PX, 2 * HOUR_PX, 15)).toEqual({ start: new Date(2026, 9, 7, 23), end: new Date(2026, 9, 8) });
  });
  it('a top beyond the day collapses to the last slot', () => {
    expect(timeRangeFromPx(day, 25 * HOUR_PX, HOUR_PX, 15)).toEqual({ start: new Date(2026, 9, 7, 23, 45), end: new Date(2026, 9, 8) });
  });
  it('a slot of 60 snaps to whole hours', () => {
    expect(timeRangeFromPx(day, 9.4 * HOUR_PX, 0.9 * HOUR_PX, 60)).toEqual({ start: new Date(2026, 9, 7, 9), end: new Date(2026, 9, 7, 10) });
  });
});

describe('rangeFromDrag', () => {
  it('is the same whichever way the drag went', () => {
    const down = rangeFromDrag(day, 9 * HOUR_PX, 10 * HOUR_PX, 15, 30);
    const up = rangeFromDrag(day, 10 * HOUR_PX, 9 * HOUR_PX, 15, 30);
    expect(down).toEqual(up);
    expect(down).toEqual({ start: new Date(2026, 9, 7, 9), end: new Date(2026, 9, 7, 10) });
  });
  it('a tiny drag becomes the minimum length', () => {
    expect(rangeFromDrag(day, 9 * HOUR_PX, 9 * HOUR_PX + 1, 15, 30)).toEqual({ start: new Date(2026, 9, 7, 9), end: new Date(2026, 9, 7, 9, 30) });
  });
  it('a drag in the last minutes of the day keeps the minimum length even past midnight (the range is not clipped)', () => {
    const r = rangeFromDrag(day, 23.9 * HOUR_PX, 23.95 * HOUR_PX, 15, 30);
    expect(r.start).toEqual(new Date(2026, 9, 7, 23, 45));
    expect(r.end).toEqual(new Date(2026, 9, 8, 0, 15));
  });
});

describe('rangeFromClick', () => {
  it('floors to the slot under the pointer and lasts the minimum', () => {
    expect(rangeFromClick(day, 9.9 * HOUR_PX, 15, 30)).toEqual({ start: new Date(2026, 9, 7, 9, 45), end: new Date(2026, 9, 7, 10, 15) });
  });
  it('near the end of the day it moves back to end at midnight; above the top it starts at 00:00', () => {
    expect(rangeFromClick(day, 23.9 * HOUR_PX, 15, 30)).toEqual({ start: new Date(2026, 9, 7, 23, 30), end: new Date(2026, 9, 8) });
    expect(rangeFromClick(day, -5, 15, 30)).toEqual({ start: new Date(2026, 9, 7, 0), end: new Date(2026, 9, 7, 0, 30) });
  });
  it('a minimum longer than the day fills the day', () => {
    expect(rangeFromClick(day, 5 * HOUR_PX, 15, 2000)).toEqual({ start: new Date(2026, 9, 7, 0), end: new Date(2026, 9, 8) });
  });
});

describe('startsToday', () => {
  it('a block one millisecond before midnight is today; at midnight it is tomorrow', () => {
    const now = new Date(2026, 9, 7, 12);
    expect(startsToday(new Date(2026, 9, 7, 23, 59, 59, 999).toISOString(), now)).toBe(true);
    expect(startsToday(new Date(2026, 9, 8, 0, 0, 0, 0).toISOString(), now)).toBe(false);
  });
  it('compares the calendar date, not 24-hour distance: same date a year apart is false', () => {
    expect(startsToday(new Date(2025, 9, 7, 12).toISOString(), new Date(2026, 9, 7, 12))).toBe(false);
  });
});
