import { randomUUID } from 'node:crypto';
import type { AvailabilityWindow, Baseline, BaselineSlot, Block, Commitment, Task } from './types.js';
import type { Store } from './store.js';
import { addDays, atTime, overlaps, startOfDay } from './time.js';
import { expandRecurring } from './free.js';

/** A stretch of one day in minutes since midnight: 0 .. 1440 (1440 = the midnight that ends the day). */
export interface MinuteSpan { start: number; end: number }

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const TITLE_MAX = 200;

const toMinutes = (hhmm: string): number => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
/** Minutes since midnight as "HH:MM"; 1440 is "24:00". */
export const fmtMinutes = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const slotMinutes = (s: BaselineSlot): number => toMinutes(s.end) - toMinutes(s.start);

function normalizeSlot(raw: unknown, legacy: boolean): BaselineSlot | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const day = r.day;
  if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) return undefined;
  if (typeof r.start !== 'string' || !HHMM.test(r.start) || typeof r.end !== 'string') return undefined;
  // A slot that runs to midnight may be written 24:00, or 00:00 after a later start (how a calendar writes it).
  const end = r.end === '00:00' && r.start !== '00:00' ? '24:00' : r.end;
  if (end !== '24:00' && !HHMM.test(end)) return undefined;
  if (toMinutes(end) <= toMinutes(r.start)) return undefined;
  const taskId = typeof r.taskId === 'string' && r.taskId.trim() ? r.taskId : undefined;
  const kind = legacy ? 'task' : r.kind === undefined ? (taskId ? 'task' : undefined) : r.kind;
  const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim().slice(0, TITLE_MAX) : undefined;
  if (kind === 'task') {
    if (!taskId) return undefined;
    return { day, start: r.start, end, kind, taskId, ...(title ? { title } : {}) };
  }
  if (kind === 'busy') return { day, start: r.start, end, kind, ...(title ? { title } : {}) };
  return undefined;
}

/**
 * A valid Baseline from whatever was stored: the v2 shape ({ version, savedAt, slots }) or the old one
 * ({ savedAt, blocks: [{ taskId, day, start, end }] }, read as task slots, version 1). Invalid slots are dropped; a value
 * that is neither shape is undefined. Slots come sorted by day, start, end.
 */
export function normalizeBaseline(raw: unknown): Baseline | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const legacy = !Array.isArray(r.slots);
  const list = legacy ? r.blocks : r.slots;
  if (!Array.isArray(list)) return undefined;
  const slots = list.map((s) => normalizeSlot(s, legacy)).filter((s): s is BaselineSlot => !!s)
    .sort((a, b) => a.day - b.day || a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const version = !legacy && typeof r.version === 'number' && Number.isInteger(r.version) && r.version >= 1 ? r.version : 1;
  return { version, savedAt: typeof r.savedAt === 'string' ? r.savedAt : '', slots };
}

/**
 * The time of `weekday` that work may use, in minutes of the day: from the day's first slot to its last, minus its busy
 * slots (blank time inside the span is free). Empty when the day has no task slot.
 */
export function usableSpans(b: Baseline, weekday: number): MinuteSpan[] {
  const day = b.slots.filter((s) => s.day === weekday);
  if (!day.some((s) => s.kind === 'task')) return [];
  let spans: MinuteSpan[] = [{ start: Math.min(...day.map((s) => toMinutes(s.start))), end: Math.max(...day.map((s) => toMinutes(s.end))) }];
  for (const busy of day.filter((s) => s.kind === 'busy')) {
    const bs = toMinutes(busy.start);
    const be = toMinutes(busy.end);
    spans = spans.flatMap((x) => [{ start: x.start, end: Math.min(x.end, bs) }, { start: Math.max(x.start, be), end: x.end }]).filter((x) => x.start < x.end);
  }
  return spans;
}

/** The availability windows (the shape `settings.availability` uses) the baseline implies: weekdays with the same span share one. */
export function availabilityFrom(b: Baseline): AvailabilityWindow[] {
  const windows = new Map<string, AvailabilityWindow>();
  for (let day = 0; day <= 6; day += 1) {
    for (const span of usableSpans(b, day)) {
      const start = fmtMinutes(span.start);
      const end = fmtMinutes(span.end);
      const key = `${start}-${end}`;
      const w = windows.get(key);
      if (w) w.days.push(day); else windows.set(key, { days: [day], start, end });
    }
  }
  return [...windows.values()];
}

