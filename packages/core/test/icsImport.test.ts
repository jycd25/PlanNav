import { describe, it, expect } from 'vitest';
import { importIcs, parseIcs } from '../src/icsImport.js';
import { toIcs } from '../src/ics.js';
import { MemoryStore } from '../src/store.js';

const now = new Date(2026, 9, 8, 9); // Thu Oct 8 2026
const crlf = (lines: string[]) => lines.join('\r\n') + '\r\n';
const local = (y: number, m: number, d: number, h: number, mi = 0) => new Date(y, m - 1, d, h, mi).toISOString();
const ev = (lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];

describe('parseIcs: one-off events', () => {
  it('imports future events within the horizon, unescaped and unfolded, from UTC, TZID, and DURATION forms', () => {
    const ics = crlf(['BEGIN:VCALENDAR', 'X-WR-CALNAME:Home',
      ...ev(['UID:one', 'DTSTART:20261009T160000Z', 'DTEND:20261009T170000Z', 'SUMMARY:Dentist\\, downtown']),
      ...ev(['UID:two', 'DTSTART;TZID=America/Los_Angeles:20261010T130000', 'DURATION:PT1H30M', 'SUMMARY:Lunch with a very long title that needs folding across several lines because it ex', ' ceeds the limit']),
      ...ev(['UID:old', 'DTSTART:20260101T100000Z', 'DTEND:20260101T110000Z', 'SUMMARY:Past']),
      ...ev(['UID:far', 'DTSTART:20270301T100000Z', 'DTEND:20270301T110000Z', 'SUMMARY:Far']),
      ...ev(['UID:cancelled', 'DTSTART:20261009T180000Z', 'DTEND:20261009T190000Z', 'STATUS:CANCELLED', 'SUMMARY:Nope']),
      ...ev(['UID:allday', 'DTSTART;VALUE=DATE:20261010', 'DTEND;VALUE=DATE:20261011', 'SUMMARY:Holiday']),
      ...ev(['UID:nodate', 'SUMMARY:Broken']),
      ...ev(['UID:backwards', 'DTSTART:20261009T170000Z', 'DTEND:20261009T160000Z', 'SUMMARY:Backwards']),
      'END:VCALENDAR']);
    const r = parseIcs(ics, { now });
    expect(r.commitments.map((c) => [c.id, c.title, c.start, c.end])).toEqual([
      ['ics:one', 'Dentist, downtown', '2026-10-09T16:00:00.000Z', '2026-10-09T17:00:00.000Z'],
      ['ics:two', 'Lunch with a very long title that needs folding across several lines because it exceeds the limit', local(2026, 10, 10, 13), local(2026, 10, 10, 14, 30)],
    ]);
    expect(r.skipped).toBe(6);
    expect(r.cancelled).toEqual(['ics:cancelled']);
    expect(r.calendarName).toBe('Home');
    expect(r.notes.join('\n')).toMatch(/all-day/i);
  });

  it('ignores nested VALARM properties and unescapes semicolons', () => {
    const ics = crlf([...ev(['UID:a', 'DTSTART:20261009T160000Z', 'DTEND:20261009T170000Z', 'SUMMARY:Real\; title', 'BEGIN:VALARM', 'ACTION:EMAIL', 'SUMMARY:Alarm notification', 'END:VALARM'])]);
    expect(parseIcs(ics, { now }).commitments[0].title).toBe('Real; title');
  });

  it('never throws on garbage', () => {
    expect(parseIcs('', { now }).commitments).toEqual([]);
    expect(parseIcs('hello\nworld', { now }).commitments).toEqual([]);
    expect(parseIcs('BEGIN:VEVENT\nDTSTART:notadate\nEND:VEVENT', { now }).skipped).toBe(1);
    expect(parseIcs(crlf(ev(['UID:x', 'DTSTART:20261009T160000Z', 'DTEND:20261009T170000Z', 'RRULE:FREQ=BOGUS', 'SUMMARY:?'])), { now }).skipped).toBe(1);
  });
});

