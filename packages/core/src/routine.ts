import type { AvailabilityWindow, Settings, Task, TaskSegment, WorkStyle } from './types.js';
import { segmentOf } from './segments.js';
import { startOfWeek } from './time.js';

export interface RoutineEvent { title: string; start: string; end: string }
export type Cadence = 'daily' | 'weekly';
export interface RoutineTask { taskId: string; name: string; segment: Exclude<TaskSegment, 'any'>; minutesPerDay: number; days: number; cadence: Cadence; minutesPerWeek: number; sessionMinutes: number }
export interface RoutineUnmatched { title: string; segment: Exclude<TaskSegment, 'any'>; minutesPerDay: number; days: number; cadence: Cadence; minutesPerWeek: number; sessionMinutes: number }
export interface ObservedStyle { style: WorkStyle; medianMinutes: number }

/** Long sittings (90 min and up) read as deep work; short ones (an hour or less) as varied; between as balanced. */
export function inferWorkStyle(lengthsMinutes: number[]): ObservedStyle {
  const a = [...lengthsMinutes].filter((x) => x > 0).sort((x, y) => x - y);
  if (a.length === 0) return { style: 'unknown', medianMinutes: 0 };
  const median = a[Math.floor((a.length - 1) / 2)];
  return { style: median >= 90 ? 'deep' : median <= 60 ? 'varied' : 'balanced', medianMinutes: median };
}

export interface Routine {
  availability: AvailabilityWindow[];
  /** Off time between blocks on a day, i.e. the gaps the user leaves. */
  gaps: AvailabilityWindow[];
  tasks: RoutineTask[];
  unmatched: RoutineUnmatched[];
  /** Distinct dates with events, and distinct weeks. */
  days: number;
  weeks: number;
  workStyle: ObservedStyle;
}

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const minuteOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const STOP = new Set(['the', 'and', 'with', 'for', 'work', 'working', 'grinding', 'study', 'session', 'time', 'block', 'daily', 'practice']);
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s: string) => normalize(s).split(' ').filter((t) => t.length >= 3 && !STOP.has(t));
/** Initials of every run of two or more words, e.g. "machine learning interview" -> ml, li, mli. */
function acronyms(name: string): Set<string> {
  const words = normalize(name).split(' ').filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < words.length; i += 1) {
    let acc = '';
    for (let j = i; j < words.length; j += 1) { acc += words[j][0]; if (acc.length >= 2) out.add(acc); }
  }
  return out;
}

/** The task an event title most plausibly refers to, or undefined. Longest task name wins among matches. */
export function matchTask(title: string, tasks: Task[]): Task | undefined {
  const t = normalize(title);
  const tt = new Set(tokens(title));
  const shortTokens = new Set(normalize(title).split(' ').filter((w) => w.length >= 2 && w.length <= 4));
  const matches = tasks.filter((task) => {
    const n = normalize(task.name);
    if (!n) return false;
    if (t && (t.includes(n) || n.includes(t))) return true;
    if (tokens(task.name).some((tok) => tt.has(tok))) return true;
    for (const a of acronyms(task.name)) if (shortTokens.has(a)) return true;
    return false;
  });
  return matches.sort((a, b) => b.name.length - a.name.length)[0];
}

interface Span { start: number; end: number }
function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** Group identical (start, end) spans across weekdays into windows with a days list, ordered by first day then start. */
function groupWindows(perDay: Map<number, Span[]>): AvailabilityWindow[] {
  const byKey = new Map<string, { days: number[]; start: string; end: string }>();
  for (const [day, spans] of perDay) {
    for (const s of spans) {
      const key = `${s.start}-${s.end}`;
      const w = byKey.get(key) ?? { days: [], start: hhmm(s.start), end: hhmm(s.end) };
      w.days.push(day);
      byKey.set(key, w);
    }
  }
  return [...byKey.values()]
    .map((w) => ({ ...w, days: [...w.days].sort() }))
    .sort((a, b) => a.days[0] - b.days[0] || a.start.localeCompare(b.start));
}