/** A task's week as the baseline holds it: total minutes, the most common slot length (ties to the longer), its weekdays. */
export function budgetsFrom(b: Baseline, taskId: string): { weeklyMinutes: number; sessionMinutes: number; days: number[] } {
  const mine = b.slots.filter((s) => s.kind === 'task' && s.taskId === taskId);
  const counts = new Map<number, number>();
  for (const s of mine) counts.set(slotMinutes(s), (counts.get(slotMinutes(s)) ?? 0) + 1);
  const modal = [...counts.entries()].sort((x, y) => y[1] - x[1] || y[0] - x[0])[0];
  return {
    weeklyMinutes: mine.reduce((n, s) => n + slotMinutes(s), 0),
    sessionMinutes: modal ? modal[0] : 0,
    days: [...new Set(mine.map((s) => s.day))].sort((x, y) => x - y),
  };
}

/**
 * Every baseline save (the Baseline tab, `save_baseline`, an import) calls this: each task with at least one slot in `b`
 * takes its weekly budget, period 'week' and session from its slots (`budgetsFrom`), so the prompt, `get_summary` and
 * the Tasks panel report what the baseline holds; a task with no slot keeps its numbers. Returns the tasks updated.
 */
export function refreshBudgets(store: Store, b: Baseline): Task[] {
  const ids = [...new Set(b.slots.filter((s) => s.kind === 'task' && s.taskId).map((s) => s.taskId!))];
  const out: Task[] = [];
  for (const id of ids) {
    const t = store.getTask(id);
    if (!t) continue;
    const x = budgetsFrom(b, id);
    out.push(store.upsertTask({ ...t, budgetMinutes: x.weeklyMinutes, budgetPeriod: 'week', sessionMinutes: x.sessionMinutes }));
  }
  return out;
}

/** The id prefix of the commitments `applyToWeek` makes from busy slots, so a re-apply finds and replaces them. */
export const BASELINE_COMMITMENT_PREFIX = 'baseline:';

/** What `applyToWeek` did; `skipped` names the task slots it could not lay (under a commitment, or over a live block of another task). */
export interface ApplyResult { created: Block[]; commitments: Commitment[]; replaced: number; skipped: Array<{ slot: BaselineSlot; reason: string }> }

/**
 * Copy the baseline onto the 7 days from `weekStart` (its date; any weekday): task slots become pending blocks with
 * source 'baseline', busy slots become commitments with an id prefixed `baseline:`. Earlier copies in that week that
 * are still ahead of `now` are replaced (pending baseline blocks without a running clock or tracked time, and the
 * baseline commitments), so a re-apply never duplicates; slots already over at `now` are skipped and their earlier
 * copies kept. Manual, adjusted, planner and done blocks are never touched. Each user-owned block of a task on a day
 * (manual, adjusted, or done of any source) is one sitting and claims exactly one slot of that task that day: the slot
 * it overlaps if any, else the nearest unclaimed one by start (overlapping claims resolved first, then the rest by block
 * start); a claimed slot is skipped with `already has <task> at HH:MM`, so a moved copy is not doubled and an extra
 * hand-placed sitting replaces one copy that day. A slot is also skipped and named when any other live block of its
 * task overlaps it (`already has …`), when a commitment or a recurring occurrence covers it (`under "<title>"`), or when
 * a live block of another task overlaps it (`over a block of <task>`). A slot whose task is gone or archived is
 * skipped. `replaced` counts the blocks replaced.
 */
