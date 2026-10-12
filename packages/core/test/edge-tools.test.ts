import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/store.js';
import { parseDays, parseSegment, parseWhen, parseWorkStyle, resolveTask, runTool, tools } from '../src/tools.js';
import { DEFAULT_SETTINGS, STANDARD_WEEK, TASK_COLORS, type Block, type Task } from '../src/types.js';

// Wed 7 Oct 2026, local time, as in tools.test.ts.
const d = (h: number, m = 0) => new Date(2026, 9, 7, h, m);
const on = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m);
const hm = (iso: string) => { const x = new Date(iso); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; };
const at = (h: number, m = 0) => ({ now: () => d(h, m) });
const ctx = at(9);
let store: MemoryStore;

const task = (id: string, name: string, extra: Partial<Task> = {}): Task => ({ id, name, color: '#000000', priority: 1, budgetMinutes: 60, budgetPeriod: 'day', archived: false, createdAt: '', ...extra });
const mk = (id: string, taskId: string, start: Date, end: Date, extra: Partial<Block> = {}): Block => ({ id, taskId, start: start.toISOString(), end: end.toISOString(), status: 'pending', createdAt: '', statusChangedAt: null, ...extra });

beforeEach(() => {
  store = new MemoryStore();
  store.saveSettings({ ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, maxBlockMinutes: 60, minBlockMinutes: 30, slotMinutes: 15 });
});

describe('parseWhen: loose inputs', () => {
  const now = d(9, 5);
  it('trims padding and pads a one-digit hour', () => {
    expect(parseWhen('  17:00  ', now)).toEqual(d(17));
    expect(parseWhen('9:30', now)).toEqual(d(9, 30));
    expect(parseWhen('0:00', now)).toEqual(d(0));
    expect(parseWhen('2026-10-07 7:05', now)).toEqual(d(7, 5));
  });
  it('"24:00" is the midnight that ends today', () => {
    expect(parseWhen('24:00', now)).toEqual(on(8, 0));
  });
  it('today/tomorrow are case-insensitive and tolerate extra spaces', () => {
    expect(parseWhen('TOMORROW 09:00', now)).toEqual(on(8, 9));
    expect(parseWhen('Today 7:05', now)).toEqual(d(7, 5));
    expect(parseWhen('tomorrow   09:00', now)).toEqual(on(8, 9));
  });
  it('drops seconds and fractions of a local date-time', () => {
    expect(parseWhen('2026-10-07T07:05:30', now)).toEqual(d(7, 5));
    expect(parseWhen('2026-10-07T07:05:30.5', now)).toEqual(d(7, 5));
    expect(parseWhen('2026-10-07T17:00:00.000', now)).toEqual(d(17));
  });
  it('an ISO string with an offset or Z is an absolute instant', () => {
    expect(parseWhen('2026-10-07T17:00:00+02:00', now).toISOString()).toBe('2026-10-07T15:00:00.000Z');
    expect(parseWhen('2026-10-07T17:00:00Z', now).toISOString()).toBe('2026-10-07T17:00:00.000Z');
  });
  it('refuses empty, whitespace, "9:5", "17:00:00", words and yesterday, naming the formats', () => {
    const formats = 'Use ISO 8601 like 2026-10-07T17:00:00+02:00, or "YYYY-MM-DD HH:MM", or "17:00" for today, or "tomorrow 09:00".';
    for (const bad of ['', '   ', '9:5', '17:00:00', 'noon', 'yesterday 09:00', 'tomorrow']) {
      expect(() => parseWhen(bad, now), bad).toThrow(`Cannot understand time "${bad}". ${formats}`);
    }
  });
  // Regression (fixed 2026-10-12): parseWhen accepts out-of-range components and silently rolls them over (tools.ts:72-77 call atTime / new Date
  // without range checks): "25:00" today becomes tomorrow 01:00, "17:99" becomes 18:39, "tomorrow 25:00" the day after
  // tomorrow 01:00 and "2026-13-45" 14 Feb 2027. Expected: the "Cannot understand time" error, as normalizeHhmm gives
  // for availability times ("start must be HH:MM (24h)").
  it('refuses hours over 23, minutes over 59 and months over 12', () => {
    for (const bad of ['25:00', '17:99', 'tomorrow 25:00', '2026-13-45']) expect(() => parseWhen(bad, now), bad).toThrow(/Cannot understand time/);
  });
});

describe('parseDays: groups, numbers, strings and junk', () => {
  it('knows the groups in any case', () => {
    expect(parseDays('weekend')).toEqual([0, 6]);
    expect(parseDays('Weekends')).toEqual([0, 6]);
    expect(parseDays('everyday')).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(parseDays('ALL')).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(parseDays('weekday')).toEqual([1, 2, 3, 4, 5]);
    expect(parseDays(['tues', 'thur', 'weds'])).toEqual([2, 3, 4]);
  });
  it('numbers 0 to 6 only, as numbers or digit strings', () => {
    expect(parseDays(0)).toEqual([0]);
    expect(parseDays([6])).toEqual([6]);
    expect(parseDays(['0', '6'])).toEqual([0, 6]);
    expect(() => parseDays(7)).toThrow('Day 7 is out of range; use 0 (Sunday) to 6 (Saturday) or names like "mon".');
    expect(() => parseDays([-1])).toThrow('Day -1 is out of range');
    expect(() => parseDays([1.5])).toThrow('Day 1.5 is out of range');
    expect(() => parseDays([NaN])).toThrow('Day NaN is out of range');
    expect(() => parseDays('7')).toThrow('Unknown day "7". Use names like mon, tue, wed, thu, fri, sat, sun, or "weekdays", "weekend", "daily".');
    expect(() => parseDays('07')).toThrow('Unknown day "07"');
  });
  it('empty or blank input is "at least one day"', () => {
    for (const empty of ['', '   ', [], [''], ', ,']) expect(() => parseDays(empty), JSON.stringify(empty)).toThrow('At least one day is required.');
  });
  it('splits on commas, slashes, "and" and spaces; dedupes; sorts', () => {
    expect(parseDays('Mon/Wed')).toEqual([1, 3]);
    expect(parseDays('mon,mon')).toEqual([1]);
    expect(parseDays('Monday and Friday')).toEqual([1, 5]);
    expect(parseDays('sat, sun, mon')).toEqual([0, 1, 6]);
    expect(parseDays([1, 'weekend', '3'])).toEqual([0, 1, 3, 6]);
    expect(() => parseDays('MON.')).toThrow('Unknown day "MON."');
  });
  it('junk values are named in the error', () => {
    expect(() => parseDays(null)).toThrow('Unknown day "null"');
    expect(() => parseDays(undefined)).toThrow('Unknown day "undefined"');
    expect(() => parseDays(true)).toThrow('Unknown day "true"');
    expect(() => parseDays({})).toThrow('Unknown day "[object Object]"');
  });
});

describe('parseSegment and parseWorkStyle', () => {
  it('maps loose words to a segment', () => {
    const cases: Array<[unknown, string]> = [['mornings', 'morning'], ['after lunch', 'afternoon'], ['night', 'evening'], ['late', 'evening'], ['pm', 'afternoon'], ['AM', 'morning'], ['no preference', 'any'], ['whenever', 'any'], ['no', 'any'], ['', 'any'], [undefined, 'any'], [null, 'any']];
    for (const [input, out] of cases) expect(parseSegment(input), String(input)).toBe(out);
    expect(() => parseSegment('sometime')).toThrow('Unknown part of day "sometime". Use morning, afternoon, evening, or any.');
  });
  it('maps loose words to a work style, deep words first', () => {
    expect(parseWorkStyle('I like long focused sessions')).toBe('deep');
    expect(parseWorkStyle('shorter blocks')).toBe('varied');
    expect(parseWorkStyle('mix')).toBe('balanced');
    expect(parseWorkStyle('somewhere in between')).toBe('balanced');
    expect(parseWorkStyle('short but deep')).toBe('deep');
    expect(() => parseWorkStyle('')).toThrow('Unknown work style "". Use deep, varied, or balanced.');
    expect(() => parseWorkStyle('fast')).toThrow('Unknown work style "fast"');
  });
});

describe('resolveTask: duplicates, archived, case, accents, quotes', () => {
  it('two active tasks whose names differ only by case are ambiguous', () => {
    store.upsertTask(task('a', 'Deep work', { priority: 1 }));
    store.upsertTask(task('b', 'deep WORK', { priority: 2 }));
    expect(() => resolveTask(store, 'deep work')).toThrow('"deep work" matches several tasks: "Deep work", "deep WORK". Use the exact name or id.');
    expect(resolveTask(store, 'b').name).toBe('deep WORK');
  });
  it('an exact name wins over a longer partial match', () => {
    store.upsertTask(task('r', 'Read', { priority: 1 }));
    store.upsertTask(task('g', 'Reading', { priority: 2 }));
    expect(resolveTask(store, 'read').id).toBe('r');
    expect(resolveTask(store, 'READ').id).toBe('r');
    expect(resolveTask(store, 'readin').id).toBe('g');
    expect(() => resolveTask(store, 'ea')).toThrow('"ea" matches several tasks: "Read", "Reading".');
  });
  it('an archived task is found by id only', () => {
    store.upsertTask(task('gym', 'Gym', { archived: true }));
    expect(resolveTask(store, 'gym').archived).toBe(true);
    expect(() => resolveTask(store, 'Gym')).toThrow('No task matches "Gym". Known tasks: (none).');
    expect(() => resolveTask(store, 'nothing')).toThrow('No task matches "nothing". Known tasks: (none).');
  });
  it('case folds but does not fold accents', () => {
    store.upsertTask(task('c', 'Café'));
    expect(resolveTask(store, 'café').id).toBe('c');
    expect(resolveTask(store, 'CAFÉ').id).toBe('c');
    expect(() => resolveTask(store, 'cafe')).toThrow('No task matches "cafe". Known tasks: "Café".');
  });
  it('quotes in names are matched and listed as they are', () => {
    store.upsertTask(task('x', 'A "x"', { priority: 1 }));
    store.upsertTask(task('y', 'A "y"', { priority: 2 }));
    expect(resolveTask(store, 'a "x"').id).toBe('x');
    expect(() => resolveTask(store, 'a "')).toThrow('"a "" matches several tasks: "A "x"", "A "y"". Use the exact name or id.');
  });
  it('trims the reference and prefers an id over a name', () => {
    store.upsertTask(task('zzz', 'Other', { priority: 1 }));
    store.upsertTask(task('q', 'zzz', { priority: 2 }));
    store.upsertTask(task('e', 'Email', { priority: 3 }));
    expect(resolveTask(store, '  Email ').id).toBe('e');
    expect(resolveTask(store, 'zzz').id).toBe('zzz');
    expect(resolveTask(store, ' zzz ').id).toBe('zzz');
  });
  // Regression (fixed 2026-10-12): resolveTask (tools.ts:52) treats "" and "   " as a partial name that every task contains, so with exactly one
  // active task an empty reference resolves to it: mark_task { task: "" } marks that task's block. Expected: the
  // 'No task matches ""' error (an empty reference names nothing).
  it('an empty or blank reference matches nothing', () => {
    store.upsertTask(task('only', 'Only'));
    expect(() => resolveTask(store, '')).toThrow('No task matches ""');
    expect(() => resolveTask(store, '   ')).toThrow('No task matches "   "');
  });
});

