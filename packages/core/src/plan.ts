import { randomUUID } from 'node:crypto';
import type { Block, Interval, Settings, Task } from './types.js';
import { MemoryStore, type Store } from './store.js';
import { addDays, addMinutes, atTime, ceilToSlot, minutesBetween, startOfDay } from './time.js';
import { freeIntervals, settingsWithBaseline } from './free.js';
import { normalizeBaseline } from './baseline.js';
import { isFlexible, prefers, segmentOf, splitBySegments } from './segments.js';
import { clip, overlaps, subtractIntervals } from './time.js';
import { allocate } from './allocate.js';
import { periodRange, remainingMinutes, usedMinutes, notTodayMinutes, availableDaysOfPeriod } from './budget.js';
import { expandRecurring, workingIntervals } from './free.js';
import { materializeMissed } from './mark.js';

export type Horizon = 'day' | 'week';

export interface PlanOptions { now: Date; until?: Date; horizon?: Horizon; /** Task ids to place before everything else. */ mustDo?: string[] }
/**
 * `kept`: the planner's own blocks in the window that still fit and stayed as they were; `removed`: how many no longer fit;
 * `displaced`: blocks that still fit but gave way to a must-do task; `extended`: kept blocks of a must-do task that grew to a
 * whole sitting; `later`: sittings added to free time on already planned days after the window (nothing there is moved or
 * removed); `unplaced`: tasks the window's first day gave a share (a sitting of their budget; a weekly task only when the window holds
 * the week's last available day) that got no block anywhere in the window, because the free time was gone (a must-do task and a task that gave way to one, which have their own reports, are not listed),
 * and the `overCap` tasks; `overCap`: tasks with budget left that the per-day cap kept off every window day they wanted
 * (each such day already held `maxTasksPerDay` tasks), so they got no block anywhere in the window (on a day plan only a
 * daily task, or a weekly task with no block anywhere in its week); `weeklyUnmet`: when the window holds the week's last
 * available day, each weekly task (not a must-do one, which has its own note, nor one named under no room) whose week
 * still owes at least a block's worth, with the minutes (the week is over, so they will not be placed), the `overCap` ones included.
 */
export interface PlanResult { created: Block[]; kept: Block[]; later: Block[]; missed: Block[]; removed: number; displaced: Block[]; extended: Block[]; unplaced: Task[]; overCap: Task[]; weeklyUnmet: Array<{ task: Task; minutes: number }>; window: Interval }

export function assertAvailability(settings: Settings) {
  if (settings.availability.length === 0) throw new Error('No availability is set yet. Tell me when you usually work (for example "weekdays 09:00 to 18:00") so I can set it.');
}

/** End of the last availability window that ends after `now`, searching day by day. */
function nextAvailableEnd(now: Date, settings: Settings): Date {
  let day = startOfDay(now);
  for (let i = 0; i < 14; i += 1) {
    const windows = workingIntervals({ start: day, end: addDays(day, 1) }, settings);
    const last = windows[windows.length - 1];
    if (last && last.end > now) return last.end;
    day = addDays(day, 1);
  }
  throw new Error('No availability found in the next two weeks. Check the availability windows in settings.');
}

export function resolveUntil(now: Date, settings: Settings, horizon: Horizon = 'day'): Date {
  assertAvailability(settings);
  if (horizon === 'day') {
    const end = nextAvailableEnd(now, settings);
    // With less than one sitting of today left, a day plan runs through tomorrow too, so the user wakes up to a planned day.
    const leftToday = workingIntervals({ start: now, end: addDays(startOfDay(now), 1) }, settings).reduce((n, w) => n + minutesBetween(w.start, w.end), 0);
    return leftToday > 0 && leftToday < settings.maxBlockMinutes ? nextAvailableEnd(end, settings) : end;
  }
  for (let weeks = 0; weeks < 3; weeks += 1) {
    const weekStart = addDays(periodRange('week', now, settings).start, 7 * weeks);
    const windows = workingIntervals({ start: weekStart, end: addDays(weekStart, 7) }, settings);
    const last = windows[windows.length - 1];
    if (last && last.end > now) return last.end;
  }
  throw new Error('No availability found in the next weeks. Check the availability windows in settings.');
}

function dedupe(blocks: Block[]): Block[] {
  const seen = new Map<string, Block>();
  for (const b of blocks) seen.set(b.id, b);
  return [...seen.values()];
}

const iv = (b: { start: string; end: string }): Interval => ({ start: new Date(b.start), end: new Date(b.end) });

/** Whether `x` lies inside one availability window of its day. */
function insideAvailability(x: Interval, settings: Settings): boolean {
  const day = startOfDay(x.start);
  return workingIntervals({ start: day, end: addDays(day, 1) }, settings).some((w) => w.start <= x.start && x.end <= w.end);
}

/**
 * Plans until a further plan would change nothing. A sweep reads the days before it as they stand when it reaches them,
 * and a later sweep can still add to those days (a scrap, a remainder), so the pacing a first pass saw on a day may differ
 * from what a second identical plan sees there. Running the pass again until it adds nothing makes the result a fixed
 * point: asking again changes nothing. The first pass's report (kept, displaced, extended) stands; what later passes
 * add is merged in, and the reports of unplaced and unmet tasks are the last pass's, less tasks that got a block.
 */
export function plan(store: Store, opts: PlanOptions): PlanResult {
  const first = planOnce(store, opts);
  let result = first;
  for (let i = 0; i < 3; i += 1) {
    const again = planOnce(store, opts);
    if (!again.created.length && !again.later.length && !again.removed) break;
    const alive = (b: Block) => store.getBlock(b.id) !== undefined;
    const byStart = (a: Block, b: Block) => a.start.localeCompare(b.start);
    result = {
      ...result,
      created: [...result.created.filter(alive), ...again.created].sort(byStart),
      later: [...result.later.filter(alive), ...again.later].sort(byStart),
      kept: result.kept.filter(alive),
      removed: result.removed + again.removed,
      unplaced: again.unplaced, overCap: again.overCap, weeklyUnmet: again.weeklyUnmet,
    };
  }
  return result;
}

/**
 * The smallest cap above the current one at which the same plan leaves no weekly budget unmet and no task kept off,
 * found by planning again on a copy of the store: never below the daily tasks plus two (a cap of the daily tasks plus
 * one adds no weekly place beyond the floor of one), at most the daily tasks plus the weekly ones (beyond that the cap
 * bounds no weekly task). Undefined when no cap does: the week's free time, not the cap, is what is short. The summary's
 * advice names it.
 */
