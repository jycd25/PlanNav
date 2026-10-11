import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/store.js';
import { SETUP_LINE, setupStatus } from '../src/setup.js';
import { DEFAULT_SETTINGS, STANDARD_WEEK } from '../src/types.js';

const task = { id: 't', name: 'A', color: '#000', priority: 1, budgetMinutes: 60, budgetPeriod: 'day' as const, archived: false, createdAt: '' };

describe('setupStatus', () => {
  it('is ready exactly when a baseline week exists; availability and tasks alone are not a setup', () => {
    const s = new MemoryStore();
    expect(setupStatus(s)).toMatchObject({ ready: false, hasAvailability: false, hasTasks: false, missing: ['baseline'], next_step: SETUP_LINE });
    s.saveSettings({ ...DEFAULT_SETTINGS, availability: STANDARD_WEEK });
    s.upsertTask(task);
    expect(setupStatus(s)).toMatchObject({ ready: false, hasAvailability: true, hasTasks: true, missing: ['baseline'] });
    s.setBaseline({ slots: [{ day: 1, start: '09:00', end: '10:00', kind: 'task', taskId: 't' }] });
    expect(setupStatus(s)).toMatchObject({ ready: true, missing: [], next_step: null, recurringCount: 0, commitmentCount: 0 });
  });
  it('a baseline of busy slots only is not a baseline: it says nothing about work time', () => {
    const s = new MemoryStore();
    s.upsertTask(task);
    s.setBaseline({ slots: [{ day: 1, start: '12:00', end: '13:00', kind: 'busy', title: 'Lunch' }] });
    expect(setupStatus(s)).toMatchObject({ ready: false, hasAvailability: false, missing: ['baseline'] });
    s.setBaseline({ slots: [{ day: 1, start: '09:00', end: '10:00', kind: 'task', taskId: 't' }] });
    expect(setupStatus(s)).toMatchObject({ ready: true, hasAvailability: true, missing: [] });
  });
  it('the next step is the one-line setup: import a past week, draw the week, or ask for a suggestion; no question script', () => {
    expect(SETUP_LINE).toBe("No baseline yet. Say: import a past week with the Import button and tick 'Use as my baseline', or draw your week on the Baseline tab; or ask me to suggest one from your tasks.");
  });
  it('ignores archived tasks', () => {
    const s = new MemoryStore();
    s.saveSettings({ ...DEFAULT_SETTINGS, availability: STANDARD_WEEK });
    s.upsertTask({ ...task, archived: true });
    expect(setupStatus(s).hasTasks).toBe(false);
  });
});
