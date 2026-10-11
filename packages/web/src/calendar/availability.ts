import type { AvailabilityWindow } from '@ds/core';

const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** Minute ranges of the day (0..1440) that are NOT available on the given weekday, for shading. */
export function offHoursForDay(windows: AvailabilityWindow[], weekday: number): Array<[number, number]> {
  const todays = windows.filter((w) => w.days.includes(weekday)).map((w) => [toMin(w.start), toMin(w.end)] as [number, number]).sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of todays) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const off: Array<[number, number]> = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) off.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < 1440) off.push([cursor, 1440]);
  return off;
}
