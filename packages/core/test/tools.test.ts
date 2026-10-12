import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { MemoryStore } from '../src/store.js';
import { markBlock } from '../src/mark.js';
import { parseDays, parseWhen, resolveTask, runTool, tools } from '../src/tools.js';
import { DEFAULT_SETTINGS, normalizeSettings, STANDARD_WEEK, type Block } from '../src/types.js';

const d = (h: number, m = 0) => new Date(2026, 9, 7, h, m);
const hm = (iso: string) => { const x = new Date(iso); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; };
let store: MemoryStore;
const ctx = { now: () => d(9) };

beforeEach(() => {
  store = new MemoryStore();
  store.saveSettings({ ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, maxBlockMinutes: 60, minBlockMinutes: 30, slotMinutes: 15 });
});

describe('tool contracts', () => {
  it('exposes the expected names', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_block', 'add_commitment', 'add_recurring_commitment', 'apply_baseline', 'archive_task', 'carry_over', 'carve_out', 'clear_schedule', 'delete_block', 'get_now', 'get_schedule', 'get_setup_status', 'get_summary', 'import_as_baseline', 'import_calendar', 'list_tasks',
      'mark_block', 'mark_task', 'move_block', 'note_block', 'plan_schedule', 'remove_commitment', 'remove_recurring_commitment', 'save_baseline', 'set_availability', 'set_work_style', 'shift_day', 'track_time', 'update_memory', 'update_settings', 'upsert_task',
    ]);
  });
  it('plan_schedule is the from-scratch suggestion of a baseline, for when none exists; shift_day takes only the answer about the breaks', () => {
    expect(tools.find((t) => t.name === 'plan_schedule')!.description).toMatch(/^Suggest a baseline \(only when none exists\)/);
    expect(Object.keys(tools.find((t) => t.name === 'shift_day')!.schema.shape)).toEqual(['breaks']);
    expect(Object.keys(tools.find((t) => t.name === 'carve_out')!.schema.shape)).toEqual(['from', 'to', 'title']);
    expect(Object.keys(tools.find((t) => t.name === 'carry_over')!.schema.shape)).toEqual(['task']);
  });
  it('plan_schedule\'s must_do field says exactly what gives way on a full day', () => {
    const field = (tools.find((t) => t.name === 'plan_schedule')!.schema.shape as any).must_do;
    const description: string = field.description ?? field.unwrap().description;
    // The summed-cost rule of the planner, in one sentence: the run whose blocks together matter least, each block half a
    // point plus its task's priority score; never a manual or baseline block.
    expect(description).toMatch(/adjacent run of kept planner blocks whose blocks together matter least/);
    expect(description).toMatch(/half a point plus its task's priority score/);
    expect(description).toMatch(/never a manual or baseline block/);
    expect(description).not.toMatch(/lowest-priority|best task matters least|fewest blocks/);
  });
  it('every tool description has an example and every field has a description', () => {
    for (const t of tools) {
      expect(t.description, t.name).toMatch(/Example:/);
      for (const [key, field] of Object.entries(t.schema.shape)) {
        // zod keeps the description on the inner schema when .optional() wraps it; JSON schema output carries it through.
        const f = field as any;
        const description = f.description ?? (typeof f.unwrap === 'function' ? f.unwrap().description : undefined);
        expect(description, `${t.name}.${key}`).toBeTruthy();
      }
    }
  });
});

describe('parseWhen', () => {
  const now = d(9, 5);
  it('accepts ISO, local date-time, time-only, and tomorrow', () => {
    expect(parseWhen('2026-10-07T17:00:00.000Z', now)).toEqual(new Date('2026-10-07T17:00:00.000Z'));
    expect(parseWhen('2026-10-08 14:30', now)).toEqual(new Date(2026, 9, 8, 14, 30));
    expect(parseWhen('2026-10-08T14:30', now)).toEqual(new Date(2026, 9, 8, 14, 30));
    expect(parseWhen('2026-10-08', now)).toEqual(new Date(2026, 9, 8, 0, 0));
    expect(parseWhen('17:00', now)).toEqual(d(17));
    expect(parseWhen('9:30', now)).toEqual(d(9, 30));
    expect(parseWhen('tomorrow 09:00', now)).toEqual(new Date(2026, 9, 8, 9));
    expect(parseWhen('today 11:00', now)).toEqual(d(11));
  });
  it('explains the accepted formats on failure', () => {
    expect(() => parseWhen('next tuesday-ish', now)).toThrow(/ISO 8601/);
  });
});

describe('parseDays', () => {
  it('accepts numbers, names, and groups', () => {
    expect(parseDays([1, 3])).toEqual([1, 3]);
    expect(parseDays(['mon', 'Wednesday', 'FRI'])).toEqual([1, 3, 5]);
    expect(parseDays('weekdays')).toEqual([1, 2, 3, 4, 5]);
    expect(parseDays(['weekend'])).toEqual([0, 6]);
    expect(parseDays('daily')).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(parseDays('Mon, Tue and Thu')).toEqual([1, 2, 4]);
    expect(() => parseDays(['funday'])).toThrow(/funday/);
    expect(() => parseDays([])).toThrow(/at least one/i);
  });
});

describe('resolveTask', () => {
  beforeEach(() => {
    runTool(store, 'upsert_task', { name: 'Deep work', priority: 1, budget_minutes: 120, budget_period: 'day' }, ctx);
    runTool(store, 'upsert_task', { name: 'Email', priority: 2, budget_minutes: 30, budget_period: 'day' }, ctx);
    runTool(store, 'upsert_task', { name: 'Deep reading', priority: 3, budget_minutes: 30, budget_period: 'week' }, ctx);
  });
  it('matches by id, exact name, case-insensitively, and unique partial', () => {
    const id = store.listTasks().find((t) => t.name === 'Email')!.id;
    expect(resolveTask(store, id).name).toBe('Email');
    expect(resolveTask(store, 'email').name).toBe('Email');
    expect(resolveTask(store, 'DEEP WORK').name).toBe('Deep work');
    expect(resolveTask(store, 'reading').name).toBe('Deep reading');
  });
  it('lists candidates when ambiguous or unknown', () => {
    expect(() => resolveTask(store, 'deep')).toThrow(/several tasks: "Deep work", "Deep reading"/);
    expect(() => resolveTask(store, 'gym')).toThrow(/Known tasks: "Deep work", "Email", "Deep reading"/);
  });
});

