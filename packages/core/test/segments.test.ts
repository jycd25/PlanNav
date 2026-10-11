import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/store.js';
import { plan } from '../src/plan.js';
import { allocate } from '../src/allocate.js';
import { inferSegment, segmentOf, splitBySegments } from '../src/segments.js';
import { runTool } from '../src/tools.js';
import { DEFAULT_SETTINGS, STANDARD_WEEK, type Task } from '../src/types.js';

const d = (h: number, m = 0) => new Date(2026, 9, 7, h, m); // Wed
const settings = { ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, maxBlockMinutes: 60, minBlockMinutes: 30, slotMinutes: 15 };
const task = (id: string, priority: number, budgetMinutes: number, preferredSegment: Task['preferredSegment'] = 'any'): Task => ({
  id, name: id, color: '#000', priority, budgetMinutes, budgetPeriod: 'day', preferredSegment, archived: false, createdAt: '',
});
const hm = (iso: string) => { const x = new Date(iso); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; };

describe('segments', () => {
  it('classifies times by the configured boundaries', () => {
    expect(segmentOf(d(8), settings)).toBe('morning');
    expect(segmentOf(d(11, 59), settings)).toBe('morning');
    expect(segmentOf(d(12), settings)).toBe('afternoon');
    expect(segmentOf(d(16, 59), settings)).toBe('afternoon');
    expect(segmentOf(d(17), settings)).toBe('evening');
    expect(segmentOf(d(23), settings)).toBe('evening');
  });
  it('splits free intervals at segment boundaries; a piece cut at an edge says where the free time really ends', () => {
    expect(splitBySegments([{ start: d(9), end: d(18) }], settings)).toEqual([
      { start: d(9), end: d(12), until: d(18) }, { start: d(12), end: d(17), until: d(18) }, { start: d(17), end: d(18) },
    ]);
  });
});

describe('allocate with an acceptance filter', () => {
  it('only places tasks the filter accepts for an interval', () => {
    const r = allocate([{ start: d(9), end: d(10) }, { start: d(13), end: d(14) }], [task('a', 1, 60), task('b', 2, 60)], { a: 60, b: 60 }, settings,
      { accepts: (t, slot) => t.id === 'b' || slot.start.getHours() < 12 });
    expect(r).toEqual([{ taskId: 'a', start: d(9), end: d(10) }, { taskId: 'b', start: d(13), end: d(14) }]);
  });
});

describe('plan with preferred segments', () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
    store.saveSettings({ ...settings, availability: [...STANDARD_WEEK, { days: [1, 2, 3, 4], start: '20:00', end: '22:30' }] });
    store.upsertTask(task('ml', 1, 120, 'morning'));
    store.upsertTask(task('leetcode', 2, 60));
    store.upsertTask(task('reading', 3, 60, 'evening'));
  });
  it('keeps preferred tasks in their segment and lets any-tasks rotate with them', () => {
    const r = plan(store, { now: d(9) });
    expect(r.created.map((b) => [b.taskId, hm(b.start), hm(b.end)])).toEqual([
      ['ml', '09:00', '10:00'], ['ml', '10:00', '11:00'], ['leetcode', '11:00', '12:00'], ['reading', '17:00', '18:00'], // evening starts at 17:00 by default
    ]);
  });
  it('falls back to other segments only when the preferred one has no room', () => {
    store.saveSettings({ ...settings, availability: STANDARD_WEEK });
    const r = plan(store, { now: d(9), until: d(16) }); // nothing after 16:00, so no evening at all
    const reading = r.created.filter((b) => b.taskId === 'reading');
    expect(reading.map((b) => [hm(b.start), hm(b.end)])).toEqual([['12:00', '13:00']]);
  });
  it('gives a morning task the morning even when a higher-priority any-task could take it', () => {
    store.upsertTask(task('ml', 2, 60, 'morning'));
    store.upsertTask(task('leetcode', 1, 60));
    const r = plan(store, { now: d(11), until: d(14) });
    expect(r.created.map((b) => [b.taskId, hm(b.start)])).toEqual([['ml', '11:00'], ['leetcode', '12:00'], ['reading', '13:00']]);
  });
});

describe('plan: fallback keeps priority', () => {
  it('a high-priority task whose segment is gone still outranks flexible tasks in the leftover time', () => {
    const store = new MemoryStore();
    store.saveSettings(settings);
    store.upsertTask(task('ml', 1, 60, 'morning'));
    store.upsertTask(task('leetcode', 2, 60));
    const r = plan(store, { now: d(15), until: d(18) });
    expect(r.created.map((b) => [b.taskId, hm(b.start)])).toEqual([['ml', '15:00'], ['leetcode', '16:00']]);
  });
});

describe('tools: preferred segment', () => {
  it('upsert_task accepts tolerant segment words and update_settings moves boundaries', () => {
    const store = new MemoryStore();
    store.saveSettings(settings);
    const ctx = { now: () => d(9) };
    const t = runTool(store, 'upsert_task', { name: 'ML', priority: 1, budget_minutes: 60, budget_period: 'day', preferred_segment: 'mornings' }, ctx) as any;
    expect(t.preferredSegment).toBe('morning');
    const t2 = runTool(store, 'upsert_task', { name: 'ML', priority: 1, budget_minutes: 60, budget_period: 'day', preferred_segment: 'after lunch' }, ctx) as any;
    expect(t2.preferredSegment).toBe('afternoon');
    expect((runTool(store, 'upsert_task', { name: 'B', priority: 1, budget_minutes: 60, budget_period: 'day', preferred_segment: 'night' }, ctx) as any).preferredSegment).toBe('evening');
    expect((runTool(store, 'upsert_task', { name: 'C', priority: 1, budget_minutes: 60, budget_period: 'day', preferred_segment: 'no preference' }, ctx) as any).preferredSegment).toBe('any');
    expect((runTool(store, 'upsert_task', { name: 'D', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx) as any).preferredSegment).toBe('any');
    expect(() => runTool(store, 'upsert_task', { name: 'E', priority: 1, budget_minutes: 60, budget_period: 'day', preferred_segment: 'dawn' }, ctx)).toThrow(/morning, afternoon, evening/);
    const s = runTool(store, 'update_settings', { morning_end: '11:00', afternoon_end: '16:00' }, ctx) as any;
    expect(s.settings.segments).toEqual({ morningEnd: '11:00', afternoonEnd: '16:00' });
    expect(() => runTool(store, 'update_settings', { morning_end: '18:00' }, ctx)).toThrow(/before/);
    const now = runTool(store, 'get_now', {}, ctx) as any;
    expect(now.segments).toEqual({ morningEnd: '11:00', afternoonEnd: '16:00' });
  });
});

describe('inferSegment', () => {
  it('reads the part of day from the task name', () => {
    expect(inferSegment('Morning learning')).toBe('morning');
    expect(inferSegment('Evening reading')).toBe('evening');
    expect(inferSegment('Night shift report')).toBe('evening');
    expect(inferSegment('Lunch run')).toBe('afternoon');
    expect(inferSegment('Leetcode')).toBeUndefined();
    expect(inferSegment('Mornington Crescent')).toBeUndefined(); // whole words only
  });
});