export function learnRoutine(events: RoutineEvent[], tasks: Task[], settings: Settings): Routine {
  const dates = new Set<string>();
  const weeks = new Set<number>();
  const allLengths: number[] = [];
  const perDay = new Map<number, Span[]>();
  type Acc = { minutes: number; dates: Set<string>; bySegment: Record<string, number>; lengths: number[] };
  const perTask = new Map<string, Acc>();
  const perUnmatched = new Map<string, Acc>();

  for (const e of events) {
    const start = new Date(e.start);
    const end = new Date(e.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) continue;
    dates.add(dateKey(start));
    weeks.add(startOfWeek(start, settings.weekStartsOn).getTime());
    const day = start.getDay();
    const s = minuteOfDay(start);
    const sameDayEnd = dateKey(end) === dateKey(start) ? minuteOfDay(end) : 24 * 60;
    (perDay.get(day) ?? perDay.set(day, []).get(day)!).push({ start: s, end: Math.max(s + 1, sameDayEnd) });

    const minutes = (Math.min(end.getTime(), new Date(start).setHours(24, 0, 0, 0)) - start.getTime()) / 60_000;
    const seg = segmentOf(start, settings);
    const task = matchTask(e.title, tasks);
    const bucket = task ? perTask : perUnmatched;
    const key = task ? task.id : e.title.trim();
    const acc = bucket.get(key) ?? bucket.set(key, { minutes: 0, dates: new Set(), bySegment: {}, lengths: [] }).get(key)!;
    acc.minutes += minutes;
    acc.dates.add(dateKey(start));
    acc.bySegment[seg] = (acc.bySegment[seg] ?? 0) + minutes;
    acc.lengths.push(minutes);
    allLengths.push(minutes);
  }

  const merged = new Map<number, Span[]>();
  const gapsPerDay = new Map<number, Span[]>();
  for (const [day, spans] of perDay) {
    const m = mergeSpans(spans);
    merged.set(day, m);
    const gaps: Span[] = [];
    for (let i = 1; i < m.length; i += 1) gaps.push({ start: m[i - 1].end, end: m[i].start });
    if (gaps.length) gapsPerDay.set(day, gaps);
  }

  const dominant = (bySegment: Record<string, number>): Exclude<TaskSegment, 'any'> => {
    const order: Array<Exclude<TaskSegment, 'any'>> = ['morning', 'afternoon', 'evening'];
    let best = order[0];
    for (const seg of order) if ((bySegment[seg] ?? 0) > (bySegment[best] ?? 0)) best = seg;
    return best;
  };
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const slot = settings.slotMinutes;
  const snap = (m: number) => Math.max(slot, Math.round(m / slot) * slot);
  const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : 0; };
  // Daily when it shows up on most routine days (and the routine spans at least three days); otherwise weekly.
  const cadenceOf = (acc: Acc): Cadence => (dates.size >= 3 && acc.dates.size / dates.size >= 0.6 ? 'daily' : 'weekly');
  const shape = (acc: Acc) => ({
    minutesPerDay: Math.round(acc.minutes / acc.dates.size),
    days: acc.dates.size,
    cadence: cadenceOf(acc),
    minutesPerWeek: Math.round(acc.minutes / Math.max(1, weeks.size)),
    sessionMinutes: snap(median(acc.lengths)),
    segment: dominant(acc.bySegment),
  });
  const routineTasks: RoutineTask[] = [...perTask].map(([taskId, acc]) => ({ taskId, name: taskById.get(taskId)!.name, ...shape(acc) }));
  const unmatched: RoutineUnmatched[] = [...perUnmatched].map(([title, acc]) => ({ title, ...shape(acc) }));

  return { availability: groupWindows(merged), gaps: groupWindows(gapsPerDay), tasks: routineTasks, unmatched, days: dates.size, weeks: weeks.size, workStyle: inferWorkStyle(allLengths) };
}