describe('tools', () => {
  it('upsert_task creates then updates, coerces numbers, assigns a colour', () => {
    const created = runTool(store, 'upsert_task', { name: 'Deep work', priority: '1', budget_minutes: '120', budget_period: 'day' }, ctx) as any;
    expect(created.id).toBeTruthy();
    expect(created.priority).toBe(1);
    expect(created.color).toMatch(/^#/);
    const updated = runTool(store, 'upsert_task', { id: created.id, name: 'Deep work', priority: 2, budget_minutes: 90, budget_period: 'day' }, ctx) as any;
    expect(updated.priority).toBe(2);
    expect(store.listTasks().length).toBe(1);
  });

  it('upsert_task by name updates the existing task instead of duplicating', () => {
    runTool(store, 'upsert_task', { name: 'Deep work', priority: 1, budget_minutes: 120, budget_period: 'day' }, ctx);
    runTool(store, 'upsert_task', { name: 'deep work', priority: 3, budget_minutes: 60, budget_period: 'day' }, ctx);
    expect(store.listTasks().length).toBe(1);
    expect(store.listTasks()[0].priority).toBe(3);
  });

  it('plan_schedule then mark_task by name marks the current block done', () => {
    runTool(store, 'upsert_task', { name: 'Deep work', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
    const planned = runTool(store, 'plan_schedule', {}, ctx) as any;
    expect(planned.created.length).toBe(1);
    expect(planned.created[0].taskName).toBe('Deep work');
    expect(planned.summary).toMatch(/1 block/);
    const marked = runTool(store, 'mark_task', { task: 'deep work', status: 'done' }, { now: () => d(9, 30) }) as any;
    expect(marked.status).toBe('done');
    const sched = runTool(store, 'get_schedule', {}, ctx) as any;
    expect(sched.blocks[0].status).toBe('done');
  });

  it('plan_schedule accepts a loose until and reports the window', () => {
    runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 240, budget_period: 'day' }, ctx);
    const r = runTool(store, 'plan_schedule', { until: '11:00' }, ctx) as any;
    expect(r.window.end).toBe(d(11).toISOString());
    expect(r.created.length).toBe(2);
  });

  it('plan_schedule treats a bare until that is already past today as that time tomorrow', () => {
    // "Something came up, I'm free until 16:00" said at 20:40 means tomorrow until 16:00; a window ending before now is never meant.
    runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
    const late = { now: () => d(20, 40) };
    const r = runTool(store, 'plan_schedule', { until: '16:00' }, late) as any;
    expect(r.window.end).toBe(new Date(2026, 9, 8, 16).toISOString());
    expect(r.created.length).toBe(1);
    expect(hm(r.created[0].start)).toBe('09:00');
    expect(r.summary).toMatch(/Thu/);
    // An explicit "today" is taken as said: the tool reports the empty window instead of guessing.
    const today = runTool(store, 'plan_schedule', { until: 'today 16:00' }, late) as any;
    expect(today.window.end).toBe(d(16).toISOString());
    expect(today.created).toEqual([]);
    expect(today.summary).toMatch(/no availability between 20:45 and 16:00/i);
  });

  it('plan_schedule summary names the day when blocks span several days', () => {
    runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
    const r = runTool(store, 'plan_schedule', { until: 'tomorrow 18:00' }, { now: () => d(17, 30) }) as any;
    expect(r.created.length).toBe(2);
    expect(r.summary).toMatch(/A Wed 17:30-18:00, A Thu 09:00-10:00/);
    // Re-planning the morning: the pending 17:30 block outside the window still reserves 30 of today's 60 minutes.
    const same = runTool(store, 'plan_schedule', { until: '12:00' }, { now: () => d(9) }) as any;
    expect(same.summary).toMatch(/^1 block: A 09:00-09:30$/);
  });

  it('plan_schedule names the busiest day only when a day carries more tasks than the cap: a must-do fifth task under a cap of 4, not a day at the cap', () => {
    const wide = { now: () => d(9) };
    store.saveSettings({ ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, maxBlockMinutes: 60, minBlockMinutes: 30, slotMinutes: 15, maxTasksPerDay: 4 });
    for (const n of ['A', 'B', 'C', 'D', 'E']) runTool(store, 'upsert_task', { name: n, priority: 1, budget_minutes: 60, budget_period: 'day' }, wide);
    const atCap = runTool(store, 'plan_schedule', {}, wide) as any; // the cap admits four
    expect(atCap.created.length).toBe(4);
    expect(atCap.summary).not.toMatch(/Busiest/);
    const over = runTool(store, 'plan_schedule', { must_do: ['E'] }, wide) as any; // a must-do is admitted whatever the count: five tasks on the day
    expect(over.summary).toMatch(/Busiest day: Wed, 5 tasks\.$/);
    // A wider cap holds seven tasks without a word: the day is within the user's setting.
    store = new MemoryStore();
    store.saveSettings({ ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, maxBlockMinutes: 60, minBlockMinutes: 30, slotMinutes: 15, maxTasksPerDay: 8 });
    for (const n of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) runTool(store, 'upsert_task', { name: n, priority: 1, budget_minutes: 60, budget_period: 'day' }, wide);
    const seven = runTool(store, 'plan_schedule', {}, wide) as any;
    expect(seven.created.length).toBe(7);
    expect(seven.summary).not.toMatch(/Busiest/);
  });

  describe('plan_schedule names a task with a share today that got no room in the window', () => {
    const fullDay = (extra: string[] = []) => {
      store.saveSettings({ ...DEFAULT_SETTINGS, availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' }], maxBlockMinutes: 60, minBlockMinutes: 30, slotMinutes: 15 });
      for (const [i, n] of ['a', 'b', 'c'].entries()) runTool(store, 'upsert_task', { name: n, priority: i + 2, budget_minutes: 60, budget_period: 'day' }, ctx);
      for (const n of ['Deep work', ...extra]) runTool(store, 'upsert_task', { name: n, priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
      // Today 09:00-12:00 is full: a and b placed by hand, c by an earlier plan (kept: it still fits). plan_schedule runs
      // only without a baseline (it refuses with one), so the day is filled by blocks, not by baseline slots.
      const block = (n: string, h: number, source: Block['source']): Block => ({ id: `${n}-blk`, taskId: resolveTask(store, n).id, start: d(h).toISOString(), end: d(h + 1).toISOString(), status: 'pending', source, createdAt: '', statusChangedAt: null });
      store.insertBlocks([block('a', 9, 'manual'), block('b', 10, 'manual'), block('c', 11, 'planner')]);
    };

    it('a full day does not silently drop a new top task: the summary says there is no room for it', () => {
      fullDay();
      const r = runTool(store, 'plan_schedule', {}, ctx) as any;
      expect(r.created).toEqual([]);
      expect(r.summary).toMatch(/ No room for: Deep work \(say "must do Deep work" or free a slot\)\.$/);
    });

    it('several such tasks are named together, comma-separated', () => {
      fullDay(['Writing']);
      const r = runTool(store, 'plan_schedule', {}, ctx) as any;
      expect(r.summary).toMatch(/ No room for: Deep work, Writing \(say "must do Deep work" or free a slot\)\.$/);
    });

    it('nothing is said about a task the user named (must do): its own note says where it went', () => {
      fullDay();
      runTool(store, 'plan_schedule', {}, ctx); // Deep work finds no room
      const named = runTool(store, 'plan_schedule', { must_do: ['Deep work'] }, ctx) as any;
      expect(named.summary).toMatch(/^Deep work first, as asked\. "c" gave way/);
      expect(named.summary).not.toMatch(/No room for: Deep work/);
    });

    it('a weekly task is not named while a later day of its week could still take it', () => {
      fullDay();
      runTool(store, 'upsert_task', { name: 'Reading', priority: 1, budget_minutes: 60, budget_period: 'week' }, ctx);
      const r = runTool(store, 'plan_schedule', {}, ctx) as any; // Wednesday: Thursday and Friday are open
      expect(r.summary).toMatch(/No room for: Deep work \(/);
      expect(r.summary).not.toMatch(/Reading/);
    });
  });

  describe('plan_schedule names the tasks the per-day cap kept off', () => {
    const monday = { now: () => new Date(2026, 9, 5, 9) };
    const fixture = (cap: number, weekly: Array<[string, number, number?]>) => {
      store.saveSettings({ ...store.getSettings(), maxTasksPerDay: cap });
      for (const [i, n] of ['A', 'B', 'C', 'D'].entries()) runTool(store, 'upsert_task', { name: n, priority: i + 1, budget_minutes: 60, budget_period: 'day' }, monday);
      for (const [i, [n, minutes, priority]] of weekly.entries()) runTool(store, 'upsert_task', { name: n, priority: priority ?? 5 + i, budget_minutes: minutes, budget_period: 'week' }, monday);
    };

    it('four daily tasks fill a cap of 4: one weekly place a day, and the weekly task it keeps out every day is named with the cap that would seat every sitting', () => {
      fixture(4, [['Reading', 180], ['Course', 180], ['Writing', 120, 20]]); // Writing far below: never outranks the others for the one weekly place
      const r = runTool(store, 'plan_schedule', { horizon: 'week' }, monday) as any;
      // Four daily tasks under a cap of 4: a cap of 5 would still leave one weekly place a day (the floor), so the advice
      // names the smallest cap at which this plan meets every budget, tried on a copy: 7 (at 6, two places a day, Friday
      // holds the last sitting of only two of the three tasks and Writing stays an hour short).
      expect(r.summary).toMatch(/ The cap of 4 tasks a day kept Writing off every day; raise max_tasks_per_day to 7 or drop a task\.$/);
      expect(r.summary).not.toMatch(/No room for/);
    });

    it('with room for two weekly tasks a day every task gets its days: nothing is said', () => {
      fixture(6, [['Reading', 120], ['Course', 120], ['Writing', 120]]);
      const r = runTool(store, 'plan_schedule', { horizon: 'week' }, monday) as any;
      expect(r.summary).not.toMatch(/The cap of|No room for|Weekly budget unmet/);
    });

    it('a weekly budget left unplaced when the window reaches the week\'s last day is named with its minutes', () => {
      fixture(4, [['Reading', 180], ['Course', 180]]); // Reading Mon, Wed, Fri; Course Tue, Thu, and Friday's place is Reading's
      const r = runTool(store, 'plan_schedule', { horizon: 'week' }, monday) as any;
      expect(r.summary).toMatch(/ Weekly budget unmet: Course 60 min \(raise max_tasks_per_day to 6 or free a slot\)\.$/);
      expect(r.summary).not.toMatch(/The cap of/);
    });

    it('when the daily tasks alone exceed the cap, the advice names the cap that seats them and the weekly sittings', () => {
      fixture(4, [['Reading', 180], ['Course', 180], ['Writing', 120, 20]]);
      runTool(store, 'upsert_task', { name: 'E', priority: 4, budget_minutes: 60, budget_period: 'day' }, monday); // five daily tasks under a cap of 4
      const r = runTool(store, 'plan_schedule', { horizon: 'week' }, monday) as any;
      expect(r.summary).toMatch(/ The cap of 4 tasks a day kept [^;]*Writing off every day; raise max_tasks_per_day to 8 or drop a task\.$/);
    });

    it('with fewer daily tasks than the cap, the advice names the cap at which the paced sittings fit, never below the daily tasks plus two', () => {
      store.saveSettings({ ...store.getSettings(), maxTasksPerDay: 4 });
      for (const [i, n] of ['A', 'B', 'C'].entries()) runTool(store, 'upsert_task', { name: n, priority: i + 1, budget_minutes: 60, budget_period: 'day' }, monday);
      for (const [n, minutes, priority] of [['Reading', 180, 5], ['Course', 180, 6], ['Writing', 120, 20]] as const) runTool(store, 'upsert_task', { name: n, priority, budget_minutes: minutes, budget_period: 'week' }, monday);
      runTool(store, 'upsert_task', { name: 'Essay', priority: 21, budget_minutes: 120, budget_period: 'week' }, monday);
      const r = runTool(store, 'plan_schedule', { horizon: 'week' }, monday) as any;
      // Three daily tasks: the first cap worth naming is 5 (two weekly places); at 5 Writing is still an hour short, at 6 every budget is met.
      expect(r.summary).toMatch(/raise max_tasks_per_day to 6 /);
      expect(r.summary).not.toMatch(/fewer weekly tasks or smaller budgets/);
    });

    it('the user\'s week at the deep preset (cap 4): the advice is the cap that meets every budget, 6, not fewer weekly tasks', () => {
      store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '07:00', end: '13:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }, { days: [1, 2, 3, 4, 5], start: '19:00', end: '21:00' }], maxBlockMinutes: 120, maxTasksPerDay: 4 });
      runTool(store, 'upsert_task', { name: 'Leetcode', priority: 2, budget_minutes: 60, budget_period: 'day', session_minutes: 60 }, monday);
      runTool(store, 'upsert_task', { name: 'AI learning', priority: 3, budget_minutes: 60, budget_period: 'day', session_minutes: 60 }, monday);
      runTool(store, 'upsert_task', { name: 'Building', priority: 1, budget_minutes: 120, budget_period: 'day', session_minutes: 120, preferred_segment: 'afternoon' }, monday);
      runTool(store, 'upsert_task', { name: 'Behavioral', priority: 4, budget_minutes: 120, budget_period: 'day', session_minutes: 120 }, monday);
      runTool(store, 'upsert_task', { name: 'Startup learning', priority: 5, budget_minutes: 300, budget_period: 'week', session_minutes: 120, preferred_segment: 'morning' }, monday);
      runTool(store, 'upsert_task', { name: 'System design', priority: 6, budget_minutes: 300, budget_period: 'week', session_minutes: 120, preferred_segment: 'morning' }, monday);
      runTool(store, 'upsert_task', { name: 'Morning learning', priority: 7, budget_minutes: 180, budget_period: 'week', session_minutes: 60, preferred_segment: 'morning' }, monday);
      const r = runTool(store, 'plan_schedule', { horizon: 'week' }, { now: () => new Date(2026, 9, 5, 7) }) as any;
      expect(r.summary).toMatch(/ Weekly budget unmet: Morning learning 120 min \(raise max_tasks_per_day to 6 or free a slot\)\.$/);
    });

    it('when no cap would seat the budgets (the week\'s free time is short), the advice is fewer weekly tasks or smaller budgets', () => {
      store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '11:00' }], maxBlockMinutes: 60, maxTasksPerDay: 4 });
      runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 60, budget_period: 'day' }, monday);
      runTool(store, 'upsert_task', { name: 'Course', priority: 2, budget_minutes: 600, budget_period: 'week' }, monday); // ten hours of weekly work in five free hours
      const r = runTool(store, 'plan_schedule', { horizon: 'week' }, monday) as any;
      expect(r.summary).toMatch(/ Weekly budget unmet: Course \d+ min \(fewer weekly tasks or smaller budgets\)\.$/);
    });

    it('a must-do task is not named as an unmet weekly budget: its own note says where it went', () => {
      store.saveSettings({ ...store.getSettings(), maxTasksPerDay: 4 });
      runTool(store, 'upsert_task', { name: 'Essay', priority: 1, budget_minutes: 600, budget_period: 'week' }, monday);
      const r = runTool(store, 'plan_schedule', { must_do: ['Essay'] }, { now: () => new Date(2026, 9, 9, 9) }) as any; // Friday, the week's last day
      expect(r.summary).not.toMatch(/Weekly budget unmet/);
    });

    it('a day plan whose week still has days to come says nothing of the weekly budget', () => {
      fixture(4, [['Reading', 180], ['Course', 180]]);
      const r = runTool(store, 'plan_schedule', {}, monday) as any;
      expect(r.summary).not.toMatch(/Weekly budget unmet|The cap of/);
    });

    it('on a week plan a task the cap kept off every day is named in the unmet minutes too', () => {
      fixture(4, [['Reading', 180], ['Course', 180], ['Writing', 120, 20]]);
      const r = runTool(store, 'plan_schedule', { horizon: 'week' }, monday) as any;
      expect(r.summary).toMatch(/ Weekly budget unmet: Course 60 min, Writing 120 min \(raise max_tasks_per_day to 7 or free a slot\)\. The cap of 4 tasks a day kept Writing off every day; raise max_tasks_per_day to 7 or drop a task\.$/);
    });
  });

  describe('the cap and unmet sentences on a day plan', () => {
    // The user's week at cap 5 (one weekly place a day), planned day by day at 07:00; the previous day's blocks marked done.
    const at = (day: number, h = 7) => ({ now: () => new Date(2026, 9, day, h) });
    const userWeek = () => {
      store.saveSettings({ ...store.getSettings(), availability: [{ days: [1, 2, 3, 4, 5], start: '07:00', end: '13:00' }, { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }, { days: [1, 2, 3, 4, 5], start: '19:00', end: '21:00' }], maxBlockMinutes: 120, maxTasksPerDay: 5 });
      runTool(store, 'upsert_task', { name: 'Leetcode', priority: 2, budget_minutes: 60, budget_period: 'day', session_minutes: 60 }, at(5));
      runTool(store, 'upsert_task', { name: 'AI learning', priority: 3, budget_minutes: 60, budget_period: 'day', session_minutes: 60 }, at(5));
      runTool(store, 'upsert_task', { name: 'Building', priority: 1, budget_minutes: 120, budget_period: 'day', session_minutes: 120, preferred_segment: 'afternoon' }, at(5));
      runTool(store, 'upsert_task', { name: 'Behavioral', priority: 4, budget_minutes: 120, budget_period: 'day', session_minutes: 120 }, at(5));
      runTool(store, 'upsert_task', { name: 'Startup learning', priority: 5, budget_minutes: 300, budget_period: 'week', session_minutes: 120, preferred_segment: 'morning' }, at(5));
      runTool(store, 'upsert_task', { name: 'System design', priority: 6, budget_minutes: 300, budget_period: 'week', session_minutes: 120, preferred_segment: 'morning' }, at(5));
      runTool(store, 'upsert_task', { name: 'Morning learning', priority: 7, budget_minutes: 180, budget_period: 'week', session_minutes: 60, preferred_segment: 'morning' }, at(5));
    };
    const dayDone = (day: number) => { for (const b of store.listBlocks({ from: new Date(2026, 9, day), to: new Date(2026, 9, day + 1) })) if (b.status === 'pending') store.updateBlock(b.id, { status: 'done' }); };
    const summaries = (through: number) => {
      const out: string[] = [];
      for (let day = 5; day <= through; day += 1) { out.push((runTool(store, 'plan_schedule', {}, at(day)) as any).summary); dayDone(day); }
      return out;
    };

    it('says "kept X off today" only for a task with no block anywhere this week: Tuesday names Morning learning, which has none', () => {
      userWeek();
      const [, tuesday] = summaries(6);
      expect(tuesday).toMatch(/ The cap of 5 tasks a day kept Morning learning off today; raise max_tasks_per_day to \d+ or drop a task\.$/);
      expect(tuesday).not.toMatch(/every day|No room for|Weekly budget unmet/);
    });

    it('says nothing of a task the cap kept off today that sat on another day of the week, while days remain', () => {
      userWeek();
      const [, , , thursday] = summaries(8); // Thursday: Morning learning takes the place; System design (Tuesday) and Startup learning (Monday, Wednesday) are refused today
      expect(thursday).not.toMatch(/The cap of|No room for|Weekly budget unmet/);
    });

    it('on the week\'s last day names the unmet minutes of a task that sat on another day, not the cap', () => {
      userWeek();
      const [, , , , friday] = summaries(9); // Friday: System design takes the place; Morning learning sat on Thursday and ends 120 short
      expect(friday).toMatch(/ Weekly budget unmet: Morning learning 120 min \((raise max_tasks_per_day to \d+ or free a slot|fewer weekly tasks or smaller budgets)\)\.$/);
      expect(friday).not.toMatch(/The cap of|No room for/);
    });
  });

  it('plan_schedule keeps blocks that still fit and reports the diff in the summary', () => {
    runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 120, budget_period: 'day' }, ctx);
    runTool(store, 'upsert_task', { name: 'B', priority: 2, budget_minutes: 60, budget_period: 'day' }, ctx);
    const first = runTool(store, 'plan_schedule', {}, ctx) as any;
    expect(first.created.length).toBe(3);
    expect(first.kept).toEqual([]);
    expect(first.summary).toMatch(/^3 blocks: /);
    runTool(store, 'add_commitment', { title: 'Call', start: '10:00', end: '11:00' }, ctx);
    const again = runTool(store, 'plan_schedule', {}, ctx) as any;
    expect(again.kept.map((b: any) => b.id)).toEqual([first.created[0].id, first.created[2].id]);
    expect(again.removed).toBe(1);
    expect(again.summary).toMatch(/^2 kept as they were, 1 replaced; 1 added: A 12:00-13:00$/);
    const same = runTool(store, 'plan_schedule', {}, ctx) as any;
    expect(same.created).toEqual([]);
    expect(same.summary).toMatch(/^Nothing to change: 3 kept as they were\.$/);
  });

  it('add_commitment accepts loose times and rejects inverted ranges', () => {
    const c = runTool(store, 'add_commitment', { title: 'Standup', start: '10:00', end: '10:30' }, ctx) as any;
    expect(c.start).toBe(d(10).toISOString());
    expect(() => runTool(store, 'add_commitment', { title: 'X', start: '11:00', end: '10:00' }, ctx)).toThrow(/end/);
  });

  it('archive_task accepts a name', () => {
    runTool(store, 'upsert_task', { name: 'Old', priority: 1, budget_minutes: 30, budget_period: 'day' }, ctx);
    runTool(store, 'archive_task', { task: 'old' }, ctx);
    expect(store.listTasks()).toEqual([]);
  });

  it('rejects invalid input and unknown tools', () => {
    expect(() => runTool(store, 'mark_block', { block_id: 'x', status: 'nope' }, ctx)).toThrow();
    expect(() => runTool(store, 'unknown_tool', {}, ctx)).toThrow(/unknown tool/i);
  });

  it('mark_task explains when there is nothing to mark', () => {
    runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 30, budget_period: 'day' }, ctx);
    expect(() => runTool(store, 'mark_task', { task: 'A', status: 'done' }, ctx)).toThrow(/No block for "A" today/);
  });

  it('get_schedule and get_summary count an unmarked past block as missed', () => {
    const t = runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx) as any;
    store.insertBlocks([{ id: 'old', taskId: t.id, start: d(9).toISOString(), end: d(10).toISOString(), status: 'pending', createdAt: '', statusChangedAt: null }]);
    const later = { now: () => d(15) };
    const sched = runTool(store, 'get_schedule', {}, later) as any;
    expect(sched.blocks[0].status).toBe('missed');
    const s = runTool(store, 'get_summary', { window: 'day' }, later) as any;
    expect(s.tasks[0].counts).toEqual({ pending: 0, done: 0, skipped: 0, missed: 1 });
    expect(s.tasks[0].completionRate).toBe(0);
  });

  it('plan_schedule (the suggestion) needs hours and tasks, not a baseline, and says what to ask', () => {
    store.saveSettings({ ...store.getSettings(), availability: [] });
    const r = runTool(store, 'plan_schedule', {}, ctx) as any;
    expect(r.created).toEqual([]);
    expect(r.setup).toBe(true);
    expect(r.missing).toEqual(['availability', 'tasks']);
    expect(r.next_step).toMatch(/set_availability/);
    expect(r.next_step).toMatch(/Baseline tab/);
    runTool(store, 'set_availability', { windows: [{ days: 'weekdays', start: '09:00', end: '18:00' }] }, ctx);
    const r2 = runTool(store, 'plan_schedule', {}, ctx) as any;
    expect(r2.setup).toBe(true);
    expect(r2.missing).toEqual(['tasks']);
    expect(r2.next_step).toMatch(/upsert_task/);
    runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
    const r3 = runTool(store, 'plan_schedule', {}, ctx) as any; // no baseline yet: this is the suggest path
    expect(r3.setup).toBeUndefined();
    expect(r3.created.length).toBe(1);
  });

  it('plan_schedule explains when today\'s availability is over and the plan moved to the next day', () => {
    runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
    const r = runTool(store, 'plan_schedule', {}, { now: () => d(21, 15) }) as any;
    expect(r.created.length).toBe(1);
    expect(r.summary).toMatch(/availability for today ended at 18:00/i);
    expect(r.summary).toMatch(/Thu/);
  });

  it('plan_schedule explains an explicit window with no availability', () => {
    runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
    const r = runTool(store, 'plan_schedule', { until: '23:00' }, { now: () => d(21, 15) }) as any;
    expect(r.created).toEqual([]);
    expect(r.summary).toMatch(/no availability between 21:15 and 23:00/i);
    expect(r.summary).toMatch(/set_availability/);
  });

  it('set_availability replaces or adds windows with tolerant days and validates', () => {
    const r = runTool(store, 'set_availability', { windows: [{ days: 'weekdays', start: '9:00', end: '18:00' }, { days: ['mon', 'tue', 'wed', 'thu'], start: '20:00', end: '22:30' }] }, ctx) as any;
    expect(r.availability).toEqual([{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }, { days: [1, 2, 3, 4], start: '20:00', end: '22:30' }]);
    const added = runTool(store, 'set_availability', { windows: [{ days: 'sat', start: '10:00', end: '13:00' }], mode: 'add' }, ctx) as any;
    expect(added.availability.length).toBe(3);
    expect(() => runTool(store, 'set_availability', { windows: [{ days: 'mon', start: '18:00', end: '09:00' }] }, ctx)).toThrow(/after/);
    expect(() => runTool(store, 'set_availability', { windows: [] }, ctx)).toThrow(/at least one/i);
    expect(() => runTool(store, 'set_availability', { windows: [{ days: 'mon', start: '9', end: '18:00' }] }, ctx)).toThrow(/HH:MM/);
  });

  it('recurring commitments: add with tolerant days, show in get_schedule, remove by title or id', () => {
    const r = runTool(store, 'add_recurring_commitment', { title: 'Standup', days: 'weekdays', start: '10:00', end: '10:30' }, ctx) as any;
    expect(r.days).toEqual([1, 2, 3, 4, 5]);
    const sched = runTool(store, 'get_schedule', {}, ctx) as any;
    expect(sched.recurring).toEqual([{ recurringId: r.id, title: 'Standup', start: d(10).toISOString(), end: d(10, 30).toISOString() }]);
    expect(() => runTool(store, 'remove_recurring_commitment', { recurring: 'lunch' }, ctx)).toThrow(/No recurring commitment matches "lunch". Known: "Standup"/);
    runTool(store, 'remove_recurring_commitment', { recurring: 'standup' }, ctx);
    expect(store.listRecurring()).toEqual([]);
  });

  it('update_settings changes sizes and validates', () => {
    const r = runTool(store, 'update_settings', { slot_minutes: 30, max_block_minutes: 120 }, ctx) as any;
    expect(r.settings.slotMinutes).toBe(30);
    expect(r.settings.maxBlockMinutes).toBe(120);
    expect(r.settings.availability).toEqual(STANDARD_WEEK);
    expect(() => runTool(store, 'update_settings', { min_block_minutes: 200 }, ctx)).toThrow(/max/);
    expect(() => runTool(store, 'update_settings', { week_starts_on: 'someday' }, ctx)).toThrow(/someday/);
  });

  it('plan_schedule describes itself as the suggestion, and sends "something came up" to carve_out', () => {
    const d = tools.find((t) => t.name === 'plan_schedule')!.description;
    expect(d).not.toMatch(/re-plan until/);
    expect(d).toMatch(/Use for "suggest a schedule" and, before a baseline exists, "plan my day"; "something came up" is carve_out\./);
  });

  it('get_setup_status says whether a baseline exists and, if not, the one-line setup', () => {
    const r = runTool(store, 'get_setup_status', {}, ctx) as any;
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(['baseline']);
    expect(r.next_step).toMatch(/Use as my baseline.*Baseline tab.*suggest one from your tasks/);
    store.setBaseline({ slots: [{ day: 1, start: '09:00', end: '10:00', kind: 'task', taskId: 'x' }] });
    expect(runTool(store, 'get_setup_status', {}, ctx)).toMatchObject({ ready: true, missing: [], next_step: null });
  });

  it('import_calendar fetches a URL through the context and stores what it finds', async () => {
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x', 'DTSTART:20261008T160000Z', 'DTEND:20261008T170000Z', 'SUMMARY:Dentist', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const fetched: string[] = [];
    const r = await runTool(store, 'import_calendar', { url: 'https://calendar.google.com/calendar/ical/x/private-abc/basic.ics' }, { now: () => d(9), fetchText: async (u) => { fetched.push(u); return ics; } }) as any;
    expect(fetched).toEqual(['https://calendar.google.com/calendar/ical/x/private-abc/basic.ics']);
    expect(r.commitments.length).toBe(1);
    expect(r.summary).toMatch(/1 upcoming event/);
    expect(store.listCommitments().length).toBe(1);
    await expect(runTool(store, 'import_calendar', { url: 'webcal://example.com/cal.ics' }, { now: () => d(9), fetchText: async (u) => { fetched.push(u); return ics; } })).resolves.toBeTruthy();
    expect(fetched[1]).toBe('https://example.com/cal.ics');
    await expect(runTool(store, 'import_calendar', { url: 'ftp://nope' }, { now: () => d(9), fetchText: async () => '' })).rejects.toThrow(/http/i);
    await expect(runTool(store, 'import_calendar', { url: 'https://x' }, { now: () => d(9) })).rejects.toThrow(/not available/i);
  });

  it('plan_schedule accepts must_do task names and explains unknown ones', () => {
    runTool(store, 'upsert_task', { name: 'Deep work', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
    runTool(store, 'upsert_task', { name: 'Email', priority: 3, budget_minutes: 60, budget_period: 'day' }, ctx);
    const r = runTool(store, 'plan_schedule', { must_do: ['email'] }, ctx) as any;
    expect(r.created.map((b: any) => b.taskName)).toEqual(['Email', 'Deep work']);
    expect(r.summary).toMatch(/Email first/);
    expect(() => runTool(store, 'plan_schedule', { must_do: ['gym'] }, ctx)).toThrow(/No task matches "gym"/);
  });

  it('plan_schedule with must_do on a full day gives the task one sitting by displacing the lowest-priority planner block, and says what moved', () => {
    runTool(store, 'upsert_task', { name: 'Alpha', priority: 1, budget_minutes: 300, budget_period: 'day' }, ctx);
    runTool(store, 'upsert_task', { name: 'Beta', priority: 2, budget_minutes: 240, budget_period: 'day' }, ctx);
    const first = runTool(store, 'plan_schedule', {}, ctx) as any;
    expect(first.created.length).toBe(9); // Alpha 09:00-14:00, Beta 14:00-18:00: the window is full
    runTool(store, 'upsert_task', { name: 'Gamma', priority: 3, budget_minutes: 60, budget_period: 'day' }, ctx);
    const r = runTool(store, 'plan_schedule', { must_do: ['Gamma'] }, ctx) as any;
    expect(r.created.map((b: any) => [b.taskName, hm(b.start), hm(b.end)])).toEqual([['Gamma', '14:00', '15:00']]);
    expect(r.kept.length).toBe(8);
    expect(r.removed).toBe(0);
    expect(r.displaced.map((b: any) => [b.taskName, hm(b.start), hm(b.end)])).toEqual([['Beta', '14:00', '15:00']]);
    expect(r.summary).toBe('Gamma at 14:00, as asked. Beta 14:00-15:00 gave way. 8 kept as they were; 1 added: Gamma 14:00-15:00');
    // Asked again, Gamma already has its sitting: nothing moves and the summary says where it is.
    const again = runTool(store, 'plan_schedule', { must_do: ['Gamma'] }, ctx) as any;
    expect(again.created).toEqual([]);
    expect(again.displaced).toEqual([]);
    expect(again.summary).toBe('Gamma at 14:00, as asked. Nothing to change: 9 kept as they were.');
  });

  it('plan_schedule with must_do grows a task\'s half sitting to a whole one and says so, or adds a whole sitting and names it', () => {
    runTool(store, 'upsert_task', { name: 'Alpha', priority: 2, budget_minutes: 60, budget_period: 'day' }, ctx);
    runTool(store, 'upsert_task', { name: 'Beta', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
    runTool(store, 'upsert_task', { name: 'Gamma', priority: 3, budget_minutes: 120, budget_period: 'day' }, ctx);
    const mk = (id: string, name: string, start: Date, end: Date): Block => ({ id, taskId: resolveTask(store, name).id, start: start.toISOString(), end: end.toISOString(), status: 'pending', source: 'planner', createdAt: '', statusChangedAt: null });
    // Alpha has half a sitting at 09:00 and the half hour after it is free: the block grows to a whole sitting, and the
    // summary says so instead of "already has 09:00-09:30".
    store.insertBlocks([mk('pa', 'Alpha', d(9), d(9, 30))]);
    const grown = runTool(store, 'plan_schedule', { until: '11:00', must_do: ['Alpha'] }, ctx) as any;
    expect(grown.extended.map((b: any) => [b.taskName, hm(b.start), hm(b.end)])).toEqual([['Alpha', '09:00', '10:00']]);
    expect(grown.summary).toMatch(/^Alpha extended to 09:00-10:00, as asked\./);
    expect(grown.created.map((b: any) => [b.taskName, hm(b.start), hm(b.end)])).toEqual([['Beta', '10:00', '11:00']]);
    // Gamma's half sitting at 13:00 is followed by a hand-placed block and cannot grow: a whole sitting is added in the
    // first free time of the day (11:00) and named by its start; the scrap stays, nothing gives way.
    store.insertBlocks([mk('pg', 'Gamma', d(13), d(13, 30))]);
    runTool(store, 'upsert_task', { name: 'Delta', priority: 4, budget_minutes: 60, budget_period: 'day' }, ctx);
    runTool(store, 'add_block', { task: 'Delta', start: '13:30', end: '14:30' }, ctx);
    const added = runTool(store, 'plan_schedule', { until: '18:00', must_do: ['Gamma'] }, ctx) as any;
    expect(added.extended).toEqual([]);
    expect(added.displaced).toEqual([]);
    expect(added.created[0]).toMatchObject({ taskName: 'Gamma', start: d(11).toISOString(), end: d(12).toISOString() });
    expect(store.getBlock('pg')!.end).toBe(d(13, 30).toISOString());
    expect(added.summary).toMatch(/^Gamma at 11:00, as asked\./);
  });

  it('plan_schedule with must_do says plainly when the task could not be placed instead of claiming it was', () => {
    runTool(store, 'upsert_task', { name: 'Alpha', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
    const alpha = resolveTask(store, 'Alpha');
    const mk = (id: string, start: Date, end: Date, extra: Partial<Block>): Block => ({ id, taskId: alpha.id, start: start.toISOString(), end: end.toISOString(), status: 'pending', createdAt: '', statusChangedAt: null, ...extra });
    store.insertBlocks([mk('done', d(9), d(10), { status: 'done' })]);
    const used = runTool(store, 'plan_schedule', { must_do: ['Alpha'] }, { now: () => d(10) }) as any;
    expect(used.created).toEqual([]);
    expect(used.summary).toMatch(/^Alpha already has 09:00-10:00 \(done\) today\./);
    expect(used.summary).not.toMatch(/as asked/);
    // A day filled by hand-placed and baseline blocks: the planner never moves those, so it says so.
    runTool(store, 'upsert_task', { name: 'Gamma', priority: 2, budget_minutes: 60, budget_period: 'day' }, ctx);
    store.insertBlocks([mk('m1', d(10), d(14), { source: 'manual' }), mk('m2', d(14), d(18), { source: 'baseline' })]);
    const full = runTool(store, 'plan_schedule', { must_do: ['Gamma'] }, { now: () => d(10) }) as any;
    expect(full.created).toEqual([]);
    expect(full.displaced).toEqual([]);
    expect(full.summary).toMatch(/^Gamma was not placed: no free time in the window and no planner block to give way\./);
    expect(store.listBlocks().map((b) => b.id).sort()).toEqual(['done', 'm1', 'm2']);
  });

  it('plan_schedule with must_do named after hours for a full tomorrow places it there and says so; the task that gave way does not re-take its gap', () => {
    runTool(store, 'upsert_task', { name: 'Alpha', priority: 1, budget_minutes: 300, budget_period: 'day' }, ctx);
    runTool(store, 'upsert_task', { name: 'Zeta', priority: 2, budget_minutes: 240, budget_period: 'day', session_minutes: 120, preferred_segment: 'afternoon' }, ctx);
    const thu = (h: number) => new Date(2026, 9, 8, h);
    const mk = (id: string, name: string, start: Date, end: Date): Block => ({ id, taskId: resolveTask(store, name).id, start: start.toISOString(), end: end.toISOString(), status: 'pending', source: 'planner', createdAt: '', statusChangedAt: null });
    store.insertBlocks([9, 10, 11, 12, 13].map((h) => mk(`a${h}`, 'Alpha', thu(h), thu(h + 1))));
    store.insertBlocks([mk('z14', 'Zeta', thu(14), thu(16)), mk('z16', 'Zeta', thu(16), thu(18))]);
    runTool(store, 'upsert_task', { name: 'Gamma', priority: 3, budget_minutes: 120, budget_period: 'day', session_minutes: 120 }, ctx);
    const r = runTool(store, 'plan_schedule', { must_do: ['Gamma'] }, { now: () => d(22) }) as any;
    expect(r.created.map((b: any) => [b.taskName, hm(b.start), hm(b.end)])).toEqual([['Gamma', '14:00', '16:00']]);
    expect(r.displaced.map((b: any) => [b.taskName, hm(b.start), hm(b.end)])).toEqual([['Zeta', '14:00', '16:00']]);
    expect(r.summary).toMatch(/^Gamma Thu 14:00, as asked\. Zeta 14:00-16:00 gave way\./);
    expect(r.summary).not.toMatch(/not placed/);
  });

  it('plan_schedule with must_do says when the task that gave way is left with no other sitting in its period', () => {
    runTool(store, 'upsert_task', { name: 'Alpha', priority: 1, budget_minutes: 420, budget_period: 'day', session_minutes: 120 }, ctx);
    runTool(store, 'upsert_task', { name: 'Beta', priority: 2, budget_minutes: 60, budget_period: 'day' }, ctx);
    runTool(store, 'upsert_task', { name: 'Weekly', priority: 3, budget_minutes: 60, budget_period: 'week' }, ctx);
    const mk = (id: string, name: string, start: Date, end: Date): Block => ({ id, taskId: resolveTask(store, name).id, start: start.toISOString(), end: end.toISOString(), status: 'pending', source: 'planner', createdAt: '', statusChangedAt: null });
    store.insertBlocks([mk('a1', 'Alpha', d(9), d(11)), mk('a2', 'Alpha', d(11), d(13)), mk('a3', 'Alpha', d(13), d(15)), mk('a4', 'Alpha', d(15), d(16)), mk('b', 'Beta', d(16), d(17)), mk('w', 'Weekly', d(17), d(18))]);
    runTool(store, 'upsert_task', { name: 'Gamma', priority: 4, budget_minutes: 60, budget_period: 'day' }, ctx);
    const r = runTool(store, 'plan_schedule', { must_do: ['Gamma'] }, ctx) as any;
    expect(r.displaced.map((b: any) => b.taskName)).toEqual(['Weekly']);
    expect(r.summary).toBe('Gamma at 17:00, as asked. "Weekly" gave way and has no other sitting this week. 5 kept as they were; 1 added: Gamma 17:00-18:00');
    // A daily task: Gamma's new sitting is now the cheapest block, and it was Gamma's only one today.
    runTool(store, 'upsert_task', { name: 'Delta', priority: 5, budget_minutes: 60, budget_period: 'day' }, ctx);
    const again = runTool(store, 'plan_schedule', { must_do: ['Delta'] }, ctx) as any;
    expect(again.displaced.map((b: any) => b.taskName)).toEqual(['Gamma']);
    expect(again.summary).toBe('Delta at 17:00, as asked. "Gamma" gave way and has no other sitting today. 5 kept as they were; 1 added: Delta 17:00-18:00');
  });

  it('plan_schedule with must_do reports a block the task already has today, even outside the window, and a weekly budget planned elsewhere', () => {
    store.saveSettings({ ...store.getSettings(), availability: [...STANDARD_WEEK, { days: [3], start: '19:00', end: '21:00' }] });
    runTool(store, 'upsert_task', { name: 'Evening', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
    runTool(store, 'upsert_task', { name: 'Weekly', priority: 2, budget_minutes: 60, budget_period: 'week' }, ctx);
    const mk = (id: string, name: string, start: Date, end: Date): Block => ({ id, taskId: resolveTask(store, name).id, start: start.toISOString(), end: end.toISOString(), status: 'pending', source: 'manual', createdAt: '', statusChangedAt: null });
    store.insertBlocks([mk('ev', 'Evening', d(19), d(20)), mk('wk', 'Weekly', new Date(2026, 9, 8, 9), new Date(2026, 9, 8, 10))]);
    const outside = runTool(store, 'plan_schedule', { until: '18:00', must_do: ['Evening'] }, { now: () => d(10) }) as any;
    expect(outside.summary).toMatch(/^Evening already has 19:00-20:00 today\./);
    const elsewhere = runTool(store, 'plan_schedule', { until: '18:00', must_do: ['Weekly'] }, { now: () => d(10) }) as any;
    expect(elsewhere.summary).toMatch(/^Weekly was not placed: its weekly budget is already done or planned\./);
    expect(store.listBlocks().map((b) => b.id).sort()).toEqual(['ev', 'wk']);
  });

  it('plan_schedule with must_do names the weekday when the block the task already has is not today', () => {
    runTool(store, 'upsert_task', { name: 'Alpha', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
    const alpha = resolveTask(store, 'Alpha');
    store.insertBlocks([{ id: 'm', taskId: alpha.id, start: new Date(2026, 9, 8, 14).toISOString(), end: new Date(2026, 9, 8, 15).toISOString(), status: 'pending', source: 'manual', createdAt: '', statusChangedAt: null }]);
    // Wednesday 21:15, no evening window: the plan runs on Thursday, and Alpha's hand-placed block is after its end.
    const r = runTool(store, 'plan_schedule', { until: 'tomorrow 12:00', must_do: ['Alpha'] }, { now: () => d(21, 15) }) as any;
    expect(r.created).toEqual([]);
    expect(r.summary).toMatch(/^Alpha already has 14:00-15:00 on Thu\./);
  });

  it('update_settings tunes the priority and deficit weights', () => {
    const r = runTool(store, 'update_settings', { priority_weight: 0.2, deficit_weight: 0.8 }, ctx) as any;
    expect(r.settings.weights).toEqual({ priority: 0.2, deficit: 0.8 });
    expect(() => runTool(store, 'update_settings', { priority_weight: 0, deficit_weight: 0 }, ctx)).toThrow(/at least one/i);
    expect(() => runTool(store, 'update_settings', { priority_weight: 2 }, ctx)).toThrow();
  });

  it('clear_schedule removes pending blocks from now on, keeps done ones, and can target a range', () => {
    runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 120, budget_period: 'day' }, ctx);
    runTool(store, 'plan_schedule', {}, ctx);
    const first = store.listBlocks()[0];
    store.updateBlock(first.id, { status: 'done' });
    const r = runTool(store, 'clear_schedule', {}, { now: () => d(10) }) as any;
    expect(r.removed).toBe(1);
    expect(store.listBlocks().map((b) => b.status)).toEqual(['done']);
    runTool(store, 'plan_schedule', { until: 'tomorrow 18:00' }, { now: () => d(10) });
    const r2 = runTool(store, 'clear_schedule', { from: 'tomorrow 00:00', to: 'tomorrow 23:59' }, { now: () => d(10) }) as any;
    expect(r2.removed).toBeGreaterThan(0);
    expect(store.listBlocks({ from: new Date(2026, 9, 8) }).length).toBe(0);
  });

  describe('import_as_baseline', () => {
    it('refuses, with the import\'s own message, a calendar in which nothing repeats in half of the weeks seen', () => {
      const ev = (date: string, title: string) => ['BEGIN:VEVENT', `UID:${date}${title}`, `DTSTART:${date}T090000`, `DTEND:${date}T100000`, `SUMMARY:${title}`, 'END:VEVENT'].join('\r\n');
      const ics = ['BEGIN:VCALENDAR', ev('20260914', 'A'), ev('20260921', 'B'), ev('20260928', 'C'), ev('20261005', 'D'), 'END:VCALENDAR'].join('\r\n');
      expect(() => runTool(store, 'import_as_baseline', { ics }, ctx)).toThrow(/No routine to import: .* 4 weeks seen .* Export one typical week/);
      expect(store.getBaseline()).toBeUndefined();
    });

    const fixture = readFileSync(new URL('../../bench/dialogues/routine.ics', import.meta.url), 'utf8');
    it('from .ics text: the routine week becomes the baseline and its titles the tasks; the summary says what was made', () => {
      const r = runTool(store, 'import_as_baseline', { ics: fixture }, ctx) as any;
      expect(r.baseline.version).toBe(1);
      expect(r.baseline.slots.length).toBe(25);
      expect(r.tasks.created.map((t: any) => t.name)).toEqual(['Morning study', 'LeetCode grinding', 'ML grinding', 'Software — system design & engineering', 'Working — startup build']);
      expect(r.weeksSeen).toBe(1);
      expect(r.summary).toBe('Baseline v1 saved from 1 week: 25 slots on Mon, Tue, Wed, Thu, Fri; 5 new tasks (Morning study, LeetCode grinding, ML grinding, Software — system design & engineering, Working — startup build). Edit titles that are busy time, not work, in the Baseline tab.');
      const again = runTool(store, 'import_as_baseline', { ics: fixture }, ctx) as any;
      expect(again.summary).toBe('Baseline v2 saved from 1 week: 25 slots on Mon, Tue, Wed, Thu, Fri; 5 tasks matched (Morning study, LeetCode grinding, ML grinding, Software — system design & engineering, Working — startup build).');
    });
    it('from a URL through the host\'s fetch, and from the last imported calendar when neither is given', async () => {
      const r = await runTool(store, 'import_as_baseline', { url: 'webcal://example.com/r.ics' }, { now: () => d(9), fetchText: async (u) => { expect(u).toBe('https://example.com/r.ics'); return fixture; } }) as any;
      expect(r.baseline.version).toBe(1);
      await runTool(store, 'import_calendar', { url: 'https://example.com/r.ics' }, { now: () => d(9), fetchText: async () => fixture });
      const fromRecord = runTool(store, 'import_as_baseline', {}, ctx) as any;
      expect(fromRecord.baseline.version).toBe(2);
      expect(fromRecord.source).toBe('https://example.com/r.ics');
      expect(fromRecord.tasks.created).toEqual([]);
      expect(fromRecord.tasks.matched.length).toBe(5);
      expect(() => runTool(new MemoryStore(), 'import_as_baseline', {}, ctx)).toThrow(/no imported calendar/i);
      expect(() => runTool(store, 'import_as_baseline', { url: 'https://example.com/r.ics' }, ctx)).toThrow(/not available/i);
    });
    it('names the one-offs it left out and the revived tasks', () => {
      runTool(store, 'upsert_task', { name: 'Reading', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
      runTool(store, 'archive_task', { task: 'Reading' }, ctx);
      const ev = (uid: string, start: string, end: string, title: string) => ['BEGIN:VEVENT', `UID:${uid}`, `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${title}`, 'END:VEVENT'];
      const ics = ['BEGIN:VCALENDAR', ...ev('a', '20260921T090000', '20260921T100000', 'Reading'), ...ev('b', '20260928T090000', '20260928T100000', 'Reading'), ...ev('c', '20261005T090000', '20261005T100000', 'Reading'), ...ev('d', '20260930T160000', '20260930T170000', 'Dentist'), 'END:VCALENDAR'].join('\r\n');
      const r = runTool(store, 'import_as_baseline', { ics }, ctx) as any;
      expect(r.summary).toBe('Baseline v1 saved from 3 weeks: 1 slot on Mon; 1 task revived (Reading); 1 one-off left out (Dentist Wed 16:00-17:00).');
      expect(store.listTasks().map((t) => t.name)).toEqual(['Reading']);
    });
  });

  it('caps the planning horizon at 14 days per call and says so', () => {
    runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
    const r = runTool(store, 'plan_schedule', { until: '2036-01-01' }, ctx) as any;
    expect(new Date(r.window.end)).toEqual(new Date(2026, 9, 21, 9));
    expect(r.created.length).toBeLessThanOrEqual(10);
    expect(r.summary).toMatch(/14 days/);
    const fine = runTool(store, 'plan_schedule', { until: '2026-10-09 18:00' }, ctx) as any;
    expect(fine.summary).not.toMatch(/14 days/);
  });

  it('bounds text lengths, counts, and durations', () => {
    expect(() => runTool(store, 'upsert_task', { name: 'x'.repeat(81), priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx)).toThrow(/80/);
    expect(() => runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 20000, budget_period: 'day' }, ctx)).toThrow(/10080|too large/i);
    expect(() => runTool(store, 'add_commitment', { title: 'x'.repeat(81), start: '10:00', end: '11:00' }, ctx)).toThrow(/80/);
    expect(() => runTool(store, 'add_commitment', { title: 'Long', start: '10:00', end: '2026-10-10 10:00' }, ctx)).toThrow(/24 hours/);
    expect(() => runTool(store, 'add_recurring_commitment', { title: 'x'.repeat(81), days: 'mon', start: '10:00', end: '11:00' }, ctx)).toThrow(/80/);
    const many = Array.from({ length: 15 }, (_, i) => ({ days: 'mon', start: `${String(i).padStart(2, '0')}:00`, end: `${String(i).padStart(2, '0')}:30` }));
    expect(() => runTool(store, 'set_availability', { windows: many }, ctx)).toThrow(/14/);
  });

  it('get_summary reports per task', () => {
    runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
    runTool(store, 'plan_schedule', {}, ctx);
    const s = runTool(store, 'get_summary', { window: 'day' }, ctx) as any;
    expect(s.tasks[0].counts.pending).toBe(1);
    expect(s.tasks[0].trackedMinutes).toBe(0);
  });
  it('get_summary carries the tracked minutes of a task', () => {
    runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
    runTool(store, 'plan_schedule', {}, ctx);
    runTool(store, 'track_time', { task: 'A', action: 'set', minutes: 45 }, ctx);
    const s = runTool(store, 'get_summary', { window: 'day' }, ctx) as any;
    expect(s.tasks[0].trackedMinutes).toBe(45);
  });
});

describe('track_time', () => {
  const at = (h: number, m = 0) => ({ now: () => d(h, m) });
  beforeEach(() => {
    runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
  });
  const planA = () => (runTool(store, 'plan_schedule', {}, ctx) as any, store.listBlocks()[0]);

  it('start by task name runs the clock and says when the block sits', () => {
    const b = planA();
    expect(hm(b.start)).toBe('09:00');
    const r = runTool(store, 'track_time', { task: 'A', action: 'start' }, ctx) as any;
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/^Started "A" 09:00-10:00\.$/);
    expect(r.block.runningSince).toBe(d(9).toISOString());
    expect(r.block.taskName).toBe('A');
    expect(r.paused).toEqual([]);
  });
  it('pause reports the minutes worked', () => {
    planA();
    runTool(store, 'track_time', { task: 'A', action: 'start' }, ctx);
    const r = runTool(store, 'track_time', { task: 'A', action: 'pause' }, at(9, 25)) as any;
    expect(r.summary).toBe('Paused "A" at 25 min.');
    expect(r.elapsedMinutes).toBe(25);
    expect(r.block.runningSince).toBeNull();
  });
  it('finish marks the block done and quotes the planned length', () => {
    const b = planA();
    runTool(store, 'track_time', { task: 'A', action: 'start' }, ctx);
    const r = runTool(store, 'track_time', { task: 'A', action: 'finish' }, at(9, 25)) as any;
    expect(r.summary).toBe('Finished "A" after 25 min (planned 60).');
    expect(store.getBlock(b.id)!.status).toBe('done');
  });
  it('finish with no clock counts the minutes from the block\'s start, capped at its length, and says so', () => {
    const b = planA();
    const r = runTool(store, 'track_time', { task: 'A', action: 'finish' }, at(9, 25)) as any;
    expect(r.summary).toBe('Finished "A" after 25 min, counted from its start (the clock never ran); planned 60.');
    expect(store.getBlock(b.id)!.status).toBe('done');
    expect(store.getBlock(b.id)!.trackedMinutes).toBe(25);
    store.insertBlocks([{ id: 'late', taskId: b.taskId, start: d(14).toISOString(), end: d(15).toISOString(), status: 'pending', source: 'planner', createdAt: '', statusChangedAt: null }]);
    expect((runTool(store, 'track_time', { block_id: 'late', action: 'finish' }, at(15, 30)) as any).summary).toMatch(/after 60 min, counted from its start \(the clock never ran\)\.$/); // past its end: capped at the hour
  });
  it('start on a block of another day runs its clock where it is; finish on another day needs a start first; a later block today may be started', () => {
    const b = planA();
    const orig = { start: b.start, end: b.end }; // MemoryStore updates its objects in place
    const tomorrow = { now: () => new Date(2026, 9, 8, 8, 0) };
    expect(() => runTool(store, 'track_time', { block_id: b.id, action: 'finish' }, tomorrow)).toThrow(/not today and was never started/);
    const started = runTool(store, 'track_time', { block_id: b.id, action: 'start' }, tomorrow) as any;
    expect(started.block.start).toBe(orig.start); expect(started.block.end).toBe(orig.end); expect(started.block.runningSince).toBe(tomorrow.now().toISOString()); expect(started.block.startedAt).toBe(tomorrow.now().toISOString());
    expect(started.summary).toMatch(/^Started "A" 09:00-10:00/);
    runTool(store, 'track_time', { block_id: b.id, action: 'pause' }, tomorrow); markBlock(store, b.id, 'pending', tomorrow.now()); // reset: undo the start
    expect(store.getBlock(b.id)!.status).toBe('pending');
    runTool(store, 'track_time', { block_id: b.id, action: 'start' }, at(8, 0));
    expect(store.getBlock(b.id)!.runningSince).toBe(d(8).toISOString());
  });
  it('set logs minutes by hand', () => {
    const b = planA();
    const r = runTool(store, 'track_time', { task: 'A', action: 'set', minutes: 45 }, ctx) as any;
    expect(r.summary).toBe('Logged 45 min on "A".');
    expect(store.getBlock(b.id)!.trackedMinutes).toBe(45);
  });
  it('accepts a block_id instead of a task', () => {
    const b = planA();
    const r = runTool(store, 'track_time', { block_id: b.id, action: 'set', minutes: 10 }, ctx) as any;
    expect(r.summary).toBe('Logged 10 min on "A".');
  });
  it('start on another block mentions the block it paused', () => {
    runTool(store, 'upsert_task', { name: 'B', priority: 2, budget_minutes: 60, budget_period: 'day' }, ctx);
    runTool(store, 'plan_schedule', {}, ctx);
    const blocks = store.listBlocks();
    const a = blocks.find((x) => store.getTask(x.taskId)!.name === 'A')!;
    runTool(store, 'track_time', { block_id: a.id, action: 'start' }, ctx);
    const r = runTool(store, 'track_time', { task: 'B', action: 'start' }, at(9, 45)) as any;
    expect(r.summary).toMatch(/^Started "B" \d\d:\d\d-\d\d:\d\d; paused "A" at 45 min\.$/);
    expect(r.paused).toHaveLength(1);
    expect(r.paused[0].taskName).toBe('A');
  });
  it('the other example of the summary names B at 10:00-11:00 when B follows A', () => {
    runTool(store, 'upsert_task', { name: 'B', priority: 2, budget_minutes: 60, budget_period: 'day' }, ctx);
    runTool(store, 'plan_schedule', {}, ctx);
    runTool(store, 'track_time', { task: 'A', action: 'start' }, ctx);
    const r = runTool(store, 'track_time', { task: 'B', action: 'start' }, at(9, 45)) as any;
    expect(r.summary).toMatch(/^Started "B" 10:00-11:00; paused "A" at \d+ min\.$/);
  });
  it('explains what is missing', () => {
    expect(() => runTool(store, 'track_time', { task: 'A', action: 'start' }, ctx)).toThrow(/No block for "A" today/);
    planA();
    expect(() => runTool(store, 'track_time', { task: 'A', action: 'set' }, ctx)).toThrow(/minutes/);
    expect(() => runTool(store, 'track_time', { action: 'start' }, ctx)).toThrow(/Give block_id or task/);
    expect(() => runTool(store, 'track_time', { block_id: 'nope', action: 'start' }, ctx)).toThrow(/Block not found: nope/);
    expect(() => runTool(store, 'track_time', { task: 'A', action: 'set', minutes: 1441 }, ctx)).toThrow();
  });
});

describe('no tool but plan_schedule plans', () => {
  // Every other tool leaves the blocks the planner placed where they were (ids and times: a mark changes the status, and
  // save_baseline the source, which locks them) and creates no block but add_block's hand-placed one. A commitment or a
  // window set over a planned block does not re-plan it: the user asks for the next plan.
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x', 'DTSTART:20261007T163000Z', 'DTEND:20261007T170000Z', 'SUMMARY:Dentist', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const later = { now: () => d(9, 30), fetchText: async () => ics };
  type Ids = { planner: string; manual: string };
  const calls: Array<[name: string, call: (ids: Ids) => unknown]> = [
    ['mark_block', ({ planner }) => runTool(store, 'mark_block', { block_id: planner, status: 'done' }, later)],
    ['mark_task', () => runTool(store, 'mark_task', { task: 'A', status: 'skipped' }, later)],
    ['move_block', ({ manual }) => runTool(store, 'move_block', { block_id: manual, start: '15:00' }, later)],
    ['add_block', () => runTool(store, 'add_block', { task: 'A', start: '16:00', end: '17:00' }, later)],
    ['delete_block', ({ manual }) => runTool(store, 'delete_block', { block_id: manual }, later)],
    ['add_commitment', () => runTool(store, 'add_commitment', { title: 'Call', start: '09:30', end: '10:00' }, later)],
    ['add_recurring_commitment', () => runTool(store, 'add_recurring_commitment', { title: 'Standup', days: 'weekdays', start: '09:30', end: '10:00' }, later)],
    ['set_availability', () => runTool(store, 'set_availability', { windows: [{ days: 'weekdays', start: '10:00', end: '18:00' }] }, later)],
    ['update_settings', () => runTool(store, 'update_settings', { max_block_minutes: 120, max_tasks_per_day: 2 }, later)],
    ['save_baseline', () => runTool(store, 'save_baseline', { confirm: true }, later)],
    ['import_calendar', () => runTool(store, 'import_calendar', { url: 'https://example.com/cal.ics' }, later)],
    ['import_as_baseline', () => runTool(store, 'import_as_baseline', { ics }, later)],
  ];
  it.each(calls)('%s leaves the planned blocks where they were and creates none', async (name, call) => {
    runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 120, budget_period: 'day' }, ctx);
    const planned = runTool(store, 'plan_schedule', {}, ctx) as any; // A 09:00-10:00, 10:00-11:00
    expect(planned.created.map((b: any) => [hm(b.start), hm(b.end)])).toEqual([['09:00', '10:00'], ['10:00', '11:00']]);
    const manual = runTool(store, 'add_block', { task: 'A', start: '14:00', end: '15:00' }, ctx) as any;
    const snap = () => Object.fromEntries(store.listBlocks().map((b) => [b.id, `${b.start} ${b.end}`]));
    const before = snap();
    await call({ planner: planned.created[0].id, manual: manual.id });
    const after = snap();
    for (const b of planned.created) expect(after[b.id], `${name}: ${b.taskName} ${hm(b.start)}`).toBe(before[b.id]);
    expect(Object.keys(before).filter((id) => !(id in after))).toEqual(name === 'delete_block' ? [manual.id] : []);
    expect(Object.keys(after).filter((id) => !(id in before)).map((id) => store.getBlock(id)!.source)).toEqual(name === 'add_block' ? ['manual'] : []);
  });
});

describe('plan_schedule reports sittings added on later planned days', () => {
  const on = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m);
  it('lists them apart from the window and counts them in the summary', () => {
    runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
    runTool(store, 'upsert_task', { name: 'W', priority: 2, budget_minutes: 120, budget_period: 'week' }, ctx);
    runTool(store, 'plan_schedule', { horizon: 'week' }, { now: () => on(5, 9) }); // A every day; W paced Tue and Thu at 10:00
    store.deleteBlocks(store.listBlocks().filter((b) => b.taskId === resolveTask(store, 'W').id && new Date(b.start).getDate() === 8).map((b) => b.id)); // the user drops Thursday's W
    const r = runTool(store, 'plan_schedule', { until: '18:00' }, { now: () => on(7, 9) }) as any; // Tuesday's W missed: W owes both sittings again
    expect(r.created.map((b: any) => b.taskName)).toEqual(['W']);
    expect(r.later.map((b: any) => [b.taskName, b.start])).toEqual([['W', on(8, 10).toISOString()]]);
    // Monday's and Tuesday's blocks ended unmarked: they became missed in this plan and are named first, with the redo hint.
    expect(r.summary).toMatch(/^A Mon 09:00, A Tue 09:00, W Tue 10:00 missed \(say "I didn't finish A" to redo it\)\. 1 kept as it was; 1 added: W 10:00-11:00, and 1 more sitting later in the week \(W Thu 10:00-11:00\)$/);
  });

  it('names at most two of them in the summary and counts the rest, so a verbatim reply stays short', () => {
    runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
    runTool(store, 'upsert_task', { name: 'W', priority: 2, budget_minutes: 180, budget_period: 'week' }, ctx);
    runTool(store, 'upsert_task', { name: 'V', priority: 3, budget_minutes: 180, budget_period: 'week' }, ctx);
    // Planned earlier: Wednesday A, W, V; Thursday and Friday A only. W and V owe two sittings each beyond Wednesday.
    const id = (n: string) => resolveTask(store, n).id;
    const planned = (n: string, day: number, h: number) => ({ id: `${n}${day}`, taskId: id(n), start: on(day, h).toISOString(), end: on(day, h + 1).toISOString(), status: 'pending' as const, source: 'planner' as const, createdAt: '', statusChangedAt: null });
    store.insertBlocks([planned('A', 7, 9), planned('W', 7, 10), planned('V', 7, 11), planned('A', 8, 9), planned('A', 9, 9)]);
    const r = runTool(store, 'plan_schedule', { until: '18:00' }, { now: () => on(7, 9) }) as any;
    expect(r.later.map((b: any) => [b.taskName, b.start])).toEqual([['W', on(8, 10).toISOString()], ['V', on(8, 11).toISOString()], ['W', on(9, 10).toISOString()], ['V', on(9, 11).toISOString()]]);
    expect(r.summary).toBe('3 kept as they were; 4 more sittings later in the week (W Thu 10:00-11:00, V Thu 11:00-12:00 and 2 more).');
  });
});

describe('skipped means not today', () => {
  it('the status field says a skipped block is not re-planned today, and missed stays the carry-over', () => {
    const t = tools.find((x) => x.name === 'mark_block')!;
    const desc = (t.schema.shape as any).status.description as string;
    expect(desc).toMatch(/skipped = not done today/i);
    expect(desc).toMatch(/not re-planned today/i);
    expect(desc).toMatch(/ended unmarked.*missed.*not re-placed the same day/i);
  });
});

describe('upsert_task infers the part of day from the name', () => {
  const base = { priority: 3, budget_minutes: 300, budget_period: 'week' };
  it('uses the name when no preferred_segment is given', () => {
    const t = runTool(store, 'upsert_task', { name: 'Morning learning', ...base }, ctx) as any;
    expect(t.preferredSegment).toBe('morning');
  });
  it('an explicit preferred_segment wins over the name', () => {
    const t = runTool(store, 'upsert_task', { name: 'Morning learning', ...base, preferred_segment: 'evening' }, ctx) as any;
    expect(t.preferredSegment).toBe('evening');
  });
  it('does not override an existing explicit preference', () => {
    const first = runTool(store, 'upsert_task', { name: 'Reading', ...base, preferred_segment: 'afternoon' }, ctx) as any;
    const t = runTool(store, 'upsert_task', { id: first.id, name: 'Morning reading', ...base }, ctx) as any;
    expect(t.preferredSegment).toBe('afternoon');
  });
  it('replaces an existing "any" with what the new name says', () => {
    const first = runTool(store, 'upsert_task', { name: 'Review', ...base }, ctx) as any;
    expect(first.preferredSegment).toBe('any');
    const t = runTool(store, 'upsert_task', { id: first.id, name: 'Evening review', ...base }, ctx) as any;
    expect(t.preferredSegment).toBe('evening');
  });
});

describe('a missed block means not today', () => {
  describe('a block that became missed in this plan is named, with the way to redo it', () => {
    it('"free until 18:00" at 10:05 with the 09:00 block unmarked says so instead of "nothing to change"', () => {
      runTool(store, 'upsert_task', { name: 'Leetcode', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
      runTool(store, 'upsert_task', { name: 'Beta', priority: 2, budget_minutes: 60, budget_period: 'day' }, ctx);
      runTool(store, 'plan_schedule', {}, ctx); // Leetcode 09:00-10:00, Beta 10:00-11:00
      const r = runTool(store, 'plan_schedule', { until: '18:00' }, { now: () => d(10, 5) }) as any;
      expect(r.summary).toMatch(/^Leetcode 09:00 missed \(say "I didn't finish Leetcode" to redo it\)\. Nothing to change: 1 kept as it was\.$/);
      // Asking again says nothing of it: it did not become missed in that plan.
      const again = runTool(store, 'plan_schedule', { until: '18:00' }, { now: () => d(10, 10) }) as any;
      expect(again.summary).toBe('Nothing to change: 1 kept as it was.');
    });

    it('several blocks are listed, a block of another day with its weekday, and the hint names the first; a block with tracked minutes is finished, not named', () => {
      runTool(store, 'upsert_task', { name: 'Reading', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
      runTool(store, 'upsert_task', { name: 'Beta', priority: 2, budget_minutes: 60, budget_period: 'day' }, ctx);
      runTool(store, 'upsert_task', { name: 'Gamma', priority: 3, budget_minutes: 60, budget_period: 'day' }, ctx);
      runTool(store, 'plan_schedule', { until: 'tomorrow 18:00' }, { now: () => d(16) }); // Reading Wed 16:00-17:00, Beta Wed 17:00-18:00, Gamma Thu 09:00 ...
      const wed = store.listBlocks({ from: d(0), to: d(24) }).sort((a, b) => a.start.localeCompare(b.start));
      expect(wed.map((b) => store.getTask(b.taskId)!.name)).toEqual(['Reading', 'Beta']);
      runTool(store, 'track_time', { block_id: wed[1].id, action: 'set', minutes: 40 }, { now: () => d(18) }); // Beta was worked on: finished at its end, not missed
      const r = runTool(store, 'plan_schedule', {}, { now: () => new Date(2026, 9, 8, 10, 5) }) as any; // Thursday 10:05: Reading Wed 16:00 and Reading Thu 09:00 ended unmarked
      expect(r.summary).toMatch(/^Reading Wed 16:00, Reading 09:00 missed \(say "I didn't finish Reading" to redo it\)\. /);
      expect(r.summary).not.toMatch(/Beta[^,]*missed/);
    });
  });

  it('plan_schedule with must_do re-places a block the user did not finish; without it the task gets nothing more today', () => {
    runTool(store, 'upsert_task', { name: 'Alpha', priority: 1, budget_minutes: 60, budget_period: 'day' }, { now: () => d(9) });
    runTool(store, 'upsert_task', { name: 'Beta', priority: 2, budget_minutes: 120, budget_period: 'day' }, { now: () => d(9) });
    runTool(store, 'plan_schedule', {}, { now: () => d(9) }); // Alpha 09:00-10:00, Beta after it
    const later = { now: () => d(10, 6) };
    const plain = runTool(store, 'plan_schedule', { until: '18:00' }, later) as any;
    expect(plain.created.filter((b: any) => b.taskName === 'Alpha')).toEqual([]);
    expect(plain.summary).not.toMatch(/Alpha at/);
    const named = runTool(store, 'plan_schedule', { until: '18:00', must_do: ['Alpha'] }, later) as any;
    expect(named.created.filter((b: any) => b.taskName === 'Alpha')).toHaveLength(1);
    expect(named.summary).toMatch(/^Alpha at \d\d:\d\d, as asked\./);
  });

  it('the must_do field says it is also the way to redo a block that was not finished', () => {
    const field = (tools.find((t) => t.name === 'plan_schedule')!.schema.shape as any).must_do;
    expect(field.description).toMatch(/redo a block .*not finish/i);
  });
});

describe('the baseline week is the source of truth for availability', () => {
  // Settings say 09:00-18:00 on weekdays; the baseline says Wednesday and Thursday 09:00-11:30 (A 09:00, blank, B 10:30).
  const seed = () => {
    runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
    runTool(store, 'upsert_task', { name: 'B', priority: 2, budget_minutes: 60, budget_period: 'day' }, ctx);
    const [a, b] = ['A', 'B'].map((n) => resolveTask(store, n).id);
    store.setBaseline({ slots: [3, 4].flatMap((day) => [{ day, start: '09:00', end: '10:00', kind: 'task' as const, taskId: a }, { day, start: '10:30', end: '11:30', kind: 'task' as const, taskId: b }]) });
    return { a, b };
  };
  const mk = (id: string, taskId: string, start: Date, end: Date, extra: Partial<Block> = {}): Block => ({ id, taskId, start: start.toISOString(), end: end.toISOString(), status: 'pending', source: 'baseline', createdAt: '', statusChangedAt: null, ...extra });

  it('get_now reports the availability the baseline implies and the baseline version; without one, the settings', () => {
    const before = runTool(store, 'get_now', {}, ctx) as any;
    expect(before.availability).toEqual(STANDARD_WEEK);
    expect(before.baseline).toBeNull();
    seed();
    const r = runTool(store, 'get_now', {}, ctx) as any;
    expect(r.availability).toEqual([{ days: [3, 4], start: '09:00', end: '11:30' }]);
    expect(r.baseline).toMatchObject({ version: 1 });
  });

  it('get_schedule lists the usable time of the range from the baseline', () => {
    seed();
    const r = runTool(store, 'get_schedule', {}, ctx) as any;
    expect(r.availability).toEqual([{ start: d(9).toISOString(), end: d(11, 30).toISOString() }]);
  });

  it('plan_schedule makes no change while a baseline with a task slot exists, and names apply_baseline and the Baseline tab; setup counts the baseline as availability', () => {
    store.saveSettings({ ...store.getSettings(), availability: [] });
    seed();
    expect((runTool(store, 'get_setup_status', {}, ctx) as any).ready).toBe(true);
    const r = runTool(store, 'plan_schedule', {}, ctx) as any;
    expect(r).toEqual({ ok: false, note: 'A baseline is set, so the week is the baseline, not a suggestion: lay it with apply_baseline (or Apply on the Baseline tab), then adjust it with shift_day, carve_out or carry_over. plan_schedule suggests a schedule only without a baseline.' });
    expect(store.listBlocks()).toEqual([]);
    store.setBaseline({ slots: [{ day: 3, start: '12:00', end: '13:00', kind: 'busy', title: 'Lunch' }] }); // a busy-only baseline says nothing about work time
    store.saveSettings({ ...store.getSettings(), availability: STANDARD_WEEK });
    expect((runTool(store, 'plan_schedule', {}, ctx) as any).created.length).toBeGreaterThan(0);
  });

  it('add_block and move_block judge "outside your availability" by the baseline', () => {
    seed();
    expect(() => runTool(store, 'add_block', { task: 'A', start: '14:00', end: '15:00' }, ctx)).toThrow(/outside your availability.*09:00-11:30/);
    const ok = runTool(store, 'add_block', { task: 'A', start: '10:00', end: '10:30' }, ctx) as any;
    expect(() => runTool(store, 'move_block', { block_id: ok.id, start: '12:00' }, ctx)).toThrow(/outside your availability/);
  });

  it('save_baseline refreshes each slotted task\'s budget, period and session from the saved slots; a task with no slot keeps its numbers', () => {
    for (const [name, minutes, period] of [['A', 60, 'day'], ['B', 300, 'week'], ['C', 200, 'week']] as const) runTool(store, 'upsert_task', { name, priority: 1, budget_minutes: minutes, budget_period: period }, ctx);
    const [a, b, c] = ['A', 'B', 'C'].map((n) => resolveTask(store, n));
    const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m);
    store.insertBlocks([mk('a1', a.id, at(5, 9), at(5, 10, 30)), mk('a2', a.id, at(7, 9), at(7, 10, 30)), mk('a3', a.id, at(9, 9), at(9, 10)), mk('b1', b.id, at(6, 14), at(6, 15))]);
    runTool(store, 'save_baseline', { confirm: true }, ctx);
    expect(store.getTask(a.id)).toMatchObject({ budgetMinutes: 240, budgetPeriod: 'week', sessionMinutes: 90 });
    expect(store.getTask(b.id)).toMatchObject({ budgetMinutes: 60, budgetPeriod: 'week', sessionMinutes: 60 });
    expect(store.getTask(c.id)).toEqual(c);
  });

  it('set_availability makes no change while a baseline exists, and says where to edit instead', () => {
    seed();
    const r = runTool(store, 'set_availability', { windows: [{ days: 'weekdays', start: '07:00', end: '20:00' }] }, ctx) as any;
    expect(r).toEqual({ ok: false, note: 'A baseline is set; edit it on the Baseline tab (or say "this is my baseline" after arranging the week). Availability windows apply only without a baseline.' });
    expect(store.getSettings().availability).toEqual(STANDARD_WEEK);
    expect(tools.find((t) => t.name === 'set_availability')!.description).toMatch(/only without a baseline/i);
    store.setBaseline({ slots: [] });
    expect((runTool(store, 'set_availability', { windows: [{ days: 'weekdays', start: '07:00', end: '20:00' }] }, ctx) as any).availability).toEqual([{ days: [1, 2, 3, 4, 5], start: '07:00', end: '20:00' }]);
  });

  describe('instance operation tools', () => {
    it('shift_day shifts today\'s blocks later by the delay, breaks kept, and returns the blocks with task names', () => {
      const { a, b } = seed();
      store.insertBlocks([mk('x', a, d(9), d(10)), mk('y', b, d(10, 30), d(11, 30))]);
      const r = runTool(store, 'shift_day', { breaks: 'keep' }, { now: () => d(9, 20) }) as any;
      expect(r.needsConfirmation).toBeUndefined();
      expect(r.shortened).toEqual([]);
      expect(r.moved.map((v: any) => [v.taskName, hm(v.start), hm(v.end)])).toEqual([['A', '09:20', '10:20'], ['B', '10:50', '11:50']]);
      // The tool's summary names what now runs when (the instance summary says only how many moved), so a reply that quotes it names the change.
      expect(r.summary).toBe('Shifted 2 blocks by 20 min (A 09:20-10:20, B 10:50-11:50), breaks kept; the day ends at 11:50.');
    });

    it('shift_day names at most three shifted blocks and counts the rest; with nothing shifted the summary is as it was', () => {
      const { a, b } = seed();
      store.insertBlocks([mk('x', a, d(9), d(9, 30)), mk('y', b, d(9, 45), d(10, 15)), mk('z', a, d(10, 30), d(11)), mk('w', b, d(11), d(11, 30))]);
      const r = runTool(store, 'shift_day', { breaks: 'keep' }, { now: () => d(9, 20) }) as any;
      expect(r.summary).toBe('Shifted 4 blocks by 20 min (A 09:20-09:50, B 10:05-10:35, A 10:50-11:20, and 1 more), breaks kept; the day ends at 11:50.');
      store.deleteBlocks(['x', 'y', 'z', 'w']);
      expect((runTool(store, 'shift_day', {}, { now: () => d(9, 20) }) as any).summary).toBe('Nothing to shift today.');
    });

    it('shift_day asks before ending the day late and changes nothing; the answer comes back as breaks', () => {
      const { a, b } = seed();
      store.insertBlocks([mk('x', a, d(9), d(10)), mk('y', b, d(10, 30), d(11, 30))]);
      const ask = runTool(store, 'shift_day', {}, { now: () => d(9, 20) }) as any;
      expect(ask).toMatchObject({ needsConfirmation: true, moved: [], shortened: [], dropped: [], summary: 'Shifting 2 blocks by 20 min keeps your breaks (10:00-10:30) but ends the day at 11:50, past 11:30. Waive the breaks to end at 11:30, or keep them and end later?' });
      expect(hm(store.getBlock('x')!.start)).toBe('09:00');
      const r = runTool(store, 'shift_day', { breaks: 'waive' }, { now: () => d(9, 20) }) as any;
      expect(r.summary).toBe('Shifted 1 block by 20 min (A 09:20-10:20), breaks waived; the day ends at 11:30.');
      expect(hm(store.getBlock('y')!.start)).toBe('10:30');
    });

    it('update_memory replaces the memory note whole, trimmed and capped; empty text clears it', () => {
      expect(runTool(store, 'update_memory', { text: '  - When I start late, waive the breaks.\n' }, ctx)).toEqual({ memory: '- When I start late, waive the breaks.', summary: 'Memory updated.' });
      expect(store.getSettings().memory).toBe('- When I start late, waive the breaks.');
      expect(() => runTool(store, 'update_memory', { text: 'x'.repeat(2001) }, ctx)).toThrow();
      expect(normalizeSettings({ memory: `  ${'y'.repeat(5000)}` }).memory).toHaveLength(2000); // what was stored by other means is trimmed and capped on read
      expect(runTool(store, 'update_memory', { text: '' }, ctx)).toEqual({ memory: '', summary: 'Memory cleared.' });
      expect(store.getSettings().memory).toBe('');
    });

    it('carve_out takes loose times and an optional title, adds the commitment and pushes the blocks', () => {
      const { a, b } = seed();
      store.insertBlocks([mk('x', a, d(9), d(10)), mk('y', b, d(10, 30), d(11, 30))]);
      const r = runTool(store, 'carve_out', { from: '09:30', to: '10:00', title: 'Call' }, ctx) as any;
      expect(r.summary).toBe('Carved out Call 09:30-10:00; split A: 09:00-09:30 kept, 30 min to 10:00-10:30.');
      expect(r.created.map((v: any) => v.taskName)).toEqual(['A']);
      expect((runTool(store, 'get_schedule', {}, ctx) as any).commitments.map((c: any) => c.title)).toEqual(['Call']);
      const busy = runTool(store, 'carve_out', { from: 'tomorrow 09:00', to: 'tomorrow 09:30' }, ctx) as any;
      expect(busy.summary).toBe('Carved out Busy 09:00-09:30; nothing to move.');
      expect(() => runTool(store, 'carve_out', { from: '10:00', to: '09:00' }, ctx)).toThrow(/end must be after start/);
    });

    it('carry_over resolves the task by name and carries its owed minutes', () => {
      const { a, b } = seed();
      store.insertBlocks([mk('x', a, d(9), d(10)), mk('y', b, d(10, 30), d(11, 30))]);
      const r = runTool(store, 'carry_over', { task: 'a' }, { now: () => d(10, 10) }) as any;
      expect(r.summary).toBe('A: 60 min carried to Thu 10:00 (slot extended).'); // no gap left today: 10:15-11:15 would overlap B
      expect(r.created.map((v: any) => [v.taskName, v.source])).toEqual([['A', 'adjusted']]);
      expect(() => runTool(store, 'carry_over', { task: 'nope' }, ctx)).toThrow(/No task matches/);
    });
  });
});

describe('note_block', () => {
  const d = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m);
  const ctx = (now: Date) => ({ now: () => now });
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
    store.saveSettings({ ...DEFAULT_SETTINGS, availability: STANDARD_WEEK });
    store.upsertTask({ id: 'a', name: 'Leetcode', color: '#000', priority: 1, budgetMinutes: 60, budgetPeriod: 'day', archived: false, createdAt: '' });
    store.insertBlocks([
      { id: 'a1', taskId: 'a', start: d(7, 9).toISOString(), end: d(7, 10).toISOString(), status: 'done', createdAt: '', statusChangedAt: null },
      { id: 'a2', taskId: 'a', start: d(8, 9).toISOString(), end: d(8, 10).toISOString(), status: 'pending', createdAt: '', statusChangedAt: null },
    ]);
  });
  it('writes the user\'s note on the block of the task they mean now, returns it and names it; get_schedule shows the note', () => {
    const r = runTool(store, 'note_block', { task: 'Leetcode', note: '  did the session but not focused ' }, ctx(d(7, 10, 30))) as any;
    expect(r.block.id).toBe('a1');
    expect(r.block.note).toBe('did the session but not focused');
    expect(r.summary).toBe('Noted on "Leetcode" Wed 09:00: "did the session but not focused".');
    const sched = runTool(store, 'get_schedule', {}, ctx(d(7, 10, 30))) as any;
    expect(sched.blocks.find((b: any) => b.id === 'a1').note).toBe('did the session but not focused');
  });
  it('takes a block id for a block on another day; an empty note clears it; the block\'s time and status are untouched', () => {
    runTool(store, 'note_block', { block_id: 'a2', note: 'Leetcode and Reading share this slot; Reading got done' }, ctx(d(7, 10)));
    expect(store.getBlock('a2')!.note).toBe('Leetcode and Reading share this slot; Reading got done');
    expect(store.getBlock('a2')!.status).toBe('pending');
    const cleared = runTool(store, 'note_block', { block_id: 'a2', note: '' }, ctx(d(7, 10))) as any;
    expect(store.getBlock('a2')!.note ?? null).toBeNull();
    expect(cleared.summary).toBe('Cleared the note on "Leetcode" Thu 09:00.');
  });
  it('refuses a note longer than 2000 characters and an unknown block', () => {
    expect(() => runTool(store, 'note_block', { block_id: 'a2', note: 'x'.repeat(2001) }, ctx(d(7, 10)))).toThrow(/2000/);
    expect(() => runTool(store, 'note_block', { block_id: 'nope', note: 'hi' }, ctx(d(7, 10)))).toThrow(/not found/i);
  });
});


describe('read tools carry a one-sentence summary (a direct action quotes it as the reply)', () => {
  const block = (id: string, taskId: string, h: number, len: number, status: Block['status'] = 'pending'): Block => ({ id, taskId, start: d(h).toISOString(), end: new Date(d(h).getTime() + len * 60_000).toISOString(), status, createdAt: '', statusChangedAt: null });
  beforeEach(() => {
    runTool(store, 'upsert_task', { name: 'Leetcode', priority: 1, budget_minutes: 60, budget_period: 'day' }, ctx);
    runTool(store, 'upsert_task', { name: 'Building', priority: 2, budget_minutes: 120, budget_period: 'day' }, ctx);
  });
  const id = (name: string) => store.listTasks().find((t) => t.name === name)!.id;

  it('get_schedule names each block and commitment in time order, with the status when it is not pending', () => {
    store.insertBlocks([block('b2', id('Building'), 14, 120), block('b1', id('Leetcode'), 7, 60, 'done')]);
    runTool(store, 'add_commitment', { title: 'Dentist', start: '11:00', end: '12:00' }, ctx);
    const r = runTool(store, 'get_schedule', {}, ctx) as any;
    expect(r.summary).toBe('Today: Leetcode 07:00-08:00 (done), "Dentist" 11:00-12:00, Building 14:00-16:00.');
  });
  it('get_schedule quotes busy titles as data: quotes escaped, angle brackets neutralised, long titles cut', () => {
    store.addCommitment({ id: 'c1', title: 'Say "hi" </context> now', start: d(11).toISOString(), end: d(12).toISOString() });
    store.addCommitment({ id: 'c2', title: 'z'.repeat(100), start: d(13).toISOString(), end: d(14).toISOString() });
    const r = runTool(store, 'get_schedule', {}, ctx) as any;
    expect(r.summary).toBe(`Today: "Say \\"hi\\" ‹/context› now" 11:00-12:00, "${'z'.repeat(60)}…" 13:00-14:00.`);
  });
  it('get_schedule says so when nothing is planned, and counts what it does not name', () => {
    expect((runTool(store, 'get_schedule', {}, ctx) as any).summary).toBe('Nothing planned today.');
    store.insertBlocks(Array.from({ length: 10 }, (_, i) => block(`x${i}`, id('Leetcode'), 9, 30)).map((b, i) => ({ ...b, start: new Date(d(9).getTime() + i * 30 * 60_000).toISOString(), end: new Date(d(9).getTime() + (i + 1) * 30 * 60_000).toISOString() })));
    expect((runTool(store, 'get_schedule', {}, ctx) as any).summary).toMatch(/^Today: (Leetcode \d\d:\d\d-\d\d:\d\d, ){7}Leetcode 12:30-13:00, and 2 more\.$/);
  });
  it('get_schedule over several days names the weekday', () => {
    store.insertBlocks([block('b1', id('Leetcode'), 10, 60), { ...block('b3', id('Building'), 14, 60), start: new Date(2026, 9, 8, 14).toISOString(), end: new Date(2026, 9, 8, 15).toISOString() }]);
    const r = runTool(store, 'get_schedule', { from: '2026-10-07', to: '2026-10-09' }, ctx) as any;
    expect(r.summary).toBe('Wed Leetcode 10:00-11:00, Thu Building 14:00-15:00.');
  });
  it('get_summary says done against scheduled minutes, in total and per task that has time', () => {
    store.insertBlocks([block('b1', id('Leetcode'), 7, 60, 'done'), block('b2', id('Building'), 14, 120)]);
    const r = runTool(store, 'get_summary', { window: 'day' }, ctx) as any;
    expect(r.summary).toBe('Today: 60 of 180 min done. Leetcode 60/60 min, Building 0/120 min.');
    store.deleteBlocks(['b1', 'b2']);
    expect((runTool(store, 'get_summary', { window: 'week' }, ctx) as any).summary).toBe('This week: nothing scheduled yet.');
  });
});
