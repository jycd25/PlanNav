import type { Interval } from './types.js';

export const MINUTE = 60_000;

export function addMinutes(d: Date, m: number): Date {
  return new Date(d.getTime() + m * MINUTE);
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MINUTE);
}

export function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Sunday by default, as in Apple Calendar and Google Calendar; `settings.weekStartsOn` overrides. */
export function startOfWeek(d: Date, weekStartsOn = 0): Date {
  const r = startOfDay(d);
  const diff = (r.getDay() - weekStartsOn + 7) % 7;
  return addDays(r, -diff);
}

/** Local date at hh:mm on the same calendar day as `day`. */
export function atTime(day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const r = startOfDay(day);
  r.setHours(h, m, 0, 0);
  return r;
}

function minutesIntoDay(d: Date): number {
  return (d.getTime() - startOfDay(d).getTime()) / MINUTE;
}

export function ceilToSlot(d: Date, slot: number): Date {
  const m = minutesIntoDay(d);
  return addMinutes(startOfDay(d), Math.ceil(m / slot) * slot);
}

export function floorToSlot(d: Date, slot: number): Date {
  const m = minutesIntoDay(d);
  return addMinutes(startOfDay(d), Math.floor(m / slot) * slot);
}

export function clip(a: Interval, bounds: Interval): Interval | null {
  const start = a.start > bounds.start ? a.start : bounds.start;
  const end = a.end < bounds.end ? a.end : bounds.end;
  return start < end ? { start, end } : null;
}

/** Sort and merge overlapping or touching intervals. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].filter((i) => i.start < i.end).sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) {
      if (i.end > last.end) last.end = new Date(i.end);
    } else {
      out.push({ start: new Date(i.start), end: new Date(i.end) });
    }
  }
  return out;
}

/** Remove `busy` from each interval in `base`. */
export function subtractIntervals(base: Interval[], busy: Interval[]): Interval[] {
  const blockers = mergeIntervals(busy);
  const out: Interval[] = [];
  for (const b of mergeIntervals(base)) {
    let cursor = b.start;
    for (const x of blockers) {
      if (x.end <= cursor) continue;
      if (x.start >= b.end) break;
      if (x.start > cursor) out.push({ start: cursor, end: x.start });
      if (x.end > cursor) cursor = x.end;
    }
    if (cursor < b.end) out.push({ start: cursor, end: b.end });
  }
  return out;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}
