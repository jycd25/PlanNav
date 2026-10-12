// Edge cases of the Tier B judge: empty traces, read-only traces, mutating calls nobody asked for, repeated calls, the
// caps at their exact boundary, and the stats reader on thin records.
import { describe, it, expect } from 'vitest';
import { MUTATING, aggregateDialogues, judgeTurn, turnStats } from '../src/dialogueScore.mjs';

describe('MUTATING', () => {
  it('is exactly the 24 tools that change the calendar or the settings', () => {
    expect([...MUTATING].sort()).toEqual([
      'add_block', 'add_commitment', 'add_recurring_commitment', 'apply_baseline', 'archive_task', 'carry_over', 'carve_out', 'clear_schedule', 'delete_block',
      'import_as_baseline', 'import_calendar', 'mark_block', 'mark_task', 'move_block', 'plan_schedule', 'remove_commitment', 'remove_recurring_commitment',
      'save_baseline', 'set_availability', 'set_work_style', 'shift_day', 'track_time', 'update_settings', 'upsert_task',
    ]);
    expect(MUTATING.size).toBe(24);
  });

  it('the memory and note tools are not in it: a memory write is not a calendar change (docs/experiments/tools-first.md)', () => {
    for (const t of ['update_memory', 'remember', 'note_block']) expect(MUTATING.has(t)).toBe(false);
  });
});

describe('judgeTurn with empty tool lists', () => {
  it('an empty script and no calls is correct with nothing unrequested; an empty error string is no error; a question without a cap is fine', () => {
    expect(judgeTurn({}, [], '')).toEqual({ correct: true, unrequested: 0 });
    expect(judgeTurn({}, [], '', '')).toEqual({ correct: true, unrequested: 0 });
    expect(judgeTurn({}, [], '???')).toEqual({ correct: true, unrequested: 0 });
    expect(judgeTurn({}, [], '', 'boom')).toEqual({ correct: false, unrequested: 0 });
  });

  it('noCalls with no calls is correct; maxQuestions 0 with an empty reply is correct', () => {
    expect(judgeTurn({ noCalls: true }, [], '')).toEqual({ correct: true, unrequested: 0 });
    expect(judgeTurn({ maxQuestions: 0 }, [], '')).toEqual({ correct: true, unrequested: 0 });
  });

  it('an expected tool that was never called is wrong, and every expected tool must appear', () => {
    expect(judgeTurn({ expect: ['carve_out'] }, [], '')).toEqual({ correct: false, unrequested: 0 });
    expect(judgeTurn({ expect: ['a', 'b'] }, ['a'], '')).toEqual({ correct: false, unrequested: 0 });
    expect(judgeTurn({ expect: ['a', 'b'] }, ['b', 'a', 'a'], '')).toEqual({ correct: true, unrequested: 0 }); // order and repeats do not matter
  });
});

describe('judgeTurn with read tools only', () => {
  it('reads in a turn marked mutating: false are correct and never unrequested', () => {
    expect(judgeTurn({ mutating: false }, ['get_schedule', 'get_now', 'list_tasks'], 'x')).toEqual({ correct: true, unrequested: 0 });
  });

  it('a read still breaks noCalls', () => {
    expect(judgeTurn({ mutating: false, noCalls: true }, ['get_schedule'], 'x')).toEqual({ correct: false, unrequested: 0 });
  });

  it('a mutating call in a turn marked mutating: true is not unrequested', () => {
    expect(judgeTurn({ mutating: true }, ['shift_day'], '')).toEqual({ correct: true, unrequested: 0 });
  });
});

describe('judgeTurn: a mutating tool the user did not ask for', () => {
  it('counts as unrequested but does not by itself make the turn wrong: correctness is the script\'s expect/forbid, unrequested is its own count', () => {
    expect(judgeTurn({ mutating: false }, ['move_block'], '')).toEqual({ correct: true, unrequested: 1 });
    expect(judgeTurn({ mutating: false, expect: ['get_schedule'] }, ['get_schedule', 'move_block'], '')).toEqual({ correct: true, unrequested: 1 });
  });

  it('is wrong as well when the script forbids it', () => {
    expect(judgeTurn({ mutating: false, forbid: ['move_block'] }, ['move_block'], '')).toEqual({ correct: false, unrequested: 1 });
  });

  it('a tool both expected and forbidden can never be correct', () => {
    expect(judgeTurn({ expect: ['x'], forbid: ['x'] }, ['x'], '')).toEqual({ correct: false, unrequested: 0 });
  });

  it('the memory tools are never unrequested, even in a mutating: false turn', () => {
    expect(judgeTurn({ mutating: false }, ['update_memory', 'remember'], '')).toEqual({ correct: true, unrequested: 0 });
  });
});

