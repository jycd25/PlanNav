export function startOfDay(d: Date): Date { const r = new Date(d); r.setHours(0, 0, 0, 0); return r; }
export function addDays(d: Date, n: number): Date { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
export function startOfWeek(d: Date, weekStartsOn = 0): Date { const r = startOfDay(d); return addDays(r, -((r.getDay() - weekStartsOn + 7) % 7)); }
export function isSameDay(a: Date, b: Date): boolean { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
export const fmtTime = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
export const fmtDayName = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short' });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function fmtRangeLabel(days: Date[]): string {
  const first = days[0];
  const last = days[days.length - 1];
  if (days.length === 1) return first.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const sameMonth = first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear();
  // Composed by hand: Intl with only { day, year } prints odd strings in some locales ("2026 (day: 11)").
  return sameMonth
    ? `${MONTHS[first.getMonth()]} ${first.getDate()} – ${last.getDate()}, ${last.getFullYear()}`
    : `${MONTHS[first.getMonth()]} ${first.getDate()} – ${MONTHS[last.getMonth()]} ${last.getDate()}, ${last.getFullYear()}`;
}
export const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;
/** Tracked minutes plus the running stretch up to `now` (mirrors core's elapsedMinutes). */
export function elapsedMinutes(b: { trackedMinutes?: number; runningSince?: string | null }, now: Date): number {
  const running = b.runningSince ? Math.max(0, (now.getTime() - new Date(b.runningSince).getTime()) / 60_000) : 0;
  return Math.round((b.trackedMinutes ?? 0) + running);
}
export function fmtMinutes(n: number): string {
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
/** The local calendar date as YYYY-MM-DD. */
export const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
