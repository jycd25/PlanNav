import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { MemoryStore } from '../src/store.js';
import { importAsBaseline } from '../src/importBaseline.js';
import { DEFAULT_SETTINGS, TASK_COLORS, type Task } from '../src/types.js';

const NOW = new Date(2026, 9, 9, 12); // Fri 9 Oct 2026
const FIXTURE = readFileSync(new URL('../../bench/dialogues/routine.ics', import.meta.url), 'utf8');

/** An ICS of local-time events: [yyyy-mm-dd, HH:MM, HH:MM, title]. */
function ics(events: Array<[string, string, string, string]>): string {
  const t = (date: string, hhmm: string) => `${date.replace(/-/g, '')}T${hhmm.replace(':', '')}00`;
  const body = events.map(([date, s, e, title], i) => ['BEGIN:VEVENT', `UID:e${i}`, `DTSTART:${t(date, s)}`, `DTEND:${t(date, e)}`, `SUMMARY:${title}`, 'END:VEVENT'].join('\r\n'));
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...body, 'END:VCALENDAR'].join('\r\n');
}
/** The same (day, start, end, title) on each Monday-week given, Monday = weekday 1. */
const weekly = (mondays: string[], shape: Array<[dayOffset: number, string, string, string]>): Array<[string, string, string, string]> =>
  mondays.flatMap((mon) => shape.map(([off, s, e, title]) => {
    const d = new Date(`${mon}T00:00:00`); d.setDate(d.getDate() + off);
    return [`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, s, e, title] as [string, string, string, string];
  }));

let store: MemoryStore;
beforeEach(() => { store = new MemoryStore(); store.saveSettings({ ...DEFAULT_SETTINGS }); });

describe('importAsBaseline', () => {
  it('turns the user\'s routine week into a baseline verbatim: 25 events, 5 tasks, 25 slots, no one-offs', () => {
    const r = importAsBaseline(store, FIXTURE, NOW);
    expect(r.weeksSeen).toBe(1);
    expect(r.oneOffs).toEqual([]);
    expect(r.tasks.created.map((t) => t.name)).toEqual(['Morning study', 'LeetCode grinding', 'ML grinding', 'Software — system design & engineering', 'Working — startup build']);
    expect(r.tasks.matched).toEqual([]);
    expect(r.tasks.revived).toEqual([]);
    expect(r.baseline.version).toBe(1);
    expect(r.baseline.slots.length).toBe(25);
    expect(r.baseline.slots.every((s) => s.kind === 'task')).toBe(true);
    const monday = r.baseline.slots.filter((s) => s.day === 1).map((s) => [s.start, s.end, store.getTask(s.taskId!)!.name]);
    expect(monday).toEqual([
      ['07:00', '09:00', 'Morning study'], ['09:00', '11:00', 'LeetCode grinding'], ['13:00', '15:00', 'ML grinding'],
      ['15:00', '17:00', 'Software — system design & engineering'], ['19:00', '21:00', 'Working — startup build'],
    ]);
    expect([...new Set(r.baseline.slots.map((s) => s.day))]).toEqual([1, 2, 3, 4, 5]);
    expect(store.getBaseline()).toEqual(r.baseline);
  });

  it('a new task gets priority by first appearance, a palette colour, a weekly budget of its slot sum, the modal slot length as its session, and no segment', () => {
    const r = importAsBaseline(store, FIXTURE, NOW);
    const t = r.tasks.created;
    expect(t.map((x) => x.priority)).toEqual([1, 2, 3, 4, 5]);
    expect(t.map((x) => x.color)).toEqual(TASK_COLORS.slice(0, 5));
    for (const x of t) expect(x).toMatchObject({ budgetPeriod: 'week', budgetMinutes: 600, sessionMinutes: 120, preferredSegment: 'any', archived: false, createdAt: NOW.toISOString() });
    expect(store.listTasks().map((x) => x.name)).toEqual(t.map((x) => x.name));
  });

  it('priorities and colours continue after the active tasks; archived ones are not counted', () => {
    store.upsertTask({ id: 'x', name: 'Existing', color: '#000', priority: 1, budgetMinutes: 60, budgetPeriod: 'day', archived: false, createdAt: '' });
    store.upsertTask({ id: 'gone', name: 'Gone', color: '#000', priority: 2, budgetMinutes: 60, budgetPeriod: 'day', archived: true, createdAt: '' });
    const r = importAsBaseline(store, ics([['2026-10-05', '09:00', '10:00', 'New thing']]), NOW);
    expect(r.tasks.created[0]).toMatchObject({ name: 'New thing', priority: 2, color: TASK_COLORS[1] });
  });

  it('a (day, time, title) seen in fewer than half of the weeks is a one-off, not a slot', () => {
    const mondays = ['2026-09-14', '2026-09-21', '2026-09-28'];
    const text = ics([...weekly(mondays, [[0, '09:00', '10:00', 'Leetcode'], [2, '14:00', '15:00', 'Reading']]), ['2026-09-23', '16:00', '17:00', 'Dentist']]);
    const r = importAsBaseline(store, text, NOW);
    expect(r.weeksSeen).toBe(3);
    expect(r.oneOffs).toEqual([{ title: 'Dentist', start: new Date(2026, 8, 23, 16).toISOString(), end: new Date(2026, 8, 23, 17).toISOString() }]);
    expect(r.baseline.slots.map((s) => [s.day, s.start, s.end, store.getTask(s.taskId!)!.name])).toEqual([[1, '09:00', '10:00', 'Leetcode'], [3, '14:00', '15:00', 'Reading']]);
    expect(r.tasks.created.map((t) => t.name)).toEqual(['Leetcode', 'Reading']); // no task for a one-off title
    expect(r.tasks.created.map((t) => t.budgetMinutes)).toEqual([60, 60]); // the slot sum, not the sum over the weeks
  });

  it('seen in exactly half of the weeks is still a slot', () => {
    const text = ics([...weekly(['2026-09-21', '2026-09-28'], [[0, '09:00', '10:00', 'Leetcode']]), ['2026-09-30', '14:00', '15:00', 'Reading']]);
    const r = importAsBaseline(store, text, NOW);
    expect(r.weeksSeen).toBe(2);
    expect(r.oneOffs).toEqual([]);
    expect(r.baseline.slots.length).toBe(2);
  });

  it('a second import of the same file creates no task and the same slots; the version increments', () => {
    const first = importAsBaseline(store, FIXTURE, NOW);
    const again = importAsBaseline(store, FIXTURE, NOW);
    expect(again.tasks.created).toEqual([]);
    expect(again.tasks.matched.map((t) => t.id).sort()).toEqual(first.tasks.created.map((t) => t.id).sort());
    expect(again.baseline.version).toBe(2);
    expect(again.baseline.slots).toEqual(first.baseline.slots);
    expect(store.listTasks(true).length).toBe(5);
    expect(store.listBaselines().map((b) => b.version)).toEqual([1, 2]);
  });

  it('matches an existing task by name, case-insensitively with spaces collapsed; its budget, period and session are refreshed from its slots, the rest kept', () => {
    const lc: Task = { id: 'lc', name: 'leetcode   GRINDING', color: '#123456', priority: 7, budgetMinutes: 90, budgetPeriod: 'day', sessionMinutes: 45, preferredSegment: 'morning', archived: false, createdAt: '' };
    store.upsertTask(lc);
    const r = importAsBaseline(store, FIXTURE, NOW);
    const refreshed = { ...lc, budgetMinutes: 600, budgetPeriod: 'week' as const, sessionMinutes: 120 }; // five 2-hour slots
    expect(r.tasks.matched).toEqual([refreshed]);
    expect(r.tasks.created.map((t) => t.name)).toEqual(['Morning study', 'ML grinding', 'Software — system design & engineering', 'Working — startup build']);
    expect(store.getTask('lc')).toEqual(refreshed);
    expect(r.baseline.slots.filter((s) => s.taskId === 'lc').length).toBe(5);
  });

  it('revives an archived task of that name instead of making a second one', () => {
    store.upsertTask({ id: 'old', name: 'ML grinding', color: '#000', priority: 3, budgetMinutes: 60, budgetPeriod: 'day', archived: true, createdAt: '' });
    const r = importAsBaseline(store, FIXTURE, NOW);
    expect(r.tasks.revived.map((t) => t.id)).toEqual(['old']);
    expect(store.getTask('old')!.archived).toBe(false);
    expect(store.listTasks(true).filter((t) => t.name.toLowerCase() === 'ml grinding').length).toBe(1);
    expect(r.baseline.slots.filter((s) => s.taskId === 'old').length).toBe(5);
    expect(store.getTask('old')).toMatchObject({ budgetMinutes: 600, budgetPeriod: 'week', sessionMinutes: 120 }); // was 60 a day: refreshed from its five 2-hour slots
  });

  it('an event that runs past midnight becomes a slot ending at 24:00', () => {
    const text = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:n', 'DTSTART:20261002T220000', 'DTEND:20261003T010000', 'SUMMARY:Night build', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const r = importAsBaseline(store, text, NOW);
    expect(r.baseline.slots).toEqual([{ day: 5, start: '22:00', end: '24:00', kind: 'task', taskId: r.tasks.created[0].id }]);
    expect(r.tasks.created[0]).toMatchObject({ budgetMinutes: 120, sessionMinutes: 120 });
  });

  it('looks back 60 days and not ahead: older events and events after now are left out', () => {
    const text = ics([['2026-07-06', '09:00', '10:00', 'Old'], ['2026-10-05', '09:00', '10:00', 'Recent'], ['2026-10-12', '09:00', '10:00', 'Future']]);
    const r = importAsBaseline(store, text, NOW);
    expect(r.tasks.created.map((t) => t.name)).toEqual(['Recent']);
    expect(r.baseline.slots.length).toBe(1);
  });

  it('refuses when no event repeats in at least half of the weeks seen, naming the weeks and suggesting a one-week export', () => {
    // Four stray appointments in Aug and Sep, then a Mon-Fri routine only in the last two weeks: 2 of 6 weeks.
    const strays: Array<[string, string, string, string]> = ['2026-08-18', '2026-08-25', '2026-09-01', '2026-09-08'].map((date) => [date, '15:00', '16:00', `Dentist ${date}`]);
    const routine = weekly(['2026-09-28', '2026-10-05'], [0, 1, 2, 3, 4].map((off) => [off, '09:00', '10:00', 'Deep'] as [number, string, string, string]));
    expect(() => importAsBaseline(store, ics([...strays, ...routine]), NOW)).toThrow('No routine to import: nothing in the last 60 days repeats in at least half of the 6 weeks seen (the weeks of Aug 16 to Oct 4). Export one typical week from your calendar and import that as your baseline.');
    expect(store.getBaseline()).toBeUndefined();
    expect(store.listBaselines()).toEqual([]);
    expect(store.listTasks(true)).toEqual([]);
  });

  it('refuses a calendar with nothing in the last 60 days instead of saving an empty baseline', () => {
    expect(() => importAsBaseline(store, ics([['2026-07-06', '09:00', '10:00', 'Old']]), NOW)).toThrow(/no events in the last 60 days/i);
    expect(store.getBaseline()).toBeUndefined();
    expect(store.listTasks(true)).toEqual([]);
  });
});
