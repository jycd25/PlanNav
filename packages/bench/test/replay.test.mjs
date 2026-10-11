import { describe, it, expect } from 'vitest';
import { MemoryStore } from '@ds/core';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEvent, localDate, runScenario, seedStore, snapshot } from '../src/replay.mjs';

describe('snapshot', () => {
  it('is a copy: a block the store later updates in place does not change the snapshot taken before', () => {
    const store = new MemoryStore();
    const now = localDate('2026-10-12T09:00');
    seedStore(store, {
      settings: { availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }] },
      tasks: [{ name: 'A', budgetMinutes: 60 }],
      blocks: [{ id: 'b1', task: 'A', start: '2026-10-12T11:00', end: '2026-10-12T12:00', source: 'planner' }],
    }, now);
    const before = snapshot(store);
    store.updateBlock('b1', { start: localDate('2026-10-12T15:00').toISOString(), status: 'done', source: 'manual' });
    const b = before.blocks.find((x) => x.id === 'b1');
    expect(b.start).toBe(localDate('2026-10-12T11:00').toISOString());
    expect(b.status).toBe('pending');
    expect(b.source).toBe('planner');
  });
});

// A tiny baseline week for the instance events: Monday A 09-10, B 10-11, blank 11-12, Lunch 12-13 (busy), C 13-14,
// blank 14-15, B 15-16. Usable spans 09:00-12:00 and 13:00-16:00. 12 Oct 2026 is a Monday.
const scenariosDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'scenarios');
const tiny = {
  settings: { availability: [], slotMinutes: 15, minBlockMinutes: 30, maxBlockMinutes: 120, maxTasksPerDay: 5 },
  tasks: [{ name: 'A', priority: 1, budgetMinutes: 60 }, { name: 'B', priority: 2, budgetMinutes: 120 }, { name: 'C', priority: 3, budgetMinutes: 60 }],
  baseline: { slots: [
    { day: 1, start: '09:00', end: '10:00', task: 'A' }, { day: 1, start: '10:00', end: '11:00', task: 'B' },
    { day: 1, start: '12:00', end: '13:00', kind: 'busy', title: 'Lunch' },
    { day: 1, start: '13:00', end: '14:00', task: 'C' }, { day: 1, start: '15:00', end: '16:00', task: 'B' },
  ] },
};
const hm = (iso) => { const x = new Date(iso); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; };
/** Monday's pending and done blocks as "task start-end source", in start order. */
const monday = (store) => store.listBlocks().filter((b) => b.status === 'pending' || b.status === 'done').sort((a, b) => a.start.localeCompare(b.start))
  .map((b) => `${b.taskId} ${hm(b.start)}-${hm(b.end)} ${b.source}`);
async function applied(nowStr = '2026-10-12T08:00') {
  const store = new MemoryStore();
  const now = localDate(nowStr);
  seedStore(store, tiny, now);
  await applyEvent(store, { type: 'apply_baseline', weekOf: 'this week' }, localDate('2026-10-12T08:00'));
  return store;
}

describe('the baseline seed field', () => {
  it('writes the baseline with setBaseline: task slots by task name (the same slug as blocks), busy slots by title, and `days` for the same slot on several weekdays', () => {
    const store = new MemoryStore();
    seedStore(store, {
      tasks: [{ name: 'Deep work' }, { name: 'Reading', id: 'r1' }],
      baseline: { slots: [
        { days: [1, 2], start: '09:00', end: '10:00', task: 'Deep work' },
        { day: 1, start: '10:00', end: '10:30', taskId: 'r1' },
        { day: 2, start: '12:00', end: '13:00', kind: 'busy', title: 'Lunch' },
      ] },
    }, localDate('2026-10-12T08:00'));
    const b = store.getBaseline();
    expect(b.version).toBe(1);
    expect(b.slots).toEqual([
      { day: 1, start: '09:00', end: '10:00', kind: 'task', taskId: 'deep-work' },
      { day: 1, start: '10:00', end: '10:30', kind: 'task', taskId: 'r1' },
      { day: 2, start: '09:00', end: '10:00', kind: 'task', taskId: 'deep-work' },
      { day: 2, start: '12:00', end: '13:00', kind: 'busy', title: 'Lunch' },
    ]);
  });

  it('no baseline field, no baseline', () => {
    const store = new MemoryStore();
    seedStore(store, { tasks: [{ name: 'A' }] }, localDate('2026-10-12T08:00'));
    expect(store.getBaseline()).toBeUndefined();
  });

  it('the snapshot carries the baseline and the availability it implies, which the scorer reads', () => {
    const store = new MemoryStore();
    seedStore(store, tiny, localDate('2026-10-12T08:00'));
    const s = snapshot(store);
    expect(s.baseline.slots).toHaveLength(5);
    expect(s.settings.availability).toEqual([{ days: [1], start: '09:00', end: '12:00' }, { days: [1], start: '13:00', end: '16:00' }]);
  });
});

