// Edge cases of the Tier A replay: empty and odd scenarios, each instance event where it has nothing to do or must ask,
// the exact error messages, the timelines and the loose seed fields. Nothing here edits a scenario or dialogue file.
import { describe, it, expect } from 'vitest';
import { MemoryStore } from '@ds/core';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEvent, localDate, runScenario, seedStore, snapshot } from '../src/replay.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const weights = JSON.parse(readFileSync(join(here, '..', 'weights.json'), 'utf8'));

// The same tiny Monday as replay.test.mjs: A 09-10, B 10-11, blank 11-12, Lunch 12-13 (busy), C 13-14, blank 14-15, B 15-16.
// Usable spans 09:00-12:00 and 13:00-16:00. 12 Oct 2026 is a Monday.
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
/** Live (pending and done) blocks as "task start-end source", in start order. */
const live = (store) => store.listBlocks().filter((b) => b.status === 'pending' || b.status === 'done').sort((a, b) => a.start.localeCompare(b.start))
  .map((b) => `${b.taskId} ${hm(b.start)}-${hm(b.end)} ${b.source}`);
const statuses = (store) => store.listBlocks().sort((a, b) => a.start.localeCompare(b.start)).map((b) => `${b.taskId} ${b.status}`);
const commitments = (store) => store.listCommitments().map((c) => `${c.title} ${hm(c.start)}-${hm(c.end)}`).sort();
const nothing = { moved: [], shortened: [], dropped: [], created: [] };
async function applied() {
  const store = new MemoryStore();
  seedStore(store, tiny, localDate('2026-10-12T08:00'));
  await applyEvent(store, { type: 'apply_baseline', weekOf: 'this week' }, localDate('2026-10-12T08:00'));
  return store;
}
const run = (scenario) => runScenario({ name: 'edge', now: '2026-10-12T08:00', ...tiny, ...scenario }, weights);
const withoutMs = (r) => { const { ms, ...rest } = r; return rest; };

const ZERO_SUMMARY = { churn: 0, holes: 0, blobs: 0, splinters: 0, off_segment: 0, budget_miss: 0, must_do_miss: 0, switches: 0, late_start: 0, consistency: 0, friction: 0, p95_ms: 0, hard: 0, errors: 0, slow: 0, under_commitment: 0 };

