import { describe, it, expect } from 'vitest';
import { escapeText, foldLine, toIcs } from '../src/ics.js';
import { parseIcs } from '../src/icsImport.js';
import type { Block, Commitment, Task } from '../src/types.js';

const utc = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const task = (id: string, name: string): Task => ({ id, name, color: '#000', priority: 1, budgetMinutes: 60, budgetPeriod: 'day', archived: false, createdAt: '' });
const block = (id: string, taskId: string, start: string, end: string, status: Block['status'] = 'pending'): Block => ({ id, taskId, start, end, status, createdAt: '', statusChangedAt: null });
const now = new Date(2026, 9, 7, 9); // Wed 7 Oct 2026

describe('escapeText', () => {
  it('escapes backslash, semicolon, comma and both newline forms; leaves everything else', () => {
    expect(escapeText('')).toBe('');
    expect(escapeText('a\\b')).toBe('a\\\\b');
    expect(escapeText(';')).toBe('\\;');
    expect(escapeText(',')).toBe('\\,');
    expect(escapeText('\n')).toBe('\\n');
    expect(escapeText('\r\n')).toBe('\\n');
    expect(escapeText('a\\nb')).toBe('a\\\\nb'); // a literal backslash followed by n, not a newline
    expect(escapeText('quotes "x" <y> & é 😀')).toBe('quotes "x" <y> & é 😀');
  });
});

describe('foldLine', () => {
  it('leaves 75 octets alone and folds the 76th onto a continuation line', () => {
    expect(foldLine('x'.repeat(75))).toEqual(['x'.repeat(75)]);
    expect(foldLine('x'.repeat(76))).toEqual(['x'.repeat(75), ' x']);
    expect(foldLine('')).toEqual(['']);
  });
  it('continuation lines hold 74 octets plus the leading space', () => {
    expect(foldLine('x'.repeat(150))).toEqual(['x'.repeat(75), ` ${'x'.repeat(74)}`, ' x']);
  });
  it('never splits a multi-byte character: two-byte letters', () => {
    const lines = foldLine('é'.repeat(40)); // 80 octets
    expect(lines).toEqual(['é'.repeat(37), ` ${'é'.repeat(3)}`]);
    for (const l of lines) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75);
  });
  it('never splits a multi-byte character: four-byte emoji (surrogate pairs)', () => {
    const lines = foldLine('😀'.repeat(20)); // 80 octets
    expect([...lines[0]]).toHaveLength(18);
    expect(lines[1]).toBe(' 😀😀');
    for (const l of lines) expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(l), 'lone surrogate').toBe(false);
  });
  it('unfolding the output gives the line back', () => {
    const line = `SUMMARY:${'word '.repeat(40)}end`;
    expect(foldLine(line).join('\r\n').replace(/\r\n /g, '')).toBe(line);
  });
});

