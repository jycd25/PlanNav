import { describe, it, expect } from 'vitest';
import { rangeFromDrag, HOUR_PX } from '../src/calendar/layout.js';

const day = new Date(2026, 9, 7);

describe('rangeFromDrag', () => {
  it('orders the two pointer positions, snaps, and enforces a minimum length', () => {
    const r = rangeFromDrag(day, 10.2 * HOUR_PX, 9.4 * HOUR_PX, 15, 30);
    expect(r.start).toEqual(new Date(2026, 9, 7, 9, 30));
    expect(r.end).toEqual(new Date(2026, 9, 7, 10, 15));
    const tiny = rangeFromDrag(day, 9 * HOUR_PX, 9 * HOUR_PX + 2, 15, 30);
    expect(tiny.end.getTime() - tiny.start.getTime()).toBe(30 * 60_000);
  });
});

import { rangeFromClick } from '../src/calendar/layout.js';

describe('rangeFromClick', () => {
  it('starts at the slot under the pointer and lasts the minimum block length', () => {
    const day = new Date(2026, 9, 7);
    const r = rangeFromClick(day, 9.4 * HOUR_PX, 15, 30);
    expect(r.start).toEqual(new Date(2026, 9, 7, 9, 15));
    expect(r.end).toEqual(new Date(2026, 9, 7, 9, 45));
    const late = rangeFromClick(day, 23.9 * HOUR_PX, 15, 30);
    expect(late.end).toEqual(new Date(2026, 9, 8, 0, 0));
    expect(late.start).toEqual(new Date(2026, 9, 7, 23, 30));
  });
});
