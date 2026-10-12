import { describe, it, expect } from 'vitest';
import { importIcs, parseIcs } from '../src/icsImport.js';
import { MemoryStore } from '../src/store.js';

const now = new Date(2026, 9, 8, 9); // Thu 8 Oct 2026 09:00 local
const crlf = (lines: string[]) => lines.join('\r\n') + '\r\n';
const local = (y: number, m: number, d: number, h: number, mi = 0) => new Date(y, m - 1, d, h, mi).toISOString();
const ev = (lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const basicUtc = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

describe('parseIcs: line endings, folding, property syntax', () => {
  it('accepts LF and mixed endings, a tab continuation, and a fold inside an escape sequence', () => {
    const text = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\r\nUID:a\nDTSTART:20261009T160000Z\nDTEND:20261009T170000Z\nSUMMARY:Dent\\\n\t,ist and\n  more\nEND:VEVENT\nEND:VCALENDAR';
    const r = parseIcs(text, { now });
    expect(r.commitments).toEqual([{ id: 'ics:a', title: 'Dent,ist and more', start: '2026-10-09T16:00:00.000Z', end: '2026-10-09T17:00:00.000Z' }]);
  });
  it('property names are case-insensitive, parameter values may be quoted, seconds may be omitted', () => {
    const r = parseIcs(crlf(ev(['uid:low', 'dtstart;tzid="America/Los_Angeles":20261009T1300', 'dtend;VALUE=DATE-TIME:20261009T1400', 'summary:Lower'])), { now });
    expect(r.commitments).toEqual([{ id: 'ics:low', title: 'Lower', start: local(2026, 10, 9, 13), end: local(2026, 10, 9, 14) }]);
  });
  it('floating and TZID times are both local; Z is UTC', () => {
    const r = parseIcs(crlf([
      ...ev(['UID:f', 'DTSTART:20261009T130000', 'DTEND:20261009T140000', 'SUMMARY:Floating']),
      ...ev(['UID:t', 'DTSTART;TZID=Europe/Paris:20261009T130000', 'DTEND;TZID=Europe/Paris:20261009T140000', 'SUMMARY:Zoned']),
      ...ev(['UID:z', 'DTSTART:20261009T130000Z', 'DTEND:20261009T140000Z', 'SUMMARY:Utc']),
    ]), { now });
    const by = (t: string) => r.commitments.find((c) => c.title === t)!;
    expect(by('Floating').start).toBe(local(2026, 10, 9, 13));
    expect(by('Zoned').start).toBe(local(2026, 10, 9, 13));
    expect(by('Utc').start).toBe('2026-10-09T13:00:00.000Z');
  });
  it('a property without a colon, an unterminated event and a stray END are ignored; junk input never throws', () => {
    expect(parseIcs('BEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261009T160000Z\r\nDTEND:20261009T170000Z\r\nSUMMARY:Open', { now })).toMatchObject({ commitments: [], skipped: 0 });
    const r = parseIcs(crlf(['END:VEVENT', 'nonsense line', ...ev(['UID:ok', 'no colon here', 'DTSTART:20261009T160000Z', 'DTEND:20261009T170000Z', 'SUMMARY:Ok'])]), { now });
    expect(r.commitments.map((c) => c.title)).toEqual(['Ok']);
    for (const junk of ['', '   \r\n\r\n', '\u0000\u0001\u0002', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n']) {
      expect(parseIcs(junk, { now })).toEqual({ commitments: [], events: [], skipped: 0, notes: [], cancelled: [] });
    }
  });
  it('reads properties after a nested VALARM, and is not confused by a VTIMEZONE with its own DTSTART', () => {
    const text = crlf(['BEGIN:VCALENDAR', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'X-WR-CALNAME:Work\\, home',
      'BEGIN:VTIMEZONE', 'TZID:America/Los_Angeles', 'BEGIN:STANDARD', 'DTSTART:19701101T020000', 'TZOFFSETFROM:-0700', 'END:STANDARD', 'END:VTIMEZONE',
      ...ev(['UID:a', 'BEGIN:VALARM', 'TRIGGER:-PT10M', 'SUMMARY:Alarm', 'DTSTART:20200101T000000Z', 'END:VALARM', 'DTSTART:20261009T160000Z', 'DTEND:20261009T170000Z', 'SUMMARY:After alarm']),
      'END:VCALENDAR']);
    const r = parseIcs(text, { now });
    expect(r.calendarName).toBe('Work, home');
    expect(r.commitments.map((c) => [c.title, c.start])).toEqual([['After alarm', '2026-10-09T16:00:00.000Z']]);
  });
  it('falls back to PRODID for the calendar name and to "unnamed" for the file key', () => {
    const r = parseIcs(crlf(['BEGIN:VCALENDAR', 'PRODID:-//Acme//Cal//EN', 'END:VCALENDAR']), { now });
    expect(r.calendarName).toBe('-//Acme//Cal//EN');
    expect(importIcs(new MemoryStore(), crlf(['BEGIN:VCALENDAR', 'END:VCALENDAR']), now).source).toBe('file:unnamed');
  });
});

describe('parseIcs: titles, ids, ends', () => {
  it('a missing or blank SUMMARY is "Untitled"; events without a UID get sequential noid ids', () => {
    const r = parseIcs(crlf([
      ...ev(['DTSTART:20261009T160000Z', 'DTEND:20261009T170000Z']),
      ...ev(['DTSTART:20261009T170000Z', 'DTEND:20261009T180000Z', 'SUMMARY:']),
      ...ev(['DTSTART:20261009T180000Z', 'DTEND:20261009T190000Z', 'SUMMARY:   ']),
    ]), { now });
    expect(r.commitments.map((c) => [c.id, c.title])).toEqual([['ics:noid-0', 'Untitled'], ['ics:noid-1', 'Untitled'], ['ics:noid-2', 'Untitled']]);
  });
  it('unescapes \\N, \\; and \\, and leaves an unknown escape alone', () => {
    const r = parseIcs(crlf(ev(['UID:a', 'DTSTART:20261009T160000Z', 'DTEND:20261009T170000Z', 'SUMMARY:a\\Nb\\;c\\,d\\xe'])), { now });
    expect(r.commitments[0].title).toBe('a\nb;c,d\\xe');
  });
  // Regression (fixed 2026-10-12): unescapeText (icsImport.ts:286) never turns "\\\\" back into one backslash, although RFC 5545 escapes a
  // backslash as "\\\\" and this app's own escapeText writes it that way. "C:\\\\Users" stays "C:\\\\Users" (two
  // backslashes), and in "a\\\\nb" the second backslash is read with the "n" as a newline, giving "a\\" + LF + "b".
  // Expected: "C:\\Users" and the literal "a\\nb".
  it('unescapes an escaped backslash, and does not read "\\\\n" as a newline', () => {
    const r = parseIcs(crlf([
      ...ev(['UID:a', 'DTSTART:20261009T160000Z', 'DTEND:20261009T170000Z', 'SUMMARY:C:\\\\Users']),
      ...ev(['UID:b', 'DTSTART:20261009T170000Z', 'DTEND:20261009T180000Z', 'SUMMARY:a\\\\nb']),
    ]), { now });
    expect(r.commitments.map((c) => c.title)).toEqual(['C:\\Users', 'a\\nb']);
  });
  it('DURATION in each form; a zero, empty, bogus or DATE end is "no usable end time"', () => {
    const r = parseIcs(crlf([
      ...ev(['UID:h', 'DTSTART:20261009T160000Z', 'DURATION:PT1H30M', 'SUMMARY:Ninety']),
      ...ev(['UID:d', 'DTSTART:20261009T160000Z', 'DURATION:P1D', 'SUMMARY:Day']),
      ...ev(['UID:w', 'DTSTART:20261009T160000Z', 'DURATION:P1W', 'SUMMARY:Week']),
      ...ev(['UID:j', 'DTSTART:20261009T160000Z', 'DTEND:junk', 'DURATION:PT15M', 'SUMMARY:JunkEnd']),
      ...ev(['UID:z', 'DTSTART:20261009T160000Z', 'DURATION:PT0S', 'SUMMARY:Zero']),
      ...ev(['UID:e', 'DTSTART:20261009T160000Z', 'DURATION:PT', 'SUMMARY:Empty']),
      ...ev(['UID:b', 'DTSTART:20261009T160000Z', 'DURATION:bogus', 'SUMMARY:Bogus']),
      ...ev(['UID:de', 'DTSTART:20261009T160000Z', 'DTEND;VALUE=DATE:20261010', 'SUMMARY:DateEnd']),
      ...ev(['UID:n', 'DTSTART:20261009T160000Z', 'SUMMARY:NoEnd']),
    ]), { now });
    // Same start for all four, so the order is by id: d, h, j, w.
    expect(r.commitments.map((c) => [c.title, c.end])).toEqual([
      ['Day', '2026-10-10T16:00:00.000Z'], ['Ninety', '2026-10-09T17:30:00.000Z'], ['JunkEnd', '2026-10-09T16:15:00.000Z'], ['Week', '2026-10-16T16:00:00.000Z'],
    ]);
    expect(r.skipped).toBe(5);
    expect(r.notes).toEqual(['Skipped 5 no usable end time events: Zero, Empty, Bogus, DateEnd, NoEnd']);
  });
  it('all-day events, as VALUE=DATE or a bare date, are skipped and named; more than five are elided', () => {
    const r = parseIcs(crlf([...ev(['UID:h', 'DTSTART;VALUE=DATE:20261010', 'DTEND;VALUE=DATE:20261011', 'SUMMARY:Holiday']), ...ev(['UID:t', 'DTSTART:20261012', 'DTEND:20261013', 'SUMMARY:Trip'])]), { now });
    expect(r).toMatchObject({ commitments: [], events: [], skipped: 2, notes: ['Skipped 2 all-day events: Holiday, Trip'] });
    const many = parseIcs(crlf(Array.from({ length: 7 }, (_, i) => ev([`UID:a${i}`, `DTSTART;VALUE=DATE:2026101${i}`, `SUMMARY:A${i + 1}`])).flat()), { now });
    expect(many.notes).toEqual(['Skipped 7 all-day events: A1, A2, A3, A4, A5, …']);
  });
  it('STATUS is case-insensitive; TENTATIVE is kept; a cancelled override is reported under its occurrence id', () => {
    const r = parseIcs(crlf([
      ...ev(['UID:c', 'DTSTART:20261009T160000Z', 'DTEND:20261009T170000Z', 'STATUS:cancelled', 'SUMMARY:Gone']),
      ...ev(['UID:t', 'DTSTART:20261009T160000Z', 'DTEND:20261009T170000Z', 'STATUS:TENTATIVE', 'SUMMARY:Maybe']),
      ...ev(['UID:s', 'RECURRENCE-ID:20261012T100000Z', 'DTSTART:20261012T100000Z', 'DTEND:20261012T110000Z', 'STATUS:CANCELLED', 'SUMMARY:One sync']),
    ]), { now });
    expect(r.commitments.map((c) => c.title)).toEqual(['Maybe']);
    expect(r.cancelled).toEqual(['ics:c', 'ics:s#20261012T100000Z']);
    expect(r.notes).toEqual(['Skipped 2 cancelled events: Gone, One sync']);
  });
  it('two masters with one UID both parse under the same id; the store keeps the later one', () => {
    const text = crlf([...ev(['UID:dup', 'DTSTART:20261009T160000Z', 'DTEND:20261009T170000Z', 'SUMMARY:First']), ...ev(['UID:dup', 'DTSTART:20261010T160000Z', 'DTEND:20261010T170000Z', 'SUMMARY:Second'])]);
    const r = parseIcs(text, { now });
    expect(r.commitments.map((c) => [c.id, c.title])).toEqual([['ics:dup', 'First'], ['ics:dup', 'Second']]);
    const s = new MemoryStore();
    importIcs(s, text, now, 'u');
    expect(s.listCommitments().map((c) => [c.id, c.title])).toEqual([['ics:dup', 'Second']]);
    expect(s.getImportRecord('u')!.ids).toEqual(['ics:dup', 'ics:dup']);
  });
  it('an event across midnight is one commitment with its real end', () => {
    const r = parseIcs(crlf(ev(['UID:n', 'DTSTART:20261009T230000', 'DTEND:20261010T010000', 'SUMMARY:Night'])), { now });
    expect(r.commitments).toEqual([{ id: 'ics:n', title: 'Night', start: local(2026, 10, 9, 23), end: local(2026, 10, 10, 1) }]);
  });
});

describe('parseIcs: the lookback and horizon edges', () => {
  it('starting exactly at the horizon is in; ending exactly at the lookback start is out; ending at now is an event, not a commitment', () => {
    // horizon end: Wed 6 Jan 2027 09:00; lookback start: Sun 9 Aug 2026 09:00 (local).
    const r = parseIcs(crlf([
      ...ev(['UID:1', 'DTSTART:20270106T090000', 'DTEND:20270106T100000', 'SUMMARY:AtHorizon']),
      ...ev(['UID:2', 'DTSTART:20270106T090100', 'DTEND:20270106T100000', 'SUMMARY:PastHorizon']),
      ...ev(['UID:3', 'DTSTART:20260809T080000', 'DTEND:20260809T090000', 'SUMMARY:EndsAtLookback']),
      ...ev(['UID:4', 'DTSTART:20260809T080000', 'DTEND:20260809T090100', 'SUMMARY:JustInside']),
      ...ev(['UID:5', 'DTSTART:20261008T080000', 'DTEND:20261008T090000', 'SUMMARY:EndsNow']),
      ...ev(['UID:6', 'DTSTART:20261008T083000', 'DTEND:20261008T093000', 'SUMMARY:InProgress']),
    ]), { now });
    expect(r.commitments.map((c) => c.title)).toEqual(['InProgress', 'AtHorizon']);
    expect(r.events.map((e) => e.title)).toEqual(['JustInside', 'EndsNow', 'InProgress', 'AtHorizon']);
    expect(r.skipped).toBe(2);
    expect(r.notes.sort()).toEqual(['Skipped 1 already over event: EndsAtLookback', 'Skipped 1 more than 90 days ahead event: PastHorizon']);
  });
  it('horizonDays 0 and lookbackDays 0 keep only what is in progress', () => {
    const r = parseIcs(crlf([
      ...ev(['UID:a', 'DTSTART:20261008T083000', 'DTEND:20261008T093000', 'SUMMARY:InProgress']),
      ...ev(['UID:b', 'DTSTART:20261008T090100', 'DTEND:20261008T100000', 'SUMMARY:Soon']),
      ...ev(['UID:c', 'DTSTART:20261008T070000', 'DTEND:20261008T080000', 'SUMMARY:Earlier']),
    ]), { now, horizonDays: 0, lookbackDays: 0 });
    expect(r.commitments.map((c) => c.title)).toEqual(['InProgress']);
    expect(r.events.map((c) => c.title)).toEqual(['InProgress']);
    expect(r.skipped).toBe(2);
  });
});

describe('parseIcs: repeat rules', () => {
  it('BYDAY with an ordinal prefix, unknown BYDAY codes, INTERVAL 0 or junk, and COUNT=0', () => {
    const r = parseIcs(crlf([
      ...ev(['UID:ord', 'DTSTART:20261005T100000', 'DTEND:20261005T110000', 'RRULE:FREQ=WEEKLY;BYDAY=1MO;COUNT=2', 'SUMMARY:Ordinal']),
      ...ev(['UID:xx', 'DTSTART:20261009T100000', 'DTEND:20261009T110000', 'RRULE:FREQ=WEEKLY;BYDAY=XX;COUNT=2', 'SUMMARY:Unknown day']),
      ...ev(['UID:i0', 'DTSTART:20261009T110000', 'DTEND:20261009T113000', 'RRULE:FREQ=DAILY;INTERVAL=0;COUNT=3', 'SUMMARY:Zero interval']),
      ...ev(['UID:ij', 'DTSTART:20261009T120000', 'DTEND:20261009T123000', 'RRULE:FREQ=DAILY;INTERVAL=abc;COUNT=2', 'SUMMARY:Junk interval']),
      ...ev(['UID:c0', 'DTSTART:20261009T130000', 'DTEND:20261009T140000', 'RRULE:FREQ=WEEKLY;COUNT=0', 'SUMMARY:C0']),
    ]), { now });
    const starts = (t: string) => r.events.filter((e) => e.title === t).map((e) => e.start);
    expect(starts('Ordinal')).toEqual([local(2026, 10, 5, 10), local(2026, 10, 12, 10)]);
    expect(r.commitments.filter((c) => c.title === 'Ordinal').map((c) => c.start)).toEqual([local(2026, 10, 12, 10)]);
    expect(starts('Unknown day')).toEqual([local(2026, 10, 9, 10), local(2026, 10, 16, 10)]);
    expect(starts('Zero interval')).toEqual([local(2026, 10, 9, 11), local(2026, 10, 10, 11), local(2026, 10, 11, 11)]);
    expect(starts('Junk interval')).toEqual([local(2026, 10, 9, 12), local(2026, 10, 10, 12)]);
    expect(starts('C0')).toEqual([]);
    expect(r.notes).toEqual(['Skipped 1 repeat already ended or outside the horizon event: C0']);
  });
  it('COUNT counts from DTSTART, past occurrences included; the occurrence id is the local basic time', () => {
    const r = parseIcs(crlf(ev(['UID:w', 'DTSTART:20260924T100000', 'DTEND:20260924T110000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Thursdays'])), { now });
    expect(r.events.map((e) => e.start)).toEqual([local(2026, 9, 24, 10), local(2026, 10, 1, 10), local(2026, 10, 8, 10)]);
    expect(r.commitments).toEqual([{ id: 'ics:w#20261008T100000', title: 'Thursdays', start: local(2026, 10, 8, 10), end: local(2026, 10, 8, 11) }]);
  });
  it('UNTIL as a date includes that whole day; as a UTC date-time it is an instant', () => {
    const r = parseIcs(crlf([
      ...ev(['UID:a', 'DTSTART:20261008T100000', 'DTEND:20261008T110000', 'RRULE:FREQ=WEEKLY;UNTIL=20261015', 'SUMMARY:ByDate']),
      ...ev(['UID:b', 'DTSTART:20261008T100000', 'DTEND:20261008T110000', 'RRULE:FREQ=WEEKLY;UNTIL=20261015T000000Z', 'SUMMARY:ByInstant']),
    ]), { now });
    expect(r.commitments.filter((c) => c.title === 'ByDate').map((c) => c.start)).toEqual([local(2026, 10, 8, 10), local(2026, 10, 15, 10)]);
    expect(r.commitments.filter((c) => c.title === 'ByInstant').map((c) => c.start)).toEqual([local(2026, 10, 8, 10)]);
  });
  it('EXDATE takes several comma-separated values, and matches by instant whatever its form', () => {
    const utcForm = basicUtc(new Date(2026, 9, 15, 10));
    const r = parseIcs(crlf([
      ...ev(['UID:a', 'DTSTART:20261008T100000', 'DTEND:20261008T110000', 'RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE:20261015T100000,20261022T100000', 'SUMMARY:Two out']),
      ...ev(['UID:b', 'DTSTART:20261008T100000', 'DTEND:20261008T110000', 'RRULE:FREQ=WEEKLY;COUNT=4', `EXDATE:${utcForm}`, 'SUMMARY:Utc out']),
      ...ev(['UID:c', 'DTSTART:20261008T100000', 'DTEND:20261008T110000', 'RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE;VALUE=DATE:20261015', 'SUMMARY:Date form ignored']),
    ]), { now });
    const starts = (t: string) => r.commitments.filter((c) => c.title === t).map((c) => c.start);
    expect(starts('Two out')).toEqual([local(2026, 10, 8, 10), local(2026, 10, 29, 10)]);
    expect(starts('Utc out')).toEqual([local(2026, 10, 8, 10), local(2026, 10, 22, 10), local(2026, 10, 29, 10)]);
    expect(starts('Date form ignored')).toHaveLength(4);
  });
  it('RECURRENCE-ID: a moved occurrence replaces the master\'s, with its own title; an override without a master still counts', () => {
    const r = parseIcs(crlf([
      ...ev(['UID:s', 'DTSTART:20261005T100000Z', 'DTEND:20261005T110000Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Sync']),
      ...ev(['UID:s', 'RECURRENCE-ID:20261012T100000Z', 'DTSTART:20261013T140000Z', 'DTEND:20261013T150000Z', 'SUMMARY:Sync (moved)']),
      ...ev(['UID:o', 'RECURRENCE-ID:20261001T100000Z', 'DTSTART:20261020T100000Z', 'DTEND:20261020T110000Z', 'SUMMARY:Orphan']),
    ]), { now });
    expect(r.commitments.map((c) => [c.id, c.title, c.start])).toEqual([
      ['ics:s#20261012T100000Z', 'Sync (moved)', '2026-10-13T14:00:00.000Z'],
      ['ics:s#20261019T100000Z', 'Sync', '2026-10-19T10:00:00.000Z'],
      ['ics:o#20261001T100000Z', 'Orphan', '2026-10-20T10:00:00.000Z'],
    ]);
    expect(r.events.map((e) => e.start)).toEqual(['2026-10-05T10:00:00.000Z', '2026-10-13T14:00:00.000Z', '2026-10-19T10:00:00.000Z', '2026-10-20T10:00:00.000Z']);
  });
  // Regression (fixed 2026-10-12): an occurrence cancelled on its own (a RECURRENCE-ID event with STATUS:CANCELLED, as Google Calendar writes a
  // deleted instance of a series) is dropped at icsImport.ts:470 before it is recorded as an override, so the master
  // still produces that occurrence; importIcs (icsImport.ts:557-562) then deletes the cancelled id and re-adds the same
  // id from the parsed commitments. Expected: the 12 Oct occurrence absent from the parse and from the store.
  // Actual: 'ics:s#20261012T100000Z' is in both.
  it('a cancelled single occurrence of a series is left out and stays out of the store', () => {
    const text = crlf(['BEGIN:VCALENDAR',
      ...ev(['UID:s', 'DTSTART:20261005T100000Z', 'DTEND:20261005T110000Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Sync']),
      ...ev(['UID:s', 'RECURRENCE-ID:20261012T100000Z', 'DTSTART:20261012T100000Z', 'DTEND:20261012T110000Z', 'STATUS:CANCELLED', 'SUMMARY:Sync']),
      'END:VCALENDAR']);
    const r = parseIcs(text, { now });
    expect(r.commitments.map((c) => c.id)).toEqual(['ics:s#20261019T100000Z']);
    const s = new MemoryStore();
    importIcs(s, text, now, 'u');
    expect(s.listCommitments().map((c) => c.id)).toEqual(['ics:s#20261019T100000Z']);
  });
  it('MONTHLY skips months without the day; YEARLY on 29 Feb has nothing in the horizon', () => {
    const r = parseIcs(crlf([
      ...ev(['UID:m', 'DTSTART:20260831T100000', 'DTEND:20260831T110000', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=31', 'SUMMARY:Last day']),
      ...ev(['UID:y', 'DTSTART:20240229T100000', 'DTEND:20240229T110000', 'RRULE:FREQ=YEARLY', 'SUMMARY:Leap']),
    ]), { now });
    expect(r.events.filter((e) => e.title === 'Last day').map((e) => e.start)).toEqual([local(2026, 8, 31, 10), local(2026, 10, 31, 10), local(2026, 12, 31, 10)]);
    expect(r.commitments.filter((c) => c.title === 'Last day')).toHaveLength(2);
    expect(r.commitments.filter((c) => c.title === 'Leap')).toEqual([]);
    expect(r.notes).toEqual(['Skipped 1 repeat already ended or outside the horizon event: Leap']);
  });
});

describe('importIcs: sources and removals', () => {
  const keep = ev(['UID:keep', 'DTSTART:20261009T160000Z', 'DTEND:20261009T170000Z', 'SUMMARY:Keep']);
  it('a cancellation removes the commitment whatever source imported it; another source\'s items are not touched', () => {
    const s = new MemoryStore();
    importIcs(s, crlf(['BEGIN:VCALENDAR', ...keep, 'END:VCALENDAR']), now, 'https://a');
    importIcs(s, crlf(['BEGIN:VCALENDAR', ...ev(['UID:other', 'DTSTART:20261010T160000Z', 'DTEND:20261010T170000Z', 'SUMMARY:Other']), 'END:VCALENDAR']), now, 'https://b');
    expect(s.listCommitments().map((c) => c.id)).toEqual(['ics:keep', 'ics:other']);
    const r = importIcs(s, crlf(['BEGIN:VCALENDAR', ...ev(['UID:keep', 'DTSTART:20261009T160000Z', 'DTEND:20261009T170000Z', 'STATUS:CANCELLED', 'SUMMARY:Keep']), 'END:VCALENDAR']), now, 'https://c');
    expect(r.removed).toEqual(['ics:keep']);
    expect(s.listCommitments().map((c) => c.id)).toEqual(['ics:other']);
    expect(s.listImportSources()).toEqual(['https://a', 'https://b', 'https://c']);
    expect(s.getImportRecord('https://c')).toMatchObject({ ids: [], events: [], importedAt: now.toISOString() });
  });
  it('an empty re-import of a source removes everything it had imported', () => {
    const s = new MemoryStore();
    importIcs(s, crlf(['BEGIN:VCALENDAR', 'X-WR-CALNAME:Home', ...keep, 'END:VCALENDAR']), now);
    const r = importIcs(s, crlf(['BEGIN:VCALENDAR', 'X-WR-CALNAME:Home', 'END:VCALENDAR']), now);
    expect(r.removed).toEqual(['ics:keep']);
    expect(s.listCommitments()).toEqual([]);
  });
});
