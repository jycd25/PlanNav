import { describe, it, expect } from 'vitest';
import { MUTATING, aggregateDialogues, judgeTurn } from '../src/dialogueScore.mjs';

describe('MUTATING', () => {
  it('names the tools of the baseline week and no retired one', () => {
    for (const t of ['shift_day', 'carve_out', 'carry_over', 'import_as_baseline', 'apply_baseline', 'save_baseline', 'plan_schedule', 'upsert_task', 'set_availability', 'track_time', 'set_work_style']) expect(MUTATING.has(t)).toBe(true);
    for (const t of ['note_block', 'apply_routine', 'learn_routine', 'get_schedule', 'get_now', 'list_tasks', 'get_setup_status', 'get_summary']) expect(MUTATING.has(t)).toBe(false);
  });
});

describe('judgeTurn', () => {
  it('a turn is correct when every expected tool was called and no forbidden one', () => {
    expect(judgeTurn({ expect: ['carve_out'], forbid: ['plan_schedule'] }, ['carve_out'], 'Done.').correct).toBe(true);
    expect(judgeTurn({ expect: ['carve_out'], forbid: ['plan_schedule'] }, ['carve_out', 'plan_schedule'], 'Done.').correct).toBe(false);
    expect(judgeTurn({ expect: ['carve_out'] }, [], 'Done.').correct).toBe(false);
    expect(judgeTurn({ expect: [] }, [], 'x', 'boom').correct).toBe(false);
  });
  it('noCalls: any tool call makes the turn wrong; maxQuestions caps the question marks', () => {
    expect(judgeTurn({ noCalls: true }, ['get_setup_status'], 'No baseline yet.').correct).toBe(false);
    expect(judgeTurn({ noCalls: true, maxQuestions: 0 }, [], 'No baseline yet. Say: import a past week.').correct).toBe(true);
    expect(judgeTurn({ noCalls: true, maxQuestions: 0 }, [], 'When do you start your day?').correct).toBe(false);
  });
  it('unrequested: mutating calls in a turn marked mutating: false, and a plan or a clear nobody expected', () => {
    expect(judgeTurn({ mutating: false }, ['shift_day', 'get_schedule'], '').unrequested).toBe(1);
    expect(judgeTurn({ expect: ['carve_out'] }, ['carve_out', 'plan_schedule'], '').unrequested).toBe(1);
    expect(judgeTurn({ expect: ['plan_schedule'] }, ['plan_schedule'], '').unrequested).toBe(0);
  });
});

describe('aggregateDialogues', () => {
  const turn = (index, calls, over = {}) => ({ index, calls, words: 10, questions: 0, correct: true, unrequested: 0, latency_s: 5, error: null, ...over });
  it('setup_turns: the user turns in the setup dialogue until the first mutating call', () => {
    const runs = [
      { name: 'setup', setup: true, turns: [turn(1, []), turn(2, ['get_now', 'upsert_task']), turn(3, ['set_availability'])] },
      { name: 'other', setup: false, turns: [turn(1, ['upsert_task'])] },
    ];
    const b = aggregateDialogues(runs);
    expect(b.setup_turns).toBe(2);
    expect(b.tool_acc).toBe(1);
    expect(aggregateDialogues([{ name: 'setup', setup: true, turns: [turn(1, [])] }]).setup_turns).toBe(null);
  });
});

describe('aggregateDialogues: latency', () => {
  const turn = (latency_s, over = {}) => ({ index: 1, calls: [], words: 10, questions: 0, correct: true, unrequested: 0, latency_s, error: null, ...over });
  it('latency_p90 is the nearest-rank 90th percentile of the wall clock per turn', () => {
    const turns = Array.from({ length: 10 }, (_, i) => turn(i + 1));
    expect(aggregateDialogues([{ name: 'a', turns }]).latency_p90_s).toBe(9);
    expect(aggregateDialogues([{ name: 'a', turns: [turn(4)] }]).latency_p90_s).toBe(4);
  });
  it('ttft_med, rounds_med and overhead_med (wall minus API) over the model turns; direct counts turns that called no model', () => {
    const runs = [{ name: 'a', turns: [
      turn(8, { ttft_s: 2.1, api_s: 5, rounds: 2 }),
      turn(4, { ttft_s: 1.9, api_s: 2, rounds: 1 }),
      turn(19, { ttft_s: 2.5, api_s: 15, rounds: 3 }),
      turn(0.2, { direct: true }),
    ] }];
    const b = aggregateDialogues(runs);
    expect(b.ttft_med_s).toBe(2.1);
    expect(b.rounds_med).toBe(2);
    expect(b.overhead_med_s).toBe(3); // 3, 2, 4 -> lower median of [2, 3, 4]
    expect(b.direct).toBe(1);
    expect(b.latency_med_s).toBe(4); // all four turns: [0.2, 4, 8, 19]
  });
  it('reads 0 for the model metrics when no turn reported them', () => {
    const b = aggregateDialogues([{ name: 'a', turns: [turn(5)] }]);
    expect(b.ttft_med_s).toBe(0);
    expect(b.rounds_med).toBe(0);
    expect(b.overhead_med_s).toBe(0);
    expect(b.direct).toBe(0);
  });
});

describe('turnStats', () => {
  it('reads the stats event of a turn into seconds, with the overhead as wall minus API', async () => {
    const { turnStats } = await import('../src/dialogueScore.mjs');
    const events = [{ type: 'text', delta: 'x' }, { type: 'stats', stats: { wallMs: 7900, durationApiMs: 5100, ttftMs: 2100, numTurns: 2, cacheReadTokens: 35337, cacheCreationTokens: 15726 } }];
    expect(turnStats(events, 8.0)).toEqual({ ttft_s: 2.1, api_s: 5.1, rounds: 2, overhead_s: 2.9, cache_read: 35337, cache_create: 15726, direct: false });
    expect(turnStats([{ type: 'stats', stats: { wallMs: 50, direct: true } }], 0.05)).toEqual({ direct: true });
    expect(turnStats([], 3)).toEqual({ direct: false });
  });
});
