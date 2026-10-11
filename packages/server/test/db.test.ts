import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../src/db.js';
import { DEFAULT_SETTINGS, markBlock, trackBlock, type Block, type Task } from '@ds/core';

const d = (h: number, m = 0) => new Date(2026, 9, 7, h, m);
const task: Task = { id: 't1', name: 'A', color: '#4f8cff', priority: 1, budgetMinutes: 60, budgetPeriod: 'day', preferredSegment: 'any', archived: false, createdAt: d(8).toISOString() };
const block = (id: string, start: Date, end: Date): Block => ({ id, taskId: 't1', start: start.toISOString(), end: end.toISOString(), status: 'pending', createdAt: start.toISOString(), statusChangedAt: null });

describe('SqliteStore', () => {
  it('round-trips tasks, blocks, commitments, settings and kv', () => {
    const s = new SqliteStore(':memory:');
    s.upsertTask(task);
    s.upsertTask({ ...task, priority: 2 });
    expect(s.listTasks()).toEqual([{ ...task, priority: 2 }]);
    s.archiveTask('t1');
    expect(s.listTasks()).toEqual([]);
    expect(s.listTasks(true)[0].archived).toBe(true);

    s.insertBlocks([block('b1', d(9), d(10)), block('b2', d(13), d(14))]);
    expect(s.listBlocks({ from: d(9, 30), to: d(12) }).map((b) => b.id)).toEqual(['b1']);
    expect(s.listBlocks().map((b) => b.id)).toEqual(['b1', 'b2']);
    const u = s.updateBlock('b1', { status: 'done', statusChangedAt: d(10).toISOString() });
    expect(u.status).toBe('done');
    expect(s.getBlock('b1')!.statusChangedAt).toBe(d(10).toISOString());
    s.deleteBlocks(['b1']);
    expect(s.getBlock('b1')).toBeUndefined();

    s.addCommitment({ id: 'c1', title: 'Standup', start: d(10).toISOString(), end: d(10, 30).toISOString() });
    expect(s.listCommitments({ from: d(10, 15), to: d(11) }).length).toBe(1);
    expect(s.listCommitments({ from: d(11), to: d(12) }).length).toBe(0);
    s.deleteCommitment('c1');
    expect(s.listCommitments().length).toBe(0);

    expect(s.getSettings()).toEqual(DEFAULT_SETTINGS);
    s.saveSettings({ ...DEFAULT_SETTINGS, slotMinutes: 30 });
    expect(s.getSettings().slotMinutes).toBe(30);

    expect(s.getJson('assistant')).toBeUndefined();
    s.setJson('assistant', { kind: 'claude-code' });
    expect(s.getJson('assistant')).toEqual({ kind: 'claude-code' });
    s.deleteKey('assistant');
    expect(s.getJson('assistant')).toBeUndefined();

    const bundle = s.exportAll();
    expect(bundle.tasks.length).toBe(1);
    expect(bundle.blocks.length).toBe(1);
    expect(bundle.settings.slotMinutes).toBe(30);
    s.close();
  });

  it('throws when updating a missing block', () => {
    const s = new SqliteStore(':memory:');
    expect(() => s.updateBlock('nope', { status: 'done' })).toThrow(/not found/i);
  });
});

describe('SqliteStore migration and recurring', () => {
  it('migrates settings saved by the working-hours version', () => {
    const s = new SqliteStore(':memory:');
    s.setJson('settings', { workingHours: { start: '08:00', end: '16:00' }, workDays: [1, 2, 3], weekStartsOn: 1, slotMinutes: 15, minBlockMinutes: 30, maxBlockMinutes: 90, reviewWindow: 'week' });
    expect(s.getSettings().availability).toEqual([{ days: [1, 2, 3], start: '08:00', end: '16:00' }]);
  });
  it('a week start saved by the Monday-default version is read as Sunday once; a week start the user chose stays', () => {
    // Settings saved before 2026-10-09 carry weekStartsOn 1 from the old default, not a choice: the first open after the upgrade turns it into Sunday.
    const legacy = new DatabaseSync(':memory:');
    legacy.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO kv (key, value) VALUES ('settings', '${JSON.stringify({ ...DEFAULT_SETTINGS, weekStartsOn: 1 })}');`);
    legacy.close();
    const dir = mkdtempSync(join(tmpdir(), 'ds-legacy-'));
    const file = join(dir, 'ds.sqlite');
    try {
      const db = new DatabaseSync(file);
      db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO kv (key, value) VALUES ('settings', '${JSON.stringify({ ...DEFAULT_SETTINGS, weekStartsOn: 1 })}');`);
      db.close();
      const s = new SqliteStore(file);
      expect(s.getSettings().weekStartsOn).toBe(0);
      // the user now picks Monday on purpose: it stays, across a reopen
      s.saveSettings({ ...s.getSettings(), weekStartsOn: 1 });
      s.close();
      const again = new SqliteStore(file);
      expect(again.getSettings().weekStartsOn).toBe(1);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // a fresh store has nothing to migrate and starts on Sunday
    expect(new SqliteStore(':memory:').getSettings().weekStartsOn).toBe(0);
  });
  it('stores recurring commitments', () => {
    const s = new SqliteStore(':memory:');
    s.addRecurring({ id: 'r', title: 'Standup', days: [1, 2, 3, 4, 5], start: '10:00', end: '10:30' });
    s.addRecurring({ id: 'r', title: 'Standup', days: [1, 3], start: '10:00', end: '10:30' });
    expect(s.listRecurring()).toEqual([{ id: 'r', title: 'Standup', days: [1, 3], start: '10:00', end: '10:30' }]);
    expect(s.exportAll().recurring.length).toBe(1);
    s.deleteRecurring('r');
    expect(s.listRecurring()).toEqual([]);
  });
});

