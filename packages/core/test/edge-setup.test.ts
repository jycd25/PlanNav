import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/store.js';
import { setupStatus } from '../src/setup.js';
import { DEFAULT_SETTINGS, STANDARD_WEEK } from '../src/types.js';

const task = { id: 't', name: 'A', color: '#000', priority: 1, budgetMinutes: 60, budgetPeriod: 'day' as const, archived: false, createdAt: '' };
const taskSlot = { day: 1, start: '09:00', end: '10:00', kind: 'task' as const, taskId: 't' };
const busySlot = { day: 1, start: '12:00', end: '13:00', kind: 'busy' as const, title: 'Lunch' };

describe('setupStatus at the edges', () => {
  it('the latest baseline version decides: a task-slot version followed by a busy-only one is no setup', () => {
    const s = new MemoryStore();
    s.setBaseline({ slots: [taskSlot] });
    expect(setupStatus(s).ready).toBe(true);
    s.setBaseline({ slots: [busySlot] });
    expect(setupStatus(s)).toMatchObject({ ready: false, hasAvailability: false, missing: ['baseline'] });
    s.setBaseline({ slots: [] });
    expect(setupStatus(s).ready).toBe(false);
  });
  it('a baseline with a task slot is ready even with no task in the store and no settings availability', () => {
    const s = new MemoryStore();
    s.setBaseline({ slots: [taskSlot] });
    expect(setupStatus(s)).toMatchObject({ ready: true, hasAvailability: true, hasTasks: false, missing: [], next_step: null });
  });
  it('a task slot whose task is archived still counts: the baseline is the source of truth', () => {
    const s = new MemoryStore();
    s.upsertTask({ ...task, archived: true });
    s.setBaseline({ slots: [taskSlot] });
    expect(setupStatus(s)).toMatchObject({ ready: true, hasTasks: false });
  });
  it('counts recurring commitments, and only the one-off commitments that are not yet over', () => {
    const s = new MemoryStore();
    const past = new Date(Date.now() - 2 * 3_600_000);
    const future = new Date(Date.now() + 2 * 3_600_000);
    s.addCommitment({ id: 'past', title: 'Past', start: new Date(past.getTime() - 3_600_000).toISOString(), end: past.toISOString() });
    s.addCommitment({ id: 'future', title: 'Future', start: future.toISOString(), end: new Date(future.getTime() + 3_600_000).toISOString() });
    s.addCommitment({ id: 'now', title: 'Now', start: past.toISOString(), end: future.toISOString() });
    s.addRecurring({ id: 'r', title: 'Standup', days: [1], start: '09:00', end: '09:15' });
    s.addRecurring({ id: 'r2', title: 'Never', days: [], start: '09:00', end: '09:15' });
    expect(setupStatus(s)).toMatchObject({ recurringCount: 2, commitmentCount: 2 });
  });
  it('settings availability alone gives hasAvailability without readiness; an empty window list gives neither', () => {
    const s = new MemoryStore();
    s.saveSettings({ ...DEFAULT_SETTINGS, availability: STANDARD_WEEK });
    expect(setupStatus(s)).toMatchObject({ ready: false, hasAvailability: true });
    s.saveSettings({ ...DEFAULT_SETTINGS, availability: [] });
    expect(setupStatus(s)).toMatchObject({ ready: false, hasAvailability: false });
  });
});