export function applyToWeek(store: Store, b: Baseline, weekStart: Date, now: Date): ApplyResult {
  const from = startOfDay(weekStart);
  const to = addDays(from, 7);
  const ahead = (x: { end: string }) => new Date(x.end) > now;
  const old = store.listBlocks({ from, to })
    .filter((x) => x.source === 'baseline' && x.status === 'pending' && ahead(x) && !x.runningSince && !((x.trackedMinutes ?? 0) > 0));
  store.deleteBlocks(old.map((x) => x.id));
  for (const c of store.listCommitments({ from, to })) if (c.id.startsWith(BASELINE_COMMITMENT_PREFIX) && ahead(c)) store.deleteCommitment(c.id);
  const live = store.listBlocks({ from, to }).filter((x) => x.status === 'pending' || x.status === 'done');
  const liveIv = (x: Block) => ({ start: new Date(x.start), end: new Date(x.end) });

  const created: Block[] = [];
  const commitments: Commitment[] = [];
  const skipped: ApplyResult['skipped'] = [];
  const stamp = now.toISOString();
  const slots = normalizeBaseline(b)?.slots ?? [];
  const dateOf = (s: BaselineSlot) => addDays(from, (s.day - from.getDay() + 7) % 7);
  // Busy slots first, so a task slot is checked against the commitments of its own baseline too.
  for (const s of slots) {
    if (s.kind !== 'busy') continue;
    const date = dateOf(s);
    const iv = { start: atTime(date, s.start), end: atTime(date, s.end) };
    if (iv.end <= now) continue;
    commitments.push(store.addCommitment({ id: `${BASELINE_COMMITMENT_PREFIX}${randomUUID()}`, title: s.title ?? 'Busy', start: iv.start.toISOString(), end: iv.end.toISOString() }));
  }
  const busy = [
    ...store.listCommitments({ from, to }).map((c) => ({ title: c.title, start: new Date(c.start), end: new Date(c.end) })),
    ...expandRecurring(store.listRecurring(), { start: from, end: to }).map((o) => ({ title: o.title, start: o.start, end: o.end })),
  ];
  const hhmm = (x: string) => { const t = new Date(x); return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; };
  // Pairing: each user-owned block claims one slot of its task on its day (the overlapped one first, else the nearest).
  const taskSlots = slots.map((s, i) => ({ s, i, iv: { start: atTime(dateOf(s), s.start), end: atTime(dateOf(s), s.end) } })).filter((x) => x.s.kind === 'task');
  const claims = new Map<number, Block>();
  const owned = live.filter((k) => k.source === 'manual' || k.source === 'adjusted' || k.status === 'done').sort((x, y) => x.start.localeCompare(y.start));
  const candidates = (k: Block) => taskSlots.filter((x) => x.s.taskId === k.taskId && !claims.has(x.i) && startOfDay(x.iv.start).getTime() === startOfDay(new Date(k.start)).getTime());
  const unclaimed = new Set(owned.map((k) => k.id));
  for (const k of owned) {
    const hit = candidates(k).find((x) => overlaps(x.iv, liveIv(k)));
    if (hit) { claims.set(hit.i, k); unclaimed.delete(k.id); }
  }
  for (const k of owned) {
    if (!unclaimed.has(k.id)) continue;
    const near = candidates(k).sort((x, y) => Math.abs(x.iv.start.getTime() - new Date(k.start).getTime()) - Math.abs(y.iv.start.getTime() - new Date(k.start).getTime()) || x.iv.start.getTime() - y.iv.start.getTime())[0];
    if (near) claims.set(near.i, k);
  }
  for (const [i, s] of slots.entries()) {
    if (s.kind !== 'task') continue;
    const date = dateOf(s);
    const iv = { start: atTime(date, s.start), end: atTime(date, s.end) };
    if (iv.end <= now) continue;
    const task = store.getTask(s.taskId!);
    if (!task || task.archived) continue;
    const mine = claims.get(i) ?? live.find((k) => k.taskId === s.taskId && overlaps(liveIv(k), iv));
    if (mine) { skipped.push({ slot: s, reason: `already has ${task.name} at ${hhmm(mine.start)}` }); continue; }
    const under = busy.find((c) => overlaps(c, iv));
    if (under) { skipped.push({ slot: s, reason: `under "${under.title}"` }); continue; }
    const over = [...live, ...created].find((k) => overlaps(liveIv(k), iv));
    if (over) { skipped.push({ slot: s, reason: `over a block of ${store.getTask(over.taskId)?.name ?? 'another task'}` }); continue; }
    created.push({ id: randomUUID(), taskId: s.taskId!, start: iv.start.toISOString(), end: iv.end.toISOString(), status: 'pending', source: 'baseline', createdAt: stamp, statusChangedAt: null });
  }
  store.insertBlocks(created);
  return { created, commitments, replaced: old.length, skipped };
}
