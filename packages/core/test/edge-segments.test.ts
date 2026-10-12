import { describe, it, expect } from 'vitest';
import { inferSegment, isFlexible, prefers, segmentOf, splitBySegments } from '../src/segments.js';
import { DEFAULT_SETTINGS, type Settings, type Task } from '../src/types.js';

const d = (h: number, m = 0) => new Date(2026, 9, 7, h, m);
const settings: Settings = { ...DEFAULT_SETTINGS };
const task = (preferredSegment?: Task['preferredSegment']): Task => ({ id: 't', name: 't', color: '#000', priority: 1, budgetMinutes: 60, budgetPeriod: 'day', preferredSegment, archived: false, createdAt: '' });

describe('segmentOf at the boundaries', () => {
  it('midnight is morning; the minute before each edge belongs to the earlier segment, the edge to the later', () => {
    expect(segmentOf(d(0), settings)).toBe('morning');
    expect(segmentOf(d(11, 59), settings)).toBe('morning');
    expect(segmentOf(d(12), settings)).toBe('afternoon');
    expect(segmentOf(d(16, 59), settings)).toBe('afternoon');
    expect(segmentOf(d(17), settings)).toBe('evening');
    expect(segmentOf(d(23, 59), settings)).toBe('evening');
  });
  it('with the edges at 00:01 and 00:02 almost the whole day is evening', () => {
    const s = { ...settings, segments: { morningEnd: '00:01', afternoonEnd: '00:02' } };
    expect(segmentOf(d(0), s)).toBe('morning');
    expect(segmentOf(d(0, 1), s)).toBe('afternoon');
    expect(segmentOf(d(0, 2), s)).toBe('evening');
    expect(segmentOf(d(12), s)).toBe('evening');
  });
  it('seconds do not move the edge: 11:59:59 is still morning', () => {
    expect(segmentOf(new Date(2026, 9, 7, 11, 59, 59), settings)).toBe('morning');
  });
});

describe('splitBySegments at the edges', () => {
  it('an interval that starts exactly at an edge is not cut there', () => {
    expect(splitBySegments([{ start: d(12), end: d(17) }], settings)).toEqual([{ start: d(12), end: d(17) }]);
  });
  it('an interval that ends exactly at an edge is not cut there, and has no until', () => {
    expect(splitBySegments([{ start: d(9), end: d(12) }], settings)).toEqual([{ start: d(9), end: d(12) }]);
    expect(splitBySegments([{ start: d(9), end: d(17) }], settings)).toEqual([{ start: d(9), end: d(12), until: d(17) }, { start: d(12), end: d(17) }]);
  });
  it('an interval wholly inside one segment, or in the evening, is returned as it is', () => {
    expect(splitBySegments([{ start: d(13), end: d(14) }], settings)).toEqual([{ start: d(13), end: d(14) }]);
    expect(splitBySegments([{ start: d(20), end: d(23)}], settings)).toEqual([{ start: d(20), end: d(23) }]);
  });
  it('an interval crossing midnight is cut only at the edges of the day it starts on', () => {
    const r = splitBySegments([{ start: d(16), end: new Date(2026, 9, 8, 13) }], settings);
    expect(r).toEqual([{ start: d(16), end: d(17), until: new Date(2026, 9, 8, 13) }, { start: d(17), end: new Date(2026, 9, 8, 13) }]);
  });
  it('an empty list and a one-minute interval at an edge', () => {
    expect(splitBySegments([], settings)).toEqual([]);
    expect(splitBySegments([{ start: d(11, 59), end: d(12) }], settings)).toEqual([{ start: d(11, 59), end: d(12) }]);
  });
  it('several intervals are each cut on their own', () => {
    const r = splitBySegments([{ start: d(11), end: d(13) }, { start: d(16), end: d(18) }], settings);
    expect(r).toEqual([{ start: d(11), end: d(12), until: d(13) }, { start: d(12), end: d(13) }, { start: d(16), end: d(17), until: d(18) }, { start: d(17), end: d(18) }]);
  });
});

describe('prefers and isFlexible', () => {
  it('a task with no preference, or "any", prefers nothing and is flexible', () => {
    expect(prefers(task(), { start: d(9), end: d(10) }, settings)).toBe(false);
    expect(prefers(task('any'), { start: d(9), end: d(10) }, settings)).toBe(false);
    expect(isFlexible(task())).toBe(true);
    expect(isFlexible(task('any'))).toBe(true);
    expect(isFlexible(task('morning'))).toBe(false);
  });
  it('the slot\'s start decides: a morning slot running into the afternoon is still morning', () => {
    expect(prefers(task('morning'), { start: d(11, 59), end: d(14) }, settings)).toBe(true);
    expect(prefers(task('afternoon'), { start: d(11, 59), end: d(14) }, settings)).toBe(false);
    expect(prefers(task('evening'), { start: d(17), end: d(17, 1) }, settings)).toBe(true);
  });
});

describe('inferSegment at the edges', () => {
  it('the first segment in morning, afternoon, evening order wins when a name says two', () => {
    expect(inferSegment('Evening and morning run')).toBe('morning');
    expect(inferSegment('Night lunch')).toBe('afternoon');
  });
  it('is case-insensitive and needs a whole word; an empty name says nothing', () => {
    expect(inferSegment('MORNING pages')).toBe('morning');
    expect(inferSegment('Tonight')).toBe('evening');
    expect(inferSegment('Afternoons')).toBe('afternoon');
    expect(inferSegment('Nightly')).toBeUndefined();
    expect(inferSegment('')).toBeUndefined();
  });
});