describe('scenarios with nothing to replay', () => {
  it('no events: no results, every summary figure 0 (not NaN), no timeline, the seed in the final state', async () => {
    const r = await run({});
    expect(r.name).toBe('edge');
    expect(r.results).toEqual([]);
    expect(r.summary).toEqual(ZERO_SUMMARY);
    expect(r.timelines).toEqual([]);
    expect(r.state.blocks).toHaveLength(0);
    expect(r.state.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(r.state.baseline.slots).toHaveLength(5);
  });

  it('a scenario with only `now`: defaults everywhere, no availability, nothing scored', async () => {
    const r = await runScenario({ name: 'bare', now: '2026-10-12T08:00' }, weights);
    expect(r.results).toEqual([]);
    expect(r.summary).toEqual(ZERO_SUMMARY);
    expect(r.state.settings.availability).toEqual([]);
    expect(r.state.tasks).toEqual([]);
    expect(r.state.baseline).toBeUndefined();
  });

  it('advance only: one unscored result carrying the clock, labelled with its target; the summary stays 0', async () => {
    const r = await run({ events: [{ type: 'advance', to: '2026-10-12T14:00' }] });
    expect(r.results).toEqual([{ event: 'advance -> 2026-10-12T14:00', advanced: true }]);
    expect(r.summary).toEqual(ZERO_SUMMARY);
    expect(r.timelines).toEqual([]);
  });

  it('an unknown event type throws the exact message from applyEvent; a scenario records it as an error and keeps going', async () => {
    await expect(applyEvent(new MemoryStore(), { type: 'teleport' }, new Date())).rejects.toThrow('Unknown event type: teleport');
    await expect(applyEvent(new MemoryStore(), {}, new Date())).rejects.toThrow('Unknown event type: undefined');
    const r = await run({ events: [{ type: 'teleport' }, { type: 'apply_baseline', weekOf: 'this week' }] });
    expect(withoutMs(r.results[0])).toEqual({ event: 'teleport', error: 'Unknown event type: teleport' });
    expect(typeof r.results[0].ms).toBe('number');
    expect(r.results[1].event).toBe('apply_baseline');
    expect(r.results[1].churn).toBe(0);
    expect(r.summary.errors).toBe(1);
    expect(r.results[0].friction).toBeUndefined(); // the error result carries no metric
    expect(r.summary.switches).toBe(1); // the apply's own A, B, C, B order; the error adds nothing
    expect(r.summary.friction).toBe(1);
    expect(r.state.blocks).toHaveLength(4);
  });
});

describe('shift_day at its edges', () => {
  it('without `breaks` when the shift would run past the day: needsConfirmation with the question, no block moves, the result lists nothing', async () => {
    const store = await applied();
    const r = await applyEvent(store, { type: 'shift_day' }, localDate('2026-10-12T10:20'));
    expect(r).toEqual({ ...nothing, needsConfirmation: true, summary: 'Shifting 3 blocks by 20 min keeps your breaks (11:00-13:00, 14:00-15:00) but ends the day at 16:20, past 16:00. Waive the breaks to end at 16:00, or keep them and end later?' });
    expect(live(store)).toEqual(['b 10:00-11:00 baseline', 'c 13:00-14:00 baseline', 'b 15:00-16:00 baseline']);
    // The block over at now is materialized as missed even when the shift only asks: that is the unmarked-means-missed rule, not a move.
    expect(statuses(store)).toEqual(['a missed', 'b pending', 'c pending', 'b pending']);
  });

  it('`breaks: "keep"`: every block moves by the delay with its break intact, so the day runs past the baseline\'s 16:00 end', async () => {
    const store = await applied();
    const r = await applyEvent(store, { type: 'shift_day', breaks: 'keep' }, localDate('2026-10-12T10:20'));
    expect(r.needsConfirmation).toBeUndefined();
    expect(r.summary).toBe('Shifted 3 blocks by 20 min (B 10:20-11:20, C 13:20-14:20, B 15:20-16:20), breaks kept; the day ends at 16:20.');
    expect(r.moved.map((b) => b.taskName)).toEqual(['B', 'C', 'B']);
    expect(r.shortened).toEqual([]);
    expect(r.dropped).toEqual([]);
    expect(live(store)).toEqual(['b 10:20-11:20 adjusted', 'c 13:20-14:20 adjusted', 'b 15:20-16:20 adjusted']);
    expect(statuses(store)).toEqual(['a missed', 'b pending', 'c pending', 'b pending']);
  });

  it('a five-minute delay still asks when the last block would end past the wall; nothing moves', async () => {
    const store = await applied();
    const r = await applyEvent(store, { type: 'shift_day' }, localDate('2026-10-12T10:05'));
    expect(r.needsConfirmation).toBe(true);
    expect(r.summary).toBe('Shifting 3 blocks by 5 min keeps your breaks (11:00-13:00, 14:00-15:00) but ends the day at 16:05, past 16:00. Waive the breaks to end at 16:00, or keep them and end later?');
    expect(live(store)).toEqual(['b 10:00-11:00 baseline', 'c 13:00-14:00 baseline', 'b 15:00-16:00 baseline']);
  });

  it('before the first block there is no delay; after the last block there is nothing left, and every block is missed', async () => {
    const early = await applied();
    expect(await applyEvent(early, { type: 'shift_day' }, localDate('2026-10-12T08:00'))).toEqual({ ...nothing, summary: 'Nothing to shift: A starts at 09:00.' });
    expect(live(early)).toHaveLength(4);
    const late = await applied();
    expect(await applyEvent(late, { type: 'shift_day' }, localDate('2026-10-12T17:00'))).toEqual({ ...nothing, summary: 'Nothing to shift today.' });
    expect(statuses(late)).toEqual(['a missed', 'b missed', 'c missed', 'b missed']);
  });

  it('a shift that only asks scores churn 0, no hard violation and no consistency (an adjust event), with the day shape still read', async () => {
    const r = await run({ events: [{ type: 'apply_baseline', weekOf: 'this week' }, { type: 'advance', to: '2026-10-12T10:20' }, { type: 'shift_day' }] });
    const shift = r.results.find((x) => x.event === 'shift_day');
    expect(shift.error).toBeUndefined();
    expect(shift.churn).toBe(0);
    expect(shift.hard).toEqual([]);
    expect(shift.consistency).toBeUndefined();
    expect(shift.holes).toBeDefined();
    expect(r.state.blocks.filter((b) => b.source === 'adjusted')).toHaveLength(0);
  });
});

describe('carve_out and carry_over with nothing to do', () => {
  it('a carve over blank time adds the commitment (default title "Busy") and moves nothing', async () => {
    const store = await applied();
    const r = await applyEvent(store, { type: 'carve_out', from: '2026-10-12T11:00', to: '2026-10-12T12:00' }, localDate('2026-10-12T08:00'));
    expect(r).toEqual({ ...nothing, summary: 'Carved out Busy 11:00-12:00; nothing to move.' });
    expect(live(store)).toEqual(['a 09:00-10:00 baseline', 'b 10:00-11:00 baseline', 'c 13:00-14:00 baseline', 'b 15:00-16:00 baseline']);
    expect(commitments(store)).toEqual(['Busy 11:00-12:00', 'Lunch 12:00-13:00']);
    const gym = await applyEvent(store, { type: 'carve_out', from: '2026-10-13T11:00', to: '2026-10-13T12:00', title: 'Gym' }, localDate('2026-10-12T08:00'));
    expect(gym.summary).toBe('Carved out Gym 11:00-12:00; nothing to move.');
  });

  it('a carve over blank time scores churn 0, no hard violation and nothing under a commitment', async () => {
    const r = await run({ events: [{ type: 'apply_baseline', weekOf: 'this week' }, { type: 'carve_out', from: '2026-10-12T11:00', to: '2026-10-12T12:00', title: 'Call' }] });
    const carve = r.results.find((x) => x.event.startsWith('carve_out'));
    expect(carve.event).toBe('carve_out Call 2026-10-12T11:00 -> 2026-10-12T12:00');
    expect(carve.churn).toBe(0);
    expect(carve.hard).toEqual([]);
    expect(carve.under_commitment).toBe(0);
    expect(carve.consistency).toBeUndefined();
  });

  it('a carve whose end is not after its start throws before adding anything; the scenario records the error and the Lunch is the only commitment', async () => {
    const store = await applied();
    await expect(applyEvent(store, { type: 'carve_out', from: '2026-10-12T12:00', to: '2026-10-12T11:00' }, localDate('2026-10-12T08:00'))).rejects.toThrow('end must be after start');
    expect(commitments(store)).toEqual(['Lunch 12:00-13:00']);
    const r = await run({ events: [{ type: 'apply_baseline', weekOf: 'this week' }, { type: 'carve_out', from: '2026-10-12T12:00', to: '2026-10-12T11:00' }] });
    expect(r.results[1].error).toBe('end must be after start');
    expect(r.summary.errors).toBe(1);
    expect(r.state.commitments.map((c) => c.title)).toEqual(['Lunch']);
  });

  it('carry_over of a task with no block over today: nothing carried, nothing created; a task never scheduled at all says the same', async () => {
    const store = await applied();
    const r = await applyEvent(store, { type: 'carry_over', task: 'C' }, localDate('2026-10-12T11:05'));
    expect(r).toEqual({ ...nothing, summary: 'C: nothing to carry over today.' });
    expect(live(store)).toEqual(['c 13:00-14:00 baseline', 'b 15:00-16:00 baseline']); // a and b ended unmarked and are missed; C's slot is untouched
    const solo = new MemoryStore();
    seedStore(solo, { tasks: [{ name: 'Solo', budgetMinutes: 60 }] }, localDate('2026-10-12T08:00'));
    expect(await applyEvent(solo, { type: 'carry_over', task: 'Solo' }, localDate('2026-10-12T11:05'))).toEqual({ ...nothing, summary: 'Solo: nothing to carry over today.' });
    expect(solo.listBlocks()).toEqual([]);
  });

  it('carry_over of a task that does not exist throws the resolver\'s message, naming the known tasks (or none)', async () => {
    const store = await applied();
    await expect(applyEvent(store, { type: 'carry_over', task: 'Zzz' }, localDate('2026-10-12T11:05'))).rejects.toThrow('No task matches "Zzz". Known tasks: "A", "B", "C".');
    await expect(applyEvent(new MemoryStore(), { type: 'carry_over', task: 'X' }, new Date())).rejects.toThrow('No task matches "X". Known tasks: (none).');
    const r = await run({ events: [{ type: 'apply_baseline', weekOf: 'this week' }, { type: 'carry_over', task: 'Zzz' }] });
    expect(withoutMs(r.results[1])).toEqual({ event: 'carry_over Zzz', error: 'No task matches "Zzz". Known tasks: "A", "B", "C".' });
    expect(r.summary.errors).toBe(1);
  });
});

describe('import_baseline without a directory', () => {
  it('throws the exact message when no `dir` is passed, and the file system error when the file is missing', async () => {
    await expect(applyEvent(new MemoryStore(), { type: 'import_baseline', ics: 'x.ics' }, new Date())).rejects.toThrow('import_baseline needs the scenario\'s directory to read its ics file from');
    await expect(applyEvent(new MemoryStore(), { type: 'import_baseline', ics: 'x.ics' }, new Date(), { dir: '/nonexistent' })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('in a scenario run without `dir`, the import is one error result and nothing else is scored', async () => {
    const r = await run({ events: [{ type: 'import_baseline', ics: 'routine.ics' }] });
    expect(withoutMs(r.results[0])).toEqual({ event: 'import_baseline routine.ics', error: 'import_baseline needs the scenario\'s directory to read its ics file from' });
    expect(r.summary.errors).toBe(1);
    expect(r.summary.hard).toBe(0);
    expect(r.state.baseline.slots).toHaveLength(5); // the seed's baseline, untouched
  });
});

describe('timelines and labels', () => {
  it('one line per day with blocks or commitments, today marked, sources other than planner in parentheses, a commitment in brackets', async () => {
    const r = await run({ events: [{ type: 'apply_baseline', weekOf: 'this week' }, { type: 'carve_out', from: '2026-10-12T13:00', to: '2026-10-12T14:00', title: 'Dentist' }] });
    expect(r.timelines).toEqual(['Mon 10/12 (today): 09:00-10:00 A (baseline) | 10:00-11:00 B (baseline) | 12:00-13:00 [Lunch] | 13:00-14:00 [Dentist] | 14:00-15:00 C (adjusted) | 15:00-16:00 B (baseline)']);
    expect(r.results.map((x) => x.event)).toEqual(['apply_baseline', 'carve_out Dentist 2026-10-12T13:00 -> 2026-10-12T14:00']);
    expect(r.results[1].churn).toBe(0); // the carve's own day from 13:00 on is the user's interruption
  });

  it('a done block is ticked, a planner block carries no source, days outside the range are left out, empty days are skipped', async () => {
    const r = await run({
      range: { from: '2026-10-11T00:00', to: '2026-10-14T00:00' },
      blocks: [
        { task: 'A', start: '2026-10-13T09:00', end: '2026-10-13T10:00', status: 'done' },
        { task: 'C', start: '2026-10-11T09:00', end: '2026-10-11T10:00', source: 'planner' },
        { task: 'B', start: '2026-10-15T09:00', end: '2026-10-15T10:00', source: 'planner' },
      ],
      events: [{ type: 'apply_baseline', weekOf: 'this week' }],
    });
    expect(r.timelines).toEqual([
      'Sun 10/11: 09:00-10:00 C',
      'Mon 10/12 (today): 09:00-10:00 A (baseline) | 10:00-11:00 B (baseline) | 12:00-13:00 [Lunch] | 13:00-14:00 C (baseline) | 15:00-16:00 B (baseline)',
      'Tue 10/13: 09:00-10:00 A (manual) ✓',
    ]);
  });

  it('labels carry what identifies the event: until and horizon, title, from -> to, task, ics', async () => {
    const r = await run({ events: [
      { type: 'plan', until: '2026-10-12T17:00', horizon: 'week', mustDo: ['A'] },
      { type: 'carve_out', from: '2026-10-12T13:00', to: '2026-10-12T14:00', title: 'Dentist' },
      { type: 'carry_over', task: 'A' },
      { type: 'import_baseline', ics: 'r.ics' },
      { type: 'advance', to: '2026-10-12T15:00' },
      { type: 'mark_done', task: 'B' },
    ] });
    expect(r.results.map((x) => x.event)).toEqual([
      'plan until 2026-10-12T17:00 week', 'carve_out Dentist 2026-10-12T13:00 -> 2026-10-12T14:00', 'carry_over A', 'import_baseline r.ics', 'advance -> 2026-10-12T15:00', 'mark_done B',
    ]);
  });
});

describe('localDate and the loose seed fields', () => {
  it('localDate: an offset-less time is local, an ISO string with a zone is passed to Date, a bare date is UTC midnight, garbage is an invalid date', () => {
    const local = localDate('2026-10-12T07:05');
    expect([local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds()]).toEqual([2026, 9, 12, 7, 5, 0]);
    expect(localDate('2026-10-12T07:05:00Z').toISOString()).toBe('2026-10-12T07:05:00.000Z');
    expect(localDate('2026-10-12').toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(Number.isNaN(localDate('garbage').getTime())).toBe(true);
  });

  it('baselineInput: an explicit kind wins over a task name, a slot with only a title is busy, `days: []` lays nothing, an empty or missing slot list saves an empty version 1', () => {
    const store = new MemoryStore();
    seedStore(store, { tasks: [{ name: 'A' }], baseline: { slots: [
      { day: 1, start: '09:00', end: '10:00', task: 'A', kind: 'busy', title: 'Overridden' },
      { day: 2, start: '09:00', end: '10:00', title: 'Standup' },
      { days: [], start: '09:00', end: '10:00', task: 'A' },
    ] } }, localDate('2026-10-12T08:00'));
    expect(store.getBaseline().slots).toEqual([
      { day: 1, start: '09:00', end: '10:00', kind: 'busy', title: 'Overridden' },
      { day: 2, start: '09:00', end: '10:00', kind: 'busy', title: 'Standup' },
    ]);
    for (const baseline of [{ slots: [] }, {}]) {
      const s = new MemoryStore();
      seedStore(s, { baseline }, localDate('2026-10-12T08:00'));
      expect(s.getBaseline().version).toBe(1);
      expect(s.getBaseline().slots).toEqual([]);
    }
  });

  it('blocks seeded with startIn/durationMinutes are relative to now, default to 60 minutes, pending, manual, and ids b0, b1, …', () => {
    const store = new MemoryStore();
    const now = localDate('2026-10-12T10:00');
    seedStore(store, { tasks: [{ name: 'A' }], blocks: [{ task: 'A', startIn: -30, durationMinutes: 45 }, { task: 'A', startIn: 120 }] }, now);
    const bs = store.listBlocks().sort((a, b) => a.start.localeCompare(b.start));
    expect(bs.map((b) => `${b.id} ${hm(b.start)}-${hm(b.end)} ${b.status} ${b.source}`)).toEqual(['b0 09:30-10:15 pending manual', 'b1 12:00-13:00 pending manual']);
    const s = snapshot(store);
    expect(s.settings.availability).toEqual([]); // no baseline with a task slot: the settings' (empty) windows hold
    expect(s.baseline).toBeUndefined();
  });
});
