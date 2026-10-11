import type { Interval, Settings, Task } from './types.js';
import type { Slot } from './segments.js';
import { addMinutes, minutesBetween } from './time.js';

export interface Allocation { taskId: string; start: Date; end: Date }
export interface AllocateOptions {
  /** When given, a task is only placed in a slot the filter accepts. */
  accepts?: (task: Task, slot: Interval) => boolean;
  /** Task ids the user asked for today: they outrank every score. */
  boost?: Set<string>;
  /** Task ids placed before the rest, the score still ordering them among themselves: a daily budget belongs to its day. */
  lead?: Set<string>;
  /** Deficit = periodRemaining / periodBudget, decreasing as blocks are placed. Defaults to `remaining` over itself. */
  periodRemaining?: Record<string, number>;
  periodBudget?: Record<string, number>;
  /** Whole sittings only: a scrap (at most half a sitting) is left for a later sweep over the days. */
  wholeSittings?: boolean;
  /**
   * For each task with blocks on the day so far (the tasks given here or not), those blocks. They tell how long a run of
   * the task already is at the cursor (a task two sessions into a run yields to another that can take the slot), and,
   * for the tasks in `closing`, where a remainder may go.
   */
  anchors?: Record<string, Interval[]>;
  /**
   * Tasks that close the day's sitting: in a whole-sittings sweep a remainder of such a task (shorter than its session)
   * is placed touching one of its anchors, or a block placed in this call, so it closes the day's sitting; only when no
   * spot touching them is left on the day does it take a second spot there, after another task's block (the anchors of
   * the other tasks say where those are), never one that opens the day.
   */
  closing?: Set<string>;
  /** The first free minute of the planning window (default: the first slot); a scrap there is not left empty, see below. */
  windowStart?: Date;
}

/**
 * Score-based allocation. For each free slot the eligible task with the highest score gets the next block
 * (at most maxBlockMinutes):
 *   score = weights.priority * priorityScore + weights.deficit * deficit
 * priorityScore is 1 for the best priority among the tasks and 0 for the worst; deficit is the fraction of the
 * task's share still unplaced, so a task that just received a block drops and others get their turn (rotation).
 * Ties go to the better priority, then the name. Boosted tasks (must do today) always come first.
 */
