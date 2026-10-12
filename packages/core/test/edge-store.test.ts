import { describe, it, expect } from 'vitest';
import { MemoryStore, inRange } from '../src/store.js';
import { DEFAULT_SETTINGS, type Block, type Task } from '../src/types.js';

const d = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m);
const block = (id: string, start: Date, end: Date, extra: Partial<Block> = {}): Block => ({ id, taskId: 't', start: start.toISOString(), end: end.toISOString(), status: 'pending', createdAt: '', statusChangedAt: null, ...extra });
const task = (id: string, priority: number, name = id, archived = false): Task => ({ id, name, color: '#000', priority, budgetMinutes: 60, budgetPeriod: 'day', archived, createdAt: '' });

describe('inRange', () => {
  const b = block('b', d(7, 9), d(7, 10));
  it('a block ending exactly at from is out; one starting exactly at to is out', () => {
    expect(inRange(b, { from: d(7, 10) })).toBe(false);
    expect(inRange(b, { to: d(7, 9) })).toBe(false);
    expect(inRange(b, { from: d(7, 9, 59), to: d(7, 9, 1) })).toBe(true); // any overlap counts, however the bounds are ordered
  });
  it('a block spanning the whole range is in; no range means everything', () => {
    expect(inRange(b, { from: d(7, 9, 20), to: d(7, 9, 40) })).toBe(true);
    expect(inRange(b)).toBe(true);
    expect(inRange(b, {})).toBe(true);
  });
  it('a block spanning midnight belongs to both days', () => {
    const n = block('n', d(7, 23), d(8, 1));
    expect(inRange(n, { from: d(7, 0), to: d(8, 0) })).toBe(true);
    expect(inRange(n, { from: d(8, 0), to: d(9, 0) })).toBe(true);
  });
});

describe('MemoryStore blocks', () => {
  it('lists by start, whatever the insertion order, and in the range', () => {
    const s = new MemoryStore();
    s.insertBlocks([block('late', d(7, 14), d(7, 15)), block('early', d(7, 9), d(7, 10)), block('yesterday', d(6, 9), d(6, 10))]);
    expect(s.listBlocks({ from: d(7, 0), to: d(8, 0) }).map((b) => b.id)).toEqual(['early', 'late']);
    expect(s.listBlocks().map((b) => b.id)).toEqual(['yesterday', 'early', 'late']);
  });
  it('insertBlocks stores a copy; an insert with the same id replaces', () => {
    const s = new MemoryStore();
    const b = block('b', d(7, 9), d(7, 10));
    s.insertBlocks([b]);
    b.status = 'done';
    expect(s.getBlock('b')!.status).toBe('pending');
    s.insertBlocks([block('b', d(7, 11), d(7, 12))]);
    expect(s.listBlocks().length).toBe(1);
    expect(s.getBlock('b')!.start).toBe(d(7, 11).toISOString());
  });
  it('updateBlock returns a copy, deletes note/startedAt/finishedAt set to null, keeps runningSince null, and throws for an unknown id', () => {
    const s = new MemoryStore();
    s.insertBlocks([block('b', d(7, 9), d(7, 10), { note: 'hi', startedAt: d(7, 9).toISOString(), finishedAt: d(7, 9, 30).toISOString(), runningSince: d(7, 9).toISOString() })]);
    const r = s.updateBlock('b', { note: null, startedAt: null, finishedAt: null, runningSince: null });
    expect('note' in r).toBe(false);
    expect('startedAt' in r).toBe(false);
    expect('finishedAt' in r).toBe(false);
    expect(r.runningSince).toBeNull();
    r.status = 'done';
    expect(s.getBlock('b')!.status).toBe('pending');
    expect(() => s.updateBlock('nope', { status: 'done' })).toThrow('Block not found: nope');
  });
  it('deleteBlocks ignores unknown ids and an empty list', () => {
    const s = new MemoryStore();
    s.insertBlocks([block('b', d(7, 9), d(7, 10))]);
    s.deleteBlocks(['nope']);
    s.deleteBlocks([]);
    expect(s.listBlocks().length).toBe(1);
  });
});

describe('MemoryStore tasks', () => {
  it('sorts by priority then name; archived tasks only on request; archiving an unknown id is a no-op', () => {
    const s = new MemoryStore();
    s.upsertTask(task('b', 2, 'Beta'));
    s.upsertTask(task('a', 2, 'Alpha'));
    s.upsertTask(task('z', 1, 'Zed'));
    s.upsertTask(task('x', 1, 'Gone', true));
    expect(s.listTasks().map((t) => t.id)).toEqual(['z', 'a', 'b']);
    expect(s.listTasks(true).map((t) => t.id)).toEqual(['x', 'z', 'a', 'b']);
    s.archiveTask('nope');
    s.archiveTask('z');
    expect(s.listTasks().map((t) => t.id)).toEqual(['a', 'b']);
    expect(s.getTask('z')!.archived).toBe(true);
  });
  it('upsertTask stores and returns copies', () => {
    const s = new MemoryStore();
    const t = task('a', 1);
    const back = s.upsertTask(t);
    t.name = 'changed'; back.name = 'changed too';
    expect(s.getTask('a')!.name).toBe('a');
  });
});

