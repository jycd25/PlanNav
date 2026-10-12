import type { Block, Commitment, RecurringCommitment, Task } from './types.js';
import { addDays, atTime, startOfDay } from './time.js';

function fmtUtc(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Fold a content line at 75 octets with CRLF + single space continuation. */
export function foldLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes + b > limit) {
      out.push(current);
      current = ch;
      bytes = b;
    } else {
      current += ch;
      bytes += b;
    }
  }
  out.push(current);
  return out.map((l, i) => (i === 0 ? l : ` ${l}`));
}

export interface IcsInput { blocks: Block[]; tasks: Task[]; commitments?: Commitment[]; recurring?: RecurringCommitment[]; now?: Date }

const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function toIcs({ blocks, tasks, commitments = [], recurring = [], now = new Date() }: IcsInput): string {
  const stamp = fmtUtc(now);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//rerouteday//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];

  for (const b of blocks) {
    const name = taskById.get(b.taskId)?.name ?? 'Task';
    const summary = (b.status === 'done' ? '✓ ' : '') + name;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${b.id}@rerouteday`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${fmtUtc(b.start)}`,
      `DTEND:${fmtUtc(b.end)}`,
      `SUMMARY:${escapeText(summary)}`,
      `DESCRIPTION:${escapeText(`Status: ${b.status}`)}`,
      `X-DS-STATUS:${b.status}`,
      `X-DS-TASK-ID:${b.taskId}`,
      'STATUS:CONFIRMED',
      'END:VEVENT',
    );
  }
  for (const c of commitments) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${c.id}@rerouteday`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${fmtUtc(c.start)}`,
      `DTEND:${fmtUtc(c.end)}`,
      `SUMMARY:${escapeText(c.title)}`,
      'X-DS-KIND:commitment',
      'END:VEVENT',
    );
  }
  for (const r of recurring) {
    // DTSTART is the first occurrence on or after today; the RRULE carries the weekdays.
    let day = startOfDay(now);
    for (let i = 0; i < 7 && !r.days.includes(day.getDay()); i += 1) day = addDays(day, 1);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${r.id}@rerouteday`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${fmtUtc(atTime(day, r.start))}`,
      `DTEND:${fmtUtc(atTime(day, r.end))}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${[...r.days].sort().map((d) => BYDAY[d]).join(',')}`,
      `SUMMARY:${escapeText(r.title)}`,
      'X-DS-KIND:recurring',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.flatMap(foldLine).join('\r\n') + '\r\n';
}