describe('judgeTurn: repeated tools', () => {
  it('each mutating call in a mutating: false turn counts: shift_day twice is 2', () => {
    expect(judgeTurn({ mutating: false }, ['shift_day', 'shift_day'], '')).toEqual({ correct: true, unrequested: 2 });
  });

  it('an unexpected plan_schedule counts once per tool name, however many times it was called', () => {
    expect(judgeTurn({}, ['plan_schedule', 'plan_schedule'], '')).toEqual({ correct: true, unrequested: 1 });
    expect(judgeTurn({}, ['clear_schedule', 'plan_schedule'], '')).toEqual({ correct: true, unrequested: 2 });
  });

  it('in a mutating: false turn an unexpected plan_schedule counts per call and once more as unexpected: twice is 3', () => {
    expect(judgeTurn({ mutating: false }, ['plan_schedule', 'plan_schedule'], '')).toEqual({ correct: true, unrequested: 3 });
  });

  it('an expected plan_schedule called twice is 0; expected but in a mutating: false turn it is 1', () => {
    expect(judgeTurn({ expect: ['plan_schedule'] }, ['plan_schedule', 'plan_schedule'], '')).toEqual({ correct: true, unrequested: 0 });
    expect(judgeTurn({ mutating: false, expect: ['plan_schedule'] }, ['plan_schedule'], '')).toEqual({ correct: true, unrequested: 1 });
  });

  it('maxQuestions is a strict cap: two marks over a cap of 1 is wrong, one mark is fine', () => {
    expect(judgeTurn({ maxQuestions: 1 }, [], 'a? b?')).toEqual({ correct: false, unrequested: 0 });
    expect(judgeTurn({ maxQuestions: 1 }, [], 'a?')).toEqual({ correct: true, unrequested: 0 });
  });
});

describe('aggregateDialogues at its edges', () => {
  const turn = (over = {}) => ({ index: 1, calls: [], words: 10, questions: 0, correct: true, unrequested: 0, latency_s: 5, error: null, ...over });
  const EMPTY = { tool_acc: 0, unrequested: 0, words_med: 0, words_max: 0, questions_max: 0, setup_turns: null, latency_med_s: 0, latency_p90_s: 0, ttft_med_s: 0, rounds_med: 0, overhead_med_s: 0, cache_create_med: 0, direct: 0, errors: 0, crash: 0 };

  it('no runs, or a setup run with no turns: every figure 0, setup_turns null, no crash', () => {
    expect(aggregateDialogues([])).toEqual(EMPTY);
    expect(aggregateDialogues([{ name: 'setup', setup: true, turns: [] }])).toEqual(EMPTY);
  });

  it('setup_turns reads the first setup run only: a second setup run\'s change is not seen', () => {
    const runs = [
      { name: 's', setup: true, turns: [turn({ index: 1, calls: ['get_setup_status'] }), turn({ index: 2, calls: ['get_now'] })] },
      { name: 's2', setup: true, turns: [turn({ index: 1, calls: ['upsert_task'] })] },
    ];
    expect(aggregateDialogues(runs).setup_turns).toBe(null);
  });

  it('the caps are strict: a run exactly at every cap has crash 0; one over each and an error has crash 4 (latency median stays under)', () => {
    expect(aggregateDialogues([{ name: 'a', turns: [turn({ words: 40, questions: 1, latency_s: 20 }), turn({ words: 60 })] }]).crash).toBe(0);
    const over = aggregateDialogues([{ name: 'a', turns: [turn({ words: 41, questions: 2, latency_s: 21 }), turn({ words: 61, error: 'x' })] }]);
    expect(over).toEqual({ ...EMPTY, tool_acc: 1, words_med: 41, words_max: 61, questions_max: 2, latency_med_s: 5, latency_p90_s: 21, errors: 1, crash: 4 });
  });

  it('custom caps of 0 make a single ten-word turn crash on every cap but errors', () => {
    expect(aggregateDialogues([{ name: 'a', turns: [turn()] }], { words_med: 0, words_max: 0, questions_max: -1, latency_med_s: 0 }).crash).toBe(4);
  });

  it('medians take the lower middle of an even count; tool_acc is the share of correct turns; unrequested is summed', () => {
    expect(aggregateDialogues([{ name: 'a', turns: [turn({ words: 10 }), turn({ words: 20 })] }]).words_med).toBe(10);
    expect(aggregateDialogues([{ name: 'a', turns: [1, 2, 3, 4].map((l) => turn({ latency_s: l })) }]).latency_med_s).toBe(2);
    const b = aggregateDialogues([{ name: 'a', turns: [turn({ correct: false, unrequested: 2 }), turn(), turn({ correct: false })] }]);
    expect(b.tool_acc).toBeCloseTo(1 / 3);
    expect(b.unrequested).toBe(2);
  });
});

describe('turnStats on thin records', () => {
  it('an empty stats object, or a stats event without one, is a model turn with no figures', () => {
    expect(turnStats([{ type: 'stats', stats: {} }], 3)).toEqual({ direct: false });
    expect(turnStats([{ type: 'stats' }], 1)).toEqual({ direct: false });
  });

  it('zeros are kept as figures, the first stats event wins, and direct wins over any figure', () => {
    expect(turnStats([{ type: 'stats', stats: { numTurns: 0, ttftMs: 0 } }], 3)).toEqual({ direct: false, ttft_s: 0, rounds: 0 });
    expect(turnStats([{ type: 'stats', stats: { durationApiMs: 1000 } }, { type: 'stats', stats: { durationApiMs: 9000 } }], 2.5)).toEqual({ direct: false, api_s: 1, overhead_s: 1.5 });
    expect(turnStats([{ type: 'stats', stats: { direct: true, ttftMs: 5 } }], 1)).toEqual({ direct: true });
  });
});