export function capThatFits(store: Store, opts: PlanOptions): number | undefined {
  const settings = store.getSettings();
  const count = (period: Task['budgetPeriod']) => store.listTasks().filter((t) => t.budgetPeriod === period && t.budgetMinutes >= settings.minBlockMinutes).length;
  const dailies = count('day');
  const weeklies = count('week');
  for (let cap = Math.max(settings.maxTasksPerDay + 1, dailies + 2); cap <= dailies + weeklies; cap += 1) {
    const copy = new MemoryStore();
    const bundle = store.exportAll();
    copy.saveSettings({ ...bundle.settings, maxTasksPerDay: cap });
    for (const t of store.listTasks(true)) copy.upsertTask(t);
    copy.insertBlocks(bundle.blocks);
    for (const c of bundle.commitments) copy.addCommitment(c);
    for (const r of bundle.recurring) copy.addRecurring(r);
    const baseline = store.getBaseline();
    if (baseline) copy.setBaseline(baseline);
    const r = plan(copy, opts);
    if (!r.weeklyUnmet.length && !r.overCap.length) return cap;
  }
  return undefined;
}

function planOnce(store: Store, opts: PlanOptions): PlanResult {
  // The availability is the baseline's usable spans when a baseline exists, else the settings' windows.
  const settings = settingsWithBaseline(store.getSettings(), store.getBaseline());
  const now = opts.now;
  const start = ceilToSlot(now, settings.slotMinutes);
  const until = opts.until ?? resolveUntil(now, settings, opts.horizon);
  const window: Interval = { start, end: until };

  // 1. Past pending blocks were never marked: they count as missed.
  const missed = materializeMissed(store, now);

  // 2. The planner's own pending blocks that touch the window. Busy time is gathered over their whole span, so a block
  //    that straddles the window edge is still checked against what lies just outside it.
  const tasks = store.listTasks();
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const isOwn = (b: Block) => b.status === 'pending' && (b.source ?? 'planner') === 'planner';
  const own = store.listBlocks({ from: start, to: until }).filter(isOwn);
  const ownIds = new Set(own.map((b) => b.id));
  // Days after the window that the planner already filled. Their blocks are not re-judged; their free time is filled
  // add-only below, so a budget this re-plan reopened (a missed day) lands in the week's holes instead of staying unmet.
  // Days with nothing planned stay unplanned, and `until` keeps its meaning on its own day (a window day).
  const plannedLater = new Set(store.listBlocks({ from: until }).filter(isOwn).map((b) => startOfDay(new Date(b.start)).getTime()));
  const fillEnd = plannedLater.size ? addDays(new Date(Math.max(...plannedLater)), 1) : until;
  const span: Interval = {
    start: new Date(Math.min(start.getTime(), ...own.map((b) => new Date(b.start).getTime()))),
    end: new Date(Math.max(fillEnd.getTime(), ...own.map((b) => new Date(b.end).getTime()))),
  };

  // 3. Busy time the planner plans around: one-off commitments, recurring commitments, and blocks it does not own
  //    (done, hand-placed, baseline), plus its own blocks on the later planned days. One of those that no longer fits (a
  //    commitment added since covers it, or it fell outside the availability) is stale: removed, its day's free time
  //    refilled add-only below. A later block that still fits is not re-judged.
  const laterOwn = store.listBlocks({ from: until, to: span.end }).filter((b) => isOwn(b) && !ownIds.has(b.id)); // a straddler is the window's
  const laterOwnIds = new Set(laterOwn.map((b) => b.id));
  const fixed: Interval[] = [
    ...store.listCommitments({ from: span.start, to: span.end }).map(iv),
    ...expandRecurring(store.listRecurring(), span).map((r) => ({ start: r.start, end: r.end })),
    ...store.listBlocks({ from: span.start, to: span.end })
      .filter((b) => b.status === 'done' || (b.status === 'pending' && !ownIds.has(b.id) && !laterOwnIds.has(b.id)))
      .map(iv),
  ];
  const stale = laterOwn.filter((b) => !insideAvailability(iv(b), settings) || fixed.some((o) => overlaps(o, iv(b))));
  const busy: Interval[] = [...fixed, ...laterOwn.filter((b) => !stale.includes(b)).map(iv)];

  // 4. A planner block that still fits (inside availability, clear of busy time and of the blocks kept before it, its task
  //    still has the budget) stays exactly where it is and counts as busy, so a re-plan adjusts the schedule instead of
  //    regenerating it. The rest are removed and their time is planned again. Earlier blocks are judged first.
  const kept: Block[] = [];
  const keptIds = new Set<string>();
  for (const b of own) {
    const t = taskById.get(b.taskId);
    const x = iv(b);
    let fits = t !== undefined && insideAvailability(x, settings) && !busy.some((o) => overlaps(o, x));
    if (fits && t) {
      const period = periodRange(t.budgetPeriod, x.start, settings);
      const settled = store.listBlocks({ from: period.start, to: period.end }).filter((o) => !ownIds.has(o.id) || keptIds.has(o.id));
      fits = usedMinutes(t, [...settled, b], period) <= t.budgetMinutes;
    }
    if (fits) { kept.push(b); keptIds.add(b.id); busy.push(x); }
  }

  // 4b. A must-do task with no block on the window's first day gets one sitting there even when that day is full: the
  //     cheapest adjacent run of kept planner blocks that makes room gives way. A run costs the sum over its blocks of
  //     0.5 + the task's priority score, so one block of a middling task gives way before two lesser ones and two bottom
  //     hours before one top sitting; then the fewer tasks it would leave with no other sitting in their period, then the
  //     earlier start. Manual and baseline blocks never give way. S8: named tasks are placed first.
  const bestP = Math.min(...tasks.map((t) => t.priority)); const worstP = Math.max(...tasks.map((t) => t.priority));
  const priorityScore = (t: Task) => (worstP === bestP ? 1 : 1 - (t.priority - bestP) / (worstP - bestP)); // 1 best .. 0 worst, as the allocator scores it
  const boost = new Set(opts.mustDo ?? []);
  const displaced: Block[] = [];
  const extended: Block[] = [];
  // The sitting held for each must-do task on the first window day: its allowance there is at least that, whatever the
  // weekly rules say (a task that already has its whole sitting is not here, so asking again adds nothing).
  const mustSit = new Map<string, number>();
  const holdOf = new Map<string, Interval>();
  const firstWindow = workingIntervals(window, settings)[0];
  // Each must-do task's sitting is held in its gap while the next one is checked (two named tasks get two gaps) and through
  // the first day's preference pass, so a task that prefers that segment cannot take the gap before the must-do task does.
  const held: Interval[] = [];
  if (firstWindow) {
    const firstDay: Interval = { start, end: new Date(Math.min(until.getTime(), addDays(startOfDay(firstWindow.start), 1).getTime())) };
    const same = (o: Interval, b: Block) => o.start.getTime() === new Date(b.start).getTime() && o.end.getTime() === new Date(b.end).getTime();
    for (const id of boost) {
      const t = taskById.get(id);
      if (!t) continue;
      const period = periodRange(t.budgetPeriod, firstWindow.start, settings);
      const settled = store.listBlocks({ from: period.start, to: period.end }).filter((o) => !ownIds.has(o.id) || keptIds.has(o.id));
      const session = t.sessionMinutes ?? settings.maxBlockMinutes;
      const rem = remainingMinutes(t, settled, firstWindow.start, settings);
      // The open gaps of the first day with `run` gone: a free gap next to a run counts toward the room it makes.
      const openWithout = (run: Block[]) => freeIntervals(firstDay, busy.filter((o) => !run.some((b) => same(o, b))), settings);
      // What the task has on the first day (the whole calendar day, as the allocator's allowance counts it, not only the
      // window), against the whole sitting it could have there (a session, or all its budget). Less than that, a kept
      // planner block of its grows into the free time right after it when that holds the rest; otherwise a whole sitting
      // is added as for a task that had nothing.
      const dayOf: Interval = { start: startOfDay(firstWindow.start), end: addDays(startOfDay(firstWindow.start), 1) };
      const todays = settled.filter((b) => b.taskId === id && (b.status === 'pending' || b.status === 'done') && overlaps(iv(b), dayOf));
      const have = usedMinutes(t, todays, dayOf);
      const whole = Math.floor(Math.min(session, rem + have) / settings.slotMinutes) * settings.slotMinutes;
      if (have >= whole) continue;
      if (have > 0) {
        const open = openWithout([]);
        const growable = kept.find((b) => b.taskId === id && todays.some((o) => o.id === b.id)
          && open.some((g) => g.start.getTime() === new Date(b.end).getTime() && minutesBetween(g.start, g.end) >= whole - have));
        if (growable) {
          const end = addMinutes(new Date(growable.end), whole - have);
          const o = busy.find((x) => same(x, growable));
          if (o) o.end = end;
          const grown = store.updateBlock(growable.id, { end: end.toISOString() });
          kept[kept.indexOf(growable)] = grown;
          extended.push(grown);
          continue;
        }
        // More than half the sitting that cannot grow already is the day's sitting (a whole-sitting pass would have
        // placed it as one): adding another would make a second identical plan differ from the first.
        if (have * 2 > whole) continue;
      }
      // The sitting the allocator will place: a whole session or the budget left, on the slot grid.
      const sitting = Math.floor(Math.min(rem, session) / settings.slotMinutes) * settings.slotMinutes;
      if (sitting < settings.minBlockMinutes) continue;
      const fits = (g: Interval) => minutesBetween(g.start, g.end) >= sitting;
      if (!openWithout([]).some(fits)) {
        const candidates = kept.filter((b) => !boost.has(b.taskId) && overlaps(iv(b), firstDay)).sort((a, b) => a.start.localeCompare(b.start));
        const cost = (run: Block[]) => run.reduce((n, b) => n + 0.5 + priorityScore(taskById.get(b.taskId)!), 0);
        // Blocks of the run whose task keeps no other sitting (pending or done) in its budget period once the run is gone.
        const orphans = (run: Block[]) => run.filter((b) => {
          const period = periodRange(taskById.get(b.taskId)!.budgetPeriod, new Date(b.start), settings);
          return !store.listBlocks({ from: period.start, to: period.end }).some((o) => o.taskId === b.taskId && (o.status === 'pending' || o.status === 'done')
            && (!ownIds.has(o.id) || (keptIds.has(o.id) && !run.some((v) => v.id === o.id))));
        }).length;
        const cheaper = (a: Block[], b: Block[]) => cost(a) < cost(b) - 1e-9 || (Math.abs(cost(a) - cost(b)) <= 1e-9 && orphans(a) < orphans(b));
        let victims: Block[] | undefined;
        for (let i = 0; i < candidates.length; i += 1) {
          for (let j = i; j < candidates.length; j += 1) {
            const run = candidates.slice(i, j + 1);
            if (victims && !cheaper(run, victims)) break; // a longer run from here only costs more
            if (openWithout(run).some(fits)) { victims = run; break; }
          }
        }
        for (const v of victims ?? []) {
          kept.splice(kept.indexOf(v), 1); keptIds.delete(v.id); displaced.push(v);
          busy.splice(busy.findIndex((o) => same(o, v)), 1);
        }
      }
      const slot = openWithout([]).find(fits);
      if (slot) { const hold = { start: slot.start, end: addMinutes(slot.start, sitting) }; held.push(hold); busy.push(hold); mustSit.set(id, sitting); holdOf.set(id, hold); }
    }
  }
  const toRemove = [...own.filter((b) => !keptIds.has(b.id)), ...stale];
  store.deleteBlocks(toRemove.map((b) => b.id));

  const created: Block[] = [];
  const createdAt = now.toISOString();

  // 5. Sweeps over the days, each day by day so weekly budgets are paced across the remaining work days: whole sittings
  //    with the habit pass and the reclaimed time first, whole sittings again for what the first round could not seat,
  //    then the scraps, first in the segments tasks prefer over all the days and then anywhere, so a preferring task's
  //    scrap lands in its segment on a later day before an off-segment crumb on an earlier one, then, on the period's last
  //    available day, one more whole sitting of a weekly task where free time is left and the week still needs it. A
  //    sitting is never cut into scraps on one day while a later day could still hold it whole. Every sweep keeps the
  //    per-day cap. Each sweep runs on past the window over the later planned days, add-only.
  const inSegment = (t: Task, slot: Interval) => prefers(t, slot, settings);
  const anywhere = () => true;
  const sweeps: Array<[firstRound: boolean, wholeSittings: boolean, extra: boolean, passes: 'both' | 'segment' | 'any']> =
    [[true, true, false, 'both'], [false, true, false, 'both'], [false, false, false, 'segment'], [false, false, false, 'any'], [false, true, true, 'both']];
  // The first minute of the window not taken by a commitment or a block the planner does not own: left empty, it would
  // be a late start. A kept planner block there is not one, so on a re-plan the rule does not move on to the next gap and
  // take a scrap there that the first plan had left whole.
  const windowStart = freeIntervals(window, fixed, settings)[0]?.start;
  // The pending and done blocks of a day: the store's plus this plan's own.
  const onDay = (day: Date) => [...store.listBlocks({ from: day, to: addDays(day, 1) }), ...created]
    .filter((b) => (b.status === 'pending' || b.status === 'done') && new Date(b.start) >= day && new Date(b.start) < addDays(day, 1));
  // The window's first day says little about a habit when the clock cut it at now (the day starts later than its first
  // availability) or a must-do led it: either shaped where its sittings fell, so they are no evidence.
  const firstDay = startOfDay(firstWindow?.start ?? start).getTime();
  const firstDayShaped = (opts.mustDo ?? []).length > 0
    || (workingIntervals({ start: new Date(firstDay), end: addDays(new Date(firstDay), 1) }, settings)[0]?.start ?? start) < start;
  const isEvidence = (b: Block) => (b.status === 'pending' || b.status === 'done') && !(firstDayShaped && startOfDay(new Date(b.start)).getTime() === firstDay);
  const baselineTaskSlots = normalizeBaseline(store.getBaseline())?.slots.filter((s) => s.kind === 'task') ?? [];
  /**
   * Where a task usually sits on `day`: its saved baseline slot on that weekday (the first baseline block of the task that
   * day), else the most common start of its sittings on the other planned days (ties to the earlier time).
   */
  const habitStart = (t: Task, day: Date): { at: Date; saved: boolean; length?: number } | undefined => {
    const saved = baselineTaskSlots.find((b) => b.taskId === t.id && b.day === day.getDay());
    if (saved) return { at: atTime(day, saved.start), saved: true, length: minutesBetween(atTime(day, saved.start), atTime(day, saved.end)) };
    const counts = new Map<number, number>();
    for (const b of dedupe([...store.listBlocks({ from: startOfDay(start), to: fillEnd }), ...created])) {
      if (b.taskId !== t.id || !isEvidence(b) || startOfDay(new Date(b.start)).getTime() === day.getTime()) continue;
      const x = new Date(b.start);
      const minute = x.getHours() * 60 + x.getMinutes();
      counts.set(minute, (counts.get(minute) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    return best ? { at: new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(best[0] / 60), best[0] % 60), saved: false } : undefined;
  };
  // Weekly pacing. A weekly task's sittings are spread over the available days of its week, counted from the week's
  // start whatever the window (so "plan my day" each morning paces the week as one week plan would): S sittings for the
  // whole budget (ceil of the budget over the session), sitting i due on day floor((i + 0.5 + stagger) * D / S) of the
  // week's D available days (the last day at the latest). The stagger, rank / W among the W weekly tasks by priority
  // (0 for the best), sets two tasks on different days: three sittings each over five days sit Mon, Wed, Fri and Tue,
  // Thu, Fri. A day takes a sitting while fewer minutes have been placed on the days before it (kept, hand-placed, done
  // or created; a missed sitting is not placed) than are due by it, catch-up included, one a day; more only when the
  // days left could not hold the rest one a day (the last day takes all that is left), so the budget is still met when
  // the days allow it. A day before the window that had no room, or was never planned, is caught up the same way.
  const sessionOf = (t: Task) => t.sessionMinutes ?? settings.maxBlockMinutes;
  const paceFrom = (period: Interval) => period.start;
  const leftBefore = (t: Task, blocks: Block[], period: Interval, at: Date) => Math.max(0, t.budgetMinutes - usedMinutes(t, blocks.filter((b) => new Date(b.start) < at), period));
  const staggers = new Map<number, Map<string, number>>();
  const staggerOf = (t: Task, period: Interval): number => {
    let ranks = staggers.get(period.start.getTime());
    if (!ranks) {
      const from = paceFrom(period);
      const owed = tasks.filter((u) => u.budgetPeriod === 'week'
        && leftBefore(u, store.listBlocks({ from: period.start, to: period.end }), period, from) >= settings.minBlockMinutes)
        .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
      ranks = new Map(owed.map((u, i) => [u.id, i / owed.length]));
      staggers.set(period.start.getTime(), ranks);
    }
    return ranks.get(t.id) ?? 0;
  };
  /** Whole sittings of weekly task `t` that `day` may hold under the pacing; `blocks` are the task's blocks in the period. */
  const pacedSittings = (t: Task, day: Date, blocks: Block[]): number => {
    const period = periodRange('week', day, settings);
    const days = availableDaysOfPeriod(paceFrom(period), 'week', settings);
    const k = days.findIndex((x) => x.getTime() === day.getTime());
    if (k < 0) return 0;
    const session = sessionOf(t);
    const owedAtStart = leftBefore(t, blocks, period, paceFrom(period));
    const owed = leftBefore(t, blocks, period, day);
    const total = Math.ceil(owedAtStart / session);
    const left = Math.ceil(owed / session);
    if (left <= 0) return 0;
    const daysLeft = days.length - k;
    if (left >= daysLeft) return Math.ceil(left / daysLeft);
    // Placed is counted in minutes, so a sitting a full day could only seat in part is still owed on the next due day.
    const stagger = staggerOf(t, period);
    let due = 0;
    for (let i = 0; i < total; i += 1) if (Math.min(days.length - 1, Math.floor((i + 0.5 + stagger) * days.length / total + 1e-9)) <= k) due += 1;
    return Math.min(owedAtStart, due * session) > owedAtStart - owed ? 1 : 0;
  };
  // The sitting held for a must-do task on the window's first day: its share there is at least that until a block of
  // this plan sits in the held gap. A piece placed elsewhere first (the window's first minutes) does not use it up, so
  // the held gap still goes to the task; once it holds a block, the usual share decides.
  const mustLeft = (t: Task, day: Date) => {
    if (!firstWindow || day.getTime() !== startOfDay(firstWindow.start).getTime()) return 0;
    const hold = holdOf.get(t.id);
    return hold && created.some((b) => b.taskId === t.id && overlaps(iv(b), hold)) ? 0 : mustSit.get(t.id) ?? 0;
  };
  /** A weekly task's whole sittings on `day` under the pacing, and the minutes they come to (`want`, a remainder included). */
  const weeklyDay = (t: Task, day: Date, blocks: Block[]) => {
    const session = sessionOf(t);
    const dayRange = { start: day, end: addDays(day, 1) };
    const skipped = notTodayMinutes(t, blocks, dayRange); // skipped and missed alike
    const today = usedMinutes(t, blocks, dayRange) + skipped;
    const sessions = pacedSittings(t, day, blocks);
    // A remainder, what the period has left after the day's whole sessions when that is shorter than one, closes this
    // day rather than opening a later one, while the day stays within two sessions.
    const owed = leftBefore(t, blocks, periodRange('week', day, settings), day);
    const left = owed - sessions * session;
    // Never more than two sessions on a day in the paced passes; the extra sweep adds one more on the week's last day.
    const want = Math.min(2 * session, sessions > 0 && left > 0 && left < session && owed <= 2 * session ? owed : sessions * session);
    return { session, dayRange, skipped, today, sessions, want };
  };
  // The days after `day` in its week must hold what the weekly tasks still owe beyond `day`: their free time less what
  // the daily tasks need there (a later day this plan only fills add-only takes one whole sitting of a task that has
  // nothing there). The cap is not counted: a week the cap keeps weekly tasks out of is the user's setting, named in the
  // summary, not a reason to crowd the one day that has a free place. When the later days cannot hold it, for one task
  // or for all of them together, `day` holds the difference ahead of the pacing: one more whole sitting per
  // task at most, within two sessions on the day; together, the best-ranked first (as the day ranking scores them) while
  // the shortfall left is at least half a sitting. So a week whose free time just holds its budgets still meets them.
  // Worked out once per window day, before it is planned, from what the week owes with the day's own blocks and the
  // planner's later sittings counted back in, so a second identical plan finds the same targets: each such task's
  // target minutes on the day.
  const ahead = new Map<number, Map<string, number>>();
  const aheadOf = (day: Date): Map<string, number> => {
    const known = ahead.get(day.getTime());
    if (known) return known;
    const out = new Map<string, number>();
    ahead.set(day.getTime(), out);
    if (workingIntervals({ start: day, end: addDays(day, 1) }, settings).length === 0) return out;
    const period = periodRange('week', day, settings);
    const inPeriod = dedupe([...store.listBlocks({ from: period.start, to: period.end }), ...created]);
    // The planner's own pending sittings of weekly tasks on the later days are counted back in, as free time there and as
    // what their tasks still owe, so a second identical plan (which finds them kept) sees the same week as the first.
    const isWeeklyOwn = (b: Block) => b.status === 'pending' && (b.source ?? 'planner') === 'planner' && taskById.get(b.taskId)?.budgetPeriod === 'week';
    const later = availableDaysOfPeriod(addDays(day, 1), 'week', settings).filter((j) => j < period.end).map((j) => {
      const r: Interval = { start: j, end: addDays(j, 1) };
      const all = dedupe([...store.listBlocks({ from: j, to: r.end }), ...created]).filter((b) => (b.status === 'pending' || b.status === 'done') && new Date(b.start) >= j && new Date(b.start) < r.end);
      const live = all.filter((b) => !isWeeklyOwn(b));
      const taken = [...store.listCommitments({ from: j, to: r.end }).map(iv), ...expandRecurring(store.listRecurring(), r).map((o) => ({ start: o.start, end: o.end })), ...live.map(iv)];
      const free = freeIntervals(r, taken, settings).reduce((n, f) => n + minutesBetween(f.start, f.end), 0);
      const daily = tasks.filter((t) => t.budgetPeriod === 'day').reduce((n, t) => n + Math.max(0, t.budgetMinutes - usedMinutes(t, live, r)), 0);
      return { live, room: Math.max(0, free - daily), addOnly: j >= until && plannedLater.has(j.getTime()) };
    });
    const ownLater = (t: Task) => inPeriod.filter((b) => b.taskId === t.id && isWeeklyOwn(b) && new Date(b.start) >= addDays(day, 1)).reduce((n, b) => n + minutesBetween(new Date(b.start), new Date(b.end)), 0);
    const wanting = tasks.filter((t) => t.budgetPeriod === 'week').map((t) => {
      const blocks = inPeriod.filter((b) => b.taskId === t.id);
      const w = weeklyDay(t, day, blocks);
      // What the week needs from this day on: the day's own blocks and the planner's later sittings counted back in.
      const owed = remainingMinutes(t, blocks, day, settings) + w.today + ownLater(t);
      const roomLater = later.reduce((n, j) => n + (j.addOnly ? (j.live.some((b) => b.taskId === t.id) ? 0 : Math.min(j.room, w.session)) : j.room), 0);
      const most = Math.min(owed, w.want + w.session, Math.max(w.want, 2 * w.session));
      const grid = (m: number) => Math.floor(m / settings.slotMinutes) * settings.slotMinutes;
      const target = grid(Math.min(most, Math.max(w.want, owed - roomLater)));
      return { t, w, owed, most: grid(most), target };
    }).filter((x) => x.w.skipped === 0 && x.owed >= settings.minBlockMinutes);
    if (!wanting.length) return out;
    const roomAll = later.reduce((n, j) => n + (j.addOnly ? Math.min(j.room, wanting.filter((x) => !j.live.some((b) => b.taskId === x.t.id)).reduce((m, x) => m + x.w.session, 0)) : j.room), 0);
    let short = wanting.reduce((n, x) => n + x.owed, 0) - roomAll - wanting.reduce((n, x) => n + Math.max(x.target, x.w.want), 0);
    const score = (x: (typeof wanting)[number]) => settings.weights.priority * priorityScore(x.t) + settings.weights.deficit * ((x.owed - x.w.want) / Math.max(1, x.t.budgetMinutes));
    for (const x of [...wanting].sort((a, b) => score(b) - score(a) || a.t.priority - b.t.priority || a.t.name.localeCompare(b.t.name))) {
      // A whole sitting more only for a shortfall of at least half of it: a few minutes short is not worth a sitting.
      if (short * 2 < x.w.session) continue;
      const raised = Math.max(x.target, x.most);
      if (raised - x.target < settings.minBlockMinutes) continue;
      short -= raised - x.target;
      x.target = raised;
    }
    for (const x of wanting) if (x.target > x.w.want) out.set(x.t.id, x.target);
    return out;
  };
  // Tasks the per-day cap kept off a window day that had free time while they wanted a share of it.
  const refusedByCap = new Set<string>();
  let firstShares: Set<string> | undefined;
  for (const [firstRound, wholeSittings, extra, passes] of sweeps) {
    for (let day = startOfDay(start); day < fillEnd; day = addDays(day, 1)) {
      const inWindow = day < until;
      if (!inWindow && !plannedLater.has(day.getTime())) continue;
      const dayEnd = addDays(day, 1);
      const dayWindow: Interval = { start: day < start ? start : day, end: inWindow && dayEnd > until ? until : dayEnd };
      let remainingFree = freeIntervals(dayWindow, busy, settings);
      // A gap held for a must-do task belongs to the window's first available day: it opens there and nowhere earlier (an
      // empty day the sweep iterates first, when the plan was asked after hours, must not release it).
      const holdsToday = held.length > 0 && !!firstWindow && day.getTime() === startOfDay(firstWindow.start).getTime();
      const boost = new Set(inWindow ? opts.mustDo ?? [] : []); // must-do means today, not the later add-only days

      const at = dayWindow.start;
      // Other in-window days with free time: while one of them has nothing of a weekly task, the task waits for it rather
      // than topping up a day that already holds a sitting of it, and a remainder here may only close that sitting. Free
      // time is judged without the planner's own blocks, so the day this plan fills later in its sweeps (or a second
      // identical plan finds full) reads the same.
      const otherOpen: Date[] = [];
      for (let d2 = startOfDay(start); d2 < until; d2 = addDays(d2, 1)) {
        if (d2.getTime() !== day.getTime() && freeIntervals({ start: d2 < start ? start : d2, end: addDays(d2, 1) }, fixed, settings).length) otherOpen.push(d2);
      }
      const waiting = new Set<string>();
      const remaining: Record<string, number> = {};
      const periodRemaining: Record<string, number> = {};
      const periodBudget: Record<string, number> = {};
      const rankRemaining: Record<string, number> = {};
      const started = new Set<string>();
      const due = new Set<string>(); // weekly tasks whose paced sittings fall on this day
      for (const t of tasks) {
        const period = periodRange(t.budgetPeriod, at, settings);
        const blocks = dedupe([...store.listBlocks({ from: period.start, to: period.end }), ...created]).filter((b) => b.taskId === t.id);
        const rem = remainingMinutes(t, blocks, at, settings);
        periodRemaining[t.id] = rem;
        periodBudget[t.id] = t.budgetMinutes;
        // A weekly task works in whole sessions, as many as the pacing gives the day (see `pacedSittings`), so weekly
        // tasks alternate across days and the budget is still met by the end of the week. A day that already held a
        // sitting of it before this plan (kept or hand-placed) takes no top-up while the task is on track and another day
        // is open for it: the minutes it still needs land on a day with nothing of it, as on the add-only later days, where
        // a top-up next to a sitting would be a scrap. Otherwise the time it already has today uses the allowance up. A
        // later day (add-only) takes one whole sitting, and only when the task has nothing there yet; catching up belongs
        // to the days the user asked to plan.
        // The last sweep relaxes the allowance on the period's last available day where free time is left: one more
        // whole sitting, up to three sessions on that day (the week is over; what it cannot hold is named as unmet).
        if (t.budgetPeriod === 'week') {
          const { session, dayRange, skipped, today, sessions, want: paced } = weeklyDay(t, day, blocks);
          if (sessions > 0) due.add(t.id);
          // A target ahead of the pacing (the later days cannot hold what the week owes) holds in every sweep, so what a
          // whole sitting could not seat is still placed today and a second plan finds nothing to add.
          const target = inWindow ? aheadOf(day).get(t.id) ?? 0 : 0;
          const want = Math.max(paced, target);
          const onDay = (d2: Date) => blocks.some((b) => (b.status === 'pending' || b.status === 'done') && new Date(b.start) >= d2 && new Date(b.start) < addDays(d2, 1));
          if (otherOpen.some((d2) => !onDay(d2))) waiting.add(t.id);
          // Not when the later days could not hold what the week still needs (a target ahead of the pacing).
          const heldBefore = sessions <= 1 && !target && waiting.has(t.id) && usedMinutes(t, blocks.filter((b) => !created.includes(b)), dayRange) > 0;
          const days = availableDaysOfPeriod(day, 'week', settings);
          const lastDay = days.length > 0 && days[days.length - 1].getTime() === day.getTime();
          // A day the task was skipped or missed on takes nothing more of it, whatever the share: skipped and missed mean not today. Only a
          // must-do overrides, through the sitting held for it below.
          const allowance = heldBefore || skipped > 0 ? 0 : extra ? (lastDay ? Math.min(session, 3 * session - today) : 0) : want - today;
          // A must-do task gets at least the sitting held for it on the window's first day.
          const must = mustLeft(t, day);
          remaining[t.id] = Math.min(rem, inWindow ? Math.max(0, allowance, must) : today ? 0 : session);
        } else {
          // A skipped or missed block means not today: its minutes stay owed to the period but the day takes nothing more of the task.
          // A must-do naming the task overrides it and gets the sitting held for it again.
          const dayRange = { start: day, end: addDays(day, 1) };
          const must = mustLeft(t, day);
          remaining[t.id] = notTodayMinutes(t, blocks, dayRange) > 0 ? Math.min(rem, must) : rem;
        }
        // The day ranking uses what the period still needs before anything was placed on this day, so a kept or hand-placed
        // block does not lower its task's rank and a re-plan admits the tasks a fresh plan would.
        const todays = blocks.filter((b) => b.status === 'pending' && new Date(b.start) >= day && new Date(b.start) < addDays(day, 1));
        if (todays.length) started.add(t.id);
        rankRemaining[t.id] = remainingMinutes(t, blocks.filter((b) => !todays.includes(b)), at, settings);
      }

      // What the window's first day gives each task, taken before its free time is looked at: a day with nothing free still
      // owes the task its share, and a share that finds no room is reported (see `unplaced`).
      if (firstWindow && firstShares === undefined && day.getTime() === startOfDay(firstWindow.start).getTime()) {
        firstShares = new Set(tasks.filter((t) => remaining[t.id] >= settings.minBlockMinutes).map((t) => t.id));
      }
      if (remainingFree.length === 0 && !holdsToday) continue;

      // Which tasks get this day is decided by score (must-do, then priority and deficit), so a high-priority task is never
      // crowded out of the per-day cap by low-priority tasks that merely prefer a segment. The cap is the user's dial for
      // how many things a day: on every sweep a day admits a task only when it already has a live block there or the
      // day's distinct live tasks (any source, pending or done) are fewer than the cap; free time on a day at the cap stays
      // free. A must-do task is admitted whatever the count.
      const dayBoost = firstWindow && day.getTime() === startOfDay(firstWindow.start).getTime() ? boost : new Set<string>();
      const dayScore = (t: Task) => (dayBoost.has(t.id) ? 10 : 0)
        + settings.weights.priority * priorityScore(t)
        + settings.weights.deficit * (rankRemaining[t.id] / Math.max(1, periodBudget[t.id]));
      const eligible = tasks.filter((t) => started.has(t.id) || remaining[t.id] >= settings.minBlockMinutes)
        .sort((a, b) => dayScore(b) - dayScore(a) || a.priority - b.priority || a.name.localeCompare(b.name));
      // Each sweep admits the day's live tasks and its must-do tasks, then the best daily tasks up to the cap in total;
      // a day that already holds the cap's worth of tasks admits no newcomer there. Weekly tasks get the places the
      // daily ones leave, and at least one, so the cap never starves weekly work: a day holds max(1, cap - its daily
      // tasks) weekly tasks, the ones whose paced sitting falls on the day first, then by score.
      const isWeekly = (id: string) => taskById.get(id)?.budgetPeriod === 'week';
      const admitted = new Set([...onDay(day).map((b) => b.taskId), ...eligible.filter((t) => dayBoost.has(t.id)).map((t) => t.id)]);
      for (const t of eligible) if (t.budgetPeriod !== 'week' && admitted.size < settings.maxTasksPerDay) admitted.add(t.id);
      const weeklyPlaces = Math.max(1, settings.maxTasksPerDay - [...admitted].filter((id) => !isWeekly(id)).length);
      let weeklies = [...admitted].filter(isWeekly).length;
      for (const t of eligible.filter((u) => u.budgetPeriod === 'week' && !admitted.has(u.id)).sort((a, b) => Number(due.has(b.id)) - Number(due.has(a.id)))) {
        if (weeklies < weeklyPlaces) { admitted.add(t.id); weeklies += 1; }
      }
      // A task whose block a new commitment covered keeps its claim on what the commitment left of that block's time: the
      // first sweep admits it for that time only. A block that gave way to a must-do is not reclaimed.
      const reclaimed = (t: Task): Interval[] => toRemove
        .filter((b) => b.taskId === t.id && !displaced.includes(b) && new Date(b.start) >= day && new Date(b.start) < dayEnd).map(iv);
      const claimOnly = new Set(firstRound ? eligible.filter((t) => !admitted.has(t.id) && reclaimed(t).length).map((t) => t.id) : []);
      for (const id of claimOnly) admitted.add(id);
      if (inWindow) for (const t of eligible) if (!admitted.has(t.id) && remaining[t.id] >= settings.minBlockMinutes) refusedByCap.add(t.id);
      const dayTasks = eligible.filter((t) => admitted.has(t.id));

      // Tasks that prefer a segment claim it first; then every task competes by score for the rest, so a high-priority
      // task whose segment is already gone still outranks flexible tasks in the leftover time. In a whole-sittings sweep
      // it does so only where its sitting fits whole: a scrap of the leftover goes to a task that does not mind the hour.
      const wholeOutside = (t: Task, here: Interval) => isFlexible(t) || minutesBetween(here.start, here.end) >= Math.min(remaining[t.id], t.sessionMinutes ?? settings.maxBlockMinutes);
      // Daily sittings go before weekly ones: a daily budget belongs to its day, while a weekly sitting can move to
      // another day of the week.
      const lead = new Set(wholeSittings ? tasks.filter((t) => t.budgetPeriod === 'day').map((t) => t.id) : []);
      const flexiblePass = wholeSittings ? wholeOutside : anywhere;
      // A claim comes first, judged on the freed part of the old block as it is (not cut at a segment edge): what a
      // commitment left of a sitting that ran past the edge is still that task's when it holds more than half the sitting.
      const reclaim = (t: Task, here: Interval) => claimOnly.has(t.id) && reclaimed(t).some((s) => overlaps(s, here));
      const freedParts = () => eligible.filter((t) => claimOnly.has(t.id)).flatMap(reclaimed)
        .flatMap((s) => remainingFree.map((f) => clip(s, f)))
        .filter((x): x is Interval => !!x && minutesBetween(x.start, x.end) >= settings.minBlockMinutes)
        .sort((a, b) => a.start.getTime() - b.start.getTime());
      // Turns allocations into this plan's blocks: the day's busy time, free time and the tasks' shares all move with them.
      const apply = (allocations: ReturnType<typeof allocate>) => {
        for (const a of allocations) {
          const b: Block = {
            id: randomUUID(), taskId: a.taskId, start: a.start.toISOString(), end: a.end.toISOString(),
            status: 'pending', source: 'planner', createdAt, statusChangedAt: null,
          };
          created.push(b);
          busy.push({ start: a.start, end: a.end });
          remaining[a.taskId] -= (a.end.getTime() - a.start.getTime()) / 60_000;
        }
        remainingFree = subtractIntervals(remainingFree, allocations.map((a) => ({ start: a.start, end: a.end })));
      };
      // The habitual slot: a task lands where it usually sits (its saved baseline slot on this weekday, else the most
      // common start of its sittings on the other planned days: kept, hand-placed or placed earlier in this plan) whenever
      // that slot is free for a whole sitting and inside a segment the task accepts. A week then reads like a timetable; a
      // commitment moves the task on that day only. Daily tasks go first, as in the passes below; one sitting at most.
      if (firstRound && wholeSittings) {
        const habitual = dayTasks.filter((t) => !claimOnly.has(t.id))
          .sort((a, b) => Number(dayBoost.has(b.id)) - Number(dayBoost.has(a.id)) || Number(lead.has(b.id)) - Number(lead.has(a.id)));
        // A saved baseline slot is a reservation: a task takes it whenever it is free, whatever floats above it. A learned
        // habit gives way to higher-ranked tasks that have no slot of their own (floaters) when the free time outside the
        // habit could not hold them, each whole in time it accepts: a morning task is not given the afternoon, and several
        // floaters need room together (otherwise weekly tasks would stop rotating by deficit and a task a commitment
        // displaced would not be re-placed first on a full day). Floaters are placed by the passes below.
        const sittingOf = (t: Task) => Math.floor(Math.min(remaining[t.id], t.sessionMinutes ?? settings.maxBlockMinutes) / settings.slotMinutes) * settings.slotMinutes;
        const habits = new Map(habitual.map((t) => [t.id, habitStart(t, day)] as const));
        // A saved slot shorter than the sitting caps it, so the sitting does not run into the next saved slot; the rest of
        // the session is placed by the passes below.
        const habitSitting = (t: Task, sitting: number) => {
          const length = habits.get(t.id)?.length;
          return length !== undefined && length >= settings.minBlockMinutes ? Math.min(sitting, Math.floor(length / settings.slotMinutes) * settings.slotMinutes) : sitting;
        };
        const floaters: Array<{ task: Task; sitting: number }> = [];
        // Whether the floaters fit in the free time left once `slot` and the saved slots of the tasks after `i` are taken:
        // per segment for those that prefer one, in total for all of them (a flexible floater takes any segment).
        const floatersFit = (slot: Interval, i: number) => {
          const reserved = habitual.slice(i + 1).filter((t) => habits.get(t.id)?.saved)
            .map((t) => ({ start: habits.get(t.id)!.at, end: addMinutes(habits.get(t.id)!.at, habitSitting(t, sittingOf(t))) }));
          const room = new Map<string, number>();
          let total = 0;
          for (const piece of splitBySegments(subtractIntervals(remainingFree, [slot, ...reserved]), settings)) {
            const minutes = minutesBetween(piece.start, piece.end);
            const segment = segmentOf(piece.start, settings);
            room.set(segment, (room.get(segment) ?? 0) + minutes);
            total += minutes;
          }
          const need = new Map<string, number>();
          for (const f of floaters) if (!isFlexible(f.task)) need.set(f.task.preferredSegment!, (need.get(f.task.preferredSegment!) ?? 0) + f.sitting);
          return floaters.reduce((n, f) => n + f.sitting, 0) <= total && [...need].every(([segment, minutes]) => minutes <= (room.get(segment) ?? 0));
        };
        habitual.forEach((t, i) => {
          const sitting = sittingOf(t);
          if (sitting < settings.minBlockMinutes) return;
          const habit = habits.get(t.id);
          const slot = habit && { start: habit.at, end: addMinutes(habit.at, habitSitting(t, sitting)) };
          const yields = !!slot && !habit.saved && !floatersFit(slot, i);
          if (!slot || yields || !remainingFree.some((f) => f.start <= slot.start && slot.end <= f.end) || (!isFlexible(t) && !prefers(t, slot, settings))) { floaters.push({ task: t, sitting }); return; }
          const placedHere = allocate([slot], [t], { ...remaining, [t.id]: Math.min(remaining[t.id], habitSitting(t, sitting)) }, settings, { wholeSittings: true, anchors: { [t.id]: onDay(day).filter((b) => b.taskId === t.id).map(iv) }, closing: waiting, periodRemaining, periodBudget, windowStart });
          apply(placedHere);
          // A weekly task's remainder rides with the sitting at its habit, as in the passes below (see `allocate`): only
          // while the free time left after it still holds the day's other tasks' next sittings.
          const end = placedHere[placedHere.length - 1]?.end;
          const tail = Math.floor(remaining[t.id] / settings.slotMinutes) * settings.slotMinutes;
          const othersNeed = dayTasks.filter((u) => u.id !== t.id && remaining[u.id] >= settings.minBlockMinutes).reduce((n, u) => n + Math.min(remaining[u.id], sessionOf(u)), 0);
          const leftAfter = end ? subtractIntervals(remainingFree, [{ start: end, end: addMinutes(end, tail) }]).reduce((n, f) => n + minutesBetween(f.start, f.end), 0) : 0;
          const savedSlot = habits.get(t.id)?.saved === true; // a saved baseline slot is a reservation of its own length: no rider past it
          if (end && t.budgetPeriod === 'week' && !savedSlot && tail >= settings.minBlockMinutes && tail < sessionOf(t)
            && minutesBetween(slot.start, end) + tail <= 2 * sessionOf(t) && remainingFree.some((f) => f.start.getTime() === end.getTime() && minutesBetween(f.start, f.end) >= tail)
            && leftAfter >= othersNeed) {
            apply([{ taskId: t.id, start: end, end: addMinutes(end, tail) }]);
          }
        });
      }
      // Daily tasks lead across the whole-sitting passes, not only within one: a daily task's whole sitting (its segment
      // first, then anywhere it accepts) is placed before a weekly task's segment pass can take the slot, since a daily
      // budget belongs to its day while a weekly sitting can move. A must-do task is left to the general passes, where
      // its boost leads and the gap held for it opens.
      const dailyLeads = (t: Task) => t.budgetPeriod === 'day' && !dayBoost.has(t.id);
      const dailySegment = (t: Task, here: Interval) => dailyLeads(t) && inSegment(t, here);
      const dailyFlexible = (t: Task, here: Interval) => dailyLeads(t) && flexiblePass(t, here);
      const passList = passes === 'segment' ? [inSegment] : passes === 'any' ? [anywhere] : [dailySegment, dailyFlexible, inSegment, flexiblePass];
      const laterDayInWeek = availableDaysOfPeriod(dayEnd, 'week', settings).some((j) => j < periodRange('week', day, settings).end);
      for (const accepts of [...(firstRound && claimOnly.size ? [reclaim] : []), ...passList]) {
        // The gaps held for must-do tasks open for the flexible pass, where the boosted task ranks first.
        if (accepts === flexiblePass && holdsToday && held.length) { for (const hold of held.splice(0)) busy.splice(busy.indexOf(hold), 1); remainingFree = freeIntervals(dayWindow, busy, settings); }
        // Only the preference pass needs slots cut at segment boundaries; flexible tasks may span them.
        const slots = accepts === reclaim ? freedParts() : accepts === inSegment || accepts === dailySegment ? splitBySegments(remainingFree, settings) : remainingFree;
        const claims = firstRound && accepts !== reclaim ? (t: Task, here: Interval) => accepts(t, here) && (!claimOnly.has(t.id) || reclaimed(t).some((s) => overlaps(s, here))) : accepts;
        // Each task's blocks on this day so far: a waiting task's remainder is placed touching one of them where it can
        // (see `allocate`), and a long run yields. Every task's blocks are given, so a remainder's second spot is judged
        // against the other tasks' blocks too.
        const onDayNow = onDay(day);
        const anchors: Record<string, Interval[]> = {};
        for (const b of onDayNow) (anchors[b.taskId] ??= []).push(iv(b));
        // A weekly task that prefers a segment takes no sitting outside it while a later available day of its week remains:
        // the pacing lets it catch up there. On the week's last day it takes what is free, so no budget the days could hold
        // is left unmet; a must-do task and a reclaimed claim are not held back. Nor is a remainder of a task that already
        // holds a whole sitting on the day: it closes that day (touching the sitting, or in a second spot when it cannot)
        // before it would travel to a later day.
        const remainderHere = (t: Task) => remaining[t.id] < sessionOf(t)
          && (anchors[t.id] ?? []).reduce((n, x) => n + minutesBetween(x.start, x.end), 0) >= sessionOf(t);
        const admits = accepts === reclaim ? claims : (t: Task, here: Interval) => claims(t, here)
          && !(laterDayInWeek && t.budgetPeriod === 'week' && !isFlexible(t) && !dayBoost.has(t.id) && !remainderHere(t) && !prefers(t, here, settings));
        apply(allocate(slots, dayTasks, remaining, settings, { accepts: admits, boost: dayBoost, lead, anchors, closing: waiting, periodRemaining, periodBudget, wholeSittings, windowStart }));
      }
    }
  }

  created.sort((a, b) => a.start.localeCompare(b.start));
  store.insertBlocks(created);
  const inWindowBlocks = [...store.listBlocks({ from: start, to: until }), ...created].filter((b) => (b.status === 'pending' || b.status === 'done') && new Date(b.start) >= start && new Date(b.start) < until);
  // A weekly sitting can move to another day, so a weekly task counts only when the window holds the week's last day with availability.
  const weekIsLast = !!firstWindow && workingIntervals({ start: until, end: periodRange('week', firstWindow.start, settings).end }, settings).length === 0;
  const week = firstWindow ? periodRange('week', firstWindow.start, settings) : undefined;
  const liveInWeek = (t: Task) => !!week && store.listBlocks({ from: week.start, to: week.end }).some((b) => b.taskId === t.id && (b.status === 'pending' || b.status === 'done'));
  // The cap kept a task off: on a week plan, off every day it wanted; on a day plan only a task with no block anywhere in
  // its week counts (a daily task's budget is the day's, so today is enough), since a weekly task kept off today may be on
  // track on another day, and its shortfall, if any, is named on the week's last day below.
  const overCap = tasks.filter((t) => refusedByCap.has(t.id) && !boost.has(t.id) && !inWindowBlocks.some((b) => b.taskId === t.id)
    && (opts.horizon === 'week' || t.budgetPeriod === 'day' || !liveInWeek(t)));
  // A task the cap refused is never "no room": the free time was there.
  const unplaced = tasks.filter((t) => overCap.includes(t) || ((t.budgetPeriod === 'day' || weekIsLast) && firstShares?.has(t.id) && !boost.has(t.id) && !refusedByCap.has(t.id)
    && !displaced.some((b) => b.taskId === t.id) && !inWindowBlocks.some((b) => b.taskId === t.id)));
  // On the week's last day every weekly shortfall is named, whatever the cap sentence says; a must-do task has its own
  // note and a task named under "no room" is not named twice.
  const weeklyUnmet = !week || !weekIsLast ? [] : tasks.filter((t) => t.budgetPeriod === 'week' && !boost.has(t.id) && (overCap.includes(t) || !unplaced.includes(t)))
    .map((t) => ({ task: t, minutes: remainingMinutes(t, store.listBlocks({ from: week.start, to: week.end }), week.start, settings) }))
    .filter((x) => x.minutes >= settings.minBlockMinutes);
  return { created: created.filter((b) => new Date(b.start) < until), kept, later: created.filter((b) => new Date(b.start) >= until), missed, removed: toRemove.length - displaced.length, displaced, extended, unplaced, overCap, weeklyUnmet, window };
}