describe('runTool: input shapes and unknown keys', () => {
  it('treats undefined and null input as {}', () => {
    expect((runTool(store, 'get_now', undefined, ctx) as any).now).toBe(d(9).toISOString());
    expect((runTool(store, 'get_now', null, ctx) as any).now).toBe(d(9).toISOString());
  });
  it('rejects an array or a string as input, and an unknown tool', () => {
    expect(() => runTool(store, 'get_now', [], ctx)).toThrow(/expected object/);
    expect(() => runTool(store, 'get_now', 'x', ctx)).toThrow(/expected object/);
    expect(() => runTool(store, 'nope', {}, ctx)).toThrow('Unknown tool: nope');
  });
  it('strips unknown keys instead of refusing them', () => {
    const t = runTool(store, 'upsert_task', { name: 'A', priority: 1, budget_minutes: 60, budget_period: 'day', bogus: 1 }, ctx) as any;
    expect('bogus' in t).toBe(false);
    expect(t.name).toBe('A');
  });
  it('booleans are not coerced from strings', () => {
    expect(() => runTool(store, 'list_tasks', { include_archived: 'true' }, ctx)).toThrow(/expected boolean/);
    expect(() => runTool(store, 'clear_schedule', { include_done: 'yes' }, ctx)).toThrow(/expected boolean/);
  });
  it('every tool has a zod object schema and a non-empty description', () => {
    for (const t of tools) {
      expect(typeof t.schema.parse, t.name).toBe('function');
      expect(t.description.length, t.name).toBeGreaterThan(20);
    }
  });
});

describe('upsert_task: coercion, bounds, names, colours, revival', () => {
  const base = { budget_minutes: 60, budget_period: 'day' };
  it('coerces priority from strings and booleans, within 1..99', () => {
    expect((runTool(store, 'upsert_task', { name: 'P1', priority: '1', ...base }, ctx) as any).priority).toBe(1);
    expect((runTool(store, 'upsert_task', { name: 'P2', priority: ' 2 ', ...base }, ctx) as any).priority).toBe(2);
    expect((runTool(store, 'upsert_task', { name: 'P3', priority: true, ...base }, ctx) as any).priority).toBe(1);
    expect((runTool(store, 'upsert_task', { name: 'P4', priority: 99, ...base }, ctx) as any).priority).toBe(99);
    for (const bad of ['', null, '1.5', 0, 100, 'abc', -1]) expect(() => runTool(store, 'upsert_task', { name: 'Bad', priority: bad, ...base }, ctx), JSON.stringify(bad)).toThrow();
  });
  it('budget_minutes is an integer from 1 to a full week, coerced', () => {
    expect((runTool(store, 'upsert_task', { name: 'B1', priority: 1, budget_minutes: '120', budget_period: 'week' }, ctx) as any).budgetMinutes).toBe(120);
    expect((runTool(store, 'upsert_task', { name: 'B2', priority: 1, budget_minutes: 10080, budget_period: 'week' }, ctx) as any).budgetMinutes).toBe(10080);
    expect(() => runTool(store, 'upsert_task', { name: 'B3', priority: 1, budget_minutes: 10081, budget_period: 'week' }, ctx)).toThrow(/too large/);
    expect(() => runTool(store, 'upsert_task', { name: 'B4', priority: 1, budget_minutes: 0, budget_period: 'week' }, ctx)).toThrow();
    expect(() => runTool(store, 'upsert_task', { name: 'B5', priority: 1, budget_minutes: 30.5, budget_period: 'week' }, ctx)).toThrow();
    expect(() => runTool(store, 'upsert_task', { name: 'B6', priority: 1, budget_minutes: 30, budget_period: 'month' }, ctx)).toThrow();
  });
  it('names are trimmed (inner spaces kept), never blank, at most 80 characters after trimming', () => {
    expect((runTool(store, 'upsert_task', { name: '  Deep   work  ', priority: 1, ...base }, ctx) as any).name).toBe('Deep   work');
    expect(() => runTool(store, 'upsert_task', { name: '   ', priority: 1, ...base }, ctx)).toThrow();
    expect((runTool(store, 'upsert_task', { name: 'x'.repeat(80), priority: 1, ...base }, ctx) as any).name).toHaveLength(80);
    expect((runTool(store, 'upsert_task', { name: `${'y'.repeat(80)} `, priority: 1, ...base }, ctx) as any).name).toHaveLength(80);
    expect(() => runTool(store, 'upsert_task', { name: 'z'.repeat(81), priority: 1, ...base }, ctx)).toThrow('Task name must be at most 80 characters');
    expect(() => runTool(store, 'upsert_task', { priority: 1, ...base }, ctx)).toThrow();
  });
  it('colour must be a six-digit hex; otherwise the palette cycles over all tasks, archived ones included', () => {
    expect((runTool(store, 'upsert_task', { name: 'C', priority: 1, ...base, color: '#ABCDEF' }, ctx) as any).color).toBe('#ABCDEF');
    expect(() => runTool(store, 'upsert_task', { name: 'C2', priority: 1, ...base, color: '#abc' }, ctx)).toThrow();
    expect(() => runTool(store, 'upsert_task', { name: 'C3', priority: 1, ...base, color: 'red' }, ctx)).toThrow();
    store = new MemoryStore();
    for (let i = 0; i < 8; i += 1) runTool(store, 'upsert_task', { name: `T${i}`, priority: 1, ...base }, ctx);
    runTool(store, 'archive_task', { task: 'T3' }, ctx);
    const ninth = runTool(store, 'upsert_task', { name: 'T8', priority: 1, ...base }, ctx) as any;
    expect(ninth.color).toBe(TASK_COLORS[0]);
    expect(store.listTasks().find((t) => t.name === 'T1')!.color).toBe(TASK_COLORS[1]);
  });
  it('preferred_segment takes loose words and refuses unknown ones', () => {
    const seg = (s: string) => (runTool(store, 'upsert_task', { name: `S ${s}`, priority: 1, ...base, preferred_segment: s }, ctx) as any).preferredSegment;
    expect(seg('mornings')).toBe('morning');
    expect(seg('after lunch')).toBe('afternoon');
    expect(seg('night')).toBe('evening');
    expect(seg('no preference')).toBe('any');
    expect(seg('')).toBe('any');
    expect(() => seg('sometime')).toThrow('Unknown part of day "sometime"');
  });
  it('session_minutes is 15..480, coerced, and kept from the existing task when omitted', () => {
    const t = runTool(store, 'upsert_task', { name: 'S', priority: 1, ...base, session_minutes: '60' }, ctx) as any;
    expect(t.sessionMinutes).toBe(60);
    expect((runTool(store, 'upsert_task', { name: 'S', priority: 2, ...base }, ctx) as any).sessionMinutes).toBe(60);
    expect((runTool(store, 'upsert_task', { name: 'S15', priority: 1, ...base, session_minutes: 15 }, ctx) as any).sessionMinutes).toBe(15);
    expect((runTool(store, 'upsert_task', { name: 'S480', priority: 1, ...base, session_minutes: 480 }, ctx) as any).sessionMinutes).toBe(480);
    expect(() => runTool(store, 'upsert_task', { name: 'S14', priority: 1, ...base, session_minutes: 14 }, ctx)).toThrow();
    expect(() => runTool(store, 'upsert_task', { name: 'S481', priority: 1, ...base, session_minutes: 481 }, ctx)).toThrow();
  });
  it('an unknown id with a new name creates a task under a fresh id', () => {
    const t = runTool(store, 'upsert_task', { id: 'ghost', name: 'New', priority: 1, ...base }, ctx) as any;
    expect(t.id).not.toBe('ghost');
    expect(store.getTask('ghost')).toBeUndefined();
    expect(store.listTasks().map((x) => x.name)).toEqual(['New']);
  });
  it('a known id wins over the name, even when the name belongs to another task', () => {
    store.upsertTask(task('a', 'A', { priority: 1 }));
    store.upsertTask(task('b', 'B', { priority: 2 }));
    runTool(store, 'upsert_task', { id: 'a', name: 'B', priority: 1, ...base }, ctx);
    expect(store.listTasks().map((x) => [x.id, x.name])).toEqual([['a', 'B'], ['b', 'B']]);
  });
  it('revives an archived task of the same name under its old id and keeps createdAt and colour', () => {
    store.upsertTask(task('old', 'Reading', { archived: true, color: '#123456', createdAt: '2020-01-01T00:00:00.000Z' }));
    const t = runTool(store, 'upsert_task', { name: 'reading', priority: 2, ...base }, ctx) as any;
    expect(t).toMatchObject({ id: 'old', name: 'reading', archived: false, color: '#123456', createdAt: '2020-01-01T00:00:00.000Z', priority: 2 });
    expect(store.listTasks(true)).toHaveLength(1);
  });
  it('a new task is stamped with the context time', () => {
    const t = runTool(store, 'upsert_task', { name: 'Stamp', priority: 1, ...base }, at(13, 7)) as any;
    expect(t.createdAt).toBe(d(13, 7).toISOString());
    expect(t.archived).toBe(false);
  });
});

describe('list_tasks and archive_task', () => {
  it('lists active tasks by priority then name; archived only on request', () => {
    store.upsertTask(task('b', 'Beta', { priority: 2 }));
    store.upsertTask(task('a', 'Alpha', { priority: 2 }));
    store.upsertTask(task('z', 'Zed', { priority: 1 }));
    store.upsertTask(task('g', 'Gone', { priority: 1, archived: true }));
    expect((runTool(store, 'list_tasks', {}, ctx) as any).tasks.map((t: Task) => t.name)).toEqual(['Zed', 'Alpha', 'Beta']);
    expect((runTool(store, 'list_tasks', { include_archived: true }, ctx) as any).tasks.map((t: Task) => t.name)).toEqual(['Gone', 'Zed', 'Alpha', 'Beta']);
    expect((runTool(new MemoryStore(), 'list_tasks', {}, ctx) as any).tasks).toEqual([]);
  });
  it('archiving twice by id is fine; by name the second time it is unknown', () => {
    store.upsertTask(task('o', 'Old'));
    expect(runTool(store, 'archive_task', { task: 'old' }, ctx)).toEqual({ ok: true, archived: 'Old' });
    expect(runTool(store, 'archive_task', { task: 'o' }, ctx)).toEqual({ ok: true, archived: 'Old' });
    expect(() => runTool(store, 'archive_task', { task: 'Old' }, ctx)).toThrow('No task matches "Old". Known tasks: (none).');
    expect(() => runTool(store, 'archive_task', {}, ctx)).toThrow();
  });
});

