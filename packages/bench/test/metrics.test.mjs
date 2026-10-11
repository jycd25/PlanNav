import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '@ds/core';
import { blobs, budgetMiss, churn, composite, consistency, hardViolations, holes, lateStart, mustDoMiss, offSegment, scoreState, splinters, switches, underCommitment } from '../src/metrics.mjs';

const d = (day, h, m = 0) => new Date(2026, 9, day, h, m); // Oct 2026, 12 = Mon
const settings = { ...DEFAULT_SETTINGS, availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '13:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }], minBlockMinutes: 30, maxBlockMinutes: 120, slotMinutes: 15, maxTasksPerDay: 4 };
const task = (id, over = {}) => ({ id, name: id, color: '#000', priority: 1, budgetMinutes: 120, budgetPeriod: 'day', archived: false, createdAt: '', ...over });
const block = (id, taskId, start, end, over = {}) => ({ id, taskId, start: start.toISOString(), end: end.toISOString(), status: 'pending', source: 'planner', createdAt: '', statusChangedAt: null, ...over });
const state = (over = {}) => ({ settings, tasks: [task('a'), task('b')], commitments: [], recurring: [], blocks: [], ...over });
const range = { start: d(12, 0), end: d(13, 0) };

describe('hard constraints', () => {
  it('flags planner blocks outside availability or overlapping, and protected blocks that moved', () => {
    const before = state({ blocks: [block('m', 'a', d(12, 9), d(12, 10), { source: 'manual' })] });
    const after = state({ blocks: [
      block('m', 'a', d(12, 10), d(12, 11), { source: 'manual' }),      // protected block moved by the planner
      block('p1', 'b', d(12, 13), d(12, 14)),                           // in the lunch gap
      block('p2', 'b', d(12, 10, 30), d(12, 11, 30)),                   // overlaps m
    ] });
    const v = hardViolations(before, after, { type: 'plan' });
    expect(v.map((x) => x.kind).sort()).toEqual(['outside_availability', 'overlap', 'protected_changed']);
    expect(hardViolations(before, before, { type: 'plan' })).toEqual([]);
    expect(hardViolations(before, after, { type: 'add_commitment' })).toEqual([]); // not the planner's doing until the next plan
  });
});

describe('a planner block under a commitment', () => {
  const under = state({
    commitments: [{ id: 'c', title: 'Offsite', start: d(15, 9).toISOString(), end: d(15, 12).toISOString() }],
    blocks: [block('1', 'a', d(12, 9), d(12, 10)), block('2', 'a', d(15, 9), d(15, 10)), block('3', 'b', d(15, 10), d(15, 11), { status: 'done' }), block('4', 'b', d(15, 11), d(15, 12), { source: 'manual' })],
  });
  it('is counted after any event: pending planner blocks only, by the minutes they share with commitments and recurring occurrences', () => {
    expect(underCommitment(under)).toEqual({ blocks: 1, minutes: 60 }); // block 2; the done block and the hand-placed one are not the planner's doing
    const standup = state({ recurring: [{ id: 'r', title: 'Standup', days: [1, 2, 3, 4, 5], start: '10:00', end: '10:15' }], blocks: [block('1', 'a', d(12, 9, 30), d(12, 11))] });
    expect(underCommitment(standup)).toEqual({ blocks: 1, minutes: 15 });
    expect(underCommitment(state())).toEqual({ blocks: 0, minutes: 0 });
  });
  it('is soft after a commitment lands (the product never auto-plans) and hard after the next planner event, on any day', () => {
    const landed = scoreState(state({ blocks: under.blocks }), under, { type: 'add_commitment' }, { start: d(12, 0), end: d(13, 0) }, d(12, 8), { churn: 100 });
    expect(landed.hard).toEqual([]);
    expect(landed.under_commitment).toBe(1);
    const planned = scoreState(under, under, { type: 'plan' }, { start: d(12, 0), end: d(13, 0) }, d(14, 9), { churn: 100 });
    expect(planned.hard.map((h) => h.kind)).toEqual(['block_under_commitment']); // Thursday is outside the Wednesday window and still the planner's
    expect(planned.under_commitment).toBe(1);
  });
});

describe('must_do_miss', () => {
  const weekly = task('w', { sessionMinutes: 120, budgetMinutes: 300, budgetPeriod: 'week' });
  const before = state({ tasks: [task('a'), weekly], blocks: [block('1', 'a', d(12, 9), d(12, 11))] });
  it('is the minutes a named task ends the plan short of min(session, budget left) on the window\'s first available day', () => {
    const placed = state({ tasks: [task('a'), weekly], blocks: [block('1', 'a', d(12, 9), d(12, 11)), block('2', 'w', d(12, 11), d(12, 13))] });
    expect(mustDoMiss(before, placed, { type: 'plan', mustDo: ['w'] }, d(12, 8))).toBe(0);
    expect(mustDoMiss(before, before, { type: 'plan', mustDo: ['w'] }, d(12, 8))).toBe(120); // nothing landed
    const half = state({ tasks: [task('a'), weekly], blocks: [block('1', 'a', d(12, 9), d(12, 11)), block('2', 'w', d(12, 11), d(12, 12))] });
    expect(mustDoMiss(before, half, { type: 'plan', mustDo: ['w'] }, d(12, 8))).toBe(60);
    expect(mustDoMiss(before, before, { type: 'plan' }, d(12, 8))).toBe(0); // nothing named
    expect(mustDoMiss(before, before, { type: 'add_commitment', mustDo: ['w'] }, d(12, 8))).toBe(0); // not a plan
  });
  it('expects only what the budget still allows, and nothing below a block\'s worth; a block already there counts', () => {
    const nearlyDone = state({ tasks: [task('a'), weekly], blocks: [block('1', 'w', d(12, 9), d(12, 13)), block('2', 'w', d(13, 9), d(13, 10), { status: 'done' })] }); // 240 + 60: nothing left
    expect(mustDoMiss(nearlyDone, nearlyDone, { type: 'plan', mustDo: ['w'] }, d(14, 8))).toBe(0);
    const sixtyLeft = state({ tasks: [task('a'), weekly], blocks: [block('1', 'w', d(12, 9), d(12, 13))] }); // 240 of 300: 60 left
    expect(mustDoMiss(sixtyLeft, sixtyLeft, { type: 'plan', mustDo: ['w'] }, d(14, 8))).toBe(60);
    const manual = state({ tasks: [task('a'), weekly], blocks: [block('m', 'w', d(12, 11), d(12, 11, 30), { source: 'manual' })] }); // 30 by hand today, 270 left: a sitting is 120
    expect(mustDoMiss(manual, manual, { type: 'plan', mustDo: ['w'] }, d(12, 8))).toBe(90);
    const fifteen = state({ tasks: [task('a'), weekly], blocks: [block('1', 'w', d(12, 9), d(12, 13)), block('2', 'w', d(13, 9), d(13, 11, 45), { status: 'done' })] }); // 15 left: below a block
    expect(mustDoMiss(fifteen, fifteen, { type: 'plan', mustDo: ['w'] }, d(14, 8))).toBe(0);
  });
  it('judges the window\'s first available day: after hours the day is tomorrow, and the name may be the task\'s name or id', () => {
    const tomorrow = state({ tasks: [task('a'), weekly], blocks: [block('2', 'w', d(13, 9), d(13, 11))] });
    expect(mustDoMiss(before, tomorrow, { type: 'plan', mustDo: ['w'] }, d(12, 22))).toBe(0);
    expect(mustDoMiss(before, before, { type: 'plan', mustDo: ['W'] }, d(12, 22))).toBe(120);
  });
});

describe('churn', () => {
  it('counts still-valid planner blocks that moved or vanished, ignoring ones the event invalidated', () => {
    const before = state({ blocks: [block('1', 'a', d(12, 9), d(12, 10)), block('2', 'b', d(12, 10), d(12, 11)), block('3', 'a', d(12, 14), d(12, 15))] });
    const after = state({
      commitments: [{ id: 'c', title: 'Dentist', start: d(12, 10).toISOString(), end: d(12, 11).toISOString() }],
      blocks: [block('1', 'a', d(12, 9), d(12, 10)), block('2', 'b', d(12, 11), d(12, 12)), block('3', 'a', d(12, 15), d(12, 16))],
    });
    expect(churn(before, after)).toBeCloseTo(0.5); // block 2 was invalidated by the commitment; of the 2 valid ones, block 3 moved
    expect(churn(state(), after)).toBe(0);
  });
  it('a block re-created at the same time under a new id is not churn; only time changes and removals are', () => {
    const before = state({ blocks: [block('1', 'a', d(12, 9), d(12, 10)), block('2', 'b', d(12, 10), d(12, 11)), block('3', 'a', d(12, 14), d(12, 15))] });
    const sameTimes = state({ blocks: [block('x', 'a', d(12, 9), d(12, 10)), block('2', 'b', d(12, 10), d(12, 11)), block('y', 'a', d(12, 15), d(12, 16))] });
    expect(churn(before, sameTimes)).toBeCloseTo(1 / 3); // 1 came back as x where it was; 3 came back as y an hour later
    const otherTask = state({ blocks: [block('x', 'b', d(12, 9), d(12, 10)), block('2', 'b', d(12, 10), d(12, 11)), block('3', 'a', d(12, 14), d(12, 15))] });
    expect(churn(before, otherTask)).toBeCloseTo(1 / 3); // another task at 09:00 is a change the user sees
  });
  it('an event may allow a number of blocks to give way (a must-do sitting); only changes beyond that count', () => {
    const before = state({ blocks: [block('1', 'a', d(12, 9), d(12, 10)), block('2', 'b', d(12, 10), d(12, 11)), block('3', 'a', d(12, 14), d(12, 15))] });
    const oneGone = state({ blocks: [block('1', 'a', d(12, 9), d(12, 10)), block('2', 'b', d(12, 10), d(12, 11))] });
    expect(churn(before, oneGone)).toBeCloseTo(1 / 3);
    expect(churn(before, oneGone, 1)).toBe(0);
    const twoGone = state({ blocks: [block('1', 'a', d(12, 9), d(12, 10))] });
    expect(churn(before, twoGone, 1)).toBeCloseTo(1 / 3);
  });
});

describe('day-shape metrics', () => {
  it('holes: free spans while budget remains, on days from now on, capped at what the remaining budgets could fill', () => {
    const s = state({ blocks: [block('1', 'a', d(12, 9), d(12, 11))] }); // a has 0 left, b has 120 left -> 2h + 4h free, but only 120 of it fillable
    expect(holes(s, range, d(12, 8))).toBe(120);
    const wanting = state({ tasks: [task('a'), task('b', { budgetMinutes: 600 })], blocks: [block('1', 'a', d(12, 9), d(12, 11))] });
    expect(holes(wanting, range, d(12, 8))).toBe(360); // b could fill all 360 free minutes
    const full = state({ tasks: [task('a', { budgetMinutes: 120 })], blocks: [block('1', 'a', d(12, 9), d(12, 11))] });
    expect(holes(full, range, d(12, 8))).toBe(0);
    const scraps = state({ tasks: [task('a', { budgetMinutes: 130 })], blocks: [block('1', 'a', d(12, 9), d(12, 11))] });
    expect(holes(scraps, range, d(12, 8))).toBe(0); // 10 minutes left is below minBlockMinutes: nothing could be placed
  });
  it('a day at the task cap has no fillable holes', () => {
    // maxTasksPerDay is 4: four tasks on the day leave its free time to the user's setting, whatever budget is left.
    const four = ['a', 'b', 'c', 'd'].map((id) => task(id, { budgetMinutes: 60 }));
    const capped = state({ tasks: [...four, task('w', { budgetPeriod: 'week', budgetMinutes: 600 })], blocks: four.map((t, i) => block(t.id, t.id, d(12, 9 + i), d(12, 10 + i))) });
    expect(holes(capped, range, d(12, 8))).toBe(0);
    const three = state({ tasks: [...four.slice(0, 3), task('w', { budgetPeriod: 'week', budgetMinutes: 600 })], blocks: four.slice(0, 3).map((t, i) => block(t.id, t.id, d(12, 9 + i), d(12, 10 + i))) });
    expect(holes(three, range, d(12, 8))).toBe(300); // below the cap the free time is still a hole
  });
  it('budget_miss: free time on a day at the task cap is not fillable', () => {
    const four = ['a', 'b', 'c', 'd'].map((id) => task(id, { budgetMinutes: 60 }));
    const capped = state({ tasks: [...four, task('w', { budgetPeriod: 'week', budgetMinutes: 120 })], blocks: four.map((t, i) => block(t.id, t.id, d(12, 9 + i), d(12, 10 + i))) });
    expect(budgetMiss(capped, range, d(12, 8))).toBe(0);
    const three = state({ tasks: [...four.slice(0, 3), task('w', { budgetPeriod: 'week', budgetMinutes: 120 })], blocks: four.slice(0, 3).map((t, i) => block(t.id, t.id, d(12, 9 + i), d(12, 10 + i))) });
    expect(budgetMiss(three, range, d(12, 8))).toBe(120); // below the cap: w's 120 had free time
  });
  it('blobs and splinters', () => {
    const s = state({ tasks: [task('a', { sessionMinutes: 60, budgetMinutes: 240 })], blocks: [block('1', 'a', d(12, 9), d(12, 12)), block('2', 'a', d(12, 14), d(12, 14, 30)), block('3', 'a', d(12, 15), d(12, 15, 30))] });
    expect(blobs(s)).toBe(60); // 4h in one day, but the longest stretch is 9-12 (3h): 1h over 2×session; the two half hours after it are separate stretches
    expect(splinters(s, d(12, 8))).toBe(1); // 14:00-14:30 needed 60 and had 14:30-15:00 free beside it; 15:00-15:30 is the last 30 of the budget
  });
  it('splinters: a pair parted only by a commitment of 30 minutes or less is one sitting', () => {
    const standup = [{ id: 'r', title: 'Standup', days: [1, 2, 3, 4, 5], start: '10:00', end: '10:15' }];
    const weekly = task('a', { sessionMinutes: 120, budgetMinutes: 300, budgetPeriod: 'week' });
    const split = state({ tasks: [weekly], recurring: standup, blocks: [block('1', 'a', d(12, 9, 30), d(12, 10)), block('2', 'a', d(12, 10, 15), d(12, 11, 45))] });
    expect(splinters(split, d(12, 8))).toBe(0); // 30 + 90 around a 15-minute standup is one 120-minute sitting
    const meeting = [{ id: 'c', title: 'Sync', start: d(12, 10).toISOString(), end: d(12, 10, 45).toISOString() }];
    const parted = state({ tasks: [weekly], commitments: meeting, blocks: [block('1', 'a', d(12, 9, 30), d(12, 10)), block('2', 'a', d(12, 10, 45), d(12, 12, 15))] });
    expect(splinters(parted, d(12, 8))).toBe(2); // a 45-minute meeting parts them: the 90 had 12:15-13:00 free beside it, and the 30 had the whole afternoon
  });
  it('splinters: a block shorter than what the task still needed, with free time beside it to be whole', () => {
    const standup = [{ id: 'r', title: 'Standup', days: [1, 2, 3, 4, 5], start: '10:00', end: '10:15' }];
    const s = state({
      tasks: [task('a', { sessionMinutes: 120, budgetMinutes: 300, budgetPeriod: 'week' }), task('b', { sessionMinutes: 60, budgetMinutes: 60 })],
      recurring: standup,
      commitments: [{ id: 'c', title: 'Offsite', start: d(14, 10, 15).toISOString(), end: d(14, 18).toISOString() }],
      blocks: [
        block('1', 'b', d(12, 14), d(12, 14, 30)),   // Mon: 30 of a 60 session, the afternoon free after it -> splinter
        block('2', 'a', d(13, 10, 15), d(13, 12)),   // Tue: 105 of a 120 session with 300 left, 12:00-13:00 free -> splinter
        block('3', 'a', d(14, 9), d(14, 10)),        // Wed: 60 with 195 left, but the window start, the standup, and the offsite leave nowhere for 120
      ],
    });
    expect(splinters(s, d(12, 8))).toBe(2);
    expect(splinters(s, d(13, 11))).toBe(1); // Tue at 11:00, the 105 in progress: 12:00-13:00 is still beside it; Monday is past
    expect(splinters(s, d(13, 12, 30))).toBe(0); // Tue at 12:30: the sitting is over and is not re-judged
    const late = state({ tasks: [task('b', { sessionMinutes: 60, budgetMinutes: 60 })], blocks: [block('1', 'b', d(12, 17, 30), d(12, 18))] });
    expect(splinters(late, d(12, 8))).toBe(1); // the free afternoon before it would have made it whole
    expect(splinters(late, d(12, 17, 45))).toBe(0); // in progress at 17:45: the afternoon before it has passed and is not room
  });
  it('splinters: a free slot elsewhere on the day long enough for the sitting is room too', () => {
    // Two 90-minute tasks each cut to 60 in the morning, hemming each other in, while the afternoon is free.
    const s = state({
      tasks: [task('a', { sessionMinutes: 90, budgetMinutes: 90 }), task('b', { sessionMinutes: 90, budgetMinutes: 90 })],
      blocks: [block('1', 'a', d(12, 9), d(12, 10)), block('2', 'b', d(12, 10), d(12, 11)), block('3', 'a', d(12, 11), d(12, 11, 30)), block('4', 'b', d(12, 11, 30), d(12, 12))],
    });
    expect(splinters(s, d(12, 8))).toBe(2); // 14:00-18:00 could have held either 90 whole; the two 30s are remainders
    const full = state({ ...s, commitments: [{ id: 'c', title: 'Offsite', start: d(12, 12).toISOString(), end: d(12, 18).toISOString() }] });
    expect(splinters(full, d(12, 8))).toBe(0); // nowhere on the day for a whole 90: not the planner's choice
  });
  it('splinters: the last of a budget is a remainder, not a splinter', () => {
    const s = state({
      tasks: [task('a', { sessionMinutes: 120, budgetMinutes: 300, budgetPeriod: 'week' }), task('b', { sessionMinutes: 60, budgetMinutes: 60 })],
      blocks: [block('1', 'a', d(12, 9), d(12, 11)), block('2', 'a', d(13, 9), d(13, 11)), block('3', 'b', d(14, 9), d(14, 10)), block('4', 'a', d(14, 10), d(14, 11))],
    });
    expect(splinters(s, d(12, 8))).toBe(0); // Wed 10:00-11:00 is what was left of 300, though 11:00-13:00 was free; it does not open the day
  });
  it('splinters: a remainder opening a day is one when another task could have opened it whole, or an earlier planned day had room for it', () => {
    const weekly = task('a', { sessionMinutes: 120, budgetMinutes: 300, budgetPeriod: 'week' });
    const daily = task('b', { sessionMinutes: 60, budgetMinutes: 60 });
    const thursday = [block('1', 'a', d(15, 9), d(15, 11)), block('2', 'a', d(15, 11), d(15, 13))];
    const opener = state({ tasks: [weekly, daily], blocks: [...thursday, block('3', 'a', d(16, 9), d(16, 10)), block('4', 'b', d(16, 10), d(16, 11))] });
    expect(splinters(opener, d(15, 8))).toBe(1); // Friday opens with the last 60 of a; b could have opened it with a whole sitting
    const second = state({ tasks: [weekly, daily], blocks: [...thursday, block('3', 'b', d(16, 9), d(16, 10)), block('4', 'a', d(16, 10), d(16, 11))] });
    expect(splinters(second, d(15, 8))).toBe(0); // the same remainder after b is free
    const alone = state({ tasks: [task('a', { sessionMinutes: 90, budgetMinutes: 210, budgetPeriod: 'week' })], blocks: [block('1', 'a', d(12, 9), d(12, 12)), block('2', 'a', d(14, 9), d(14, 9, 30))] });
    expect(splinters(alone, d(12, 8))).toBe(1); // the last 30 of a opens Wednesday alone, though Monday had room to close with it
    expect(splinters(alone, d(14, 8))).toBe(0); // seen from Wednesday, Monday is past and no other task could have opened: free
  });
  it('switches and late start', () => {
    const s = state({ blocks: [block('1', 'a', d(12, 10), d(12, 11)), block('2', 'b', d(12, 11), d(12, 12)), block('3', 'a', d(12, 14), d(12, 15)), block('4', 'b', d(12, 15), d(12, 16))] });
    expect(switches(s)).toBe(2); // a,b,a,b = 3 transitions, 2 distinct -> 2 extra
    expect(lateStart(s, d(12, 8))).toBe(60); // availability starts 09:00, first block 10:00
    expect(lateStart(state({ tasks: [task('a', { budgetMinutes: 0 })] }), d(12, 8))).toBe(0);
    expect(lateStart(s, d(12, 10, 30))).toBe(0); // a block in progress at now: the user is working, there is no late start
  });
  it('off-segment minutes only when the preferred segment had room', () => {
    const s = state({ tasks: [task('a', { preferredSegment: 'morning' })], blocks: [block('1', 'a', d(12, 14), d(12, 15))] });
    expect(offSegment(s, d(12, 8))).toBe(60);
    const noRoom = state({ tasks: [task('a', { preferredSegment: 'morning' })], commitments: [{ id: 'c', title: 'x', start: d(12, 9).toISOString(), end: d(12, 13).toISOString() }], blocks: [block('1', 'a', d(12, 14), d(12, 15))] });
    expect(offSegment(noRoom, d(12, 8))).toBe(0);
  });
  it('off-segment: a morning that is already in the past is not room', () => {
    const s = state({ tasks: [task('a', { preferredSegment: 'morning' })], blocks: [block('1', 'a', d(12, 14), d(12, 15))] });
    expect(offSegment(s, d(12, 8))).toBe(60);
    expect(offSegment(s, d(12, 11))).toBe(60); // 11:00-12:00 of the morning was still ahead
    expect(offSegment(s, d(12, 13))).toBe(0); // the whole morning had passed when the plan was made
    expect(offSegment(s, d(13, 8))).toBe(0); // a block on a past day is not re-judged
  });
  it('budget miss is unmet budget that had free time to use', () => {
    const s = state({ tasks: [task('a', { budgetMinutes: 180 })], blocks: [block('1', 'a', d(12, 9), d(12, 10))] });
    expect(budgetMiss(s, range, d(12, 8))).toBe(120);
  });
  it('budget miss: a daily task that got no block on a planned day lost its day to weekly sittings, even with no free time left', () => {
    const weekly = task('w', { sessionMinutes: 120, budgetMinutes: 300, budgetPeriod: 'week' });
    const daily = [task('a', { sessionMinutes: 60, budgetMinutes: 60 }), task('b', { sessionMinutes: 60, budgetMinutes: 60 })];
    const allWeekly = [block('1', 'w', d(12, 9), d(12, 11)), block('2', 'w', d(12, 11), d(12, 13)), block('3', 'w', d(12, 14), d(12, 16)), block('4', 'w', d(12, 16), d(12, 18))];
    const starved = state({ tasks: [weekly, ...daily], blocks: allWeekly });
    expect(budgetMiss(starved, range, d(12, 8))).toBe(120); // the day is full of w; a and b each lose their 60
    const capped = state({ tasks: [weekly, ...daily], settings: { ...settings, maxTasksPerDay: 1 }, blocks: allWeekly });
    expect(budgetMiss(capped, range, d(12, 8))).toBe(0); // one task a day is the user's own setting
    const fuller = task('c', { sessionMinutes: 120, budgetMinutes: 480 });
    const littleWeekly = state({ tasks: [weekly, ...daily, fuller], blocks: [block('1', 'w', d(12, 9), d(12, 9, 30)), block('2', 'c', d(12, 9, 30), d(12, 13), { source: 'manual' }), block('3', 'c', d(12, 14), d(12, 18), { source: 'manual' })] });
    expect(budgetMiss(littleWeekly, range, d(12, 8))).toBe(0); // 30 weekly minutes could not have held a 60-minute sitting: not the planner's doing
  });
  it('composite applies the weights', () => {
    const w = { churn: 100, holes: 0.1, blobs: 0, splinters: 1, off_segment: 0, budget_miss: 0, switches: 1, late_start: 0 };
    expect(composite({ churn: 0.5, holes: 100, blobs: 9, splinters: 2, off_segment: 9, budget_miss: 9, switches: 3, late_start: 9 }, w)).toBeCloseTo(65);
  });
});

describe('scoring per event', () => {
  const w = { churn: 100, holes: 0.1, blobs: 0, splinters: 1, off_segment: 0, budget_miss: 0, switches: 1, late_start: 0.1 };
  it('a non-planner event is scored for churn and hard constraints only; the day shape is judged after planner events', () => {
    // At 13:00 the user skips Leetcode; the afternoon is empty while budget remains. That is the product's rule (marking
    // never auto-plans), not friction, so holes and late_start wait for the replan.
    const before = state({ blocks: [block('1', 'a', d(12, 9), d(12, 10)), block('2', 'b', d(12, 14), d(12, 15))] });
    const after = state({ blocks: [block('1', 'a', d(12, 9), d(12, 10)), block('2', 'b', d(12, 14), d(12, 15), { status: 'skipped' })] });
    const skipped = scoreState(before, after, { type: 'mark_skipped' }, range, d(12, 13), w);
    expect(skipped.churn).toBe(0);
    expect(skipped.hard).toEqual([]);
    for (const k of ['holes', 'blobs', 'splinters', 'off_segment', 'budget_miss', 'switches', 'late_start', 'consistency']) expect(skipped[k]).toBeUndefined();
    expect(skipped.friction).toBe(0);
    const planned = scoreState(after, after, { type: 'replan_until' }, range, d(12, 13), w);
    expect(planned.holes).toBe(120); // 14:00-18:00 free; a has 60 left and b 120 less the 60 skipped that day (skipped minutes are not fillable on their day), so 120 of the 240 could be filled
    expect(planned.late_start).toBe(240);
    expect(planned.consistency).toBe(0); // scored after a planner event
    expect(planned.friction).toBeCloseTo(36);
  });
  it('a block the user moved or added by hand is not churn: after move_block and add_block, churn is not scored', () => {
    const before = state({ blocks: [block('1', 'a', d(12, 9), d(12, 10)), block('2', 'b', d(12, 11), d(12, 12))] });
    const moved = state({ blocks: [block('1', 'a', d(12, 9), d(12, 10)), block('2', 'b', d(12, 15), d(12, 16), { source: 'manual' })] });
    const m = scoreState(before, moved, { type: 'move_block', task: 'b' }, range, d(12, 9, 5), w);
    expect(m.churn).toBeUndefined();
    expect(m.friction).toBe(0);
    expect(m.hard).toEqual([]);
    expect(churn(before, moved)).toBeCloseTo(0.5); // the metric itself still sees the move; the event rule leaves it out
  });
});

describe('skipped means not today', () => {
  it('minutes skipped on a day are not fillable that day: no hole and no miss while the task\'s period budget still remains', () => {
    const s = state({ tasks: [task('a')], blocks: [block('1', 'a', d(12, 9), d(12, 10), { status: 'skipped' }), block('2', 'a', d(12, 10), d(12, 11))] });
    expect(holes(s, range, d(12, 11))).toBe(0);
    expect(budgetMiss(s, range, d(12, 11))).toBe(0);
    const notSkipped = state({ tasks: [task('a')], blocks: [block('2', 'a', d(12, 10), d(12, 11))] });
    expect(holes(notSkipped, range, d(12, 11))).toBe(60);
  });
});

describe('missed means not today', () => {
  it('minutes missed on a day are not fillable that day: no hole and no miss while the task\'s period budget still remains', () => {
    const s = state({ tasks: [task('a')], blocks: [block('1', 'a', d(12, 9), d(12, 10), { status: 'missed' }), block('2', 'a', d(12, 10), d(12, 11))] });
    expect(holes(s, range, d(12, 11))).toBe(0);
    expect(budgetMiss(s, range, d(12, 11))).toBe(0);
  });
});

describe('blobs by contiguous run', () => {
  it('counts the longest stretch of one task on a day beyond two sessions, not the day total', () => {
    const run = state({ tasks: [task('a', { budgetMinutes: 300, budgetPeriod: 'week', sessionMinutes: 120 })], blocks: [
      block('1', 'a', d(16, 8), d(16, 10)), block('2', 'a', d(16, 10), d(16, 12)), block('3', 'a', d(16, 12), d(16, 13)), // one 5-hour stretch
    ] });
    expect(blobs(run)).toBe(60);
    const alternated = state({ tasks: [task('a', { budgetMinutes: 300, budgetPeriod: 'week', sessionMinutes: 120 }), task('b', { budgetMinutes: 300, budgetPeriod: 'week', sessionMinutes: 120 })], blocks: [
      block('1', 'a', d(16, 8), d(16, 10)), block('2', 'b', d(16, 10), d(16, 12)), block('3', 'a', d(16, 12), d(16, 13)),
      block('4', 'b', d(16, 14), d(16, 16)), block('5', 'a', d(16, 16), d(16, 18)), block('6', 'b', d(16, 19), d(16, 20)),
    ] });
    expect(blobs(alternated)).toBe(0); // five hours each, no stretch longer than two sessions
  });
  it('a lunch gap or a long commitment ends a run; a short commitment does not', () => {
    const lunch = state({ tasks: [task('a', { budgetMinutes: 300, budgetPeriod: 'week', sessionMinutes: 120 })], blocks: [
      block('1', 'a', d(16, 9), d(16, 13)), block('2', 'a', d(16, 14), d(16, 16)), // 4h, lunch, 2h: two runs
    ] });
    expect(blobs(lunch)).toBe(0);
    const standup = state({ tasks: [task('a', { budgetMinutes: 300, budgetPeriod: 'week', sessionMinutes: 120 })],
      recurring: [{ id: 'r', title: 'Standup', days: [1, 2, 3, 4, 5], start: '10:00', end: '10:15' }],
      blocks: [block('1', 'a', d(16, 8), d(16, 10)), block('2', 'a', d(16, 10, 15), d(16, 12, 15)), block('3', 'a', d(16, 12, 15), d(16, 13))] });
    expect(blobs(standup)).toBe(45); // 8:00-13:00 across a 15-minute standup is one 4h45 run
    const meeting = state({ tasks: [task('a', { budgetMinutes: 300, budgetPeriod: 'week', sessionMinutes: 120 })],
      commitments: [{ id: 'c', title: 'Sync', start: d(16, 10).toISOString(), end: d(16, 10, 45).toISOString() }],
      blocks: [block('1', 'a', d(16, 8), d(16, 10)), block('2', 'a', d(16, 10, 45), d(16, 12, 45))] });
    expect(blobs(meeting)).toBe(0); // a 45-minute commitment parts them: two 2h runs, none beyond two sessions
  });
});

describe('consistency', () => {
  it('counts the days a task starts at a time other than its usual one', () => {
    const s = state({ tasks: [task('a', { budgetMinutes: 60 })], blocks: [
      block('1', 'a', d(12, 10), d(12, 11)), block('2', 'a', d(13, 10), d(13, 11)), block('3', 'a', d(14, 12), d(14, 13)), block('4', 'a', d(15, 10), d(15, 11)),
    ] });
    expect(consistency(s, { start: d(12, 0), end: d(17, 0) }, d(12, 8))).toBe(1);
    const same = state({ tasks: [task('a', { budgetMinutes: 60 })], blocks: [block('1', 'a', d(12, 10), d(12, 11)), block('2', 'a', d(13, 10), d(13, 11))] });
    expect(consistency(same, { start: d(12, 0), end: d(17, 0) }, d(12, 8))).toBe(0);
    const single = state({ tasks: [task('a', { budgetMinutes: 60 })], blocks: [block('1', 'a', d(12, 10), d(12, 11))] });
    expect(consistency(single, { start: d(12, 0), end: d(17, 0) }, d(12, 8))).toBe(0); // one day: nothing to compare
  });
  it('compares the first block of each day, so a second sitting the same day is not a different start; ties go to the earliest start', () => {
    const r = { start: d(12, 0), end: d(17, 0) };
    const two = state({ tasks: [task('a')], blocks: [block('1', 'a', d(12, 10), d(12, 11)), block('2', 'a', d(12, 15), d(12, 16)), block('3', 'a', d(13, 10), d(13, 11))] });
    expect(consistency(two, r, d(12, 8))).toBe(0);
    const tie = state({ tasks: [task('a')], blocks: [block('1', 'a', d(12, 11), d(12, 12)), block('2', 'a', d(13, 9), d(13, 10))] });
    expect(consistency(tie, r, d(12, 8))).toBe(1); // 09:00 and 11:00 tie: the usual is 09:00, so Monday is the one off
  });
  it('counts days from now on, skips skipped blocks, and judges each task on its own', () => {
    const r = { start: d(12, 0), end: d(17, 0) };
    const pastDay = state({ tasks: [task('a')], blocks: [block('1', 'a', d(12, 10), d(12, 11)), block('2', 'a', d(13, 14), d(13, 15))] });
    expect(consistency(pastDay, r, d(13, 8))).toBe(0); // Monday is behind us: Tuesday alone has nothing to compare
    const skipped = state({ tasks: [task('a')], blocks: [block('1', 'a', d(12, 10), d(12, 11)), block('2', 'a', d(13, 14), d(13, 15), { status: 'skipped' })] });
    expect(consistency(skipped, r, d(12, 8))).toBe(0);
    const two = state({ blocks: [block('1', 'a', d(12, 10), d(12, 11)), block('2', 'a', d(13, 10), d(13, 11)), block('3', 'b', d(12, 9), d(12, 10)), block('4', 'b', d(13, 14), d(13, 15))] });
    expect(consistency(two, r, d(12, 8))).toBe(1); // a is steady; b is off one day (09:00 is the earlier of its two)
  });
  it('a done block earlier in the day is that day\'s start', () => {
    const r = { start: d(12, 0), end: d(17, 0) };
    const s = state({ tasks: [task('a')], blocks: [
      block('1', 'a', d(12, 9), d(12, 10), { status: 'done' }), block('2', 'a', d(12, 14), d(12, 15)),
      block('3', 'a', d(13, 14), d(13, 15)), block('4', 'a', d(14, 14), d(14, 15)),
    ] });
    expect(consistency(s, r, d(12, 8))).toBe(1); // Monday starts at 09:00 (done), the other days at 14:00
  });
  it('counts live blocks of any source: the user\'s own placements are the routine, so a planner block off their hour is the inconsistent one', () => {
    const r = { start: d(12, 0), end: d(17, 0) };
    const s = state({ tasks: [task('a')], blocks: [
      block('1', 'a', d(12, 10), d(12, 11)),
      block('2', 'a', d(13, 11), d(13, 12), { source: 'manual' }),
      block('3', 'a', d(14, 11), d(14, 12), { source: 'baseline' }),
    ] });
    expect(consistency(s, r, d(12, 8))).toBe(1);
  });
});

describe('instance events (baseline-first)', () => {
  const base = (id, taskId, start, end, over = {}) => block(id, taskId, start, end, { source: 'baseline', ...over });
  const weights = { churn: 100, holes: 0.1 };

  it('shift_day, carve_out, carry_over and apply_baseline are scored on the day shape; import_baseline only for churn and the hard checks (it lays no block)', () => {
    const s = state({ blocks: [base('1', 'a', d(12, 9), d(12, 11))] });
    for (const type of ['shift_day', 'carve_out', 'carry_over', 'apply_baseline']) expect(scoreState(s, s, { type }, range, d(12, 8), weights).holes).toBeDefined();
    const imp = scoreState(s, s, { type: 'import_baseline' }, range, d(12, 8), weights);
    expect(imp.holes).toBeUndefined();
    expect(imp.churn).toBe(0);
  });

  it('the hard checks after an instance event judge the blocks it laid or moved (any source but manual), and protect manual and done blocks only', () => {
    const before = state({ blocks: [base('1', 'a', d(12, 9), d(12, 10)), base('2', 'b', d(12, 10), d(12, 11)), block('m', 'a', d(12, 15), d(12, 16), { source: 'manual' }), base('x', 'b', d(12, 16), d(12, 17), { status: 'done' })] });
    const moved = state({ blocks: [base('1', 'a', d(12, 9, 30), d(12, 10, 30), { source: 'adjusted' }), base('2', 'b', d(12, 10, 30), d(12, 11, 30), { source: 'adjusted' }), before.blocks[2], before.blocks[3]] });
    expect(hardViolations(before, moved, { type: 'shift_day' })).toEqual([]); // moving baseline blocks is the operation's job
    const bad = state({ blocks: [base('1', 'a', d(12, 12, 30), d(12, 13, 30), { source: 'adjusted' }), base('2', 'b', d(12, 16, 30), d(12, 17), { source: 'adjusted' }), block('m', 'a', d(12, 16), d(12, 17), { source: 'manual' }), base('x', 'b', d(12, 16), d(12, 17), { status: 'done' })] });
    expect(hardViolations(before, bad, { type: 'carve_out' }).map((v) => `${v.kind} ${v.block}`).sort()).toEqual(['outside_availability 1', 'overlap 2', 'protected_changed m']);
    // A block the event did not touch is not the event's doing, even if it sits under a commitment.
    const old = state({ commitments: [{ id: 'c', title: 'Call', start: d(13, 9).toISOString(), end: d(13, 10).toISOString() }], blocks: [base('t', 'a', d(13, 9), d(13, 10))] });
    expect(hardViolations(old, old, { type: 'shift_day' })).toEqual([]);
    const under = state({ commitments: old.commitments, blocks: [base('t', 'a', d(13, 9), d(13, 10), { source: 'adjusted' })] });
    expect(hardViolations(state({ commitments: old.commitments, blocks: [base('t', 'a', d(13, 11), d(13, 12))] }), under, { type: 'carry_over' }).map((v) => v.kind)).toEqual(['block_under_commitment']);
  });

  it('consistency is not scored after shift_day, carve_out or carry_over (the moves the user asked for); it is after apply_baseline and a plan', () => {
    const s = state({ blocks: [base('1', 'a', d(12, 9), d(12, 11))] });
    for (const type of ['shift_day', 'carve_out', 'carry_over']) {
      const m = scoreState(s, s, { type }, range, d(12, 8), weights);
      expect(m.consistency).toBeUndefined();
      expect(m.holes).toBeDefined();
    }
    for (const type of ['apply_baseline', 'plan', 'replan_until']) expect(scoreState(s, s, { type }, range, d(12, 8), weights).consistency).toBeDefined();
  });

  it('import_baseline must not touch a block', () => {
    const before = state({ blocks: [base('1', 'a', d(12, 9), d(12, 10)), block('p', 'b', d(12, 10), d(12, 11))] });
    const after = state({ blocks: [before.blocks[1]] });
    expect(hardViolations(before, after, { type: 'import_baseline' }).map((v) => `${v.kind} ${v.block}`)).toEqual(['protected_changed 1']);
    expect(hardViolations(before, before, { type: 'import_baseline' })).toEqual([]);
  });

  it('churn counts the product\'s blocks (planner, baseline, adjusted), not the hand-placed ones', () => {
    const before = state({ blocks: [base('1', 'a', d(12, 9), d(12, 10)), block('m', 'b', d(12, 10), d(12, 11), { source: 'manual' })] });
    const after = state({ blocks: [base('1', 'a', d(12, 14), d(12, 15)), block('m', 'b', d(12, 15), d(12, 16), { source: 'manual' })] });
    expect(churn(before, after)).toBe(1);
  });

  it('churn per event: what the user asked an instance operation to move is not churn; anything else it moved is', () => {
    const before = state({ blocks: [base('1', 'a', d(12, 9), d(12, 10)), base('2', 'b', d(12, 14), d(12, 15)), base('3', 'a', d(12, 15), d(12, 16)), base('4', 'b', d(13, 9), d(13, 10))] });
    const at = (blocks) => state({ blocks });
    // shift_day: the rest of today is the request; a past block or another day's block moved is churn.
    const shifted = at([before.blocks[0], base('2', 'b', d(12, 11), d(12, 12)), base('3', 'a', d(12, 13), d(12, 14)), before.blocks[3]]);
    expect(scoreState(before, shifted, { type: 'shift_day' }, range, d(12, 10, 30), weights).churn).toBe(0);
    const shiftedTomorrow = at([before.blocks[0], before.blocks[1], before.blocks[2], base('4', 'b', d(13, 11), d(13, 12))]);
    expect(scoreState(before, shiftedTomorrow, { type: 'shift_day' }, range, d(12, 10, 30), weights).churn).toBe(0.25);
    // carve_out: blocks on the carve's day ending after its start are the user's interruption; earlier ones are not.
    const carved = at([before.blocks[0], base('2', 'b', d(12, 15), d(12, 16)), base('3', 'a', d(12, 16), d(12, 17)), before.blocks[3]]);
    expect(scoreState(before, carved, { type: 'carve_out', from: '2026-10-12T14:00', to: '2026-10-12T15:00' }, range, d(12, 8), weights).churn).toBe(0);
    const carvedEarly = at([base('1', 'a', d(12, 10), d(12, 11)), base('2', 'b', d(12, 15), d(12, 16)), before.blocks[2], before.blocks[3]]);
    expect(scoreState(before, carvedEarly, { type: 'carve_out', from: '2026-10-12T14:00', to: '2026-10-12T15:00' }, range, d(12, 8), weights).churn).toBe(0.25);
    // carry_over: the carried task's own blocks may move (a slot extended); another task's may not.
    const carried = at([before.blocks[0], before.blocks[1], base('3', 'a', d(12, 15), d(12, 17)), before.blocks[3]]);
    expect(scoreState(before, carried, { type: 'carry_over', task: 'a' }, range, d(12, 8), weights).churn).toBe(0);
    const carriedOther = at([before.blocks[0], base('2', 'b', d(12, 16), d(12, 17)), before.blocks[2], before.blocks[3]]);
    expect(scoreState(before, carriedOther, { type: 'carry_over', task: 'a' }, range, d(12, 8), weights).churn).toBe(0.25);
  });

  it('`under` counts pending blocks of any source but manual: a baseline copy under a commitment is the product\'s too', () => {
    const s = state({ commitments: [{ id: 'c', title: 'Call', start: d(12, 9).toISOString(), end: d(12, 10).toISOString() }], blocks: [base('1', 'a', d(12, 9), d(12, 10)), base('2', 'b', d(12, 9), d(12, 10), { source: 'adjusted' }), block('m', 'a', d(12, 9), d(12, 10), { source: 'manual' })] });
    expect(underCommitment(s)).toEqual({ blocks: 2, minutes: 120 });
  });
});