describe('instance events', () => {
  it('apply_baseline copies the slots onto the week: task slots as baseline blocks, busy slots as commitments', async () => {
    const store = await applied();
    expect(monday(store)).toEqual(['a 09:00-10:00 baseline', 'b 10:00-11:00 baseline', 'c 13:00-14:00 baseline', 'b 15:00-16:00 baseline']);
    expect(store.listCommitments().map((c) => `${c.title} ${hm(c.start)}-${hm(c.end)}`)).toEqual(['Lunch 12:00-13:00']);
  });

  it('shift_day: the block in progress starts now, the later ones move up inside the usable spans; the block over at now is missed', async () => {
    const store = await applied();
    await applyEvent(store, { type: 'shift_day' }, localDate('2026-10-12T10:20'));
    expect(monday(store)).toEqual(['b 10:20-11:00 adjusted', 'c 11:00-12:00 adjusted', 'b 13:00-14:00 adjusted']);
    expect(store.listBlocks().find((b) => b.taskId === 'a').status).toBe('missed');
  });

  it('carve_out: adds the busy time and pushes the block under it into the next room, in order; the blank stretch absorbs the push', async () => {
    const store = await applied();
    await applyEvent(store, { type: 'carve_out', from: '2026-10-12T13:00', to: '2026-10-12T14:00', title: 'Dentist' }, localDate('2026-10-12T08:00'));
    expect(monday(store)).toEqual(['a 09:00-10:00 baseline', 'b 10:00-11:00 baseline', 'c 14:00-15:00 adjusted', 'b 15:00-16:00 baseline']);
    expect(store.listCommitments().map((c) => `${c.title} ${hm(c.start)}-${hm(c.end)}`).sort()).toEqual(['Dentist 13:00-14:00', 'Lunch 12:00-13:00']);
  });

  it('carry_over: a block that ended unmarked lands whole in the first blank gap today after now', async () => {
    const store = await applied();
    await applyEvent(store, { type: 'carry_over', task: 'A' }, localDate('2026-10-12T11:05'));
    expect(monday(store)).toEqual(['c 13:00-14:00 baseline', 'a 14:00-15:00 adjusted', 'b 15:00-16:00 baseline']);
    expect(store.listBlocks().filter((b) => b.status === 'missed').map((b) => b.taskId).sort()).toEqual(['a', 'b']); // both ended unmarked
  });

  it('import_baseline reads the .ics file relative to the scenario\'s directory and saves it as the baseline (routine.ics: 25 slots, 5 tasks)', async () => {
    const store = new MemoryStore();
    const now = localDate('2026-10-05T06:00');
    seedStore(store, {}, now);
    await applyEvent(store, { type: 'import_baseline', ics: '../dialogues/routine.ics' }, now, { dir: scenariosDir });
    expect(store.getBaseline().slots).toHaveLength(25);
    expect(store.listTasks()).toHaveLength(5);
    await expect(applyEvent(store, { type: 'import_baseline', ics: 'routine.ics' }, now, {})).rejects.toThrow(/directory/);
  });
});