describe('get_schedule: ranges and summaries', () => {
  beforeEach(() => store.upsertTask(task('a', 'A')));
  it('an inverted or empty range is "nothing planned in that range"', () => {
    store.insertBlocks([mk('x', 'a', d(9), d(10))]);
    const inverted = runTool(store, 'get_schedule', { from: '2026-10-09', to: '2026-10-07' }, ctx) as any;
    expect(inverted.blocks).toEqual([]);
    expect(inverted.summary).toBe('Nothing planned in that range.');
    const empty = runTool(store, 'get_schedule', { from: '2026-10-07 10:00', to: '2026-10-07 10:00' }, ctx) as any;
    expect(empty.blocks).toEqual([]);
    expect(empty.summary).toBe('Nothing planned in that range.');
  });
  it('an explicit range equal to today still says "Today:"; one other day is named; a block of a missing task is "Unknown task"', () => {
    store.insertBlocks([mk('x', 'a', d(9), d(10)), mk('y', 'ghost', on(8, 9), on(8, 10))]);
    expect((runTool(store, 'get_schedule', { from: '2026-10-07', to: '2026-10-08' }, ctx) as any).summary).toBe('Today: A 09:00-10:00.');
    const thu = runTool(store, 'get_schedule', { from: '2026-10-08', to: '2026-10-09' }, ctx) as any;
    expect(thu.summary).toBe('Thu: Unknown task 09:00-10:00.');
    expect(thu.blocks[0].taskName).toBe('Unknown task');
  });
  it('from alone keeps the default end (end of today); garbage is refused', () => {
    store.insertBlocks([mk('x', 'a', d(9), d(10)), mk('y', 'a', on(8, 9), on(8, 10))]);
    const r = runTool(store, 'get_schedule', { from: '09:30' }, ctx) as any;
    expect(r.from).toBe(d(9, 30).toISOString());
    expect(r.to).toBe(on(8, 0).toISOString());
    expect(r.blocks.map((b: Block) => b.id)).toEqual(['x']);
    expect(() => runTool(store, 'get_schedule', { from: 'garbage' }, ctx)).toThrow(/Cannot understand time "garbage"/);
  });
  it('a fresh store has no availability and nothing planned', () => {
    const r = runTool(new MemoryStore(), 'get_schedule', {}, ctx) as any;
    expect(r).toMatchObject({ blocks: [], commitments: [], recurring: [], availability: [], summary: 'Nothing planned today.' });
  });
  it('names skipped and missed statuses and keeps a block that crosses midnight in both days', () => {
    store.insertBlocks([mk('s', 'a', d(9), d(10), { status: 'skipped' }), mk('n', 'a', d(23), on(8, 1))]);
    const wed = runTool(store, 'get_schedule', {}, at(12)) as any;
    expect(wed.summary).toBe('Today: A 09:00-10:00 (skipped), A 23:00-01:00.');
    const thu = runTool(store, 'get_schedule', { from: '2026-10-08', to: '2026-10-09' }, at(12)) as any;
    expect(thu.blocks.map((b: Block) => b.id)).toEqual(['n']);
  });
});

describe('mark_block and mark_task: which block, which status', () => {
  beforeEach(() => {
    store.upsertTask(task('a', 'A'));
    store.insertBlocks([mk('a1', 'a', d(9), d(10)), mk('a2', 'a', d(14), d(15))]);
  });
  it('mark_block refuses an unknown id and an unknown status', () => {
    expect(() => runTool(store, 'mark_block', { block_id: 'x', status: 'done' }, ctx)).toThrow('Block not found: x');
    expect(() => runTool(store, 'mark_block', { block_id: 'a1', status: 'missed' }, ctx)).toThrow();
    expect(() => runTool(store, 'mark_block', { block_id: 'a1' }, ctx)).toThrow();
  });
  it('mark_task picks the block containing now, else the latest earlier one, else the first of the day', () => {
    const pick = (h: number, m = 0) => (runTool(store, 'mark_task', { task: 'A', status: 'skipped' }, at(h, m)) as any).id;
    expect(pick(8)).toBe('a1');
    expect(pick(9, 30)).toBe('a1');
    expect(pick(11)).toBe('a1');
    expect(pick(14, 30)).toBe('a2');
    expect(pick(16)).toBe('a2');
    expect(pick(23, 59)).toBe('a2');
  });
  it('mark_task on another day finds nothing and says what to do', () => {
    expect(() => runTool(store, 'mark_task', { task: 'A', status: 'done' }, { now: () => on(8, 9, 30) })).toThrow('No block for "A" today. Use get_schedule to find one on another day, or plan_schedule first.');
    expect(() => runTool(store, 'mark_task', { task: 'A', status: 'done' }, { now: () => on(6, 9, 30) })).toThrow('No block for "A" today.');
  });
  it('a done block can be found again and set back to pending, stamping statusChangedAt', () => {
    runTool(store, 'mark_task', { task: 'A', status: 'done' }, at(9, 30));
    expect(store.getBlock('a1')!.status).toBe('done');
    const undone = runTool(store, 'mark_task', { task: 'A', status: 'pending' }, at(9, 45)) as any;
    expect(undone).toMatchObject({ id: 'a1', status: 'pending', statusChangedAt: d(9, 45).toISOString(), taskName: 'A' });
  });
  it('marking a block whose clock runs pauses it and keeps the minutes', () => {
    runTool(store, 'track_time', { block_id: 'a1', action: 'start' }, at(9));
    const r = runTool(store, 'mark_task', { task: 'A', status: 'done' }, at(9, 20)) as any;
    expect(r.status).toBe('done');
    expect(r.runningSince).toBeNull();
    expect(r.trackedMinutes).toBe(20);
    expect(r.end).toBe(d(10).toISOString());
  });
  it('an archived task cannot be marked by name', () => {
    store.archiveTask('a');
    expect(() => runTool(store, 'mark_task', { task: 'A', status: 'done' }, at(9, 30))).toThrow('No task matches "A"');
  });
});

describe('move_block: guards and messages', () => {
  beforeEach(() => {
    store.upsertTask(task('a', 'A', { priority: 1 }));
    store.upsertTask(task('b', 'B', { priority: 2 }));
    store.insertBlocks([mk('x', 'a', d(9), d(10))]);
  });
  it('needs a block_id or a task; an unknown block_id with no task gets the same message', () => {
    expect(() => runTool(store, 'move_block', { start: '10:00' }, ctx)).toThrow('Give block_id or task.');
    // Unlike note_block and track_time ("Block not found: nope"), move_block does not name the unknown id.
    expect(() => runTool(store, 'move_block', { block_id: 'nope', start: '10:00' }, ctx)).toThrow('Give block_id or task.');
    expect(() => runTool(store, 'move_block', { task: 'B', start: '10:00' }, ctx)).toThrow('No block for "B" today. Use get_schedule to find one, or add_block to create one.');
  });
  it('an end at or before the start is refused after the placement checks', () => {
    expect(() => runTool(store, 'move_block', { block_id: 'x', start: '10:00', end: '09:00' }, ctx)).toThrow('end must be after start');
    expect(() => runTool(store, 'move_block', { block_id: 'x', start: '10:00', end: '10:00' }, ctx)).toThrow('end must be after start');
    expect(store.getBlock('x')!.start).toBe(d(9).toISOString());
  });
  it('outside the windows: the message names the day, its windows, and the override', () => {
    expect(() => runTool(store, 'move_block', { block_id: 'x', start: '19:00' }, ctx)).toThrow("That time is outside your availability: 19:00-20:00 is not inside Wed's windows (09:00-18:00). Pass allow_outside_availability: true to place it anyway, or change availability first.");
    expect(() => runTool(store, 'move_block', { block_id: 'x', start: '2026-10-10 10:00' }, ctx)).toThrow("10:00-11:00 is not inside Sat's windows (none).");
    const moved = runTool(store, 'move_block', { block_id: 'x', start: '19:00', allow_outside_availability: true }, ctx) as any;
    expect([hm(moved.start), hm(moved.end), moved.source]).toEqual(['19:00', '20:00', 'manual']);
    expect(() => runTool(store, 'move_block', { block_id: 'x', start: '19:00', allow_outside_availability: 'true' }, ctx)).toThrow(/expected boolean/);
  });
  it('overlaps: commitments first, then recurring, then live blocks, joined with "and"', () => {
    runTool(store, 'add_commitment', { title: 'Call', start: '10:00', end: '10:30' }, ctx);
    store.insertBlocks([mk('y', 'b', d(10, 30), d(11, 30))]);
    expect(() => runTool(store, 'move_block', { block_id: 'x', start: '10:15' }, ctx)).toThrow('That time overlaps "Call" 10:00-10:30 and "B" 10:30-11:30. Pick another time, or pass allow_overlap: true.');
    runTool(store, 'add_recurring_commitment', { title: 'Standup', days: 'weekdays', start: '11:30', end: '11:45' }, ctx);
    expect(() => runTool(store, 'move_block', { block_id: 'x', start: '11:30' }, ctx)).toThrow('That time overlaps "Standup" 11:30-11:45. Pick another time, or pass allow_overlap: true.');
    const forced = runTool(store, 'move_block', { block_id: 'x', start: '10:15', allow_overlap: true }, ctx) as any;
    expect(hm(forced.start)).toBe('10:15');
  });
  it('a block may overlap its own old time, a skipped block and a missed block, but not a done one', () => {
    expect(hm((runTool(store, 'move_block', { block_id: 'x', start: '09:30' }, ctx) as any).start)).toBe('09:30');
    store.insertBlocks([mk('s', 'b', d(12), d(13), { status: 'skipped' }), mk('m', 'b', d(13), d(14), { status: 'missed' }), mk('dn', 'b', d(14), d(15), { status: 'done' })]);
    expect(hm((runTool(store, 'move_block', { block_id: 'x', start: '12:00' }, ctx) as any).start)).toBe('12:00');
    expect(hm((runTool(store, 'move_block', { block_id: 'x', start: '13:00' }, ctx) as any).start)).toBe('13:00');
    expect(() => runTool(store, 'move_block', { block_id: 'x', start: '14:00' }, ctx)).toThrow('That time overlaps "B" 14:00-15:00.');
  });
  it('an explicit end changes the length; a block of another day moves to the day asked', () => {
    const r = runTool(store, 'move_block', { block_id: 'x', start: '13:00', end: '13:30' }, ctx) as any;
    expect([hm(r.start), hm(r.end)]).toEqual(['13:00', '13:30']);
    store.insertBlocks([mk('t', 'a', on(8, 9), on(8, 10))]);
    const moved = runTool(store, 'move_block', { block_id: 't', start: '15:00' }, ctx) as any;
    expect(moved.start).toBe(d(15).toISOString());
    expect(moved.end).toBe(d(16).toISOString());
  });
});

