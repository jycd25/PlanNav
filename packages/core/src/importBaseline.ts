import { randomUUID } from 'node:crypto';
import type { Baseline, BaselineSlot, Task } from './types.js';
import { TASK_COLORS } from './types.js';
import type { Store } from './store.js';
import { parseIcs } from './icsImport.js';
import type { RoutineEvent } from './routine.js';
import { budgetsFrom, refreshBudgets } from './baseline.js';
import { addDays, startOfDay, startOfWeek } from './time.js';

export const IMPORT_LOOKBACK_DAYS = 60;

export interface ImportBaselineResult {
  baseline: Baseline;
  tasks: { created: Task[]; matched: Task[]; revived: Task[] };
  /** Events that appear in fewer than half of the weeks seen: not part of the routine. */
  oneOffs: RoutineEvent[];
  weeksSeen: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** The name as the import compares it: trimmed, spaces collapsed, case folded. */
export const canonicalName = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The events of the last 60 days as the baseline week, verbatim: a (weekday, start, end, title) that appears in at
 * least half of the weeks seen is a slot (an event past midnight ends at 24:00); the rest are one-offs (with no slot at
 * all the import is refused, naming the weeks seen, rather than saved as an empty version). Every slot is a
 * task slot: its title matches an active task by name (case-insensitive, spaces collapsed), else revives an archived
 * task of that name, else makes a new task (priority by first appearance after the existing tasks, a palette colour, a
 * weekly budget of its slot sum, the modal slot length as its session, no segment; archived tasks are not counted for the priority or the colour);
 * a matched or revived task's budget, period and session are refreshed from its slots too (`refreshBudgets`). Saved as a new baseline version, so
 * importing the same file again creates no task and the same slots.
 */
export function baselineFromEvents(store: Store, events: RoutineEvent[], now: Date): ImportBaselineResult {
  const settings = store.getSettings();
  const lookbackStart = addDays(now, -IMPORT_LOOKBACK_DAYS);
  const usable = events
    .map((e) => ({ title: e.title.trim().replace(/\s+/g, ' ') || 'Untitled', start: new Date(e.start), end: new Date(e.end) }))
    .filter((e) => !Number.isNaN(e.start.getTime()) && !Number.isNaN(e.end.getTime()) && e.end > e.start && e.end > lookbackStart && e.start <= now)
    .sort((a, b) => a.start.getTime() - b.start.getTime() || a.title.localeCompare(b.title));
  if (usable.length === 0) throw new Error(`No events in the last ${IMPORT_LOOKBACK_DAYS} days to import as a baseline.`);

  // Group by (weekday, start, end, title) and count the distinct weeks each appears in.
  type Group = { day: number; start: string; end: string; title: string; weeks: Set<number>; events: typeof usable };
  const weeks = new Set<number>();
  const groups = new Map<string, Group>();
  for (const e of usable) {
    const week = startOfWeek(e.start, settings.weekStartsOn).getTime();
    weeks.add(week);
    const end = startOfDay(e.end).getTime() > startOfDay(e.start).getTime() ? '24:00' : hhmm(e.end);
    const key = `${e.start.getDay()}|${hhmm(e.start)}|${end}|${canonicalName(e.title)}`;
    const g = groups.get(key) ?? groups.set(key, { day: e.start.getDay(), start: hhmm(e.start), end, title: e.title, weeks: new Set(), events: [] }).get(key)!;
    g.weeks.add(week);
    g.events.push(e);
  }
  const weeksSeen = weeks.size;
  const isSlot = (g: Group) => g.weeks.size * 2 >= weeksSeen;
  const slotGroups = [...groups.values()].filter(isSlot);
  if (slotGroups.length === 0) {
    // Nothing repeats often enough (say, a routine that began two weeks ago behind older stray events): refuse rather than save an empty version.
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const label = (t: number) => { const x = new Date(t); return `${MONTHS[x.getMonth()]} ${x.getDate()}`; };
    const seen = [...weeks].sort((x, y) => x - y);
    const range = seen.length === 1 ? `the week of ${label(seen[0])}` : `the weeks of ${label(seen[0])} to ${label(seen[seen.length - 1])}`;
    throw new Error(`No routine to import: nothing in the last ${IMPORT_LOOKBACK_DAYS} days repeats in at least half of the ${weeksSeen} weeks seen (${range}). Export one typical week from your calendar and import that as your baseline.`);
  }
  const oneOffs: RoutineEvent[] = [...groups.values()].filter((g) => !isSlot(g)).flatMap((g) => g.events)
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .map((e) => ({ title: e.title, start: e.start.toISOString(), end: e.end.toISOString() }));

  // Title -> task, in order of first appearance.
  const created: Task[] = []; const matched: Task[] = []; const revived: Task[] = [];
  const byTitle = new Map<string, Task>();
  const all = store.listTasks(true);
  const stamp = now.toISOString();
  for (const g of slotGroups.sort((a, b) => a.events[0].start.getTime() - b.events[0].start.getTime())) {
    const name = canonicalName(g.title);
    if (byTitle.has(name)) continue;
    const active = all.find((t) => !t.archived && canonicalName(t.name) === name);
    if (active) { byTitle.set(name, active); matched.push(active); continue; }
    const archived = all.find((t) => t.archived && canonicalName(t.name) === name);
    if (archived) { const t = store.upsertTask({ ...archived, archived: false }); byTitle.set(name, t); revived.push(t); continue; }
    const count = all.filter((t) => !t.archived).length + created.length; // archived tasks are not counted
    const t: Task = { id: randomUUID(), name: g.title.slice(0, 200), color: TASK_COLORS[count % TASK_COLORS.length], priority: count + 1, budgetMinutes: 0, budgetPeriod: 'week', preferredSegment: 'any', archived: false, createdAt: stamp };
    byTitle.set(name, t); created.push(t);
  }

  const slots: BaselineSlot[] = slotGroups.map((g) => ({ day: g.day, start: g.start, end: g.end, kind: 'task' as const, taskId: byTitle.get(canonicalName(g.title))!.id }));
  const draft: Baseline = { version: 0, savedAt: stamp, slots };
  for (const t of created) {
    const b = budgetsFrom(draft, t.id);
    store.upsertTask({ ...t, budgetMinutes: b.weeklyMinutes, sessionMinutes: b.sessionMinutes });
  }
  store.setBaseline({ slots, savedAt: stamp });
  const baseline = store.getBaseline()!;
  refreshBudgets(store, baseline); // matched and revived tasks too: every slotted task's numbers come from the baseline
  const fresh = (ts: Task[]) => ts.map((t) => store.getTask(t.id)!);
  return { baseline, tasks: { created: fresh(created), matched: fresh(matched), revived: fresh(revived) }, oneOffs, weeksSeen };
}

/** `baselineFromEvents` over an .ics text: the events of the last 60 days (horizon 0: nothing ahead of now). */
export function importAsBaseline(store: Store, icsText: string, now: Date): ImportBaselineResult {
  const parsed = parseIcs(icsText, { now, lookbackDays: IMPORT_LOOKBACK_DAYS, horizonDays: 0 });
  return baselineFromEvents(store, parsed.events, now);
}
