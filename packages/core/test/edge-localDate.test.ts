// Dates the tools print must be the local calendar date. On a UTC-7 machine toISOString().slice(0, 10) happens to agree
// with the local date in office hours, so this file runs in a UTC+9 zone, where the UTC date is the day before until 09:00.
const TZ_BEFORE = process.env.TZ;
process.env.TZ = 'Asia/Tokyo';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store.js';
import { runTool } from '../src/tools.js';
import { DEFAULT_SETTINGS, STANDARD_WEEK, type Task } from '../src/types.js';

afterAll(() => { if (TZ_BEFORE === undefined) delete process.env.TZ; else process.env.TZ = TZ_BEFORE; });

const task = (id: string, name: string): Task => ({ id, name, color: '#000000', priority: 1, budgetMinutes: 60, budgetPeriod: 'day', archived: false, createdAt: '' });
let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
  store.saveSettings({ ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, maxBlockMinutes: 60, minBlockMinutes: 30, slotMinutes: 15 });
  store.upsertTask(task('a', 'A'));
});

describe('tool summaries print the local date in a UTC+ zone', () => {
  it('the process runs in Asia/Tokyo (else this file proves nothing)', () => {
    expect(new Date(2026, 9, 4).getTimezoneOffset()).toBe(-540);
  });
  it('apply_baseline names the week by its local Sunday, not the UTC date of that midnight', () => {
    store.setBaseline({ slots: [{ day: 4, start: '09:00', end: '10:00', kind: 'task', taskId: 'a' }] });
    const ctx = { now: () => new Date(2026, 9, 7, 9) }; // Wed 7 Oct 2026 09:00 JST; Sun 4 Oct 00:00 JST is 3 Oct 15:00Z
    const r = runTool(store, 'apply_baseline', { week_of: 'this week' }, ctx) as any;
    expect(r.week.start).toBe('2026-10-03T15:00:00.000Z');
    expect(r.summary).toBe('Copied 1 baseline block onto the week of Sun 2026-10-04.');
  });
  it('plan_schedule names the capped horizon by its local date', () => {
    const ctx = { now: () => new Date(2026, 9, 7, 3) }; // 03:00 JST: 14 days on is Wed 21 Oct 03:00 JST, 20 Oct 18:00Z
    const r = runTool(store, 'plan_schedule', { until: '2036-01-01' }, ctx) as any;
    expect(r.summary).toMatch(/Planned up to Wed 2026-10-21 only/);
  });
});