describe('MemoryStore baseline versions', () => {
  it('the version is always the last plus one, whatever version the caller wrote', () => {
    const s = new MemoryStore();
    s.setBaseline({ version: 7, slots: [] });
    s.setBaseline({ version: 1, slots: [] });
    expect(s.listBaselines().map((b) => b.version)).toEqual([1, 2]);
  });
  it('a given savedAt is kept, an empty one stamped; an empty slot list is a valid (empty) baseline', () => {
    const s = new MemoryStore();
    s.setBaseline({ slots: [], savedAt: '2026-10-01T00:00:00.000Z' });
    expect(s.getBaseline()).toEqual({ version: 1, savedAt: '2026-10-01T00:00:00.000Z', slots: [] });
  });
  it('invalid slots are dropped on save, not kept', () => {
    const s = new MemoryStore();
    s.setBaseline({ slots: [{ day: 1, start: '10:00', end: '09:00', kind: 'task', taskId: 'a' }, { day: 1, start: '09:00', end: '10:00', kind: 'task', taskId: 'a' }] });
    expect(s.getBaseline()!.slots).toEqual([{ day: 1, start: '09:00', end: '10:00', kind: 'task', taskId: 'a' }]);
  });
  it('refuses what is not a baseline', () => {
    const s = new MemoryStore();
    expect(() => s.setBaseline(null as any)).toThrow('Not a baseline: expected { slots: [...] }.');
    expect(() => s.setBaseline({ version: 1 } as any)).toThrow(/Not a baseline/);
    expect(s.listBaselines()).toEqual([]);
  });
  it('listBaselines returns copies, oldest first', () => {
    const s = new MemoryStore();
    s.setBaseline({ slots: [{ day: 1, start: '09:00', end: '10:00', kind: 'task', taskId: 'a' }] });
    s.setBaseline({ slots: [] });
    const list = s.listBaselines();
    list[0].slots.length = 0;
    expect(s.listBaselines()[0].slots.length).toBe(1);
    expect(s.listBaselines().map((b) => b.version)).toEqual([1, 2]);
  });
});

describe('MemoryStore settings, commitments, recurring, imports', () => {
  it('settings are copied in and out, the day lists included', () => {
    const s = new MemoryStore();
    const settings = { ...DEFAULT_SETTINGS, availability: [{ days: [1, 2], start: '09:00', end: '10:00' }] };
    s.saveSettings(settings);
    settings.availability[0].days.push(3);
    expect(s.getSettings().availability[0].days).toEqual([1, 2]);
    s.getSettings().availability[0].days.push(4);
    expect(s.getSettings().availability[0].days).toEqual([1, 2]);
  });
  it('commitments list by start inside the range; a deleted one is gone', () => {
    const s = new MemoryStore();
    s.addCommitment({ id: 'b', title: 'B', start: d(7, 14).toISOString(), end: d(7, 15).toISOString() });
    s.addCommitment({ id: 'a', title: 'A', start: d(7, 9).toISOString(), end: d(7, 10).toISOString() });
    expect(s.listCommitments().map((c) => c.id)).toEqual(['a', 'b']);
    expect(s.listCommitments({ from: d(7, 10) }).map((c) => c.id)).toEqual(['b']);
    s.deleteCommitment('a');
    s.deleteCommitment('nope');
    expect(s.listCommitments().map((c) => c.id)).toEqual(['b']);
  });
  it('recurring commitments sort by start then title, and their day lists are copies', () => {
    const s = new MemoryStore();
    const days = [1];
    s.addRecurring({ id: 'y', title: 'Yoga', days, start: '09:00', end: '10:00' });
    s.addRecurring({ id: 'g', title: 'Gym', days: [2], start: '09:00', end: '10:00' });
    s.addRecurring({ id: 'e', title: 'Early', days: [3], start: '07:00', end: '08:00' });
    days.push(5);
    expect(s.listRecurring().map((r) => [r.id, r.days])).toEqual([['e', [3]], ['g', [2]], ['y', [1]]]);
  });
  it('import records are deep copies and sources are listed', () => {
    const s = new MemoryStore();
    const rec = { ids: ['1'], events: [{ title: 'x', start: 'a', end: 'b' }], importedAt: 'now' };
    s.setImportRecord('file:a.ics', rec);
    rec.ids.push('2');
    expect(s.getImportRecord('file:a.ics')!.ids).toEqual(['1']);
    s.getImportRecord('file:a.ics')!.events.length = 0;
    expect(s.getImportRecord('file:a.ics')!.events.length).toBe(1);
    expect(s.getImportRecord('nope')).toBeUndefined();
    expect(s.listImportSources()).toEqual(['file:a.ics']);
  });
  it('exportAll includes archived tasks and every block', () => {
    const s = new MemoryStore();
    s.upsertTask(task('x', 1, 'Gone', true));
    s.insertBlocks([block('b', d(7, 9), d(7, 10))]);
    const e = s.exportAll();
    expect(e.tasks.map((t) => t.id)).toEqual(['x']);
    expect(e.blocks.length).toBe(1);
    expect(e.settings).toEqual(DEFAULT_SETTINGS);
    expect(Number.isNaN(new Date(e.exportedAt).getTime())).toBe(false);
  });
});
