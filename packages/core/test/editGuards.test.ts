import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/store.js';
import { runTool } from '../src/tools.js';
import { DEFAULT_SETTINGS } from '../src/types.js';

const d = (h: number, m = 0) => new Date(2026, 9, 9, h, m); // Fri
let store: MemoryStore;
const ctx = { now: () => d(8) };
beforeEach(() => {
  store = new MemoryStore();
  store.saveSettings({ ...DEFAULT_SETTINGS, availability: [{ days: [5], start: '07:00', end: '13:00' }, { days: [5], start: '14:00', end: '18:00' }], maxBlockMinutes: 90, minBlockMinutes: 30, slotMinutes: 15 });
  runTool(store, 'upsert_task', { name: 'Leetcode', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
  runTool(store, 'upsert_task', { name: 'Building', priority: 2, budget_minutes: 60, budget_period: 'day' }, ctx);
  runTool(store, 'add_recurring_commitment', { title: 'Standup', days: 'fri', start: '10:00', end: '10:30' }, ctx);
});

describe('edit guards', () => {
  it('refuses to add or move a block into a gap in availability unless allowed', () => {
    expect(() => runTool(store, 'add_block', { task: 'Leetcode', start: '13:00', end: '14:00' }, ctx)).toThrow(/outside your availability.*13:00-14:00/);
    const ok = runTool(store, 'add_block', { task: 'Leetcode', start: '13:00', end: '14:00', allow_outside_availability: true }, ctx) as any;
    expect(ok.start).toBe(d(13).toISOString());
  });

  it('with a baseline, the availability it implies is what the guard checks', () => {
    const lc = store.listTasks().find((t) => t.name === 'Leetcode')!.id;
    store.setBaseline({ slots: [{ day: 5, start: '08:00', end: '09:00', kind: 'task', taskId: lc }, { day: 5, start: '11:00', end: '12:00', kind: 'task', taskId: lc }] }); // Friday 08:00-12:00
    expect(() => runTool(store, 'add_block', { task: 'Leetcode', start: '12:30', end: '13:00' }, ctx)).toThrow(/outside your availability.*08:00-12:00/);
    const ok = runTool(store, 'add_block', { task: 'Leetcode', start: '09:00', end: '10:00' }, ctx) as any;
    expect(ok.start).toBe(d(9).toISOString());
  });

  it('refuses overlaps with commitments or other blocks unless allowed', () => {
    expect(() => runTool(store, 'add_block', { task: 'Leetcode', start: '09:45', end: '10:45' }, ctx)).toThrow(/overlaps "Standup" 10:00-10:30/);
    const a = runTool(store, 'add_block', { task: 'Leetcode', start: '11:00', end: '12:00' }, ctx) as any;
    expect(() => runTool(store, 'add_block', { task: 'Building', start: '11:30', end: '12:30' }, ctx)).toThrow(/overlaps "Leetcode" 11:00-12:00/);
    expect(() => runTool(store, 'move_block', { block_id: a.id, start: '09:30' }, ctx)).toThrow(/overlaps "Standup"/);
    const moved = runTool(store, 'move_block', { block_id: a.id, start: '09:30', allow_overlap: true }, ctx) as any;
    expect(moved.start).toBe(d(9, 30).toISOString());
    const fine = runTool(store, 'move_block', { block_id: a.id, start: '14:00' }, ctx) as any;
    expect(fine.start).toBe(d(14).toISOString());
  });
});