export function allocate(
  free: Slot[],
  tasks: Task[],
  remaining: Record<string, number>,
  settings: Settings,
  options: AllocateOptions = {},
): Allocation[] {
  const order = [...tasks].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  const rem: Record<string, number> = {};
  for (const t of order) rem[t.id] = remaining[t.id] ?? 0;
  const periodRemaining: Record<string, number> = options.periodRemaining ?? { ...rem };
  const periodBudget: Record<string, number> = {};
  for (const t of order) periodBudget[t.id] = Math.max(options.periodBudget?.[t.id] ?? periodRemaining[t.id] ?? rem[t.id], 1);
  const out: Allocation[] = [];
  const { minBlockMinutes, maxBlockMinutes, slotMinutes } = settings;
  const weights = settings.weights ?? { priority: 0.6, deficit: 0.4 };
  const priorities = order.map((t) => t.priority);
  const bestP = Math.min(...priorities);
  const worstP = Math.max(...priorities);
  const priorityScore = (t: Task) => (worstP === bestP ? 1 : 1 - (t.priority - bestP) / (worstP - bestP));
  const score = (t: Task) => (options.boost?.has(t.id) ? 10 : options.lead?.has(t.id) ? 2 : 0) + weights.priority * priorityScore(t) + weights.deficit * Math.max(0, (periodRemaining[t.id] ?? rem[t.id]) / periodBudget[t.id]);

  let si = 0;
  let cursor: Date | null = free.length ? new Date(free[0].start) : null;
  const accepts = options.accepts ?? (() => true);
  const eligibleAnywhere = (t: Task) => rem[t.id] >= minBlockMinutes;
  const advanceSlot = () => {
    si += 1;
    // A sitting that ran past a segment edge already holds the start of the next slot.
    cursor = si < free.length ? new Date(Math.max(free[si].start.getTime(), cursor?.getTime() ?? 0)) : null;
  };
  // The sitting a task wants next: a whole session, or what is left of its budget.
  const sitting = (t: Task) => Math.min(rem[t.id], t.sessionMinutes ?? maxBlockMinutes);
  // Minutes a task can take from `at` in a slot. A slot cut at a segment edge with free time running on past it lets a
  // sitting that the edge would cut short run to its full length when at least half of it sits before the edge; one that
  // would mostly sit past the edge is an off-segment placement, not an overrun, and the usual rules decide.
  const room = (t: Task, at: Date, slot: Slot) => {
    const toEdge = minutesBetween(at, slot.end);
    const s = sitting(t);
    return slot.until && toEdge < s && toEdge * 2 >= s && minutesBetween(at, slot.until) >= s ? s : toEdge;
  };
  // Sittings are placed whole where they fit: a task whose sitting does not fit at the cursor waits for a later slot it
  // accepts that is long enough, so a lunch gap or a segment boundary does not cut one session into two blocks. The first
  // free minutes of the window are never skipped this way: a split sitting beats a late start.
  const waitsForLongerSlot = (t: Task, at: Date, slot: Slot) =>
    at > free[0].start && room(t, at, slot) < sitting(t) && free.slice(si + 1).some((s) => accepts(t, s) && room(t, s.start, s) >= sitting(t));

  // Minutes of the task's touching blocks on the day (anchors, plus those placed in this call) that end exactly at `at`.
  const runEndingAt = (t: Task, at: Date) => {
    const blocks = [...(options.anchors?.[t.id] ?? []), ...out.filter((o) => o.taskId === t.id)];
    let run = 0;
    for (let end = at.getTime(), prev = blocks.find((b) => b.end.getTime() === end); prev; prev = blocks.find((b) => b.end.getTime() === end)) {
      run += minutesBetween(prev.start, prev.end);
      end = prev.start.getTime();
    }
    return run;
  };

  while (si < free.length && cursor) {
    if (!order.some(eligibleAnywhere)) break;
    const slot = free[si];
    const available = minutesBetween(cursor, slot.end);
    if (available < minBlockMinutes) { advanceSlot(); continue; }
    const at = cursor;
    const here: Interval = { start: at, end: slot.end }; // what a block placed now could still use of the slot
    const open = order.filter((t) => eligibleAnywhere(t) && accepts(t, here));
    // A weekly task that has already sat two sessions in a row yields the cursor to any other task that can take it; it continues
    // only when nobody else can. The run is the touching blocks of the task on the day that end exactly at the cursor.
    // "Can take it" includes a task that would rather wait for a longer slot: it takes what is here in a shorter sitting
    // (the `yielded` tasks, which the scrap rule below does not hold back) so the run does not stretch to fill the gap.
    const longRun = (t: Task) => t.budgetPeriod === 'week' && runEndingAt(t, at) >= 2 * (t.sessionMinutes ?? maxBlockMinutes);
    const waiters = open.filter((t) => waitsForLongerSlot(t, at, slot));
    const candidates = open.filter((t) => !waiters.includes(t));
    const yielded = new Set(candidates.some(longRun) ? waiters.filter((t) => !longRun(t)) : []);
    if (candidates.length === 0) { advanceSlot(); continue; }

    // Highest score wins; `order` is already sorted by priority then name, so a stable sort keeps that tie-break.
    const pool = [...candidates, ...yielded];
    const scores = new Map(pool.map((t) => [t.id, score(t)]));
    const byScore = [...pool].sort((a, b) => (Math.abs(scores.get(b.id)! - scores.get(a.id)!) <= 1e-9 ? 0 : scores.get(b.id)! - scores.get(a.id)!));
    // Order: tasks that need no waiting, then the waiters taking a short sitting, then the long run (which continues only
    // when none of those places).
    const ranked = [...byScore.filter((t) => !longRun(t) && !yielded.has(t)), ...byScore.filter((t) => yielded.has(t)), ...byScore.filter(longRun)];

    // A whole-sittings pass leaves a scrap (at most half a sitting) for the scrap sweep, except at the window's first free
    // minutes: when no candidate takes them whole, the best one whose sitting continues later in the day takes them,
    // because a split sitting beats a late start. A task whose sitting goes to another day still leaves them.
    const continuesToday = (t: Task) => free.slice(si + 1).some((s) => accepts(t, s));
    let placed = false;
    for (const splitting of options.wholeSittings && at <= (options.windowStart ?? free[0].start) ? [false, true] : [false]) {
      for (const picked of ranked) {
        const sitting = Math.floor(Math.min(rem[picked.id], picked.sessionMinutes ?? maxBlockMinutes) / slotMinutes) * slotMinutes;
        const chunk = Math.min(sitting, Math.floor(room(picked, at, slot) / slotMinutes) * slotMinutes);
        if (chunk < minBlockMinutes) continue;
        // A yielded waiter keeps the half-sitting floor (it takes the short slot only at half its sitting or more); a scrap is never worth it.
        if (options.wholeSittings && (yielded.has(picked) ? chunk * 2 < sitting : chunk * 2 <= sitting && !(splitting && continuesToday(picked)))) continue;

        const start: Date = cursor;
        const end = addMinutes(start, chunk);
        const own = options.anchors?.[picked.id];
        if (own && options.closing?.has(picked.id) && options.wholeSittings && chunk < (picked.sessionMinutes ?? maxBlockMinutes)) {
          const todays = [...own, ...out.filter((o) => o.taskId === picked.id)];
          if (todays.length && !todays.some((o) => o.end.getTime() === start.getTime() || o.start.getTime() === end.getTime())) {
            // A remainder that could still touch one of its blocks whole waits for that spot: free time for all of it right
            // after one of them, or right before one still ahead of the cursor, in the slots left. One that cannot touch
            // anywhere (or only for part of it) takes a second spot on the day, after another task's block (it never
            // opens the day), rather than travelling to a later day.
            const couldTouch = todays.some((o) => free.slice(si).some((s) => {
              const from = s.start > at ? s.start : at;
              return (from <= o.end && o.end < s.end && room(picked, o.end, s) >= sitting) || (o.start > at && s.start < o.start && o.start <= s.end && minutesBetween(from, o.start) >= sitting);
            }));
            const afterAnother = Object.entries(options.anchors ?? {}).some(([id, xs]) => id !== picked.id && xs.some((x) => x.end <= start))
              || out.some((o) => o.taskId !== picked.id && o.end <= start);
            if (couldTouch || !afterAnother) continue;
          }
        }
        out.push({ taskId: picked.id, start, end });
        rem[picked.id] -= chunk;
        periodRemaining[picked.id] = (periodRemaining[picked.id] ?? rem[picked.id] + chunk) - chunk;
        cursor = end;
        // A weekly task's remainder rides with its whole sitting: when what the day still allows the task is shorter than a
        // session and the time right after holds it, it is placed now, touching, so it closes this day instead of waiting
        // for a later one, as long as the free time left after it still holds the other tasks' next sittings (a remainder
        // never takes the room of another task's whole sitting). Never past two sessions in a row.
        const session = picked.sessionMinutes ?? maxBlockMinutes;
        const tail = Math.floor(rem[picked.id] / slotMinutes) * slotMinutes;
        const leftAfter = (at: Date) => free.slice(si).reduce((n, f) => n + Math.max(0, minutesBetween(f.start > at ? f.start : at, f.end)), 0);
        const othersNeed = order.filter((t) => t.id !== picked.id && rem[t.id] >= minBlockMinutes).reduce((n, t) => n + Math.min(rem[t.id], t.sessionMinutes ?? maxBlockMinutes), 0);
        if (options.wholeSittings && picked.budgetPeriod === 'week' && chunk === sitting && tail >= minBlockMinutes && tail < session
          && Math.floor(room(picked, end, slot) / slotMinutes) * slotMinutes >= tail && runEndingAt(picked, end) + tail <= 2 * session
          && leftAfter(addMinutes(end, tail)) >= othersNeed) {
          out.push({ taskId: picked.id, start: end, end: addMinutes(end, tail) });
          rem[picked.id] -= tail;
          periodRemaining[picked.id] -= tail;
          cursor = addMinutes(end, tail);
        }
        placed = true;
        break;
      }
      if (placed) break;
    }
    if (!placed) advanceSlot();
  }
  return out;
}