describe('parseIcs: repeating events become concrete commitments within the horizon', () => {
  it('expands weekly rules with BYDAY, honouring EXDATE and COUNT', () => {
    const ics = crlf([
      ...ev(['UID:standup', 'DTSTART;TZID=America/Los_Angeles:20260105T100000', 'DTEND;TZID=America/Los_Angeles:20260105T101500', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'EXDATE;TZID=America/Los_Angeles:20261012T100000', 'SUMMARY:Standup']),
      ...ev(['UID:short', 'DTSTART:20261008T200000Z', 'DTEND:20261008T210000Z', 'RRULE:FREQ=WEEKLY;COUNT=2', 'SUMMARY:Two only']),
      ...ev(['UID:ended', 'DTSTART:20250106T100000Z', 'DTEND:20250106T110000Z', 'RRULE:FREQ=WEEKLY;UNTIL=20250301', 'SUMMARY:Ended']),
    ]);
    const r = parseIcs(ics, { now, horizonDays: 14 });
    const standups = r.commitments.filter((c) => c.title === 'Standup').map((c) => c.start);
    expect(standups).toEqual([local(2026, 10, 14, 10), local(2026, 10, 19, 10), local(2026, 10, 21, 10)]); // Mon Oct 12 excluded by EXDATE
    expect(r.commitments.filter((c) => c.title === 'Two only').map((c) => c.start)).toEqual(['2026-10-08T20:00:00.000Z', '2026-10-15T20:00:00.000Z']);
    expect(r.commitments.some((c) => c.title === 'Ended')).toBe(false);
    expect(r.commitments.find((c) => c.title === 'Standup')!.id).toBe('ics:standup#20261014T100000');
  });

  it('expands biweekly, daily, monthly and yearly rules', () => {
    const ics = crlf([
      ...ev(['UID:dinner', 'DTSTART;TZID=America/Los_Angeles:20260106T180000', 'DTEND;TZID=America/Los_Angeles:20260106T190000', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', 'SUMMARY:Team dinner']),
      ...ev(['UID:daily', 'DTSTART:20261001T070000Z', 'DTEND:20261001T073000Z', 'RRULE:FREQ=DAILY;INTERVAL=3', 'SUMMARY:Run']),
      ...ev(['UID:rent', 'DTSTART;TZID=America/Los_Angeles:20260115T090000', 'DTEND;TZID=America/Los_Angeles:20260115T093000', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=15', 'SUMMARY:Rent']),
      ...ev(['UID:bday', 'DTSTART;TZID=America/Los_Angeles:20201020T120000', 'DTEND;TZID=America/Los_Angeles:20201020T130000', 'RRULE:FREQ=YEARLY', 'SUMMARY:Birthday lunch']),
    ]);
    const r = parseIcs(ics, { now, horizonDays: 30 });
    const starts = (t: string) => r.commitments.filter((c) => c.title === t).map((c) => c.start);
    expect(starts('Team dinner')).toEqual([local(2026, 10, 13, 18), local(2026, 10, 27, 18)]); // Jan 6 2026 + n*14 days: Oct 13, Oct 27
    expect(starts('Run')).toEqual(['2026-10-10T07:00:00.000Z', '2026-10-13T07:00:00.000Z', '2026-10-16T07:00:00.000Z', '2026-10-19T07:00:00.000Z', '2026-10-22T07:00:00.000Z', '2026-10-25T07:00:00.000Z', '2026-10-28T07:00:00.000Z', '2026-10-31T07:00:00.000Z', '2026-11-03T07:00:00.000Z', '2026-11-06T07:00:00.000Z']);
    expect(starts('Rent')).toEqual([local(2026, 10, 15, 9)]);
    expect(starts('Birthday lunch')).toEqual([local(2026, 10, 20, 12)]);
  });

  it('replaces an occurrence with its RECURRENCE-ID override', () => {
    const ics = crlf([
      ...ev(['UID:s', 'DTSTART:20260105T100000Z', 'DTEND:20260105T110000Z', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Team sync']),
      ...ev(['UID:s', 'RECURRENCE-ID:20261012T100000Z', 'DTSTART:20261012T140000Z', 'DTEND:20261012T150000Z', 'SUMMARY:Team sync (moved)']),
    ]);
    const r = parseIcs(ics, { now, horizonDays: 10 });
    expect(r.commitments.map((c) => [c.title, c.start])).toEqual([
      ['Team sync (moved)', '2026-10-12T14:00:00.000Z'],
    ]);
    expect(r.commitments[0].id).toBe('ics:s#20261012T100000Z');
  });
});

describe('parseIcs: lookback', () => {
  it('also returns past events within the lookback window, for routine learning', () => {
    const ics = crlf([...ev(['UID:p', 'DTSTART:20260928T150000Z', 'DTEND:20260928T163000Z', 'SUMMARY:Morning study']),
      ...ev(['UID:w', 'DTSTART:20260901T150000Z', 'DTEND:20260901T160000Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Old weekly'])]);
    const r = parseIcs(ics, { now, lookbackDays: 30 });
    expect(r.commitments).toEqual([]);
    expect(r.events.map((e) => [e.title, e.start])).toEqual([
      ['Old weekly', '2026-09-15T15:00:00.000Z'],
      ['Morning study', '2026-09-28T15:00:00.000Z'],
    ]);
  });
});

describe('importIcs', () => {
  const keep = ev(['UID:keep', 'DTSTART:20261009T160000Z', 'DTEND:20261009T170000Z', 'SUMMARY:Keep']);
  it('stores commitments, refreshes per source, and removes cancelled or vanished events', () => {
    const s = new MemoryStore();
    const v1 = crlf(['BEGIN:VCALENDAR', ...keep, ...ev(['UID:gone', 'DTSTART:20261010T160000Z', 'DTEND:20261010T170000Z', 'SUMMARY:Gone']),
      ...ev(['UID:cancel', 'DTSTART:20261011T160000Z', 'DTEND:20261011T170000Z', 'SUMMARY:Cancel me']), 'END:VCALENDAR']);
    importIcs(s, v1, now, 'https://example.com/a.ics');
    expect(s.listCommitments().map((c) => c.id).sort()).toEqual(['ics:cancel', 'ics:gone', 'ics:keep']);
    const v2 = crlf(['BEGIN:VCALENDAR', ...keep, ...ev(['UID:cancel', 'DTSTART:20261011T160000Z', 'DTEND:20261011T170000Z', 'STATUS:CANCELLED', 'SUMMARY:Cancel me']), 'END:VCALENDAR']);
    const r = importIcs(s, v2, now, 'https://example.com/a.ics');
    expect(s.listCommitments().map((c) => c.id)).toEqual(['ics:keep']);
    expect(r.removed.sort()).toEqual(['ics:cancel', 'ics:gone']);
  });

  it('uses the calendar name as the source for file imports, so re-importing the same file refreshes', () => {
    const s = new MemoryStore();
    importIcs(s, crlf(['BEGIN:VCALENDAR', 'X-WR-CALNAME:Home', ...keep, ...ev(['UID:gone', 'DTSTART:20261010T160000Z', 'DTEND:20261010T170000Z', 'SUMMARY:Gone']), 'END:VCALENDAR']), now);
    const r = importIcs(s, crlf(['BEGIN:VCALENDAR', 'X-WR-CALNAME:Home', ...keep, 'END:VCALENDAR']), now);
    expect(r.source).toBe('file:Home');
    expect(s.listCommitments().map((c) => c.id)).toEqual(['ics:keep']);
    importIcs(s, crlf(['BEGIN:VCALENDAR', 'X-WR-CALNAME:Work', ...ev(['UID:w', 'DTSTART:20261010T160000Z', 'DTEND:20261010T170000Z', 'SUMMARY:Work thing']), 'END:VCALENDAR']), now);
    expect(s.listCommitments().map((c) => c.id).sort()).toEqual(['ics:keep', 'ics:w']);
  });

  it('keeps an import record with all events so a routine can be learned later', () => {
    const s = new MemoryStore();
    const r = importIcs(s, crlf(['BEGIN:VCALENDAR', 'X-WR-CALNAME:Routine', ...ev(['UID:p', 'DTSTART:20260928T150000Z', 'DTEND:20260928T163000Z', 'SUMMARY:Morning study']), 'END:VCALENDAR']), now);
    expect(r.commitments).toEqual([]);
    expect(r.events.length).toBe(1);
    const rec = s.getImportRecord('file:Routine')!;
    expect(rec.events.map((e) => e.title)).toEqual(['Morning study']);
    expect(rec.ids).toEqual([]);
    expect(s.listImportSources()).toEqual(['file:Routine']);
  });

  it('skips this app\'s own export', () => {
    const s = new MemoryStore();
    s.upsertTask({ id: 't', name: 'A', color: '#000', priority: 1, budgetMinutes: 60, budgetPeriod: 'day', archived: false, createdAt: '' });
    s.insertBlocks([{ id: 'b', taskId: 't', start: now.toISOString(), end: new Date(now.getTime() + 3600000).toISOString(), status: 'pending', createdAt: '', statusChangedAt: null }]);
    s.addRecurring({ id: 'r', title: 'Standup', days: [1], start: '10:00', end: '10:15' });
    const own = toIcs({ blocks: s.listBlocks(), tasks: s.listTasks(), commitments: [], recurring: s.listRecurring(), now });
    const r = parseIcs(own, { now });
    expect(r.commitments).toEqual([]);
    expect(r.notes.join('\n')).toMatch(/exported by this app/i);
    for (const old of ['@plannav', '@dynamic-scheduler']) { // exports made under the earlier names are still recognised as our own
      expect(parseIcs(`BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x${old}\nSUMMARY:Old\nDTSTART:20261012T100000Z\nDTEND:20261012T110000Z\nEND:VEVENT\nEND:VCALENDAR`, { now: new Date('2026-10-01T00:00:00Z') }).notes.join('\n')).toMatch(/exported by this app/i);
    }
  });
});