describe('add_block: snapping and guards', () => {
  beforeEach(() => { store.upsertTask(task('a', 'A')); store.upsertTask(task('b', 'B', { priority: 2 })); });
  it('snaps the start down and the end up to the slot grid, after checking the raw times', () => {
    const r = runTool(store, 'add_block', { task: 'A', start: '09:07', end: '09:50' }, ctx) as any;
    expect([hm(r.start), hm(r.end), r.source, r.status, r.createdAt]).toEqual(['09:00', '10:00', 'manual', 'pending', d(9).toISOString()]);
    const tail = runTool(store, 'add_block', { task: 'A', start: '17:50', end: '18:00' }, ctx) as any;
    expect([hm(tail.start), hm(tail.end)]).toEqual(['17:45', '18:00']);
    expect(() => runTool(store, 'add_block', { task: 'A', start: '17:50', end: '18:05' }, ctx)).toThrow("17:50-18:05 is not inside Wed's windows (09:00-18:00)");
    const tiny = runTool(store, 'add_block', { task: 'A', start: '12:00', end: '12:01' }, ctx) as any;
    expect([hm(tiny.start), hm(tiny.end)]).toEqual(['12:00', '12:15']);
  });
  it('refuses an empty or inverted range', () => {
    expect(() => runTool(store, 'add_block', { task: 'A', start: '09:00', end: '09:00' }, ctx)).toThrow('end must be after start');
    expect(() => runTool(store, 'add_block', { task: 'A', start: '10:00', end: '09:00' }, ctx)).toThrow('end must be after start');
    expect(store.listBlocks()).toEqual([]);
  });
  it('clashes with a done block but not with a skipped one', () => {
    store.insertBlocks([mk('dn', 'b', d(10), d(11), { status: 'done' }), mk('sk', 'b', d(11), d(12), { status: 'skipped' })]);
    expect(() => runTool(store, 'add_block', { task: 'A', start: '10:00', end: '11:00' }, ctx)).toThrow('That time overlaps "B" 10:00-11:00. Pick another time, or pass allow_overlap: true.');
    expect(hm((runTool(store, 'add_block', { task: 'A', start: '11:00', end: '12:00' }, ctx) as any).start)).toBe('11:00');
  });
  it('an archived task cannot take a block by name', () => {
    store.archiveTask('a');
    expect(() => runTool(store, 'add_block', { task: 'A', start: '10:00', end: '11:00' }, ctx)).toThrow('No task matches "A". Known tasks: "B".');
  });
  it('a block across midnight is outside the day\'s windows unless allowed', () => {
    expect(() => runTool(store, 'add_block', { task: 'A', start: '23:00', end: 'tomorrow 01:00' }, ctx)).toThrow("23:00-01:00 is not inside Wed's windows (09:00-18:00)");
    const r = runTool(store, 'add_block', { task: 'A', start: '23:00', end: 'tomorrow 01:00', allow_outside_availability: true }, ctx) as any;
    expect(r.start).toBe(d(23).toISOString());
    expect(r.end).toBe(on(8, 1).toISOString());
  });
  it('with no availability at all every placement is outside "(none)"', () => {
    store.saveSettings({ ...store.getSettings(), availability: [] });
    expect(() => runTool(store, 'add_block', { task: 'A', start: '10:00', end: '11:00' }, ctx)).toThrow("10:00-11:00 is not inside Wed's windows (none).");
  });
});

describe('delete_block', () => {
  it('refuses an unknown id, deletes a done block, and refuses the same id twice', () => {
    store.upsertTask(task('a', 'A'));
    store.insertBlocks([mk('x', 'a', d(9), d(10), { status: 'done' })]);
    expect(() => runTool(store, 'delete_block', { block_id: 'nope' }, ctx)).toThrow('Block not found: nope');
    expect(runTool(store, 'delete_block', { block_id: 'x' }, ctx)).toEqual({ ok: true });
    expect(() => runTool(store, 'delete_block', { block_id: 'x' }, ctx)).toThrow('Block not found: x');
    expect(() => runTool(store, 'delete_block', {}, ctx)).toThrow();
  });
});

describe('note_block: text handling and targeting', () => {
  beforeEach(() => {
    store.upsertTask(task('a', 'A', { priority: 1 }));
    store.upsertTask(task('b', 'B', { priority: 2 }));
    store.insertBlocks([mk('a1', 'a', d(9), d(10)), mk('b1', 'b', d(10), d(11))]);
  });
  it('collapses whitespace, keeps quotes and angle brackets verbatim, and a blank note clears', () => {
    const r = runTool(store, 'note_block', { task: 'A', note: 'say "hi"\n\n <b>\t ok ' }, at(9, 30)) as any;
    expect(r.block.note).toBe('say "hi" <b> ok');
    expect(r.summary).toBe('Noted on "A" Wed 09:00: "say "hi" <b> ok".');
    const cleared = runTool(store, 'note_block', { task: 'A', note: '   \n ' }, at(9, 30)) as any;
    expect(cleared.summary).toBe('Cleared the note on "A" Wed 09:00.');
    expect('note' in store.getBlock('a1')!).toBe(false);
  });
  it('accepts exactly 2000 characters and refuses 2001', () => {
    expect((runTool(store, 'note_block', { block_id: 'a1', note: 'x'.repeat(2000) }, ctx) as any).block.note).toHaveLength(2000);
    expect(() => runTool(store, 'note_block', { block_id: 'a1', note: 'x'.repeat(2001) }, ctx)).toThrow('A note is at most 2000 characters');
  });
  it('block_id wins over task; missing both, or an unknown block, or a task without a block today are refused', () => {
    const r = runTool(store, 'note_block', { task: 'A', block_id: 'b1', note: 'on b' }, at(9, 30)) as any;
    expect(r.block.id).toBe('b1');
    expect(r.summary).toBe('Noted on "B" Wed 10:00: "on b".');
    expect(() => runTool(store, 'note_block', { note: 'x' }, ctx)).toThrow('Give a task or a block_id');
    expect(() => runTool(store, 'note_block', { block_id: 'nope', note: 'x' }, ctx)).toThrow('Block not found: nope');
    expect(() => runTool(store, 'note_block', { task: 'A', note: 'x' }, { now: () => on(8, 9) })).toThrow('No block for "A" today. Use get_schedule to find one on another day.');
    expect(() => runTool(store, 'note_block', { task: 'A' }, ctx)).toThrow();
  });
  it('a note never changes the block\'s time or status', () => {
    const before = { ...store.getBlock('a1')! };
    runTool(store, 'note_block', { block_id: 'a1', note: 'hello' }, ctx);
    const after = store.getBlock('a1')!;
    expect([after.start, after.end, after.status, after.source]).toEqual([before.start, before.end, before.status, before.source]);
  });
});

describe('track_time: actions on blocks in every status', () => {
  beforeEach(() => {
    store.upsertTask(task('a', 'A'));
    store.insertBlocks([mk('p', 'a', d(9), d(10))]);
  });
  it('start refuses a done or skipped block; pause and set never refuse', () => {
    store.insertBlocks([mk('dn', 'a', d(11), d(12), { status: 'done' }), mk('sk', 'a', d(13), d(14), { status: 'skipped' })]);
    expect(() => runTool(store, 'track_time', { block_id: 'dn', action: 'start' }, at(11))).toThrow('Only a pending block can be started');
    expect(() => runTool(store, 'track_time', { block_id: 'sk', action: 'start' }, at(13))).toThrow('Only a pending block can be started');
    const paused = runTool(store, 'track_time', { block_id: 'dn', action: 'pause' }, at(11)) as any;
    expect(paused.summary).toBe('Paused "A" at 0 min.');
    expect(paused.elapsedMinutes).toBe(0);
    const set = runTool(store, 'track_time', { block_id: 'dn', action: 'set', minutes: 30 }, at(11)) as any;
    expect(set.summary).toBe('Logged 30 min on "A".');
    expect(store.getBlock('dn')).toMatchObject({ status: 'done', trackedMinutes: 30 });
  });
  it('finish on a done block that never ran a clock keeps it done and counts its whole length (now is past its end)', () => {
    store.insertBlocks([mk('dn', 'a', d(11), d(12), { status: 'done' })]);
    const r = runTool(store, 'track_time', { block_id: 'dn', action: 'finish' }, at(12, 30)) as any;
    expect(r.summary).toBe('Finished "A" after 60 min, counted from its start (the clock never ran).');
    expect(store.getBlock('dn')).toMatchObject({ status: 'done', finishedAt: d(12, 30).toISOString(), trackedMinutes: 60 });
  });
  it('set: 0 and 1440 are accepted, out-of-range, fractional, string and missing minutes are not', () => {
    expect((runTool(store, 'track_time', { block_id: 'p', action: 'set', minutes: 0 }, ctx) as any).summary).toBe('Logged 0 min on "A".');
    expect((runTool(store, 'track_time', { block_id: 'p', action: 'set', minutes: 1440 }, ctx) as any).block.trackedMinutes).toBe(1440);
    for (const bad of [1441, -1, 10.5, '45']) expect(() => runTool(store, 'track_time', { block_id: 'p', action: 'set', minutes: bad }, ctx), String(bad)).toThrow();
    expect(() => runTool(store, 'track_time', { block_id: 'p', action: 'set' }, ctx)).toThrow('minutes must be between 0 and 1440');
    expect(() => runTool(store, 'track_time', { block_id: 'p', action: 'stop' }, ctx)).toThrow();
  });
  it('a second start keeps the first start time and is not an error', () => {
    runTool(store, 'track_time', { block_id: 'p', action: 'start' }, at(9));
    const again = runTool(store, 'track_time', { block_id: 'p', action: 'start' }, at(9, 10)) as any;
    expect(again.block.runningSince).toBe(d(9).toISOString());
    expect(again.block.startedAt).toBe(d(9).toISOString());
    expect(again.summary).toBe('Started "A" 09:00-10:00.');
    expect(again.elapsedMinutes).toBe(10);
  });
  it('an early finish ends the block no earlier than one slot after its start and keeps the planned length', () => {
    runTool(store, 'track_time', { block_id: 'p', action: 'start' }, at(9));
    const r = runTool(store, 'track_time', { block_id: 'p', action: 'finish' }, at(9, 3)) as any;
    expect(r.summary).toBe('Finished "A" after 3 min (planned 60).');
    expect(store.getBlock('p')).toMatchObject({ status: 'done', end: d(9, 15).toISOString(), plannedMinutes: 60, trackedMinutes: 3, runningSince: null });
  });
  it('a finish after the planned end keeps the end and does not quote a planned length', () => {
    runTool(store, 'track_time', { block_id: 'p', action: 'start' }, at(9));
    const r = runTool(store, 'track_time', { block_id: 'p', action: 'finish' }, at(10, 30)) as any;
    expect(r.summary).toBe('Finished "A" after 90 min.');
    expect(store.getBlock('p')!.end).toBe(d(10).toISOString());
    expect(store.getBlock('p')!.plannedMinutes).toBeUndefined();
  });
  it('set then start adds the running stretch on top of the logged minutes', () => {
    runTool(store, 'track_time', { block_id: 'p', action: 'set', minutes: 20 }, at(9));
    runTool(store, 'track_time', { block_id: 'p', action: 'start' }, at(9, 20));
    const r = runTool(store, 'track_time', { block_id: 'p', action: 'pause' }, at(9, 35)) as any;
    expect(r.summary).toBe('Paused "A" at 35 min.');
  });
});

