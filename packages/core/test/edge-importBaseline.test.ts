import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/store.js';
import { baselineFromEvents, canonicalName, importAsBaseline } from '../src/importBaseline.js';
import { DEFAULT_SETTINGS, type Task } from '../src/types.js';

const NOW = new Date(2026, 9, 9, 12); // Fri 9 Oct 2026 12:00; the lookback starts Mon 10 Aug 12:00

/** An ICS of local-time events: [yyyy-mm-dd, HH:MM, HH:MM, title]. */
function ics(events: Array<[string, string, string, string]>): string {
  const t = (date: string, hhmm: string) => `${date.replace(/-/g, '')}T${hhmm.replace(':', '')}00`;
  const body = events.map(([date, s, e, title], i) => ['BEGIN:VEVENT', `UID:e${i}`, `DTSTART:${t(date, s)}`, `DTEND:${t(date, e)}`, `SUMMARY:${title}`, 'END:VEVENT'].join('\r\n'));
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...body, 'END:VCALENDAR'].join('\r\n');
}
/** The same (day, start, end, title) on each Monday-week given, Monday = offset 0. */
const weekly = (mondays: string[], shape: Array<[dayOffset: number, string, string, string]>): Array<[string, string, string, string]> =>
  mondays.flatMap((mon) => shape.map(([off, s, e, title]) => {
    const d = new Date(`${mon}T00:00:00`); d.setDate(d.getDate() + off);
    return [`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, s, e, title] as [string, string, string, string];
  }));
const slotsOf = (store: MemoryStore, r: { baseline: { slots: Array<{ day: number; start: string; end: string; taskId?: string }> } }) =>
  r.baseline.slots.map((s) => [s.day, s.start, s.end, store.getTask(s.taskId!)!.name]);

let store: MemoryStore;
beforeEach(() => { store = new MemoryStore(); store.saveSettings({ ...DEFAULT_SETTINGS }); });

describe('importAsBaseline: how many weeks, how often', () => {
  it('one week: every event is a slot, even an obvious one-off', () => {
    const r = importAsBaseline(store, ics([['2026-09-28', '09:00', '10:00', 'Leetcode'], ['2026-09-30', '16:00', '17:00', 'Dentist']]), NOW);
    expect(r.weeksSeen).toBe(1);
    expect(r.oneOffs).toEqual([]);
    expect(slotsOf(store, r)).toEqual([[1, '09:00', '10:00', 'Leetcode'], [3, '16:00', '17:00', 'Dentist']]);
    expect(r.tasks.created.map((t) => t.name)).toEqual(['Leetcode', 'Dentist']);
  });
  it('two of four weeks is a slot; one of four is a one-off', () => {
    const mondays = ['2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05'];
    const text = ics([...weekly(mondays, [[0, '09:00', '10:00', 'Deep']]), ['2026-09-15', '14:00', '15:00', 'Half'], ['2026-09-29', '14:00', '15:00', 'Half'], ['2026-09-16', '11:00', '12:00', 'Once']]);
    const r = importAsBaseline(store, text, NOW);
    expect(r.weeksSeen).toBe(4);
    expect(slotsOf(store, r)).toEqual([[1, '09:00', '10:00', 'Deep'], [2, '14:00', '15:00', 'Half']]);
    expect(r.oneOffs).toEqual([{ title: 'Once', start: new Date(2026, 8, 16, 11).toISOString(), end: new Date(2026, 8, 16, 12).toISOString() }]);
    expect(r.tasks.created.map((t) => t.name)).toEqual(['Deep', 'Half']);
  });
  it('weeks with no events do not count: three weeks spread over seven', () => {
    const text = ics([...weekly(['2026-09-07', '2026-09-21', '2026-10-05'], [[0, '09:00', '10:00', 'Deep']]), ['2026-09-08', '14:00', '15:00', 'Solo']]);
    const r = importAsBaseline(store, text, NOW);
    expect(r.weeksSeen).toBe(3);
    expect(slotsOf(store, r)).toEqual([[1, '09:00', '10:00', 'Deep']]);
    expect(r.oneOffs.map((e) => e.title)).toEqual(['Solo']);
  });
  it('weekend events land on days 0 and 6, and the week start setting decides which week a Sunday belongs to', () => {
    const text = ics([['2026-09-27', '09:00', '10:00', 'Gym'], ['2026-10-03', '09:00', '10:00', 'Run']]);
    const sundayWeeks = importAsBaseline(store, text, NOW);
    expect(sundayWeeks.weeksSeen).toBe(1);
    expect(slotsOf(store, sundayWeeks)).toEqual([[0, '09:00', '10:00', 'Gym'], [6, '09:00', '10:00', 'Run']]);
    store = new MemoryStore();
    store.saveSettings({ ...DEFAULT_SETTINGS, weekStartsOn: 1 });
    const mondayWeeks = importAsBaseline(store, text, NOW);
    expect(mondayWeeks.weeksSeen).toBe(2);
    expect(mondayWeeks.baseline.slots).toHaveLength(2);
  });
  it('refuses when three weeks each hold a different title, naming the weeks', () => {
    const text = ics([['2026-09-14', '09:00', '10:00', 'A'], ['2026-09-21', '09:00', '10:00', 'B'], ['2026-09-28', '09:00', '10:00', 'C']]);
    expect(() => importAsBaseline(store, text, NOW)).toThrow('No routine to import: nothing in the last 60 days repeats in at least half of the 3 weeks seen (the weeks of Sep 13 to Sep 27). Export one typical week from your calendar and import that as your baseline.');
    expect(store.getBaseline()).toBeUndefined();
    expect(store.listTasks(true)).toEqual([]);
    expect(store.listBaselines()).toEqual([]);
  });
  it('an event after now is left out; one earlier today is in', () => {
    const r = importAsBaseline(store, ics([['2026-10-09', '09:00', '10:00', 'Today'], ['2026-10-09', '13:00', '14:00', 'Later today'], ['2026-10-12', '09:00', '10:00', 'Future']]), NOW);
    expect(slotsOf(store, r)).toEqual([[5, '09:00', '10:00', 'Today']]);
    expect(r.tasks.created.map((t) => t.name)).toEqual(['Today']);
  });
});

describe('importAsBaseline: titles, lengths, overlaps, midnight', () => {
  it('one title at two lengths is two slots of one task: budget is the sum, session the longer of a tie', () => {
    const r = importAsBaseline(store, ics([['2026-09-28', '09:00', '10:00', 'Reading'], ['2026-09-30', '14:00', '16:00', 'Reading']]), NOW);
    expect(r.tasks.created).toHaveLength(1);
    expect(r.tasks.created[0]).toMatchObject({ name: 'Reading', budgetMinutes: 180, sessionMinutes: 120, budgetPeriod: 'week' });
    expect(slotsOf(store, r)).toEqual([[1, '09:00', '10:00', 'Reading'], [3, '14:00', '16:00', 'Reading']]);
  });
  it('titles differing in case or inner spaces are one task, named as first seen', () => {
    const r = importAsBaseline(store, ics([['2026-09-28', '09:00', '10:00', 'LeetCode  Daily'], ['2026-09-29', '09:00', '10:00', 'leetcode daily'], ['2026-09-30', '09:00', '10:00', 'LEETCODE DAILY']]), NOW);
    expect(r.tasks.created.map((t) => t.name)).toEqual(['LeetCode Daily']);
    expect(new Set(r.baseline.slots.map((s) => s.taskId)).size).toBe(1);
    expect(r.baseline.slots).toHaveLength(3);
    expect(canonicalName('  LeetCode   Daily ')).toBe('leetcode daily');
  });
  it('two titles at the same time are two overlapping slots; identical duplicates collapse into one slot and one week', () => {
    const r = importAsBaseline(store, ics([['2026-09-28', '09:00', '10:00', 'A'], ['2026-09-28', '09:00', '10:00', 'B'], ['2026-09-29', '09:00', '10:00', 'Dup'], ['2026-09-29', '09:00', '10:00', 'Dup']]), NOW);
    expect(slotsOf(store, r)).toEqual([[1, '09:00', '10:00', 'A'], [1, '09:00', '10:00', 'B'], [2, '09:00', '10:00', 'Dup']]);
    expect(r.weeksSeen).toBe(1);
    expect(r.tasks.created.find((t) => t.name === 'Dup')!.budgetMinutes).toBe(60);
  });
  it('a long title is cut to 200 characters for the task; a blank one is "Untitled"', () => {
    const long = 'L'.repeat(250);
    const r = importAsBaseline(store, ics([['2026-09-28', '09:00', '10:00', long], ['2026-09-29', '09:00', '10:00', '   ']]), NOW);
    expect(r.tasks.created.map((t) => t.name)).toEqual(['L'.repeat(200), 'Untitled']);
  });
  it('a Saturday event past midnight ends at 24:00 on Saturday; a midnight-to-midnight event is 00:00-24:00', () => {
    const text = ['BEGIN:VCALENDAR',
      'BEGIN:VEVENT', 'UID:a', 'DTSTART:20261003T220000', 'DTEND:20261004T010000', 'SUMMARY:Late', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:b', 'DTSTART:20261001T000000', 'DTEND:20261002T000000', 'SUMMARY:Whole day', 'END:VEVENT',
      'END:VCALENDAR'].join('\r\n');
    const r = importAsBaseline(store, text, NOW);
    expect(slotsOf(store, r)).toEqual([[4, '00:00', '24:00', 'Whole day'], [6, '22:00', '24:00', 'Late']]);
    expect(r.tasks.created.map((t) => [t.name, t.budgetMinutes, t.sessionMinutes])).toEqual([['Whole day', 1440, 1440], ['Late', 120, 120]]);
  });
  it('a repeating rule in the file is expanded into the weeks it covers', () => {
    const text = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:r', 'DTSTART:20260914T090000', 'DTEND:20260914T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'SUMMARY:Standup', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const r = importAsBaseline(store, text, NOW);
    expect(r.weeksSeen).toBe(4);
    expect(slotsOf(store, r)).toEqual([[1, '09:00', '10:00', 'Standup'], [3, '09:00', '10:00', 'Standup']]);
    expect(r.tasks.created[0]).toMatchObject({ budgetMinutes: 120, sessionMinutes: 60 });
  });
  it('an active task of the name is matched before an archived one, and refreshed from its slots', () => {
    const live: Task = { id: 'live', name: 'reading', color: '#111111', priority: 4, budgetMinutes: 30, budgetPeriod: 'day', archived: false, createdAt: '' };
    store.upsertTask(live);
    store.upsertTask({ ...live, id: 'old', archived: true });
    const r = importAsBaseline(store, ics([['2026-09-28', '09:00', '10:30', 'Reading']]), NOW);
    expect(r.tasks.matched.map((t) => t.id)).toEqual(['live']);
    expect(r.tasks.revived).toEqual([]);
    expect(r.tasks.created).toEqual([]);
    expect(store.getTask('live')).toEqual({ ...live, budgetMinutes: 90, budgetPeriod: 'week', sessionMinutes: 90 });
    expect(store.getTask('old')!.archived).toBe(true);
  });
});

describe('baselineFromEvents on raw events', () => {
  const iso = (m: number, d: number, h: number, mi = 0) => new Date(2026, m - 1, d, h, mi).toISOString();
  it('drops events with junk dates or a non-positive length; refuses when nothing is left', () => {
    const junk = [{ title: 'Bad', start: 'nope', end: iso(9, 28, 10) }, { title: 'Zero', start: iso(9, 28, 9), end: iso(9, 28, 9) }, { title: 'Backwards', start: iso(9, 28, 10), end: iso(9, 28, 9) }];
    expect(() => baselineFromEvents(store, junk, NOW)).toThrow('No events in the last 60 days to import as a baseline.');
    expect(() => baselineFromEvents(store, [], NOW)).toThrow('No events in the last 60 days to import as a baseline.');
    const r = baselineFromEvents(store, [...junk, { title: 'Good', start: iso(9, 28, 9), end: iso(9, 28, 10) }], NOW);
    expect(slotsOf(store, r)).toEqual([[1, '09:00', '10:00', 'Good']]);
  });
  it('the edges: starting exactly at now is in, after now is out; ending exactly at the lookback start is out, a minute later is in', () => {
    const r = baselineFromEvents(store, [
      { title: 'AtNow', start: iso(10, 9, 12), end: iso(10, 9, 13) },
      { title: 'AfterNow', start: iso(10, 9, 12, 1), end: iso(10, 9, 13) },
      { title: 'EndsAtLookback', start: iso(8, 10, 11), end: iso(8, 10, 12) },
      { title: 'JustInside', start: iso(8, 10, 11), end: iso(8, 10, 12, 1) },
    ], NOW);
    expect(r.tasks.created.map((t) => t.name)).toEqual(['JustInside', 'AtNow']);
    expect(r.weeksSeen).toBe(2);
    expect(slotsOf(store, r)).toEqual([[1, '11:00', '12:01', 'JustInside'], [5, '12:00', '13:00', 'AtNow']]);
  });
  it('one-offs come back sorted by start as ISO strings, whatever order they were given in', () => {
    const routine = ['2026-09-14', '2026-09-21', '2026-09-28'].map((date) => ({ title: 'Deep', start: new Date(`${date}T09:00:00`).toISOString(), end: new Date(`${date}T10:00:00`).toISOString() }));
    const later = { title: 'Later', start: iso(9, 23, 16), end: iso(9, 23, 17) };
    const earlier = { title: 'Earlier', start: iso(9, 16, 16), end: iso(9, 16, 17) };
    const r = baselineFromEvents(store, [later, ...routine, earlier], NOW);
    expect(r.oneOffs).toEqual([earlier, later]);
  });
  it('trims and collapses the title before grouping and naming the task', () => {
    const r = baselineFromEvents(store, [{ title: '  Morning   study ', start: iso(9, 28, 7), end: iso(9, 28, 9) }, { title: 'morning study', start: iso(10, 5, 7), end: iso(10, 5, 9) }], NOW);
    expect(r.tasks.created.map((t) => t.name)).toEqual(['Morning study']);
    expect(r.baseline.slots).toHaveLength(1);
    expect(r.weeksSeen).toBe(2);
  });
});
