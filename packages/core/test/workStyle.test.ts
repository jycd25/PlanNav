import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/store.js';
import { inferWorkStyle } from '../src/routine.js';
import { runTool } from '../src/tools.js';
import { learnRoutine } from '../src/routine.js';
import { createBlock } from '../src/mark.js';
import { DEFAULT_SETTINGS, STANDARD_WEEK } from '../src/types.js';

const d = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m);
const ctx = { now: () => d(9, 12) };

describe('inferWorkStyle', () => {
  it('reads long sittings as deep and short varied ones as varied, with the median length', () => {
    expect(inferWorkStyle([120, 120, 90, 180])).toEqual({ style: 'deep', medianMinutes: 120 });
    expect(inferWorkStyle([30, 45, 60, 45, 30])).toEqual({ style: 'varied', medianMinutes: 45 });
    expect(inferWorkStyle([75, 90, 60])).toEqual({ style: 'balanced', medianMinutes: 75 });
    expect(inferWorkStyle([])).toEqual({ style: 'unknown', medianMinutes: 0 });
  });
});

describe('set_work_style', () => {
  it('sets the session default and the tasks-per-day brake, and reports back', () => {
    const store = new MemoryStore();
    store.saveSettings({ ...DEFAULT_SETTINGS, availability: STANDARD_WEEK });
    const deep = runTool(store, 'set_work_style', { style: 'deep' }, ctx) as any;
    expect(deep.settings).toMatchObject({ workStyle: 'deep', maxBlockMinutes: 120, maxTasksPerDay: 4 });
    const varied = runTool(store, 'set_work_style', { style: 'shorter varied blocks' }, ctx) as any;
    expect(varied.settings).toMatchObject({ workStyle: 'varied', maxBlockMinutes: 60, maxTasksPerDay: 8 });
    const balanced = runTool(store, 'set_work_style', { style: 'mix' }, ctx) as any;
    expect(balanced.settings).toMatchObject({ workStyle: 'balanced', maxBlockMinutes: 90, maxTasksPerDay: 6 });
    expect(() => runTool(store, 'set_work_style', { style: 'purple' }, ctx)).toThrow(/deep, varied, or balanced/);
  });
});

describe('observing the style', () => {
  it('learnRoutine and save_baseline report the observed style', async () => {
    const store = new MemoryStore();
    store.saveSettings({ ...DEFAULT_SETTINGS, availability: [{ days: [5], start: '07:00', end: '18:00' }], workStyle: 'varied', maxBlockMinutes: 60, maxTasksPerDay: 8 });
    runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 240, budget_period: 'day' }, ctx);
    createBlock(store, store.listTasks()[0].id, d(9, 7), d(9, 9), d(9, 6));
    createBlock(store, store.listTasks()[0].id, d(9, 9), d(9, 11), d(9, 6));
    createBlock(store, store.listTasks()[0].id, d(9, 14), d(9, 17), d(9, 6));
    const saved = runTool(store, 'save_baseline', { confirm: true }, ctx) as any;
    expect(saved.observedStyle).toEqual({ style: 'deep', medianMinutes: 120, differsFromSetting: true });
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'DTSTART:20260928T150000Z', 'DTEND:20260928T153000Z', 'SUMMARY:A', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:b', 'DTSTART:20260928T160000Z', 'DTEND:20260928T164500Z', 'SUMMARY:A', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    await runTool(store, 'import_calendar', { url: 'https://example.com/r.ics' }, { now: () => d(9, 12), fetchText: async () => ics });
    const learned = learnRoutine(store.getImportRecord('https://example.com/r.ics')!.events, store.listTasks(), store.getSettings());
    expect(learned.workStyle).toEqual({ style: 'varied', medianMinutes: 30 });
  });
});
