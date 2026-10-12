import { describe, it, expect } from 'vitest';
import { toIcs } from '../src/ics.js';
import type { Block, Task } from '../src/types.js';

const task: Task = { id: 't1', name: 'Write; review, ship\nnow', color: '#000', priority: 1, budgetMinutes: 60, budgetPeriod: 'day', archived: false, createdAt: '' };
const block: Block = { id: 'b1', taskId: 't1', start: '2026-10-07T09:00:00.000Z', end: '2026-10-07T10:30:00.000Z', status: 'done', createdAt: '', statusChangedAt: null };

describe('toIcs', () => {
  it('produces a VCALENDAR with one VEVENT per block, escaped and CRLF-terminated', () => {
    const ics = toIcs({ blocks: [block], tasks: [task], now: new Date('2026-10-07T12:00:00.000Z') });
    const lines = ics.split('\r\n');
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines).toContain('VERSION:2.0');
    expect(lines).toContain('UID:b1@rerouteday');
    expect(lines).toContain('DTSTART:20261007T090000Z');
    expect(lines).toContain('DTEND:20261007T103000Z');
    expect(lines).toContain('DTSTAMP:20261007T120000Z');
    expect(lines).toContain('SUMMARY:✓ Write\\; review\\, ship\\nnow');
    expect(lines).toContain('X-DS-STATUS:done');
    expect(lines).toContain('DESCRIPTION:Status: done');
    expect(lines[lines.length - 2]).toBe('END:VCALENDAR');
    expect(lines[lines.length - 1]).toBe('');
  });

  it('escapes semicolons, commas, backslashes and newlines', () => {
    const t = { ...task, name: 'a;b,c\\d\ne' };
    const ics = toIcs({ blocks: [block], tasks: [t] });
    const summary = ics.split('\r\n').find((l) => l.startsWith('SUMMARY:'))!;
    expect(summary).toBe('SUMMARY:✓ a\\;b\\,c\\\\d\\ne');
  });

  it('folds lines longer than 75 octets', () => {
    const long = { ...task, name: 'x'.repeat(120) };
    const ics = toIcs({ blocks: [block], tasks: [long] });
    const lines = ics.split('\r\n');
    const i = lines.findIndex((l) => l.startsWith('SUMMARY:'));
    expect(Buffer.byteLength(lines[i])).toBeLessThanOrEqual(75);
    expect(lines[i + 1].startsWith(' ')).toBe(true);
  });

  it('includes commitments when given', () => {
    const ics = toIcs({ blocks: [], tasks: [], commitments: [{ id: 'c1', title: 'Standup', start: block.start, end: block.end }] });
    expect(ics).toContain('UID:c1@rerouteday');
    expect(ics).toContain('SUMMARY:Standup');
  });
});

describe('toIcs recurring', () => {
  it('exports recurring commitments as weekly RRULE events', () => {
    const ics = toIcs({ blocks: [], tasks: [], recurring: [{ id: 'r1', title: 'Standup', days: [1, 3, 5], start: '10:00', end: '10:30' }], now: new Date(2026, 9, 7, 9) });
    const lines = ics.split('\r\n');
    expect(lines).toContain('UID:r1@rerouteday');
    expect(lines).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR');
    expect(lines).toContain('X-DS-KIND:recurring');
    const dtstart = lines.find((l) => l.startsWith('DTSTART:'))!;
    expect(dtstart).toBe(`DTSTART:${new Date(2026, 9, 7, 10).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`); // Wed Oct 7 is the first matching day on/after now
  });
});