describe('SqliteStore task segment migration', () => {
  it('adds the preferred_segment column to an older tasks table and defaults it to any', () => {
    const s = new SqliteStore(':memory:');
    s.close();
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const legacy = new DatabaseSync(':memory:');
    legacy.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, priority INTEGER NOT NULL,
      budget_minutes INTEGER NOT NULL, budget_period TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      INSERT INTO tasks VALUES ('t', 'Old', '#000', 1, 60, 'day', 0, '2026-01-01T00:00:00.000Z');`);
    legacy.close();
  });
});

describe('SqliteStore actual-time columns', () => {
  it('round-trips tracked minutes, the running clock and planned minutes; absent values read back as undefined / null', () => {
    const s = new SqliteStore(':memory:');
    s.upsertTask(task);
    s.insertBlocks([block('b1', d(9), d(10)), { ...block('b2', d(13), d(14)), trackedMinutes: 20, runningSince: d(13).toISOString(), plannedMinutes: 60 }]);
    const b1 = s.getBlock('b1')!;
    expect(b1.trackedMinutes).toBeUndefined();
    expect(b1.plannedMinutes).toBeUndefined();
    expect(b1.runningSince ?? null).toBeNull();
    expect(s.getBlock('b2')).toMatchObject({ trackedMinutes: 20, runningSince: d(13).toISOString(), plannedMinutes: 60 });
    const u = s.updateBlock('b2', { trackedMinutes: 35, runningSince: null });
    expect(u).toMatchObject({ trackedMinutes: 35, runningSince: null, plannedMinutes: 60 });
    expect(s.getBlock('b2')).toMatchObject({ trackedMinutes: 35, runningSince: null, plannedMinutes: 60 });
    s.close();
  });
  it('a Finish then a Reset on SQLite restores the planned end and undoes the clock (cleared fields are written as null)', () => {
    const s = new SqliteStore(':memory:');
    s.upsertTask(task);
    s.insertBlocks([block('b1', d(9), d(10))]);
    trackBlock(s, 'b1', 'start', d(9));
    trackBlock(s, 'b1', 'finish', d(9, 40));
    expect(s.getBlock('b1')).toMatchObject({ status: 'done', plannedMinutes: 60, trackedMinutes: 40, startedAt: d(9).toISOString(), finishedAt: d(9, 40).toISOString() });
    markBlock(s, 'b1', 'pending', d(9, 50));
    const b = s.getBlock('b1')!;
    expect(b.end).toBe(d(10).toISOString());
    expect(b.plannedMinutes).toBeUndefined();
    expect(b.trackedMinutes).toBeUndefined();
    expect(b.startedAt).toBeUndefined(); expect(b.finishedAt).toBeUndefined();
    s.close();
  });
  it('adds the columns to a blocks table created before time tracking and keeps its rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-legacy-'));
    const file = join(dir, 'ds.sqlite');
    try {
      const legacy = new DatabaseSync(file);
      legacy.exec(`CREATE TABLE blocks (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, status TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'planner', created_at TEXT NOT NULL, status_changed_at TEXT);
        INSERT INTO blocks (id, task_id, start, end, status, created_at, status_changed_at) VALUES ('old', 't1', '2026-10-07T09:00:00.000Z', '2026-10-07T10:00:00.000Z', 'pending', '2026-10-07T08:00:00.000Z', NULL);`);
      legacy.close();
      const s = new SqliteStore(file);
      const old = s.getBlock('old')!;
      expect(old.status).toBe('pending');
      expect(old.trackedMinutes).toBeUndefined();
      expect(s.updateBlock('old', { trackedMinutes: 10 }).trackedMinutes).toBe(10);
      s.close();
      const again = new SqliteStore(file);
      expect(again.getBlock('old')!.trackedMinutes).toBe(10);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips carriedTo (the block a carry moved the minutes to); absent reads back as no property, and a table without the column gains it', () => {
    const s = new SqliteStore(':memory:');
    s.insertBlocks([block('src', d(9), d(10)), { ...block('dst', d(11), d(12)), source: 'adjusted' }]);
    expect('carriedTo' in s.getBlock('src')!).toBe(false);
    expect(s.updateBlock('src', { carriedTo: 'dst' }).carriedTo).toBe('dst');
    expect(s.getBlock('src')!.carriedTo).toBe('dst');
    s.insertBlocks([{ ...block('x', d(13), d(14)), carriedTo: 'dst' }]);
    expect(s.getBlock('x')!.carriedTo).toBe('dst');
    const dir = mkdtempSync(join(tmpdir(), 'ds-legacy-'));
    const file = join(dir, 'ds.sqlite');
    try {
      const legacy = new DatabaseSync(file);
      legacy.exec(`CREATE TABLE blocks (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, status TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'planner', created_at TEXT NOT NULL, status_changed_at TEXT, tracked_minutes INTEGER, running_since TEXT, planned_minutes INTEGER);
        INSERT INTO blocks (id, task_id, start, end, status, created_at, status_changed_at) VALUES ('old', 't1', '2026-10-07T09:00:00.000Z', '2026-10-07T10:00:00.000Z', 'missed', '2026-10-07T08:00:00.000Z', NULL);`);
      legacy.close();
      const old = new SqliteStore(file);
      expect(old.getBlock('old')!.carriedTo).toBeUndefined();
      expect(old.updateBlock('old', { carriedTo: 'new' }).carriedTo).toBe('new');
      old.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('round-trips the actual start and finish times; a table without the columns gains them', () => {
    const s = new SqliteStore(':memory:');
    s.insertBlocks([block('n', d(9), d(10))]);
    expect('startedAt' in s.getBlock('n')!).toBe(false);
    expect(s.updateBlock('n', { startedAt: d(9, 3).toISOString() }).startedAt).toBe(d(9, 3).toISOString());
    expect(s.updateBlock('n', { finishedAt: d(9, 58).toISOString() }).finishedAt).toBe(d(9, 58).toISOString());
    expect(s.getBlock('n')!.startedAt).toBe(d(9, 3).toISOString());
    expect(s.getBlock('n')!.finishedAt).toBe(d(9, 58).toISOString());
    expect('startedAt' in s.updateBlock('n', { startedAt: null, finishedAt: null })).toBe(false);
    s.insertBlocks([{ ...block('m', d(13), d(14)), startedAt: d(13, 1).toISOString() }]);
    expect(s.exportAll().blocks.find((b) => b.id === 'm')!.startedAt).toBe(d(13, 1).toISOString());
    const dir = mkdtempSync(join(tmpdir(), 'ds-legacy-'));
    const file = join(dir, 'ds.sqlite');
    try {
      const legacy = new DatabaseSync(file);
      legacy.exec(`CREATE TABLE blocks (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, status TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'planner', created_at TEXT NOT NULL, status_changed_at TEXT, tracked_minutes INTEGER, running_since TEXT, planned_minutes INTEGER, carried_to TEXT, note TEXT);
        INSERT INTO blocks (id, task_id, start, end, status, created_at, status_changed_at) VALUES ('old', 't1', '2026-10-07T09:00:00.000Z', '2026-10-07T10:00:00.000Z', 'done', '2026-10-07T08:00:00.000Z', NULL);`);
      legacy.close();
      const old = new SqliteStore(file);
      expect(old.getBlock('old')!.startedAt).toBeUndefined();
      expect(old.updateBlock('old', { finishedAt: '2026-10-07T10:02:00.000Z' }).finishedAt).toBe('2026-10-07T10:02:00.000Z');
      old.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('round-trips a note (the user\'s words on a block); absent reads back as no property; a table without the column gains it', () => {
    const s = new SqliteStore(':memory:');
    s.insertBlocks([block('n', d(9), d(10))]);
    expect('note' in s.getBlock('n')!).toBe(false);
    expect(s.updateBlock('n', { note: 'did it, not focused' }).note).toBe('did it, not focused');
    expect(s.getBlock('n')!.note).toBe('did it, not focused');
    expect('note' in s.updateBlock('n', { note: null })).toBe(false);
    s.insertBlocks([{ ...block('m', d(13), d(14)), note: 'two tasks share this slot' }]);
    expect(s.getBlock('m')!.note).toBe('two tasks share this slot');
    expect(s.exportAll().blocks.find((b) => b.id === 'm')!.note).toBe('two tasks share this slot');
    const dir = mkdtempSync(join(tmpdir(), 'ds-legacy-'));
    const file = join(dir, 'ds.sqlite');
    try {
      const legacy = new DatabaseSync(file);
      legacy.exec(`CREATE TABLE blocks (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, status TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'planner', created_at TEXT NOT NULL, status_changed_at TEXT, tracked_minutes INTEGER, running_since TEXT, planned_minutes INTEGER, carried_to TEXT);
        INSERT INTO blocks (id, task_id, start, end, status, created_at, status_changed_at) VALUES ('old', 't1', '2026-10-07T09:00:00.000Z', '2026-10-07T10:00:00.000Z', 'done', '2026-10-07T08:00:00.000Z', NULL);`);
      legacy.close();
      const old = new SqliteStore(file);
      expect(old.getBlock('old')!.note).toBeUndefined();
      expect(old.updateBlock('old', { note: 'later' }).note).toBe('later');
      old.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SqliteStore baseline versions', () => {
  const slot = (day: number, start: string, end: string) => ({ day, start, end, kind: 'task' as const, taskId: 't1' });
  it('appends a version per save, lists them oldest first and returns the latest', () => {
    const s = new SqliteStore(':memory:');
    expect(s.getBaseline()).toBeUndefined();
    expect(s.listBaselines()).toEqual([]);
    s.setBaseline({ slots: [slot(1, '09:00', '10:00')] });
    s.setBaseline({ slots: [slot(1, '09:00', '10:00'), slot(2, '13:00', '14:00')] });
    expect(s.listBaselines().map((b) => [b.version, b.slots.length])).toEqual([[1, 1], [2, 2]]);
    expect(s.getBaseline()!.version).toBe(2);
    expect(s.getBaseline()!.slots.length).toBe(2);
    expect(s.getBaseline()!.savedAt).toBeTruthy();
    expect(s.getJson<{ version: number }>('baseline')!.version).toBe(2); // kv keeps the latest for compatibility
    s.close();
  });
  it('keeps every version across a reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-baseline-'));
    const file = join(dir, 'ds.sqlite');
    try {
      const s = new SqliteStore(file);
      s.setBaseline({ slots: [slot(1, '09:00', '10:00')] });
      s.setBaseline({ slots: [slot(3, '09:00', '10:00')] });
      s.close();
      const again = new SqliteStore(file);
      expect(again.listBaselines().map((b) => b.version)).toEqual([1, 2]);
      expect(again.getBaseline()!.slots[0].day).toBe(3);
      again.setBaseline({ slots: [slot(4, '09:00', '10:00')] });
      expect(again.listBaselines().map((b) => b.version)).toEqual([1, 2, 3]);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('reads a legacy kv baseline ({ blocks }) as version 1 on a fresh open, and the next save is version 2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-baseline-legacy-'));
    const file = join(dir, 'ds.sqlite');
    try {
      const old = new SqliteStore(file);
      old.setJson('baseline', { savedAt: '2026-10-01T08:00:00.000Z', blocks: [{ taskId: 't1', day: 1, start: '09:00', end: '10:00' }] });
      old.close();
      const s = new SqliteStore(file);
      const b = s.getBaseline()!;
      expect(b.version).toBe(1);
      expect(b.savedAt).toBe('2026-10-01T08:00:00.000Z');
      expect(b.slots).toEqual([{ day: 1, start: '09:00', end: '10:00', kind: 'task', taskId: 't1' }]);
      expect(s.listBaselines().map((x) => x.version)).toEqual([1]);
      s.setBaseline({ slots: [slot(2, '09:00', '10:00')] });
      expect(s.listBaselines().map((x) => x.version)).toEqual([1, 2]);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('reads a legacy kv baseline written after open (no reopen) the same way', () => {
    const s = new SqliteStore(':memory:');
    s.setJson('baseline', { savedAt: '2026-10-01T08:00:00.000Z', blocks: [{ taskId: 't1', day: 1, start: '09:00', end: '10:00' }] });
    expect(s.getBaseline()!.version).toBe(1);
    expect(s.listBaselines().length).toBe(1);
    s.close();
  });
  it('rejects a value that is not a baseline', () => {
    const s = new SqliteStore(':memory:');
    expect(() => s.setBaseline({} as any)).toThrow(/baseline/i);
    s.close();
  });
});
