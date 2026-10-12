// Edge cases of the scorer: empty and one-block states, blocks across midnight, odd weights, the protected blocks under
// each event, which keys each event scores, and the corners of churn, late start, holes, must-do and `under`.
import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '@ds/core';
import { ADJUST_EVENTS, INSTANCE_EVENTS, METRICS, PLANNER_EVENTS, USER_EDIT_EVENTS, blobs, budgetMiss, busyOn, churn, churnExempt, composite, consistency, daysIn, freeSpans, hardViolations, holes, lateStart, mustDoMiss, offSegment, scoreState, splinters, switches, underCommitment } from '../src/metrics.mjs';

const d = (day, h, m = 0) => new Date(2026, 9, day, h, m); // Oct 2026, 12 = Mon
const settings = { ...DEFAULT_SETTINGS, availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '13:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }], minBlockMinutes: 30, maxBlockMinutes: 120, slotMinutes: 15, maxTasksPerDay: 4 };
const task = (id, over = {}) => ({ id, name: id, color: '#000', priority: 1, budgetMinutes: 120, budgetPeriod: 'day', archived: false, createdAt: '', ...over });
const block = (id, taskId, start, end, over = {}) => ({ id, taskId, start: start.toISOString(), end: end.toISOString(), status: 'pending', source: 'planner', createdAt: '', statusChangedAt: null, ...over });
const base = (id, taskId, start, end, over = {}) => block(id, taskId, start, end, { source: 'baseline', ...over });
const state = (over = {}) => ({ settings, tasks: [task('a'), task('b')], commitments: [], recurring: [], blocks: [], ...over });
const range = { start: d(12, 0), end: d(13, 0) };
const mins = (a, b) => Math.round((b.getTime() - a.getTime()) / 60_000);
/** Every metric on one state, as scoreState would read it after a plan naming `a`. */
const all = (s, now = d(12, 8), r = range) => ({
  churn: churn(s, s), holes: holes(s, r, now), blobs: blobs(s), splinters: splinters(s, now), off_segment: offSegment(s, now), budget_miss: budgetMiss(s, r, now),
  must_do_miss: mustDoMiss(s, s, { type: 'plan', mustDo: ['a'] }, now), switches: switches(s), late_start: lateStart(s, now), consistency: consistency(s, r, now),
});
const zeros = Object.fromEntries(METRICS.map((k) => [k, 0]));

describe('an empty state', () => {
  it('every metric is 0 and finite with no tasks and no blocks; scoreState after a plan reads all zeros, no hard violation, nothing under', () => {
    const empty = state({ tasks: [] });
    const m = all(empty);
    expect(m).toEqual(zeros);
    for (const v of Object.values(m)) expect(Number.isFinite(v)).toBe(true);
    expect(scoreState(empty, empty, { type: 'plan' }, range, d(12, 8), { churn: 100, holes: 0.1 })).toEqual({ ...zeros, friction: 0, hard: [], under_commitment: 0 });
    expect(underCommitment(empty)).toEqual({ blocks: 0, minutes: 0 });
    expect(hardViolations(empty, empty, { type: 'plan' })).toEqual([]);
  });

  it('no blocks but two tasks of 120: the whole day is a hole up to their 240, a 240 miss, the named task 120 short, and the first block is 480 minutes late', () => {
    expect(all(state())).toEqual({ ...zeros, holes: 240, budget_miss: 240, must_do_miss: 120, late_start: 480 });
  });

  it('blocks of a task that is not in the task list count for nothing', () => {
    const ghost = state({ tasks: [], blocks: [block('1', 'ghost', d(12, 9), d(12, 9, 30)), block('2', 'ghost', d(12, 14), d(12, 14, 30))] });
    expect(all(ghost)).toEqual(zeros);
  });
});

describe('a single block', () => {
  it('one hour of a 120-minute task: 180 fillable minutes left as holes and miss, one splinter (60 of 120 with room beside it), no late start', () => {
    const single = state({ blocks: [block('1', 'a', d(12, 9), d(12, 10))] });
    expect(all(single)).toEqual({ ...zeros, holes: 180, budget_miss: 180, splinters: 1 });
  });

  it('one hour of a 60-minute task alone: every metric 0', () => {
    expect(all(state({ tasks: [task('a', { budgetMinutes: 60 })], blocks: [block('1', 'a', d(12, 9), d(12, 10))] }))).toEqual(zeros);
  });

  it('switches: one block, or two of the same task, make no switch', () => {
    expect(switches(state({ blocks: [block('1', 'a', d(12, 9), d(12, 10))] }))).toBe(0);
    expect(switches(state({ blocks: [block('1', 'a', d(12, 9), d(12, 10)), block('2', 'a', d(12, 14), d(12, 15))] }))).toBe(0);
  });
});

describe('blocks crossing midnight', () => {
  const weekly = task('a', { budgetMinutes: 600, budgetPeriod: 'week', sessionMinutes: 60 });
  const mid = state({ tasks: [weekly], blocks: [block('1', 'a', d(12, 23), d(13, 1))] });

  it('is outside availability after a plan, and after a shift that laid it (a new block is one it touched)', () => {
    expect(hardViolations(state({ tasks: [weekly] }), mid, { type: 'plan' })).toEqual([{ kind: 'outside_availability', block: '1' }]);
    expect(hardViolations(state({ tasks: [weekly] }), mid, { type: 'shift_day' })).toEqual([{ kind: 'outside_availability', block: '1' }]);
  });

  it('busyOn clips it to each day: 60 minutes on Monday, 60 on Tuesday', () => {
    const mon = busyOn(mid, d(12, 0));
    const tue = busyOn(mid, d(13, 0));
    expect(mon).toEqual([{ start: d(12, 23), end: d(13, 0) }]);
    expect(tue).toEqual([{ start: d(13, 0), end: d(13, 1) }]);
    expect(mins(mon[0].start, mon[0].end)).toBe(60);
  });

  it('a commitment on the next morning is shared time: `under` counts the 30 minutes', () => {
    const withCall = { ...mid, commitments: [{ id: 'c', title: 'Call', start: d(13, 0).toISOString(), end: d(13, 0, 30).toISOString() }] };
    expect(underCommitment(withCall)).toEqual({ blocks: 1, minutes: 30 });
  });

  it('day-shape metrics key on the start day: 120 minutes is exactly two 60-minute sessions (no blob), no switch across the day line, the usual start compares 23:00 with 22:00', () => {
    expect(blobs(mid)).toBe(0);
    expect(switches(state({ blocks: [block('1', 'a', d(12, 23), d(13, 1)), block('2', 'b', d(13, 0, 30), d(13, 2))] }))).toBe(0);
    const three = state({ tasks: [task('a')], blocks: [block('1', 'a', d(12, 23), d(13, 1)), block('2', 'a', d(13, 23), d(14, 1)), block('3', 'a', d(14, 22), d(15, 1))] });
    expect(consistency(three, { start: d(12, 0), end: d(19, 0) }, d(12, 8))).toBe(1);
    expect(all(mid, d(12, 8), { start: d(12, 0), end: d(14, 0) })).toEqual({ ...zeros, holes: 960, budget_miss: 480, late_start: 480 }); // 480 of the week's 600 left, both days' 480 free minutes capped at it
  });
});

describe('composite and weights', () => {
  it('no weights, zero weights, missing keys, unknown keys and undefined metrics all read as 0', () => {
    const m = { churn: 1, holes: 100, splinters: 2 };
    expect(composite(m, {})).toBe(0);
    expect(composite(m, { churn: 0, holes: 0, splinters: 0 })).toBe(0);
    expect(composite(m, { churn: 100 })).toBe(100); // holes and splinters have no weight
    expect(composite({ churn: 1 }, { churn: 100, holes: 0.1, nothing: 5 })).toBe(100); // an unweighted metric and an unknown weight add nothing
    expect(composite({}, { churn: 100, holes: 0.1 })).toBe(0);
    expect(composite({ churn: undefined }, { churn: 100 })).toBe(0);
  });

  it('a NaN metric is not masked: it propagates into the composite (the metrics never produce one)', () => {
    expect(Number.isNaN(composite({ holes: NaN }, { holes: 1 }))).toBe(true);
  });

  it('scoreState with empty weights has friction 0 whatever the metrics read', () => {
    const s = state({ blocks: [block('1', 'a', d(12, 9), d(12, 10))] });
    const r = scoreState(s, s, { type: 'plan' }, range, d(12, 8), {});
    expect(r.holes).toBe(180);
    expect(r.friction).toBe(0);
  });
});

describe('protected blocks', () => {
  const before = state({ blocks: [block('m', 'a', d(12, 9), d(12, 10), { source: 'manual' }), base('d', 'b', d(12, 10), d(12, 11), { status: 'done' }), base('p', 'a', d(12, 14), d(12, 15))] });

  it('a manual block moved by any instance operation is a hard violation', () => {
    const moved = state({ blocks: [block('m', 'a', d(12, 9, 30), d(12, 10, 30), { source: 'manual' }), before.blocks[1], before.blocks[2]] });
    for (const type of INSTANCE_EVENTS) expect(hardViolations(before, moved, { type })).toEqual([{ kind: 'protected_changed', block: 'm' }]);
  });

  it('a done block moved by a carve is a hard violation; a manual block resized is too; a manual block whose status changed at the same time is not', () => {
    const doneMoved = state({ blocks: [before.blocks[0], base('d', 'b', d(12, 11), d(12, 12), { status: 'done' }), before.blocks[2]] });
    expect(hardViolations(before, doneMoved, { type: 'carve_out' })).toEqual([{ kind: 'protected_changed', block: 'd' }]);
    const resized = state({ blocks: [block('m', 'a', d(12, 9), d(12, 10, 30), { source: 'manual' }), before.blocks[1], before.blocks[2]] });
    expect(hardViolations(before, resized, { type: 'shift_day' })).toEqual([{ kind: 'protected_changed', block: 'm' }]);
    const marked = state({ blocks: [block('m', 'a', d(12, 9), d(12, 10), { source: 'manual', status: 'done' }), before.blocks[1], before.blocks[2]] });
    expect(hardViolations(before, marked, { type: 'shift_day' })).toEqual([]);
  });

  it('removing both protected blocks is two violations, under an instance event and under a plan alike', () => {
    const gone = state({ blocks: [before.blocks[2]] });
    const two = [{ kind: 'protected_changed', block: 'm' }, { kind: 'protected_changed', block: 'd' }];
    expect(hardViolations(before, gone, { type: 'shift_day' })).toEqual(two);
    expect(hardViolations(before, gone, { type: 'plan' })).toEqual(two);
  });

  it('events that are not planner or import events never raise a hard violation, nor does a missing event', () => {
    const moved = state({ blocks: [block('m', 'a', d(12, 9, 30), d(12, 10, 30), { source: 'manual' })] });
    for (const type of ['mark_done', 'advance', 'add_commitment', 'move_block', 'save_baseline']) expect(hardViolations(before, moved, { type })).toEqual([]);
    expect(hardViolations(before, moved, undefined)).toEqual([]);
  });
});

describe('which keys each event scores', () => {
  const s = state({ blocks: [base('1', 'a', d(12, 9), d(12, 11))] });
  const keys = (type) => Object.keys(scoreState(s, s, type === undefined ? undefined : { type }, range, d(12, 8), {}));
  const shape = ['holes', 'blobs', 'splinters', 'off_segment', 'budget_miss', 'must_do_miss', 'switches', 'late_start'];
  const tail = ['friction', 'hard', 'under_commitment'];

  it('adjust events: churn and the day shape, no consistency', () => {
    for (const type of ADJUST_EVENTS) expect(keys(type)).toEqual(['churn', ...shape, ...tail]);
  });
  it('apply_baseline and the plan events: churn, the day shape and consistency', () => {
    for (const type of ['apply_baseline', 'plan', 'replan_until', 'clear_schedule']) expect(keys(type)).toEqual(['churn', ...shape, 'consistency', ...tail]);
  });
  it('the user\'s own edits: no churn and no day shape', () => {
    for (const type of USER_EDIT_EVENTS) expect(keys(type)).toEqual(tail);
  });
  it('every other event, and no event at all: churn only', () => {
    for (const type of ['mark_done', 'mark_skipped', 'import_baseline', 'advance', 'add_commitment', 'save_baseline', undefined]) expect(keys(type)).toEqual(['churn', ...tail]);
  });
  it('the event sets are disjoint where they must be', () => {
    for (const t of ADJUST_EVENTS) expect(INSTANCE_EVENTS.has(t) && PLANNER_EVENTS.has(t)).toBe(true);
    for (const t of USER_EDIT_EVENTS) expect(PLANNER_EVENTS.has(t)).toBe(false);
    expect(METRICS).toEqual(['churn', 'holes', 'blobs', 'splinters', 'off_segment', 'budget_miss', 'must_do_miss', 'switches', 'late_start', 'consistency']);
  });
});

describe('churn corners', () => {
  const before = state({ blocks: [base('1', 'a', d(12, 9), d(12, 10)), base('2', 'b', d(12, 10), d(12, 11))] });

  it('reads 0 when every block was invalidated (a commitment over both), when the allowance exceeds the changes, when every change is exempt, and when nothing was pending before', () => {
    const covered = state({ commitments: [{ id: 'c', title: 'x', start: d(12, 9).toISOString(), end: d(12, 11).toISOString() }] });
    expect(churn(before, covered)).toBe(0);
    expect(churn(before, state(), 5)).toBe(0);
    expect(churn(before, state(), 0, () => true)).toBe(0);
    expect(churn(before, state(), 1)).toBe(0.5);
    expect(churn(state({ blocks: [base('1', 'a', d(12, 9), d(12, 10), { status: 'done' })] }), state())).toBe(0);
  });

  it('reads 0 when the event removed all availability: no block is still valid', () => {
    expect(churn(before, state({ settings: { ...settings, availability: [] } }))).toBe(0);
  });

  it('churnExempt: carry_over matches the task by id or name, case-insensitively; an unknown task or no event exempts nothing', () => {
    expect(churnExempt({ type: 'carry_over', task: 'A' }, before, d(12, 8))(before.blocks[0])).toBe(true);
    expect(churnExempt({ type: 'carry_over', task: 'a' }, before, d(12, 8))(before.blocks[1])).toBe(false);
    expect(churnExempt({ type: 'carry_over', task: 'Nope' }, before, d(12, 8))(before.blocks[0])).toBe(false);
    expect(churnExempt(undefined, before, d(12, 8))(before.blocks[0])).toBe(false);
    expect(churnExempt({ type: 'shift_day' }, before, d(12, 9, 30))(before.blocks[0])).toBe(true); // ends after now
    expect(churnExempt({ type: 'shift_day' }, before, d(12, 10))(before.blocks[0])).toBe(false); // over at now
  });
});

describe('late start, holes and budget miss corners', () => {
  it('late_start: 0 without availability; the whole day (480) with budget and no block, after hours (tomorrow), on a weekend (Monday), or when the only block is tomorrow', () => {
    expect(lateStart(state({ settings: { ...settings, availability: [] } }), d(12, 8))).toBe(0);
    expect(lateStart(state(), d(12, 8))).toBe(480);
    expect(lateStart(state(), d(12, 20))).toBe(480);
    expect(lateStart(state(), d(17, 8))).toBe(480);
    expect(lateStart(state({ blocks: [block('1', 'a', d(13, 9), d(13, 10))] }), d(12, 8))).toBe(480);
  });

  it('holes: an empty range or a reversed one has no days; a range from mid-day starts at midnight', () => {
    expect(holes(state(), { start: d(12, 0), end: d(12, 0) }, d(12, 8))).toBe(0);
    expect(daysIn({ start: d(13, 0), end: d(12, 0) })).toEqual([]);
    expect(daysIn({ start: d(12, 13), end: d(13, 1) })).toEqual([d(12, 0), d(13, 0)]);
  });

  it('holes: capped at the fillable budget at 08:00 and at noon, 0 once the day is behind us, 0 without availability', () => {
    expect(holes(state(), range, d(12, 8))).toBe(240);
    expect(holes(state(), range, d(12, 12))).toBe(240); // 60 + 240 free from noon, 240 fillable
    expect(holes(state(), range, d(13, 8))).toBe(0);
    expect(holes(state({ settings: { ...settings, availability: [] } }), range, d(12, 8))).toBe(0);
  });

  it('budget_miss: 240 at 08:00, 0 at 18:00 (no free time left to use), 0 once the day is past', () => {
    expect(budgetMiss(state(), range, d(12, 8))).toBe(240);
    expect(budgetMiss(state(), range, d(12, 18))).toBe(0);
    expect(budgetMiss(state(), range, d(13, 8))).toBe(0);
  });

  it('freeSpans: the two windows on a free weekday, a tail shorter than minBlockMinutes dropped, none on a Sunday', () => {
    expect(freeSpans(state(), d(12, 0))).toEqual([{ start: d(12, 9), end: d(12, 13) }, { start: d(12, 14), end: d(12, 18) }]);
    expect(freeSpans(state(), d(12, 0), d(12, 17, 45))).toEqual([]);
    expect(freeSpans(state(), d(12, 0), d(12, 17, 30))).toEqual([{ start: d(12, 17, 30), end: d(12, 18) }]);
    expect(freeSpans(state(), d(11, 0))).toEqual([]);
  });
});

describe('must_do_miss corners', () => {
  it('an unknown name, no availability, or an empty list reads 0', () => {
    expect(mustDoMiss(state(), state(), { type: 'plan', mustDo: ['nope'] }, d(12, 8))).toBe(0);
    const none = state({ settings: { ...settings, availability: [] } });
    expect(mustDoMiss(none, none, { type: 'plan', mustDo: ['a'] }, d(12, 8))).toBe(0);
    expect(mustDoMiss(state(), state(), { type: 'plan', mustDo: [] }, d(12, 8))).toBe(0);
  });

  it('an instance event carrying mustDo is scored like a plan (instance events are planner events)', () => {
    expect(mustDoMiss(state(), state(), { type: 'shift_day', mustDo: ['a'] }, d(12, 8))).toBe(120);
    expect(mustDoMiss(state(), state(), { type: 'apply_baseline', mustDo: ['a'] }, d(12, 8))).toBe(120);
  });
});

describe('under a commitment, corners', () => {
  it('overlapping commitments are merged before the shared minutes are counted; done, skipped, missed and manual blocks are not counted', () => {
    const s = state({
      commitments: [{ id: 'c1', title: 'x', start: d(12, 9).toISOString(), end: d(12, 9, 30).toISOString() }, { id: 'c2', title: 'y', start: d(12, 9, 15).toISOString(), end: d(12, 9, 45).toISOString() }],
      blocks: [
        block('1', 'a', d(12, 9), d(12, 10)), block('2', 'a', d(12, 9), d(12, 10), { status: 'done' }), block('3', 'a', d(12, 9), d(12, 10), { status: 'skipped' }),
        block('4', 'a', d(12, 9), d(12, 10), { status: 'missed' }), block('5', 'a', d(12, 9), d(12, 10), { source: 'manual' }), block('6', 'a', d(12, 9), d(12, 10), { source: 'adjusted' }),
      ],
    });
    expect(underCommitment(s)).toEqual({ blocks: 2, minutes: 90 }); // blocks 1 and 6, 45 merged minutes each
  });

  it('a commitment that only touches a block shares no minute', () => {
    const s = state({ commitments: [{ id: 'c', title: 'x', start: d(12, 10).toISOString(), end: d(12, 11).toISOString() }], blocks: [block('1', 'a', d(12, 9), d(12, 10))] });
    expect(underCommitment(s)).toEqual({ blocks: 0, minutes: 0 });
  });
});