describe('toIcs: skeleton and statuses', () => {
  it('an empty export is just the calendar wrapper, CRLF-terminated', () => {
    expect(toIcs({ blocks: [], tasks: [], now }).split('\r\n')).toEqual(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//plannav//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'END:VCALENDAR', '']);
  });
  it('a block whose task is gone is exported as "Task"; only done blocks get the tick', () => {
    const b = block('b1', 'ghost', '2026-10-07T16:00:00.000Z', '2026-10-07T17:00:00.000Z', 'skipped');
    const lines = toIcs({ blocks: [b, { ...block('b2', 't', '2026-10-07T17:00:00.000Z', '2026-10-07T18:00:00.000Z', 'done') }], tasks: [task('t', 'Read')], now }).split('\r\n');
    expect(lines).toContain('SUMMARY:Task');
    expect(lines).toContain('X-DS-STATUS:skipped');
    expect(lines).toContain('DESCRIPTION:Status: skipped');
    expect(lines).toContain('SUMMARY:✓ Read');
    expect(lines).toContain('X-DS-TASK-ID:ghost');
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(2);
  });
  it('without now the stamp is the current UTC time in basic format', () => {
    const stamp = toIcs({ blocks: [block('b', 't', '2026-10-07T16:00:00.000Z', '2026-10-07T17:00:00.000Z')], tasks: [] }).split('\r\n').find((l) => l.startsWith('DTSTAMP:'))!;
    expect(stamp).toMatch(/^DTSTAMP:\d{8}T\d{6}Z$/);
    expect(Math.abs(Date.now() - new Date(stamp.slice(8).replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z')).getTime())).toBeLessThan(60_000);
  });
  it('a commitment title with every special character is escaped', () => {
    const c: Commitment = { id: 'c', title: 'a,b;c\\d\ne', start: '2026-10-07T16:00:00.000Z', end: '2026-10-07T17:00:00.000Z' };
    expect(toIcs({ blocks: [], tasks: [], commitments: [c], now }).split('\r\n')).toContain('SUMMARY:a\\,b\\;c\\\\d\\ne');
  });
});

describe('toIcs: recurring commitments', () => {
  const rec = (days: number[]) => ({ id: 'r', title: 'Standup', days, start: '10:00', end: '10:30' });
  const dtstart = (days: number[]) => toIcs({ blocks: [], tasks: [], recurring: [rec(days)], now }).split('\r\n').find((l) => l.startsWith('DTSTART:'))!;
  it('starts today when today is one of its days, else on the next such day, wrapping the week', () => {
    expect(dtstart([3])).toBe(`DTSTART:${utc(new Date(2026, 9, 7, 10))}`);
    expect(dtstart([1])).toBe(`DTSTART:${utc(new Date(2026, 9, 12, 10))}`);
    expect(dtstart([0])).toBe(`DTSTART:${utc(new Date(2026, 9, 11, 10))}`);
    expect(dtstart([2])).toBe(`DTSTART:${utc(new Date(2026, 9, 13, 10))}`);
  });
  it('sorts BYDAY whatever the order given', () => {
    expect(toIcs({ blocks: [], tasks: [], recurring: [rec([5, 1, 3])], now }).split('\r\n')).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR');
  });
});

describe('round trip: export, re-label the UIDs, import', () => {
  // The parser skips this app's own UIDs on purpose, so the round trip rewrites them as another producer's.
  const foreign = (ics: string) => ics.replace(/@plannav/g, '@elsewhere');
  const long = 'x'.repeat(120);
  const tasks = [task('t1', 'Write; review, ship\nnow'), task('t2', long)];
  const blocks = [block('b1', 't1', '2026-10-09T16:00:00.000Z', '2026-10-09T17:00:00.000Z', 'done'), block('b2', 't2', '2026-10-10T16:00:00.000Z', '2026-10-10T17:00:00.000Z')];
  const commitments: Commitment[] = [{ id: 'c1', title: 'Lunch, with; friends\nlate', start: '2026-10-11T16:00:00.000Z', end: '2026-10-11T17:00:00.000Z' }];

  it('titles with commas, semicolons, newlines and folded long lines come back exactly, with the same times', () => {
    const r = parseIcs(foreign(toIcs({ blocks, tasks, commitments, now })), { now });
    expect(r.skipped).toBe(0);
    expect(r.commitments).toEqual([
      { id: 'ics:b1@elsewhere', title: '✓ Write; review, ship\nnow', start: '2026-10-09T16:00:00.000Z', end: '2026-10-09T17:00:00.000Z' },
      { id: 'ics:b2@elsewhere', title: long, start: '2026-10-10T16:00:00.000Z', end: '2026-10-10T17:00:00.000Z' },
      { id: 'ics:c1@elsewhere', title: 'Lunch, with; friends\nlate', start: '2026-10-11T16:00:00.000Z', end: '2026-10-11T17:00:00.000Z' },
    ]);
    expect(r.calendarName).toBe('-//plannav//EN');
  });
  it('a weekly recurring commitment comes back as its occurrences at the same local time', () => {
    const r = parseIcs(foreign(toIcs({ blocks: [], tasks: [], recurring: [{ id: 'r1', title: 'Standup', days: [3], start: '10:00', end: '10:30' }], now })), { now, horizonDays: 10 });
    expect(r.commitments.map((c) => [c.title, c.start, c.end])).toEqual([
      ['Standup', new Date(2026, 9, 7, 10).toISOString(), new Date(2026, 9, 7, 10, 30).toISOString()],
      ['Standup', new Date(2026, 9, 14, 10).toISOString(), new Date(2026, 9, 14, 10, 30).toISOString()],
    ]);
    expect(r.commitments[0].id).toBe(`ics:r1@elsewhere#${utc(new Date(2026, 9, 7, 10))}`);
  });
  it('an unaltered own export is skipped whole, with one note naming the events', () => {
    const r = parseIcs(toIcs({ blocks, tasks: [task('t1', 'A'), task('t2', 'B')], commitments: [{ ...commitments[0], title: 'C' }], now }), { now });
    expect(r.commitments).toEqual([]);
    expect(r.events).toEqual([]);
    expect(r.skipped).toBe(3);
    expect(r.notes).toEqual(['Skipped 3 exported by this app events: ✓ A, B, C']);
  });
});