describe('add_commitment and remove_commitment', () => {
  it('needs end after start, at most 24 hours, a non-blank title of at most 80 characters, string times', () => {
    expect(() => runTool(store, 'add_commitment', { title: 'X', start: '10:00', end: '10:00' }, ctx)).toThrow('end must be after start');
    const day = runTool(store, 'add_commitment', { title: 'Offsite', start: '2026-10-07 10:00', end: '2026-10-08 10:00' }, ctx) as any;
    expect([day.start, day.end]).toEqual([d(10).toISOString(), on(8, 10).toISOString()]);
    expect(() => runTool(store, 'add_commitment', { title: 'Long', start: '2026-10-07 10:00', end: '2026-10-08 10:01' }, ctx)).toThrow('A commitment can be at most 24 hours long. Use add_recurring_commitment for weekly fixed time, or set_availability for days off.');
    expect(() => runTool(store, 'add_commitment', { title: '   ', start: '10:00', end: '11:00' }, ctx)).toThrow();
    expect(() => runTool(store, 'add_commitment', { title: 'N', start: 1000, end: '11:00' }, ctx)).toThrow(/expected string/);
    const quoted = runTool(store, 'add_commitment', { title: '  Say "hi" <now>  ', start: '08:00', end: '08:30' }, ctx) as any;
    expect(quoted.title).toBe('Say "hi" <now>');
    expect(quoted.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('a commitment in the past is accepted; removing an unknown id is refused by name, like a block', () => {
    const past = runTool(store, 'add_commitment', { title: 'Yesterday', start: '2026-10-06 10:00', end: '2026-10-06 11:00' }, ctx) as any;
    expect(store.listCommitments().map((c) => c.id)).toEqual([past.id]);
    expect(() => runTool(store, 'remove_commitment', { commitment_id: 'nope' }, ctx)).toThrow('Commitment not found: nope');
    expect(runTool(store, 'remove_commitment', { commitment_id: past.id }, ctx)).toEqual({ ok: true });
    expect(store.listCommitments()).toEqual([]);
  });
});

describe('recurring commitments: days, times, resolution', () => {
  it('days groups and bounds; HH:MM is strict 24h with the value quoted back', () => {
    expect((runTool(store, 'add_recurring_commitment', { title: 'Gym', days: 'weekend', start: ' 9:00 ', end: '10:00' }, ctx) as any)).toMatchObject({ days: [0, 6], start: '09:00', end: '10:00' });
    expect((runTool(store, 'add_recurring_commitment', { title: 'Walk', days: 'daily', start: '23:30', end: '23:59' }, ctx) as any).days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(() => runTool(store, 'add_recurring_commitment', { title: 'X', days: [7], start: '09:00', end: '10:00' }, ctx)).toThrow('Day 7 is out of range');
    expect(() => runTool(store, 'add_recurring_commitment', { title: 'X', days: 7, start: '09:00', end: '10:00' }, ctx)).toThrow('Day 7 is out of range');
    expect(() => runTool(store, 'add_recurring_commitment', { title: 'X', days: [], start: '09:00', end: '10:00' }, ctx)).toThrow('At least one day is required.');
    expect(() => runTool(store, 'add_recurring_commitment', { title: 'X', days: '', start: '09:00', end: '10:00' }, ctx)).toThrow('At least one day is required.');
    expect(() => runTool(store, 'add_recurring_commitment', { title: 'X', days: 'mon', start: '9:5', end: '10:00' }, ctx)).toThrow('start must be HH:MM (24h), e.g. "09:00" or "20:30"; got "9:5".');
    expect(() => runTool(store, 'add_recurring_commitment', { title: 'X', days: 'mon', start: '09:00', end: '24:00' }, ctx)).toThrow('end must be HH:MM (24h), e.g. "09:00" or "20:30"; got "24:00".');
    expect(() => runTool(store, 'add_recurring_commitment', { title: 'X', days: 'mon', start: '23:60', end: '23:61' }, ctx)).toThrow('start must be HH:MM');
    expect(() => runTool(store, 'add_recurring_commitment', { title: 'X', days: 'mon', start: '09:00', end: '09:00' }, ctx)).toThrow('end (09:00) must be after start (09:00).');
    expect(() => runTool(store, 'add_recurring_commitment', { title: 'X', days: 'mon', start: '10:00', end: '09:00' }, ctx)).toThrow('end (09:00) must be after start (10:00).');
  });
  it('removal resolves by exact title, unique partial, or id, and lists the options', () => {
    const a = runTool(store, 'add_recurring_commitment', { title: 'Standup A', days: 'mon', start: '09:00', end: '09:15' }, ctx) as any;
    runTool(store, 'add_recurring_commitment', { title: 'Standup B', days: 'mon', start: '10:00', end: '10:15' }, ctx);
    expect(() => runTool(store, 'remove_recurring_commitment', { recurring: 'standup' }, ctx)).toThrow('"standup" matches several recurring commitments: "Standup A", "Standup B". Use the exact title or id.');
    expect(() => runTool(store, 'remove_recurring_commitment', { recurring: 'lunch' }, ctx)).toThrow('No recurring commitment matches "lunch". Known: "Standup A", "Standup B".');
    expect(runTool(store, 'remove_recurring_commitment', { recurring: 'standup a' }, ctx)).toEqual({ ok: true, removed: 'Standup A' });
    expect(runTool(store, 'remove_recurring_commitment', { recurring: ' b' }, ctx)).toEqual({ ok: true, removed: 'Standup B' });
    expect(store.listRecurring()).toEqual([]);
    expect(() => runTool(store, 'remove_recurring_commitment', { recurring: a.id }, ctx)).toThrow('No recurring commitment matches');
  });
});

describe('set_availability: counts, times, modes', () => {
  const win = (i: number) => ({ days: 'mon', start: `${String(i).padStart(2, '0')}:00`, end: `${String(i).padStart(2, '0')}:30` });
  it('fourteen windows per call and in total', () => {
    const r = runTool(store, 'set_availability', { windows: Array.from({ length: 14 }, (_, i) => win(i)) }, ctx) as any;
    expect(r.availability).toHaveLength(14);
    expect(() => runTool(store, 'set_availability', { windows: Array.from({ length: 15 }, (_, i) => win(i)) }, ctx)).toThrow('At most 14 windows per call');
    expect(() => runTool(store, 'set_availability', { windows: [win(20)], mode: 'add' }, ctx)).toThrow('At most 14 availability windows in total; replace the template instead of adding more.');
    expect(store.getSettings().availability).toHaveLength(14);
  });
  it('validates each window and the mode', () => {
    expect(() => runTool(store, 'set_availability', { windows: [{ days: 'mon', start: '09:00', end: '09:00' }] }, ctx)).toThrow('end (09:00) must be after start (09:00).');
    expect(() => runTool(store, 'set_availability', { windows: [{ days: 'mon', start: '09:00', end: '24:00' }] }, ctx)).toThrow('end must be HH:MM (24h), e.g. "09:00" or "20:30"; got "24:00".');
    expect(() => runTool(store, 'set_availability', { windows: [{ days: 'funday', start: '09:00', end: '10:00' }] }, ctx)).toThrow('Unknown day "funday"');
    expect(() => runTool(store, 'set_availability', { windows: [win(1)], mode: 'append' }, ctx)).toThrow();
    expect(() => runTool(store, 'set_availability', {}, ctx)).toThrow();
    expect(store.getSettings().availability).toEqual(STANDARD_WEEK);
  });
  it('keeps overlapping windows as given and reports the setup status', () => {
    const r = runTool(store, 'set_availability', { windows: [{ days: 'weekend', start: '08:00', end: '12:00' }, { days: 'sat', start: '10:00', end: '14:00' }] }, ctx) as any;
    expect(r.availability).toEqual([{ days: [0, 6], start: '08:00', end: '12:00' }, { days: [6], start: '10:00', end: '14:00' }]);
    expect(r.setup).toMatchObject({ ready: false, hasAvailability: true, hasTasks: false, missing: ['baseline'] });
  });
  it('a busy-only baseline does not block it; a task baseline does, without change', () => {
    store.setBaseline({ slots: [{ day: 1, start: '12:00', end: '13:00', kind: 'busy', title: 'Lunch' }] });
    expect((runTool(store, 'set_availability', { windows: [win(8)] }, ctx) as any).availability).toEqual([{ days: [1], start: '08:00', end: '08:30' }]);
    store.setBaseline({ slots: [{ day: 1, start: '09:00', end: '10:00', kind: 'task', taskId: 't' }] });
    expect(runTool(store, 'set_availability', { windows: [win(9)] }, ctx)).toEqual({ ok: false, note: 'A baseline is set; edit it on the Baseline tab (or say "this is my baseline" after arranging the week). Availability windows apply only without a baseline.' });
    expect(store.getSettings().availability).toEqual([{ days: [1], start: '08:00', end: '08:30' }]);
  });
});

describe('set_work_style and update_settings', () => {
  it('set_work_style applies the preset, clamps the minimum block, and says so', () => {
    store.saveSettings({ ...store.getSettings(), minBlockMinutes: 90 });
    const deep = runTool(store, 'set_work_style', { style: 'I like long focused sessions' }, ctx) as any;
    expect(deep.summary).toBe('Work style set to deep: sittings of 120 min, up to 4 tasks a day.');
    expect(deep.settings).toMatchObject({ workStyle: 'deep', maxBlockMinutes: 120, maxTasksPerDay: 4, minBlockMinutes: 90 });
    const varied = runTool(store, 'set_work_style', { style: 'shorter blocks' }, ctx) as any;
    expect(varied.summary).toBe('Work style set to varied: sittings of 60 min, up to 8 tasks a day.');
    expect(varied.settings).toMatchObject({ workStyle: 'varied', maxBlockMinutes: 60, maxTasksPerDay: 8, minBlockMinutes: 60 });
    expect((runTool(store, 'set_work_style', { style: 'mix' }, ctx) as any).summary).toBe('Work style set to balanced: sittings of 90 min, up to 6 tasks a day.');
    expect(() => runTool(store, 'set_work_style', { style: '' }, ctx)).toThrow('Unknown work style "". Use deep, varied, or balanced.');
    expect(() => runTool(store, 'set_work_style', {}, ctx)).toThrow();
  });
  it('update_settings with nothing changes nothing', () => {
    const before = store.getSettings();
    expect((runTool(store, 'update_settings', {}, ctx) as any).settings).toEqual(before);
    expect(store.getSettings()).toEqual(before);
  });
  it('update_settings bounds and coerces each number', () => {
    expect((runTool(store, 'update_settings', { slot_minutes: '30', max_tasks_per_day: '3' }, ctx) as any).settings).toMatchObject({ slotMinutes: 30, maxTasksPerDay: 3 });
    for (const bad of [{ slot_minutes: 4 }, { slot_minutes: 61 }, { max_tasks_per_day: 0 }, { max_tasks_per_day: 51 }, { min_block_minutes: 4 }, { priority_weight: -0.1 }, { deficit_weight: 1.01 }, { review_window: 'month' }]) {
      expect(() => runTool(store, 'update_settings', bad, ctx), JSON.stringify(bad)).toThrow();
    }
  });
  it('update_settings cross-checks min/max, the segments, and the weights with exact messages', () => {
    expect(() => runTool(store, 'update_settings', { min_block_minutes: 200 }, ctx)).toThrow('min_block_minutes (200) must not exceed max_block_minutes (60).');
    expect(() => runTool(store, 'update_settings', { morning_end: '17:00' }, ctx)).toThrow('morning_end (17:00) must be before afternoon_end (17:00).');
    expect(() => runTool(store, 'update_settings', { morning_end: '25:00' }, ctx)).toThrow('morning_end must be HH:MM (24h), e.g. "09:00" or "20:30"; got "25:00".');
    expect(() => runTool(store, 'update_settings', { afternoon_end: '9:5' }, ctx)).toThrow('afternoon_end must be HH:MM (24h), e.g. "09:00" or "20:30"; got "9:5".');
    expect(() => runTool(store, 'update_settings', { priority_weight: 0, deficit_weight: 0 }, ctx)).toThrow('At least one of priority_weight and deficit_weight must be above zero.');
    expect((runTool(store, 'update_settings', { priority_weight: 0 }, ctx) as any).settings.weights).toEqual({ priority: 0, deficit: 0.4 });
    expect((runTool(store, 'update_settings', { morning_end: '9:30' }, ctx) as any).settings.segments).toEqual({ morningEnd: '09:30', afternoonEnd: '17:00' });
  });
  it('update_settings week_starts_on takes a day word or a one-element list; a group means its first day', () => {
    expect((runTool(store, 'update_settings', { week_starts_on: 'mon' }, ctx) as any).settings.weekStartsOn).toBe(1);
    expect((runTool(store, 'update_settings', { week_starts_on: 'weekend' }, ctx) as any).settings.weekStartsOn).toBe(0);
    expect((runTool(store, 'update_settings', { week_starts_on: [6] }, ctx) as any).settings.weekStartsOn).toBe(6);
    expect((runTool(store, 'update_settings', { week_starts_on: '6' }, ctx) as any).settings.weekStartsOn).toBe(6);
    expect(() => runTool(store, 'update_settings', { week_starts_on: [7] }, ctx)).toThrow('Day 7 is out of range');
  });
  // Regression (fixed 2026-10-12): update_settings describes week_starts_on as 'Weekday the week starts on, e.g. "mon" or 1' (tools.ts:706) and
  // daysField as 'numbers 0 (Sun) to 6 (Sat)' (tools.ts:125), but the schema is z.union([z.string(), z.array(...)]), so a
  // bare number is refused with "expected string / expected array" before parseDays (which accepts numbers) runs. The
  // same holds for days: 1 on add_recurring_commitment, set_availability and save_baseline. Expected: 1 -> weekStartsOn 1.
  it('update_settings week_starts_on takes a bare number, as its description says', () => {
    expect((runTool(store, 'update_settings', { week_starts_on: 1 }, ctx) as any).settings.weekStartsOn).toBe(1);
  });
  it('update_settings leaves the memory note and the availability alone', () => {
    runTool(store, 'update_memory', { text: 'keep me' }, ctx);
    const r = runTool(store, 'update_settings', { max_block_minutes: 120 }, ctx) as any;
    expect(r.settings.memory).toBe('keep me');
    expect(r.settings.availability).toEqual(STANDARD_WEEK);
  });
});

describe('get_now, get_setup_status, get_summary on an empty store', () => {
  it('get_now reports the settings\' windows (none on a fresh store), no baseline, the segments and slot', () => {
    const r = runTool(new MemoryStore(), 'get_now', {}, ctx) as any;
    expect(r).toEqual({ now: d(9).toISOString(), local: d(9).toString(), availability: [], baseline: null, segments: { morningEnd: '12:00', afternoonEnd: '17:00' }, slotMinutes: 15 });
  });
  it('get_setup_status on a fresh store wants a baseline', () => {
    expect(runTool(new MemoryStore(), 'get_setup_status', {}, ctx)).toMatchObject({ ready: false, hasAvailability: false, hasTasks: false, recurringCount: 0, commitmentCount: 0, missing: ['baseline'] });
  });
  it('get_summary with nothing scheduled, for the configured window and an explicit one', () => {
    expect((runTool(store, 'get_summary', {}, ctx) as any).summary).toBe('This week: nothing scheduled yet.');
    expect((runTool(store, 'get_summary', { window: 'day' }, ctx) as any).summary).toBe('Today: nothing scheduled yet.');
    store.saveSettings({ ...store.getSettings(), reviewWindow: 'day' });
    expect((runTool(store, 'get_summary', {}, ctx) as any).summary).toBe('Today: nothing scheduled yet.');
    expect(() => runTool(store, 'get_summary', { window: 'month' }, ctx)).toThrow();
  });
});

describe('clear_schedule', () => {
  beforeEach(() => store.upsertTask(task('a', 'A')));
  it('an empty store removes nothing and reports the default range (now to a year ahead)', () => {
    const r = runTool(store, 'clear_schedule', {}, ctx) as any;
    expect(r).toEqual({ removed: 0, from: d(9).toISOString(), to: new Date(2027, 9, 7, 9).toISOString() });
    expect((runTool(store, 'clear_schedule', { from: '12:00', to: '11:00' }, ctx) as any).removed).toBe(0);
  });
  it('from now: a block that ended is kept, one in progress goes; skipped and missed never go; done only with include_done', () => {
    store.insertBlocks([mk('over', 'a', d(7), d(8)), mk('now', 'a', d(8, 30), d(9, 30)), mk('later', 'a', d(10), d(11)), mk('dn', 'a', d(12), d(13), { status: 'done' }), mk('sk', 'a', d(13), d(14), { status: 'skipped' }), mk('ms', 'a', d(14), d(15), { status: 'missed' })]);
    const r = runTool(store, 'clear_schedule', {}, ctx) as any;
    expect(r.removed).toBe(2);
    expect(store.listBlocks().map((b) => b.id)).toEqual(['over', 'dn', 'sk', 'ms']);
    const all = runTool(store, 'clear_schedule', { from: '00:00', include_done: true }, ctx) as any;
    expect(all.removed).toBe(2);
    expect(store.listBlocks().map((b) => b.id)).toEqual(['sk', 'ms']);
  });
});

describe('save_baseline: confirmation flow and edge weeks', () => {
  beforeEach(() => { store.upsertTask(task('a', 'A', { priority: 1 })); store.upsertTask(task('b', 'B', { priority: 2 })); });
  it('an empty week is refused', () => {
    expect(() => runTool(store, 'save_baseline', {}, ctx)).toThrow('No blocks in that week to save. Arrange the week first (plan, drag, or right-click), then save it as the baseline.');
    store.insertBlocks([mk('sk', 'a', d(9), d(10), { status: 'skipped' }), mk('ms', 'a', d(10), d(11), { status: 'missed' })]);
    expect(() => runTool(store, 'save_baseline', { confirm: true }, ctx)).toThrow('No blocks in that week to save.');
    expect(store.getBaseline()).toBeUndefined();
  });
  it('a day covered under half asks first and changes nothing', () => {
    store.insertBlocks([mk('x', 'a', d(9), d(10))]);
    const r = runTool(store, 'save_baseline', {}, ctx) as any;
    expect(r).toEqual({ needsConfirmation: true, partialDays: ['Wed'], summary: 'Wed is only partly planned. Ask whether to keep those days (then call again with confirm: true) or leave them out (call again with days set to the days to keep).' });
    expect(store.getBaseline()).toBeUndefined();
    expect(store.getBlock('x')!.source).toBeUndefined();
    store.insertBlocks([mk('y', 'b', on(8, 9), on(8, 10))]);
    expect((runTool(store, 'save_baseline', {}, ctx) as any).summary).toMatch(/^Wed, Thu are only partly planned\./);
  });
  it('exactly half of the day is not partial; a days filter or confirm skips the question', () => {
    store.insertBlocks([mk('half', 'a', d(9), d(13, 30))]);
    const r = runTool(store, 'save_baseline', {}, ctx) as any;
    expect(r.needsConfirmation).toBeUndefined();
    expect(r.summary).toBe('Saved 1 task slot and 0 busy slots on Wed as baseline v1.');
    expect(r.blocks).toEqual([{ taskId: 'a', taskName: 'A', day: 3, start: '09:00', end: '13:30' }]);
    store.insertBlocks([mk('short', 'b', on(8, 9), on(8, 10))]);
    expect((runTool(store, 'save_baseline', { days: 'thu' }, ctx) as any).summary).toBe('Saved 1 task slot and 0 busy slots on Thu as baseline v2.');
    expect((runTool(store, 'save_baseline', { confirm: true }, ctx) as any).summary).toBe('Saved 2 task slots and 0 busy slots on Wed, Thu as baseline v3.');
    expect(() => runTool(store, 'save_baseline', { days: 'fri' }, ctx)).toThrow('No blocks in that week to save.');
  });
  it('with no availability there is nothing to be partial against: it saves', () => {
    store.saveSettings({ ...store.getSettings(), availability: [] });
    store.insertBlocks([mk('x', 'a', d(9), d(10))]);
    expect((runTool(store, 'save_baseline', {}, ctx) as any).summary).toBe('Saved 1 task slot and 0 busy slots on Wed as baseline v1.');
  });
  it('commitments become busy slots, a block over midnight ends at 24:00, saved blocks are locked as baseline', () => {
    store.insertBlocks([mk('x', 'a', d(9), d(17)), mk('n', 'b', on(8, 22), on(9, 1))]);
    runTool(store, 'add_commitment', { title: 'Lunch', start: '12:00', end: '13:00' }, ctx);
    runTool(store, 'add_recurring_commitment', { title: 'Standup', days: 'weekdays', start: '10:00', end: '10:15' }, ctx);
    const r = runTool(store, 'save_baseline', { confirm: true }, ctx) as any;
    expect(r.summary).toBe('Saved 2 task slots and 1 busy slot on Wed, Thu as baseline v1.');
    expect(r.busy).toEqual([{ day: 3, start: '12:00', end: '13:00', title: 'Lunch' }]);
    expect(r.blocks[1]).toEqual({ taskId: 'b', taskName: 'B', day: 4, start: '22:00', end: '24:00' });
    expect(store.getBaseline()!.slots).toEqual([
      { day: 3, start: '09:00', end: '17:00', kind: 'task', taskId: 'a' },
      { day: 3, start: '12:00', end: '13:00', kind: 'busy', title: 'Lunch' },
      { day: 4, start: '22:00', end: '24:00', kind: 'task', taskId: 'b' },
    ]);
    expect(store.listBlocks().map((b) => b.source)).toEqual(['baseline', 'baseline']);
    expect(r.observedStyle).toEqual({ style: 'deep', medianMinutes: 180, differsFromSetting: true });
    expect(r.version).toBe(1);
  });
  it('an explicit range limits the snapshot; a bad range is refused', () => {
    store.insertBlocks([mk('x', 'a', d(9), d(17)), mk('y', 'b', on(8, 9), on(8, 17))]);
    const r = runTool(store, 'save_baseline', { from: '2026-10-07', to: '2026-10-08' }, ctx) as any;
    expect(r.summary).toBe('Saved 1 task slot and 0 busy slots on Wed as baseline v1.');
    expect(() => runTool(store, 'save_baseline', { from: 'never' }, ctx)).toThrow(/Cannot understand time "never"/);
  });
});

describe('apply_baseline: missing baseline, re-apply, moved blocks, busy slots', () => {
  beforeEach(() => { store.upsertTask(task('a', 'A', { priority: 1 })); store.upsertTask(task('b', 'B', { priority: 2 })); });
  const thuFri = () => store.setBaseline({ slots: [{ day: 4, start: '09:00', end: '10:00', kind: 'task', taskId: 'a' }, { day: 5, start: '09:00', end: '10:00', kind: 'task', taskId: 'b' }] });
  it('refuses without a baseline, or with a busy-only one, and refuses a week it cannot understand', () => {
    const msg = 'No baseline saved yet. Arrange a week, then say "this is my baseline" (save_baseline), or import a past week (import_as_baseline).';
    expect(() => runTool(store, 'apply_baseline', {}, ctx)).toThrow(msg);
    store.setBaseline({ slots: [{ day: 3, start: '12:00', end: '13:00', kind: 'busy', title: 'Lunch' }] });
    expect(() => runTool(store, 'apply_baseline', {}, ctx)).toThrow(msg);
    thuFri();
    expect(() => runTool(store, 'apply_baseline', { week_of: 'someday' }, ctx)).toThrow(/Cannot understand time "someday"/);
  });
  it('next week by default, trimmed and case-folded; a date inside the week picks that week', () => {
    thuFri();
    const next = runTool(store, 'apply_baseline', {}, ctx) as any;
    expect(next.summary).toBe('Copied 2 baseline blocks onto the week of Sun 2026-10-11.');
    expect(next.week).toEqual({ start: on(11, 0).toISOString(), end: on(18, 0).toISOString() });
    expect(next.created.map((b: any) => [b.taskName, b.start, b.source])).toEqual([['A', on(15, 9).toISOString(), 'baseline'], ['B', on(16, 9).toISOString(), 'baseline']]);
    expect((runTool(store, 'apply_baseline', { week_of: '  NEXT WEEK ' }, ctx) as any).replaced).toBe(2);
    expect((runTool(store, 'apply_baseline', { week_of: '2026-10-21' }, ctx) as any).week.start).toBe(on(18, 0).toISOString());
  });
  it('a re-apply replaces its own pending copies and never duplicates', () => {
    thuFri();
    const first = runTool(store, 'apply_baseline', { week_of: 'this week' }, ctx) as any;
    expect(first.summary).toBe('Copied 2 baseline blocks onto the week of Sun 2026-10-04.');
    const again = runTool(store, 'apply_baseline', { week_of: 'this week' }, ctx) as any;
    expect(again.replaced).toBe(2);
    expect(again.created).toHaveLength(2);
    expect(again.summary).toBe('Copied 2 baseline blocks onto the week of Sun 2026-10-04, replacing 2.');
    expect(store.listBlocks()).toHaveLength(2);
    expect(store.listBlocks().map((b) => b.id)).not.toEqual(first.created.map((b: any) => b.id));
  });
  it('a slot already over is neither laid nor named; a moved copy keeps its sitting and the slot is skipped', () => {
    store.setBaseline({ slots: [{ day: 1, start: '09:00', end: '10:00', kind: 'task', taskId: 'a' }, { day: 4, start: '09:00', end: '10:00', kind: 'task', taskId: 'a' }] });
    const r = runTool(store, 'apply_baseline', { week_of: 'this week' }, ctx) as any;
    expect(r.created.map((b: any) => b.start)).toEqual([on(8, 9).toISOString()]);
    expect(r.skipped).toEqual([]);
    runTool(store, 'move_block', { block_id: r.created[0].id, start: '2026-10-08 10:00', allow_outside_availability: true }, ctx);
    const again = runTool(store, 'apply_baseline', { week_of: 'this week' }, ctx) as any;
    expect(again.created).toEqual([]);
    expect(again.replaced).toBe(0);
    expect(again.skipped).toEqual([{ slot: { day: 4, start: '09:00', end: '10:00', kind: 'task', taskId: 'a' }, reason: 'already has A at 10:00' }]);
    expect(again.summary).toBe('Copied 0 baseline blocks onto the week of Sun 2026-10-04; skipped A Thu 09:00 (already has A at 10:00).');
    expect(store.listBlocks()).toHaveLength(1);
  });
  it('a slot under a commitment is skipped and named; an archived task\'s slot is dropped silently', () => {
    thuFri();
    runTool(store, 'add_commitment', { title: 'Dentist', start: '2026-10-08 09:30', end: '2026-10-08 10:00' }, ctx);
    store.archiveTask('b');
    const r = runTool(store, 'apply_baseline', { week_of: 'this week' }, ctx) as any;
    expect(r.created).toEqual([]);
    expect(r.skipped.map((s: any) => s.reason)).toEqual(['under "Dentist"']);
    expect(r.summary).toBe('Copied 0 baseline blocks onto the week of Sun 2026-10-04; skipped A Thu 09:00 (under "Dentist").');
  });
  it('busy slots become prefixed commitments and are counted in the summary', () => {
    store.setBaseline({ slots: [{ day: 4, start: '09:00', end: '10:00', kind: 'task', taskId: 'a' }, { day: 4, start: '12:00', end: '13:00', kind: 'busy', title: 'Lunch' }] });
    const r = runTool(store, 'apply_baseline', {}, ctx) as any;
    expect(r.summary).toBe('Copied 1 baseline block and 1 busy slot onto the week of Sun 2026-10-11.');
    expect(r.commitments).toHaveLength(1);
    expect(r.commitments[0].id).toMatch(/^baseline:/);
    expect(r.commitments[0]).toMatchObject({ title: 'Lunch', start: on(15, 12).toISOString(), end: on(15, 13).toISOString() });
  });
  it('honours the week start setting', () => {
    thuFri();
    store.saveSettings({ ...store.getSettings(), weekStartsOn: 1 });
    expect((runTool(store, 'apply_baseline', {}, ctx) as any).summary).toBe('Copied 2 baseline blocks onto the week of Mon 2026-10-12.');
  });
});

describe('import_calendar and import_as_baseline: inputs and summaries', () => {
  const ev = (uid: string, start: string, end: string, title: string, extra: string[] = []) => ['BEGIN:VEVENT', `UID:${uid}`, `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${title}`, ...extra, 'END:VEVENT'];
  const cal = (name: string | undefined, ...events: string[][]) => ['BEGIN:VCALENDAR', ...(name ? [`X-WR-CALNAME:${name}`] : []), ...events.flat(), 'END:VCALENDAR'].join('\r\n');
  const withText = (text: string, urls: string[] = []) => ({ now: () => d(9), fetchText: async (u: string) => { urls.push(u); return text; } });

  it('garbage text imports nothing and says so exactly', async () => {
    const r = await runTool(store, 'import_calendar', { url: 'https://x/cal.ics' }, withText('hello world')) as any;
    expect(r.summary).toBe('Imported 0 upcoming events for the next 90 days; 0 skipped.');
    expect(r.commitments).toEqual([]);
    expect(r.events).toBeUndefined();
    expect(r.source).toBe('https://x/cal.ics');
  });
  it('names the calendar, counts skipped and removed, and points past events at import_as_baseline', async () => {
    const v1 = cal('Home', ev('u1', '20261009T160000Z', '20261009T170000Z', 'Dentist'), ev('u2', '20261010T160000Z', '20261010T170000Z', 'Gone'), ev('p', '20260930T160000Z', '20260930T170000Z', 'Past'), ev('bad', '20261009T170000Z', '20261009T160000Z', 'Backwards'));
    const first = await runTool(store, 'import_calendar', { url: 'https://x/cal.ics' }, withText(v1)) as any;
    expect(first.summary).toBe('Imported 2 upcoming events for the next 90 days from "Home"; 1 skipped. 1 past event kept: say "use it as my baseline" (import_as_baseline) to make the baseline week from them.');
    const v2 = cal('Home', ev('u1', '20261009T160000Z', '20261009T170000Z', 'Dentist'));
    const second = await runTool(store, 'import_calendar', { url: 'https://x/cal.ics' }, withText(v2)) as any;
    expect(second.summary).toBe('Imported 1 upcoming event for the next 90 days from "Home"; 0 skipped; 1 removed.');
    expect(store.listCommitments().map((c) => c.id)).toEqual(['ics:u1']);
  });
  it('trims and rewrites webcal in any case; refuses other schemes; propagates a failed fetch', async () => {
    const urls: string[] = [];
    await runTool(store, 'import_calendar', { url: '  WEBCAL://x/y.ics ' }, withText(cal(undefined), urls));
    await runTool(store, 'import_calendar', { url: 'http://x/z.ics' }, withText(cal(undefined), urls));
    expect(urls).toEqual(['https://x/y.ics', 'http://x/z.ics']);
    await expect(runTool(store, 'import_calendar', { url: 'file:///tmp/x.ics' }, withText(''))).rejects.toThrow('The calendar URL must start with http://, https:// or webcal://.');
    await expect(runTool(store, 'import_calendar', { url: 'https://x' }, { now: () => d(9), fetchText: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
    expect(() => runTool(store, 'import_calendar', {}, ctx)).toThrow();
  });
  it('import_as_baseline: an empty ics string counts as absent; garbage has no events; a url needs fetch', () => {
    expect(() => runTool(store, 'import_as_baseline', { ics: '' }, ctx)).toThrow('No imported calendar yet. Import an .ics file or a calendar URL first.');
    expect(() => runTool(store, 'import_as_baseline', { ics: 'hello' }, ctx)).toThrow('No events in the last 60 days to import as a baseline.');
    expect(() => runTool(store, 'import_as_baseline', { url: 'https://x' }, ctx)).toThrow('Fetching URLs is not available in this context. Ask the user to use the Import button for a file instead.');
    expect(() => runTool(store, 'import_as_baseline', { url: 'ftp://x' }, withText(''))).toThrow('The calendar URL must start with http://, https:// or webcal://.');
    expect(store.getBaseline()).toBeUndefined();
  });
  it('import_as_baseline names three one-offs and counts the rest; the source is undefined for text', () => {
    const t = (date: string, h: string) => `${date}T${h}0000`;
    const deep = ['20260914', '20260921', '20260928'].map((date) => ev(`d${date}`, t(date, '09'), t(date, '10'), 'Deep'));
    const oneOffs = [['20260915', 'D1'], ['20260916', 'D2'], ['20260917', 'D3'], ['20260918', 'D4']].map(([date, title]) => ev(title, t(date, '16'), t(date, '17'), title));
    const r = runTool(store, 'import_as_baseline', { ics: cal('Past', ...deep, ...oneOffs) }, ctx) as any;
    expect(r.summary).toBe('Baseline v1 saved from 3 weeks: 1 slot on Mon; 1 new task (Deep); 4 one-offs left out (D1 Tue 16:00-17:00, D2 Wed 16:00-17:00, D3 Thu 16:00-17:00, and 1 more). Edit titles that are busy time, not work, in the Baseline tab.');
    expect(r.source).toBeUndefined();
    expect(r.oneOffs).toHaveLength(4);
    expect(store.listTasks().map((x) => x.name)).toEqual(['Deep']);
  });
});

describe('shift_day: nothing to ask, confirmation flows, no baseline', () => {
  const seed = () => {
    store.upsertTask(task('a', 'A', { priority: 1 }));
    store.upsertTask(task('b', 'B', { priority: 2 }));
    store.upsertTask(task('c', 'C', { priority: 3 }));
  };
  const base = (id: string, taskId: string, s: Date, e: Date) => mk(id, taskId, s, e, { source: 'baseline' });
  it('refuses an unknown answer about the breaks', () => {
    expect(() => runTool(store, 'shift_day', { breaks: 'maybe' }, ctx)).toThrow();
    expect(() => runTool(store, 'shift_day', { breaks: true }, ctx)).toThrow();
  });
  it('nothing to shift: no blocks, only hand-placed blocks, a running clock, or now before the first block', () => {
    seed();
    expect((runTool(store, 'shift_day', {}, at(9, 20)) as any).summary).toBe('Nothing to shift today.');
    store.insertBlocks([mk('m', 'a', d(9), d(10), { source: 'manual' })]);
    expect((runTool(store, 'shift_day', { breaks: 'waive' }, at(9, 20)) as any).summary).toBe('Nothing to shift today.');
    store.insertBlocks([mk('run', 'b', d(10), d(11), { source: 'baseline', runningSince: d(10).toISOString() })]);
    expect((runTool(store, 'shift_day', {}, at(10, 20)) as any).summary).toBe('Nothing to shift today.');
    store.insertBlocks([mk('p', 'c', d(13), d(14), { source: 'planner' })]);
    const early = runTool(store, 'shift_day', {}, at(12)) as any;
    expect(early.summary).toBe('Nothing to shift: C starts at 13:00.');
    expect(early.needsConfirmation).toBeUndefined();
    expect(store.getBlock('p')!.start).toBe(d(13).toISOString());
  });
  it('an answer about the breaks given when nothing needs asking is still honoured', () => {
    seed();
    // Baseline Wed 09:00-12:00: A, a break, B, and C's slot (whose block is not laid) leaves slack until 12:00.
    store.setBaseline({ slots: [{ day: 3, start: '09:00', end: '10:00', kind: 'task', taskId: 'a' }, { day: 3, start: '10:30', end: '11:30', kind: 'task', taskId: 'b' }, { day: 3, start: '11:30', end: '12:00', kind: 'task', taskId: 'c' }] });
    const lay = () => { store.deleteBlocks(['x', 'y']); store.insertBlocks([base('x', 'a', d(9), d(10)), base('y', 'b', d(10, 30), d(11, 30))]); };
    lay();
    const auto = runTool(store, 'shift_day', {}, at(9, 20)) as any;
    expect(auto.needsConfirmation).toBeUndefined();
    expect(auto.summary).toBe('Shifted 2 blocks by 20 min (A 09:20-10:20, B 10:50-11:50), breaks kept; the day ends at 11:50.');
    lay();
    const keep = runTool(store, 'shift_day', { breaks: 'keep' }, at(9, 20)) as any;
    expect(keep.summary).toBe(auto.summary);
    lay();
    const waive = runTool(store, 'shift_day', { breaks: 'waive' }, at(9, 20)) as any;
    expect(waive.summary).toBe('Shifted 1 block by 20 min (A 09:20-10:20), breaks waived; the day ends at 11:30.');
    expect(waive.moved.map((b: any) => [b.taskName, hm(b.start), hm(b.end), b.source])).toEqual([['A', '09:20', '10:20', 'adjusted']]);
    expect(store.getBlock('y')).toMatchObject({ start: d(10, 30).toISOString(), source: 'baseline' });
  });
  it('with no break to waive the question offers to drop the block that no longer fits; each answer does what it says', () => {
    seed();
    store.setBaseline({ slots: [{ day: 3, start: '09:00', end: '10:00', kind: 'task', taskId: 'a' }, { day: 3, start: '10:00', end: '11:30', kind: 'task', taskId: 'b' }] });
    const lay = () => { store.deleteBlocks(['x', 'y']); store.insertBlocks([base('x', 'a', d(9), d(10)), base('y', 'b', d(10), d(11, 30))]); };
    lay();
    const ask = runTool(store, 'shift_day', {}, at(9, 20)) as any;
    expect(ask).toEqual({ needsConfirmation: true, moved: [], shortened: [], dropped: [], created: [], summary: 'Shifting 2 blocks by 20 min ends the day at 11:50, past 11:30, and there is no break to waive. Drop B to end by 11:30, or shift everything?' });
    expect(store.getBlock('x')!.start).toBe(d(9).toISOString());
    expect(store.getBlock('y')!.status).toBe('pending');
    const waive = runTool(store, 'shift_day', { breaks: 'waive' }, at(9, 20)) as any;
    expect(waive.summary).toBe('Shifted 1 block by 20 min (A 09:20-10:20); the day ends at 10:20; dropped B (no room before 11:30).');
    expect(waive.dropped.map((b: any) => b.taskName)).toEqual(['B']);
    expect(store.getBlock('y')).toMatchObject({ status: 'missed', start: d(10).toISOString() });
    lay();
    const keep = runTool(store, 'shift_day', { breaks: 'keep' }, at(9, 20)) as any;
    expect(keep.summary).toBe('Shifted 2 blocks by 20 min (A 09:20-10:20, B 10:20-11:50); the day ends at 11:50.');
    expect(keep.dropped).toEqual([]);
  });
  it('with neither baseline nor availability the day runs to midnight and a planner block simply moves', () => {
    seed();
    store.saveSettings({ ...store.getSettings(), availability: [] });
    store.insertBlocks([mk('p', 'a', d(9), d(10), { source: 'planner' })]);
    const r = runTool(store, 'shift_day', {}, at(9, 20)) as any;
    expect(r.summary).toBe('Shifted 1 block by 20 min (A 09:20-10:20); the day ends at 10:20.');
    expect(r.moved[0]).toMatchObject({ id: 'p', source: 'adjusted', taskName: 'A' });
  });
});

describe('carve_out and carry_over edges', () => {
  beforeEach(() => { store.upsertTask(task('a', 'A', { priority: 1 })); store.upsertTask(task('b', 'B', { priority: 2 })); });
  it('carve_out refuses an empty range before adding anything, and a blank title', () => {
    expect(() => runTool(store, 'carve_out', { from: '10:00', to: '10:00' }, ctx)).toThrow('end must be after start');
    expect(() => runTool(store, 'carve_out', { from: '10:00', to: '11:00', title: '   ' }, ctx)).toThrow();
    expect(() => runTool(store, 'carve_out', { from: '10:00' }, ctx)).toThrow();
    expect(store.listCommitments()).toEqual([]);
  });
  it('carve_out defaults the title to Busy, trims it, and leaves manual and done blocks where they are', () => {
    store.insertBlocks([mk('m', 'a', d(9), d(10), { source: 'manual' }), mk('dn', 'b', d(10), d(11), { status: 'done' })]);
    const r = runTool(store, 'carve_out', { from: '09:30', to: '10:30', title: '  Call  ' }, ctx) as any;
    expect(r.summary).toBe('Carved out Call 09:30-10:30; nothing to move.');
    expect(store.getBlock('m')!.start).toBe(d(9).toISOString());
    expect(store.listCommitments().map((c) => c.title)).toEqual(['Call']);
    const busy = runTool(store, 'carve_out', { from: 'tomorrow 14:00', to: 'tomorrow 15:00' }, ctx) as any;
    expect(busy.summary).toBe('Carved out Busy 14:00-15:00; nothing to move.');
    expect(busy).toMatchObject({ moved: [], shortened: [], dropped: [], created: [] });
  });
  it('carry_over with nothing owed, a done block, a skipped block; unknown and archived tasks', () => {
    expect((runTool(store, 'carry_over', { task: 'A' }, at(12)) as any).summary).toBe('A: nothing to carry over today.');
    store.insertBlocks([mk('dn', 'a', d(9), d(10), { status: 'done' }), mk('sk', 'b', d(9), d(10), { status: 'skipped' })]);
    expect((runTool(store, 'carry_over', { task: 'A' }, at(12)) as any).summary).toBe('A: nothing to carry over today.');
    expect((runTool(store, 'carry_over', { task: 'B' }, at(12)) as any).summary).toBe('B: nothing to carry over today.');
    expect(() => runTool(store, 'carry_over', { task: 'zzz' }, at(12))).toThrow('No task matches "zzz". Known tasks: "A", "B".');
    store.archiveTask('b');
    expect(() => runTool(store, 'carry_over', { task: 'B' }, at(12))).toThrow('No task matches "B"');
    expect((runTool(store, 'carry_over', { task: 'b' }, at(12)) as any).summary).toBe('B: nothing to carry over today.');
  });
});

describe('update_memory: the 2000-character cap and verbatim text', () => {
  it('accepts exactly 2000 characters and refuses 2001, before trimming', () => {
    const r = runTool(store, 'update_memory', { text: 'x'.repeat(2000) }, ctx) as any;
    expect(r.memory).toHaveLength(2000);
    expect(r.summary).toBe('Memory updated.');
    expect(() => runTool(store, 'update_memory', { text: 'x'.repeat(2001) }, ctx)).toThrow();
    expect(() => runTool(store, 'update_memory', { text: ` ${'x'.repeat(2000)}` }, ctx)).toThrow();
    expect((runTool(store, 'update_memory', { text: `  ${'y'.repeat(1998)}` }, ctx) as any).memory).toBe('y'.repeat(1998));
  });
  it('keeps inner newlines, quotes and angle brackets verbatim; trims the ends', () => {
    const text = '\n- "quoted" <tag> & \\back\n- second line\n\n';
    const r = runTool(store, 'update_memory', { text }, ctx) as any;
    expect(r.memory).toBe('- "quoted" <tag> & \\back\n- second line');
    expect(store.getSettings().memory).toBe('- "quoted" <tag> & \\back\n- second line');
  });
  it('whitespace-only clears; a non-string or missing text is refused; other settings stay', () => {
    runTool(store, 'update_memory', { text: 'something' }, ctx);
    const before = store.getSettings();
    expect(runTool(store, 'update_memory', { text: ' \n\t ' }, ctx)).toEqual({ memory: '', summary: 'Memory cleared.' });
    expect(() => runTool(store, 'update_memory', { text: 42 }, ctx)).toThrow();
    expect(() => runTool(store, 'update_memory', {}, ctx)).toThrow();
    expect(() => runTool(store, 'update_memory', { text: null }, ctx)).toThrow();
    expect(store.getSettings()).toEqual({ ...before, memory: '' });
  });
});