describe('the instance scenarios', () => {
  const load = (name) => JSON.parse(readFileSync(join(scenariosDir, `${name}.json`), 'utf8'));
  const run = (name) => runScenario(load(name), weights, { dir: scenariosDir });
  const weights = JSON.parse(readFileSync(join(scenariosDir, '..', 'weights.json'), 'utf8'));
  const day = (state, date) => state.blocks.filter((b) => (b.status === 'pending' || b.status === 'done') && localDate(`${date}T00:00`) <= new Date(b.start) && new Date(b.start) < localDate(`${date}T23:59`))
    .sort((a, b) => a.start.localeCompare(b.start)).map((b) => `${state.tasks.find((t) => t.id === b.taskId).name} ${hm(b.start)}-${hm(b.end)}`);

  it('apply-week: the week is the baseline, churn 0, holes 0, nothing under a commitment', async () => {
    const r = await run('apply-week');
    expect(r.summary.churn).toBe(0);
    expect(r.summary.holes).toBe(0);
    expect(r.summary.under_commitment).toBe(0);
    expect(r.summary.hard).toBe(0);
    expect(r.summary.errors).toBe(0);
    expect(r.state.blocks.filter((b) => b.source === 'baseline')).toHaveLength(35);
  });

  it('shift-day: Monday compacts from 10:40 around the call and the lowest-priority block that no longer fits is dropped (kept as missed)', async () => {
    const r = await run('shift-day');
    expect(r.summary.errors).toBe(0);
    expect(r.summary.hard).toBe(0);
    expect(day(r.state, '2026-10-12')).toEqual(['Writing 10:40-11:00', 'Reading 13:00-14:00', 'Building 14:00-15:00', 'Design 15:00-16:00', 'Journal 16:00-17:00']);
    expect(r.state.blocks.filter((b) => b.taskId === 'review' && b.start.startsWith('2026-10-12')).map((b) => b.status)).toEqual(['missed']); // not live, so carry_over can owe it
  });

  it('consistency: scored after apply_baseline (apply-week, 0), not after the shift (shift-day scores it 0: only its apply counts)', async () => {
    const a = await run('apply-week');
    expect(a.results.find((x) => x.event.startsWith('apply_baseline')).consistency).toBe(0);
    const r = await run('shift-day');
    expect(r.results.find((x) => x.event === 'shift_day').consistency).toBeUndefined();
    expect(r.summary.consistency).toBe(0);
    for (const name of ['carve-out', 'carry-over']) expect((await run(name)).summary.consistency).toBe(0);
  });

  it('carve-out: busy 14:00-15:00 on Monday, the blocks keep their order and the pushed ones follow into the blank hour', async () => {
    const r = await run('carve-out');
    expect(r.summary.errors).toBe(0);
    expect(r.summary.hard).toBe(0);
    expect(r.summary.churn).toBe(0);
    expect(day(r.state, '2026-10-12')).toEqual(['Leetcode 09:00-10:00', 'Writing 10:00-11:00', 'Reading 11:00-12:00', 'Building 13:00-14:00', 'Design 15:00-16:00', 'Journal 16:00-17:00', 'Review 17:00-18:00']);
  });

  it('carry-over: Writing ended unmarked, its hour lands in the blank hour today', async () => {
    const r = await run('carry-over');
    expect(r.summary.errors).toBe(0);
    expect(r.summary.hard).toBe(0);
    expect(day(r.state, '2026-10-12')).toEqual(['Leetcode 09:00-10:00', 'Reading 11:00-12:00', 'Building 13:00-14:00', 'Design 14:00-15:00', 'Journal 15:00-16:00', 'Writing 16:00-17:00', 'Review 17:00-18:00']);
  });

  it('import-as-baseline: routine.ics yields 25 slots and 5 tasks, and applying it lays 25 blocks on the week', async () => {
    const r = await run('import-as-baseline');
    expect(r.summary.errors).toBe(0);
    expect(r.summary.hard).toBe(0);
    expect(r.state.baseline.slots).toHaveLength(25);
    expect(r.state.tasks).toHaveLength(5);
    expect(r.state.blocks.filter((b) => b.source === 'baseline')).toHaveLength(25);
    expect(r.summary.holes).toBe(0);
    expect(r.summary.budget_miss).toBe(0);
  });
});
