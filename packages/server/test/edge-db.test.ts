import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../src/db.js';
import { DEFAULT_SETTINGS, MEMORY_MAX, type Block, type Task } from '@ds/core';

const d = (h: number, m = 0) => new Date(2026, 9, 7, h, m);
const task = (id: string, name = id, priority = 1): Task => ({ id, name, color: '#4f8cff', priority, budgetMinutes: 60, budgetPeriod: 'day', preferredSegment: 'any', archived: false, createdAt: d(8).toISOString() });
const block = (id: string, start: Date, end: Date, extra: Partial<Block> = {}): Block => ({ id, taskId: 't1', start: start.toISOString(), end: end.toISOString(), status: 'pending', createdAt: start.toISOString(), statusChangedAt: null, ...extra });

/** The schema the pre-rename app (~/.dynamic-scheduler) created, before any migration: no segment, session, source, clock, note or carry columns, no baselines table. */
const LEGACY_SCHEMA = `
CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, priority INTEGER NOT NULL, budget_minutes INTEGER NOT NULL, budget_period TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE blocks (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, status_changed_at TEXT);
CREATE TABLE commitments (id TEXT PRIMARY KEY, title TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL);
CREATE TABLE recurring (id TEXT PRIMARY KEY, title TEXT NOT NULL, days TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL);
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'plannav-edge-db-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const columns = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map((c) => c.name);

describe('opening a pre-rename database', () => {
  it('migrates a ~/.dynamic-scheduler style file in place: columns added, old settings and baseline shapes read, rows kept, and a second open changes nothing more', () => {
    const home = join(dir, 'home');
    mkdirSync(join(home, '.dynamic-scheduler'), { recursive: true });
    const file = join(home, '.dynamic-scheduler', 'data.sqlite');
    const raw = new DatabaseSync(file);
    raw.exec(LEGACY_SCHEMA);
    raw.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('t1', 'Old task', '#000', 2, 90, 'week', 0, '2026-01-01T00:00:00.000Z');
    raw.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('t2', 'Archived', '#111', 1, 30, 'day', 1, '2026-01-02T00:00:00.000Z');
    raw.prepare('INSERT INTO blocks VALUES (?, ?, ?, ?, ?, ?, ?)').run('b1', 't1', '2026-10-07T09:00:00.000Z', '2026-10-07T10:00:00.000Z', 'done', '2026-10-07T08:00:00.000Z', '2026-10-07T10:00:00.000Z');
    raw.prepare('INSERT INTO commitments VALUES (?, ?, ?, ?)').run('c1', 'Dentist', '2026-10-08T09:00:00.000Z', '2026-10-08T10:00:00.000Z');
    raw.prepare('INSERT INTO recurring VALUES (?, ?, ?, ?, ?)').run('r1', 'Standup', '[1,2,3,4,5]', '10:00', '10:30');
    raw.prepare('INSERT INTO kv VALUES (?, ?)').run('settings', JSON.stringify({ workingHours: { start: '08:00', end: '16:00' }, workDays: [1, 2, 3], weekStartsOn: 1, slotMinutes: 15, minBlockMinutes: 30, maxBlockMinutes: 90, reviewWindow: 'day' }));
    raw.prepare('INSERT INTO kv VALUES (?, ?)').run('baseline', JSON.stringify({ savedAt: '2026-09-30T08:00:00.000Z', blocks: [{ taskId: 't1', day: 1, start: '09:00', end: '10:00' }, { taskId: 't1', day: 3, start: '14:00', end: '15:00' }] }));
    raw.prepare('INSERT INTO kv VALUES (?, ?)').run('import:https://example.com/a.ics', JSON.stringify(['c1']));
    raw.prepare('INSERT INTO kv VALUES (?, ?)').run('assistant', JSON.stringify({ kind: 'claude-code' }));
    raw.close();

    const s = new SqliteStore(file);
    // rows read with the defaults the new columns imply
    expect(s.listTasks(true)).toEqual([
      { id: 't2', name: 'Archived', color: '#111', priority: 1, budgetMinutes: 30, budgetPeriod: 'day', preferredSegment: 'any', sessionMinutes: undefined, archived: true, createdAt: '2026-01-02T00:00:00.000Z' },
      { id: 't1', name: 'Old task', color: '#000', priority: 2, budgetMinutes: 90, budgetPeriod: 'week', preferredSegment: 'any', sessionMinutes: undefined, archived: false, createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(s.listTasks().map((t) => t.id)).toEqual(['t1']);
    expect(s.getBlock('b1')).toEqual({ id: 'b1', taskId: 't1', start: '2026-10-07T09:00:00.000Z', end: '2026-10-07T10:00:00.000Z', status: 'done', source: 'planner', createdAt: '2026-10-07T08:00:00.000Z', statusChangedAt: '2026-10-07T10:00:00.000Z', trackedMinutes: undefined, runningSince: null, plannedMinutes: undefined });
    expect(s.listCommitments()).toEqual([{ id: 'c1', title: 'Dentist', start: '2026-10-08T09:00:00.000Z', end: '2026-10-08T10:00:00.000Z' }]);
    expect(s.listRecurring()).toEqual([{ id: 'r1', title: 'Standup', days: [1, 2, 3, 4, 5], start: '10:00', end: '10:30' }]);
    // the working-hours settings become one window; the Monday default becomes Sunday, once; the rest is kept or defaulted
    expect(s.getSettings()).toEqual({ ...DEFAULT_SETTINGS, availability: [{ days: [1, 2, 3], start: '08:00', end: '16:00' }], weekStartsOn: 0, slotMinutes: 15, minBlockMinutes: 30, maxBlockMinutes: 90, reviewWindow: 'day' });
    expect(s.getJson('week_start_chosen')).toBe(true);
    expect(s.getJson<{ weekStartsOn: number }>('settings')!.weekStartsOn).toBe(0); // rewritten in kv, not only on read
    // the kv baseline ({ blocks }) is the first version, sorted by day
    expect(s.listBaselines()).toEqual([{ version: 1, savedAt: '2026-09-30T08:00:00.000Z', slots: [{ day: 1, start: '09:00', end: '10:00', kind: 'task', taskId: 't1' }, { day: 3, start: '14:00', end: '15:00', kind: 'task', taskId: 't1' }] }]);
    // an import record that held only ids
    expect(s.getImportRecord('https://example.com/a.ics')).toEqual({ ids: ['c1'], events: [], importedAt: '' });
    expect(s.listImportSources()).toEqual(['https://example.com/a.ics']);
    expect(s.getJson('assistant')).toEqual({ kind: 'claude-code' });
    s.close();

    const check = new DatabaseSync(file);
    expect(columns(check, 'tasks')).toEqual(['id', 'name', 'color', 'priority', 'budget_minutes', 'budget_period', 'archived', 'created_at', 'preferred_segment', 'session_minutes']);
    expect(columns(check, 'blocks')).toEqual(['id', 'task_id', 'start', 'end', 'status', 'created_at', 'status_changed_at', 'source', 'tracked_minutes', 'running_since', 'planned_minutes', 'carried_to', 'note', 'started_at', 'finished_at']);
    expect((check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as unknown as Array<{ name: string }>).map((r) => r.name)).toEqual(['baselines', 'blocks', 'commitments', 'kv', 'recurring', 'tasks']);
    expect((check.prepare('PRAGMA journal_mode').get() as unknown as { journal_mode: string }).journal_mode).toBe('wal');
    check.close();

    // the second open is a no-op: one baseline row, the same settings, and a Monday the user now chooses stays
    const again = new SqliteStore(file);
    expect(again.listBaselines().map((b) => b.version)).toEqual([1]);
    expect(again.getSettings().weekStartsOn).toBe(0);
    again.saveSettings({ ...again.getSettings(), weekStartsOn: 1 });
    again.close();
    const third = new SqliteStore(file);
    expect(third.getSettings().weekStartsOn).toBe(1);
    expect(third.listBaselines()).toHaveLength(1);
    third.close();
  });

  it('a Monday week start is left alone when the flag is already set, and when there are no settings at all nothing is written but the flag', () => {
    const file = join(dir, 'flagged.sqlite');
    const raw = new DatabaseSync(file);
    raw.exec(LEGACY_SCHEMA);
    raw.prepare('INSERT INTO kv VALUES (?, ?)').run('settings', JSON.stringify({ ...DEFAULT_SETTINGS, weekStartsOn: 1 }));
    raw.prepare('INSERT INTO kv VALUES (?, ?)').run('week_start_chosen', 'true');
    raw.close();
    const s = new SqliteStore(file);
    expect(s.getSettings().weekStartsOn).toBe(1);
    s.close();

    const empty = new SqliteStore(join(dir, 'empty.sqlite'));
    expect(empty.getJson('week_start_chosen')).toBe(true);
    expect(empty.getJson('settings')).toBeUndefined();
    expect(empty.getSettings()).toEqual(DEFAULT_SETTINGS);
    empty.close();
  });

  it('a legacy kv baseline is ignored once the versions table has rows (the table is the truth)', () => {
    const s = new SqliteStore(join(dir, 'versions.sqlite'));
    s.setBaseline({ slots: [{ day: 2, start: '09:00', end: '10:00', kind: 'task', taskId: 't1' }] });
    s.setJson('baseline', { savedAt: '2026-01-01T00:00:00.000Z', blocks: [{ taskId: 'zzz', day: 5, start: '09:00', end: '10:00' }] });
    expect(s.listBaselines()).toHaveLength(1);
    expect(s.getBaseline()!.slots[0].taskId).toBe('t1');
    s.close();
  });

  it('a kv baseline that is not a baseline at all is not adopted', () => {
    const s = new SqliteStore(':memory:');
    s.setJson('baseline', { hello: 'world' });
    expect(s.listBaselines()).toEqual([]);
    expect(s.getBaseline()).toBeUndefined();
    s.setJson('baseline', 'a string');
    expect(s.listBaselines()).toEqual([]);
    s.setJson('baseline', { slots: 'not an array' });
    expect(s.listBaselines()).toEqual([]);
    s.close();
  });
});

describe('settings written in old or odd shapes are normalized on read', () => {
  const read = (raw: unknown) => { const s = new SqliteStore(':memory:'); s.setJson('settings', raw); const out = s.getSettings(); s.close(); return out; };

  it('working hours with no workDays mean weekdays; invalid hours mean no availability; an inverted window is dropped', () => {
    expect(read({ workingHours: { start: '09:00', end: '17:00' } }).availability).toEqual([{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }]);
    expect(read({ workingHours: { start: '9:00', end: '17:00' } }).availability).toEqual([]);
    expect(read({ workingHours: { start: '18:00', end: '09:00' }, workDays: [1] }).availability).toEqual([]);
    expect(read({ workingHours: { start: '09:00', end: '17:00' }, workDays: [9] }).availability).toEqual([{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }]); // a bad day list falls back to weekdays
    expect(read({ availability: [{ days: [3, 1], start: '09:00', end: '12:00' }, { days: [1], start: '12:00', end: '12:00' }, { days: [], start: '09:00', end: '10:00' }, 'junk', { days: [2], start: '24:00', end: '25:00' }] }).availability)
      .toEqual([{ days: [1, 3], start: '09:00', end: '12:00' }, { days: [], start: '09:00', end: '10:00' }]);
  });

  it('numbers below their minimum, out of range, or of the wrong type fall back to the defaults; enum-like fields too', () => {
    const s = read({ slotMinutes: 2, minBlockMinutes: '30', maxBlockMinutes: -5, weekStartsOn: 9, maxTasksPerDay: 3.7, workStyle: 'lazy', reviewWindow: 'month', segments: { morningEnd: '13:00', afternoonEnd: '12:00' }, weights: { priority: 2, deficit: 0.5 } });
    expect(s).toEqual({ ...DEFAULT_SETTINGS, maxTasksPerDay: 3 });
    expect(read({ maxTasksPerDay: 51 }).maxTasksPerDay).toBe(5);
    expect(read({ maxTasksPerDay: 0.5 }).maxTasksPerDay).toBe(5);
    expect(read({ weekStartsOn: 6 }).weekStartsOn).toBe(6);
    expect(read({ weekStartsOn: 2.5 }).weekStartsOn).toBe(0); // an integer 0..6, else the default
    expect(read({ reviewWindow: 'day' }).reviewWindow).toBe('day');
    expect(read({ workStyle: 'varied' }).workStyle).toBe('varied');
    expect(read({ weights: { priority: 0, deficit: 0 } }).weights).toEqual(DEFAULT_SETTINGS.weights);
    expect(read({ weights: { priority: 0, deficit: 1 } }).weights).toEqual({ priority: 0, deficit: 1 });
    expect(read({ segments: { morningEnd: '11:00', afternoonEnd: '16:00' } }).segments).toEqual({ morningEnd: '11:00', afternoonEnd: '16:00' });
  });

  it('the memory note is trimmed and capped at 2000 characters on read; a non-string is the empty note', () => {
    expect(read({ memory: '  - a  \n' }).memory).toBe('- a');
    expect(read({ memory: 'x'.repeat(5000) }).memory).toBe('x'.repeat(MEMORY_MAX));
    expect(read({ memory: `  ${'y'.repeat(2001)}` }).memory).toBe('y'.repeat(2000)); // trimmed first, then cut
    for (const m of [42, null, ['a'], { text: 'a' }, true]) expect(read({ memory: m }).memory, JSON.stringify(m)).toBe('');
    expect(read({}).memory).toBe('');
  });

  it('a settings value that is not an object (null, a list, a number, a string) reads as the defaults', () => {
    for (const raw of [null, [], [1, 2], 7, 'settings', true]) expect(read(raw), JSON.stringify(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it('a saved settings object with extra keys loses them on read, and what is saved is what getJson returns', () => {
    const s = new SqliteStore(':memory:');
    s.saveSettings({ ...DEFAULT_SETTINGS, extra: 'kept in kv' } as never);
    expect((s.getJson('settings') as Record<string, unknown>).extra).toBe('kept in kv');
    expect('extra' in s.getSettings()).toBe(false);
    s.close();
  });
});

describe('kv: JSON values', () => {
  it('round-trips nested objects, arrays, strings, numbers, booleans and null; null reads back as null, not undefined', () => {
    const s = new SqliteStore(':memory:');
    const v = { a: [1, 2, { b: 'c' }], d: { e: null, f: true, g: 1.5 }, h: 'ü✓' };
    s.setJson('k', v);
    expect(s.getJson('k')).toEqual(v);
    s.setJson('k', 'text'); expect(s.getJson('k')).toBe('text');
    s.setJson('k', 0); expect(s.getJson('k')).toBe(0);
    s.setJson('k', false); expect(s.getJson('k')).toBe(false);
    s.setJson('k', null); expect(s.getJson('k')).toBeNull();
    s.setJson('k', []); expect(s.getJson('k')).toEqual([]);
    expect(s.getJson('missing')).toBeUndefined();
    s.close();
  });

  it('keys are case-sensitive and exact; an overwrite replaces; deleting a missing key is a no-op', () => {
    const s = new SqliteStore(':memory:');
    s.setJson('Key', 1);
    s.setJson('key', 2);
    s.setJson('key ', 3);
    expect([s.getJson('Key'), s.getJson('key'), s.getJson('key ')]).toEqual([1, 2, 3]);
    s.setJson('key', { replaced: true });
    expect(s.getJson('key')).toEqual({ replaced: true });
    expect(() => s.deleteKey('nothing')).not.toThrow();
    s.deleteKey('key');
    expect(s.getJson('key')).toBeUndefined();
    expect(s.getJson('Key')).toBe(1);
    s.close();
  });

  it('a kv row holding invalid JSON reads as absent with one warning, so a corrupt settings row still lets the store open with the defaults', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = join(dir, 'corrupt.sqlite');
    const raw = new DatabaseSync(file);
    raw.exec(LEGACY_SCHEMA);
    raw.prepare('INSERT INTO kv VALUES (?, ?)').run('junk', '{not json');
    raw.prepare('INSERT INTO kv VALUES (?, ?)').run('week_start_chosen', 'true');
    raw.close();
    const s = new SqliteStore(file);
    expect(s.getJson('junk')).toBeUndefined();
    expect(warn).toHaveBeenLastCalledWith('plannav: the "junk" row in the database is not valid JSON; using defaults until it is saved again.');
    expect(s.getSettings()).toEqual(DEFAULT_SETTINGS); // other keys are unaffected
    s.close();

    const file2 = join(dir, 'corrupt-settings.sqlite');
    const raw2 = new DatabaseSync(file2);
    raw2.exec(LEGACY_SCHEMA);
    raw2.prepare('INSERT INTO kv VALUES (?, ?)').run('settings', '{"weekStartsOn": ');
    raw2.close();
    const s2 = new SqliteStore(file2); // the migration reads settings before the flag exists: defaults, not a crash
    expect(s2.getSettings()).toEqual(DEFAULT_SETTINGS);
    s2.saveSettings({ ...DEFAULT_SETTINGS, weekStartsOn: 1 }); // the next save replaces the row
    expect(s2.getSettings().weekStartsOn).toBe(1);
    s2.close();
    warn.mockRestore();
  });

  it('import records: the prefix is private to the store, sources are listed without it, and other kv keys do not leak in', () => {
    const s = new SqliteStore(':memory:');
    s.setImportRecord('file:Routine.ics', { ids: ['a'], events: [], importedAt: '2026-10-01T00:00:00.000Z' });
    s.setImportRecord('https://example.com/a.ics', { ids: [], events: [{ title: 'x', start: '2026-10-08T09:00:00.000Z', end: '2026-10-08T10:00:00.000Z' }], importedAt: '2026-10-02T00:00:00.000Z' });
    s.setJson('importer', 'not a record');
    s.setJson('import', 'not a record either');
    expect(s.listImportSources().sort()).toEqual(['file:Routine.ics', 'https://example.com/a.ics']);
    expect(s.getImportRecord('https://example.com/a.ics')!.events).toHaveLength(1);
    expect(s.getImportRecord('nope')).toBeUndefined();
    expect(s.getJson('import:file:Routine.ics')).toEqual({ ids: ['a'], events: [], importedAt: '2026-10-01T00:00:00.000Z' });
    s.close();
  });
});

describe('blocks: ranges, replacement, and very large notes', () => {
  it('a range keeps blocks that overlap it: touching at either end does not count; open-ended ranges work', () => {
    const s = new SqliteStore(':memory:');
    s.insertBlocks([block('a', d(8), d(9)), block('b', d(9), d(10)), block('c', d(10), d(11)), block('d', d(11), d(12))]);
    expect(s.listBlocks({ from: d(9), to: d(11) }).map((b) => b.id)).toEqual(['b', 'c']);
    expect(s.listBlocks({ from: d(9, 30), to: d(10, 30) }).map((b) => b.id)).toEqual(['b', 'c']);
    expect(s.listBlocks({ from: d(10) }).map((b) => b.id)).toEqual(['c', 'd']);
    expect(s.listBlocks({ to: d(10) }).map((b) => b.id)).toEqual(['a', 'b']);
    expect(s.listBlocks({ from: d(12), to: d(13) })).toEqual([]);
    expect(s.listBlocks({ from: d(11), to: d(11) })).toEqual([]); // an empty range holds nothing
    expect(s.listBlocks({}).map((b) => b.id)).toEqual(['a', 'b', 'c', 'd']);
    s.close();
  });

  it('inserting an id again replaces the row whole (a field left out is gone)', () => {
    const s = new SqliteStore(':memory:');
    s.insertBlocks([block('a', d(8), d(9), { note: 'first', trackedMinutes: 10, source: 'manual' })]);
    s.insertBlocks([block('a', d(13), d(14))]);
    expect(s.listBlocks()).toHaveLength(1);
    expect(s.getBlock('a')).toMatchObject({ start: d(13).toISOString(), source: 'planner', runningSince: null });
    expect(s.getBlock('a')!.note).toBeUndefined();
    expect(s.getBlock('a')!.trackedMinutes).toBeUndefined();
    s.close();
  });

  it('a 100,000-character note with every kind of character round-trips exactly through insert, update, reopen and export', () => {
    const file = join(dir, 'notes.sqlite');
    const s = new SqliteStore(file);
    const note = `${'é✓🙂"\\\n\t'.repeat(10_000)}${'x'.repeat(30_000)}`;
    expect(note.length).toBeGreaterThan(100_000);
    s.insertBlocks([block('big', d(9), d(10), { note })]);
    expect(s.getBlock('big')!.note).toBe(note);
    const other = `second ${note}`;
    expect(s.updateBlock('big', { note: other }).note).toBe(other);
    s.close();
    const again = new SqliteStore(file);
    expect(again.getBlock('big')!.note).toBe(other);
    expect(again.exportAll().blocks[0].note).toBe(other);
    expect(JSON.parse(JSON.stringify(again.exportAll())).blocks[0].note).toBe(other);
    again.close();
  });

  it('updateBlock writes every optional field: a 0 is kept (only null, undefined and "" clear), and the row matches the return value', () => {
    const s = new SqliteStore(':memory:');
    s.insertBlocks([block('a', d(8), d(9))]);
    const u = s.updateBlock('a', { trackedMinutes: 0, plannedMinutes: 0, note: '', startedAt: '', carriedTo: '' });
    expect(u.trackedMinutes).toBe(0);
    expect(u.plannedMinutes).toBe(0);
    expect('note' in u).toBe(false);
    expect('startedAt' in u).toBe(false);
    expect(u.carriedTo).toBe(''); // carriedTo is not in the cleared list: the empty string is written, and read back as absent
    const row = s.getBlock('a')!;
    expect(row.trackedMinutes).toBe(0);
    expect(row.plannedMinutes).toBe(0);
    expect('carriedTo' in row).toBe(false);
    expect('note' in row).toBe(false);
    expect(row).toEqual({ ...u, carriedTo: undefined });
    s.close();
  });
});

describe('tasks, recurring and two handles on one file', () => {
  it('tasks list by priority then name, upsert can unarchive, and getTask of a missing id is undefined', () => {
    const s = new SqliteStore(':memory:');
    s.upsertTask(task('b', 'Beta', 2));
    s.upsertTask(task('a', 'alpha', 2));
    s.upsertTask(task('z', 'Zed', 1));
    expect(s.listTasks().map((t) => t.id)).toEqual(['z', 'b', 'a']); // SQLite's default collation: 'B' before 'a'
    s.archiveTask('z');
    expect(s.listTasks().map((t) => t.id)).toEqual(['b', 'a']);
    s.upsertTask({ ...task('z', 'Zed', 1), archived: false, sessionMinutes: 45, preferredSegment: 'evening' });
    expect(s.getTask('z')).toMatchObject({ archived: false, sessionMinutes: 45, preferredSegment: 'evening' });
    expect(s.getTask('nope')).toBeUndefined();
    s.archiveTask('nope'); // no row, no error
    s.close();
  });

  it('recurring rules order by start then title, keep an empty day list, and replace by id', () => {
    const s = new SqliteStore(':memory:');
    s.addRecurring({ id: 'b', title: 'Gym', days: [6], start: '18:00', end: '19:00' });
    s.addRecurring({ id: 'a', title: 'Standup', days: [1, 3], start: '10:00', end: '10:30' });
    s.addRecurring({ id: 'c', title: 'Coffee', days: [], start: '10:00', end: '10:15' });
    expect(s.listRecurring().map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(s.listRecurring()[0].days).toEqual([]);
    s.addRecurring({ id: 'a', title: 'Standup', days: [2], start: '09:00', end: '09:15' });
    expect(s.listRecurring().map((r) => [r.id, r.start])).toEqual([['a', '09:00'], ['c', '10:00'], ['b', '18:00']]);
    s.close();
  });

  it('two stores on the same file see each other\'s writes (WAL), and the export of one matches the other', () => {
    const file = join(dir, 'shared.sqlite');
    const a = new SqliteStore(file);
    const b = new SqliteStore(file);
    a.upsertTask(task('t1'));
    a.insertBlocks([block('x', d(9), d(10))]);
    a.saveSettings({ ...DEFAULT_SETTINGS, memory: '- shared' });
    a.setBaseline({ slots: [{ day: 1, start: '09:00', end: '10:00', kind: 'task', taskId: 't1' }] });
    expect(b.listTasks().map((t) => t.id)).toEqual(['t1']);
    expect(b.getBlock('x')!.start).toBe(d(9).toISOString());
    expect(b.getSettings().memory).toBe('- shared');
    expect(b.getBaseline()!.version).toBe(1);
    b.setBaseline({ slots: [] });
    expect(a.listBaselines().map((v) => v.version)).toEqual([1, 2]);
    const ea = a.exportAll(); const eb = b.exportAll();
    expect({ ...ea, exportedAt: '' }).toEqual({ ...eb, exportedAt: '' });
    expect(Object.keys(ea)).toEqual(['exportedAt', 'tasks', 'blocks', 'commitments', 'recurring', 'settings']);
    a.close(); b.close();
  });

  it('baseline versions: a given savedAt is kept, an empty one is stamped, and numbering continues across a reopen', () => {
    const file = join(dir, 'versions.sqlite');
    const s = new SqliteStore(file);
    const v1 = s.setBaseline({ slots: [], savedAt: '2026-10-01T00:00:00.000Z' });
    expect(v1).toEqual({ version: 1, savedAt: '2026-10-01T00:00:00.000Z', slots: [] });
    const v2 = s.setBaseline({ slots: [], version: 99 }); // a caller's version number is ignored: the store numbers
    expect(v2.version).toBe(2);
    expect(Number.isNaN(new Date(v2.savedAt).getTime())).toBe(false);
    s.close();
    const again = new SqliteStore(file);
    expect(again.setBaseline({ slots: [] }).version).toBe(3);
    expect(again.getJson<{ version: number }>('baseline')!.version).toBe(3);
    again.close();
  });
});
