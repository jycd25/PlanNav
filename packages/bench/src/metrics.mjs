// Friction metrics over a planner state. Pure functions; the state is a plain snapshot of the store.
// All minutes are integers; lower is better everywhere.
import { addDays, atTime, expandRecurring, mergeIntervals, periodRange, remainingMinutes, segmentOf, startOfDay, subtractIntervals, usedMinutes, workingIntervals } from '@ds/core';

const MIN = 60_000;
const mins = (a, b) => Math.round((b.getTime() - a.getTime()) / MIN);
const iv = (b) => ({ start: new Date(b.start), end: new Date(b.end) });
const isLive = (b) => b.status === 'pending' || b.status === 'done';
const isPlanner = (b) => (b.source ?? 'planner') === 'planner';
const isProtected = (b) => !isPlanner(b);
/** The product's blocks: the planner's, the baseline's copies, and those an instance operation adjusted; never a hand-placed one. */
const isOwned = (b) => (b.source ?? 'planner') !== 'manual';
/** "2026-10-12T14:00" (no offset) -> local Date, as the replay reads scenario times. */
const localTime = (s) => {
  if (s instanceof Date) return s;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s ?? '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) : new Date(s);
};
const sessionOf = (t, settings) => t.sessionMinutes ?? settings.maxBlockMinutes;
const dayRange = (day) => ({ start: startOfDay(day), end: addDays(startOfDay(day), 1) });
const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const sum = (xs) => xs.reduce((n, x) => n + x, 0);
/** `now` when `day` is today (the past is never room), else null: the whole day counts. */
const fromOn = (day, now) => (startOfDay(day).getTime() === startOfDay(now).getTime() ? now : null);

export function daysIn(range) {
  const out = [];
  for (let day = startOfDay(range.start); day < range.end; day = addDays(day, 1)) out.push(day);
  return out;
}

/** Everything that occupies time on a day: live blocks, commitments, recurring occurrences. */
export function busyOn(state, day) {
  const r = dayRange(day);
  return mergeIntervals([
    ...state.blocks.filter(isLive).map(iv),
    ...state.commitments.map(iv),
    ...expandRecurring(state.recurring, r).map((x) => ({ start: x.start, end: x.end })),
  ].filter((x) => overlaps(x, r)).map((x) => ({ start: x.start < r.start ? r.start : x.start, end: x.end > r.end ? r.end : x.end })));
}

/** Availability minus everything busy on a day, from `from` on, however short. */
function rawFree(state, day, from = null) {
  const r = dayRange(day);
  const avail = workingIntervals(r, state.settings).map((w) => (from && w.start < from ? { start: from, end: w.end } : w)).filter((w) => w.end > w.start);
  return subtractIntervals(avail, busyOn(state, day));
}

/** Free availability spans on a day, dropping spans shorter than minBlockMinutes. */
export function freeSpans(state, day, from = null) {
  return rawFree(state, day, from).filter((f) => mins(f.start, f.end) >= state.settings.minBlockMinutes);
}

const insideAvailability = (state, b) => {
  const r = dayRange(new Date(b.start));
  const x = iv(b);
  return workingIntervals(r, state.settings).some((w) => w.start <= x.start && x.end <= w.end);
};

/**
 * Instance events (baseline-first): operations on the real week, which the product owns. apply_baseline lays the
 * baseline on a week; shift_day, carve_out and carry_over adjust one day of it. Their hard checks judge the blocks they
 * laid or moved (any source but manual) and protect manual and done blocks only: moving baseline blocks is their job.
 */
export const INSTANCE_EVENTS = new Set(['apply_baseline', 'shift_day', 'carve_out', 'carry_over']);
/**
 * Events that change the plan. Only these are judged on the day's shape and the hard constraints. The product rule is
 * that every other event (advance, mark_done, mark_skipped, add_commitment, extend_availability, move_block) never
 * auto-plans, so scoring the day after one of them measured that ruling, not the planner's friction; they are scored
 * for churn only (and a thrown error or a slow call still counts). import_baseline changes the template, not the week
 * (the week changes when apply_baseline lays it), so it is scored for churn and the hard checks only: it must not
 * touch a block.
 */
export const PLANNER_EVENTS = new Set(['plan', 'replan_until', 'clear_schedule', ...INSTANCE_EVENTS]);
const HARD_EVENTS = new Set([...PLANNER_EVENTS, 'import_baseline']);
/** The instance operations that move blocks at the user's request; `consistency` is not scored after them (the user asked for the off-hour start). */
export const ADJUST_EVENTS = new Set(['shift_day', 'carve_out', 'carry_over']);
/** The user's own block edits: the change is theirs, so churn is not scored after them either. */
export const USER_EDIT_EVENTS = new Set(['move_block', 'add_block']);
export const METRICS = ['churn', 'holes', 'blobs', 'splinters', 'off_segment', 'budget_miss', 'must_do_miss', 'switches', 'late_start', 'consistency'];

/** The fixed time on a day: commitments and recurring occurrences. */
const fixedOn = (state, day) => [...state.commitments.map(iv), ...expandRecurring(state.recurring, dayRange(day)).map((o) => ({ start: o.start, end: o.end }))];

/**
 * Pending planner blocks that overlap a commitment or a recurring occurrence, on any day, and the minutes they share.
 * Counted after every event: a commitment that lands on a block leaves it there until the next plan (the product never
 * auto-plans), so after the user's events the count is information; after a planner event it is a hard violation
 * (`block_under_commitment`): a plan that leaves its own pending block under a commitment it knows about, on any day,
 * has produced a schedule the user cannot follow.
 */
export function underCommitment(state) {
  let blocks = 0; let minutes = 0;
  for (const b of state.blocks.filter((b) => b.status === 'pending' && isOwned(b))) {
    const x = iv(b);
    const shared = sum(mergeIntervals(fixedOn(state, x.start)).filter((o) => overlaps(o, x)).map((o) => mins(o.start > x.start ? o.start : x.start, o.end < x.end ? o.end : x.end)));
    if (shared > 0) { blocks += 1; minutes += shared; }
  }
  return { blocks, minutes };
}

/** Hard-constraint violations after a planner event. Any entry makes the experiment a crash. Other events (a commitment added over a block) are judged by churn and holes at the next plan. */
export function hardViolations(before, after, event) {
  const out = [];
  const type = event?.type;
  if (!HARD_EVENTS.has(type)) return out;
  const afterById = new Map(after.blocks.map((b) => [b.id, b]));
  const changed = (p) => { const a = afterById.get(p.id); return !a || a.start !== p.start || a.end !== p.end; };
  if (type === 'import_baseline') {
    for (const p of before.blocks.filter((b) => isLive(b) && changed(b))) out.push({ kind: 'protected_changed', block: p.id });
    return out;
  }
  const instance = INSTANCE_EVENTS.has(type);
  const beforeById = new Map(before.blocks.map((b) => [b.id, b]));
  const touched = (b) => { const p = beforeById.get(b.id); return !p || p.start !== b.start || p.end !== b.end; };
  const live = after.blocks.filter(isLive);
  // A plan answers for every planner block; an instance operation for the blocks it laid or moved.
  const judged = instance ? live.filter((b) => isOwned(b) && touched(b)) : live.filter(isPlanner);
  const guarded = instance ? (b) => b.source === 'manual' || b.status === 'done' : isProtected;
  for (const b of judged) {
    if (!insideAvailability(after, b)) out.push({ kind: 'outside_availability', block: b.id });
    const x = iv(b);
    if (live.filter((o) => o.id !== b.id).map(iv).some((o) => overlaps(o, x))) out.push({ kind: 'overlap', block: b.id });
    if (b.status === 'pending' && fixedOn(after, x.start).some((o) => overlaps(o, x))) out.push({ kind: 'block_under_commitment', block: b.id });
  }
  for (const p of before.blocks.filter((b) => guarded(b) && isLive(b))) if (changed(p)) out.push({ kind: 'protected_changed', block: p.id });
  return out;
}

/**
 * Share of still-valid blocks the product owns (planner, baseline, adjusted; not hand-placed) that the event moved,
 * resized, or removed. A block that comes back for the same task at the same time under a new id is not churn: the
 * user sees no change. Ids are the planner's business. `allowed`: blocks the event may change without it counting (a
 * scenario's `allowedChurnBlocks`, for the one block that gives way to a must-do sitting); only changes beyond that
 * number count. `exempt`: blocks the user asked the event to move (see `churnExempt`); they stay in the denominator.
 */
export function churn(before, after, allowed = 0, exempt = () => false) {
  const pre = before.blocks.filter((b) => isOwned(b) && b.status === 'pending');
  const slot = (b) => `${b.taskId}|${b.start}|${b.end}`;
  const afterSlots = new Set(after.blocks.map(slot));
  const stillValid = pre.filter((b) => {
    if (!insideAvailability(after, b)) return false;
    const x = iv(b);
    const r = dayRange(x.start);
    const blockers = [...after.commitments.map(iv), ...expandRecurring(after.recurring, r).map((o) => ({ start: o.start, end: o.end }))];
    return !blockers.some((o) => overlaps(o, x));
  });
  if (stillValid.length === 0) return 0;
  const changed = stillValid.filter((b) => !afterSlots.has(slot(b)) && !exempt(b));
  return Math.max(0, changed.length - allowed) / stillValid.length;
}

/**
 * The blocks an instance operation was asked to move, per event: shift_day, the rest of today (today's blocks ending
 * after now); carve_out, the carve's day from its start on (blocks that day ending after the carve starts: the user's
 * own interruption); carry_over, the carried task's own blocks (its slot may be extended). Anything else the
 * operation moved is churn.
 */
export function churnExempt(event, before, now) {
  const sameDay = (b, day) => startOfDay(new Date(b.start)).getTime() === startOfDay(day).getTime();
  switch (event?.type) {
    case 'shift_day': return (b) => sameDay(b, now) && new Date(b.end) > now;
    case 'carve_out': { const from = localTime(event.from); return (b) => sameDay(b, from) && new Date(b.end) > from; }
    case 'carry_over': {
      const t = before.tasks.find((x) => x.id === event.task || x.name.toLowerCase() === String(event.task).toLowerCase());
      return (b) => !!t && b.taskId === t.id;
    }
    default: return () => false;
  }
}

const periodsIn = (task, range, settings) => {
  const out = [];
  for (let at = range.start; at < range.end;) { const p = periodRange(task.budgetPeriod, at, settings); out.push(p); at = p.end; }
  return out;
};
const remainingIn = (state, task, period) => {
  const blocks = state.blocks.filter((b) => b.taskId === task.id);
  return remainingMinutes(task, blocks, period.start, state.settings);
};
/** Minutes of the task's skipped or missed blocks on `day`: such a block means not that day, so they are not fillable there. */
const notTodayOn = (state, task, day) => sum(state.blocks.filter((b) => b.taskId === task.id && (b.status === 'skipped' || b.status === 'missed') && startOfDay(new Date(b.start)).getTime() === day.getTime()).map((b) => mins(iv(b).start, iv(b).end)));
/** Budget the tasks could still place on `day`: each task's remaining budget in its period (less what was skipped or missed that day), when at least a block's worth. */
const fillableOn = (state, day) => sum(state.tasks.map((t) => Math.max(0, remainingIn(state, t, periodRange(t.budgetPeriod, day, state.settings)) - notTodayOn(state, t, day))).filter((r) => r >= state.settings.minBlockMinutes));
const anyBudgetLeftOn = (state, day) => fillableOn(state, day) > 0;

/**
 * Free minutes left on planned days while some task still had budget, counted only up to what the remaining budgets
 * could fill that day: an empty evening with 60 minutes of budget left is a 60-minute hole, not a 150-minute one. A day
 * at the task cap (distinct live tasks, any source, at least maxTasksPerDay) has no fillable holes.
 */
/** A day whose distinct live tasks (any source) reached maxTasksPerDay takes no other task: its free time is the user's setting. */
const atCap = (state, day) => new Set(state.blocks.filter((b) => isLive(b) && startOfDay(new Date(b.start)).getTime() === day.getTime()).map((b) => b.taskId)).size >= state.settings.maxTasksPerDay;

export function holes(state, range, now) {
  let total = 0;
  for (const day of daysIn(range)) {
    if (day < startOfDay(now)) continue;
    if (atCap(state, day)) continue;
    const fillable = fillableOn(state, day);
    if (fillable === 0) continue;
    total += Math.min(fillable, sum(freeSpans(state, day, fromOn(day, now)).map((f) => mins(f.start, f.end))));
  }
  return total;
}

const byTaskDay = (state, pred = isPlanner) => {
  const groups = new Map();
  for (const b of state.blocks.filter((b) => isLive(b) && pred(b))) {
    const key = `${b.taskId}|${startOfDay(new Date(b.start)).getTime()}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(b);
  }
  return groups;
};

/** Minutes of one task's longest stretch on one day beyond two sessions (blocks parted only by a short commitment are one stretch). */
export function blobs(state) {
  const taskById = new Map(state.tasks.map((t) => [t.id, t]));
  let total = 0;
  for (const [key, bs] of byTaskDay(state)) {
    const [taskId, dayMs] = key.split('|');
    const t = taskById.get(taskId); if (!t) continue;
    const longest = Math.max(0, ...sittingsOf(state, bs, new Date(Number(dayMs))).map((s) => s.minutes));
    total += Math.max(0, longest - 2 * sessionOf(t, state.settings));
  }
  return total;
}

/** A commitment of at most this many minutes between two blocks of one task does not break the sitting. */
const SHORT_BREAK_MINUTES = 30;

/** One task's blocks on one day as sittings: touching blocks, and blocks parted only by a short commitment, are one. */
function sittingsOf(state, blocks, day) {
  const fixed = mergeIntervals([...state.commitments.map(iv), ...expandRecurring(state.recurring, dayRange(day)).map((o) => ({ start: o.start, end: o.end }))]);
  const out = [];
  for (const x of blocks.map(iv).sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    const gap = last ? { start: last.end, end: x.start } : null;
    if (gap && mins(gap.start, gap.end) <= SHORT_BREAK_MINUTES && subtractIntervals([gap], fixed).length === 0) { last.end = x.end; last.minutes += mins(x.start, x.end); }
    else out.push({ start: x.start, end: x.end, minutes: mins(x.start, x.end) });
  }
  return out;
}

/**
 * Sittings shorter than what the task still needed, min(session, budget left before the sitting), when the day had
 * room to make them whole: free time beside the sitting, or a free slot elsewhere on the day long enough for it. A
 * sitting with nowhere on the day to be whole was not the planner's choice. The last of a budget is a remainder, free
 * anywhere except as the first block of a day: there it is a splinter when another task could have opened the day
 * with a whole sitting, or an earlier planned day in the period still had room to close with it. A sitting that ended
 * before `now` is not re-judged, and today's past minutes are not room.
 */
export function splinters(state, now) {
  const taskById = new Map(state.tasks.map((t) => [t.id, t]));
  const liveOn = (day) => state.blocks.filter((b) => isLive(b) && startOfDay(new Date(b.start)).getTime() === day.getTime());
  const leftBefore = (t, at, day) => t.budgetMinutes - usedMinutes(t, state.blocks.filter((b) => new Date(b.start) < at), periodRange(t.budgetPeriod, day, state.settings));
  const anotherCouldOpen = (t, day, at) => {
    const room = Math.max(0, ...workingIntervals(dayRange(day), state.settings).filter((w) => w.end > at).map((w) => mins(w.start > at ? w.start : at, w.end)));
    return state.tasks.some((u) => u.id !== t.id && Math.min(leftBefore(u, at, day), room) >= sessionOf(u, state.settings));
  };
  const earlierDayHadRoom = (period, day, minutes) => {
    for (let e = period.start < startOfDay(now) ? startOfDay(now) : period.start; e < day; e = addDays(e, 1)) {
      if (liveOn(e).length && rawFree(state, e, fromOn(e, now)).some((f) => mins(f.start, f.end) >= minutes)) return true;
    }
    return false;
  };
  let total = 0;
  for (const [key, bs] of byTaskDay(state)) {
    const [taskId, dayMs] = key.split('|');
    const t = taskById.get(taskId); if (!t) continue;
    const day = new Date(Number(dayMs));
    if (day < startOfDay(now)) continue;
    const free = rawFree(state, day, fromOn(day, now));
    const longestFree = Math.max(0, ...free.map((f) => mins(f.start, f.end)));
    const period = periodRange(t.budgetPeriod, day, state.settings);
    const firstStart = Math.min(...liveOn(day).map((b) => new Date(b.start).getTime()));
    for (const s of sittingsOf(state, bs, day)) {
      if (s.end <= now) continue;
      const left = leftBefore(t, s.start, day);
      const need = Math.min(sessionOf(t, state.settings), left);
      if (s.minutes < need) {
        const beside = free.filter((f) => f.end.getTime() === s.start.getTime() || f.start.getTime() === s.end.getTime());
        if (longestFree >= need || s.minutes + sum(beside.map((f) => mins(f.start, f.end))) >= need) total += 1;
        continue;
      }
      const remainder = s.minutes < sessionOf(t, state.settings) && left - s.minutes < state.settings.minBlockMinutes;
      if (!remainder || s.start.getTime() !== firstStart) continue;
      if (anotherCouldOpen(t, day, s.start) || earlierDayHadRoom(period, day, s.minutes)) total += 1;
    }
  }
  return total;
}

/**
 * Minutes outside a task's preferred segment on days where that segment still had room. Room is counted from `now`:
 * a morning that had already passed when the plan was made is not room, and a block on a past day is not re-judged.
 */
export function offSegment(state, now) {
  const taskById = new Map(state.tasks.map((t) => [t.id, t]));
  let total = 0;
  for (const b of state.blocks.filter((b) => isLive(b) && isPlanner(b))) {
    const t = taskById.get(b.taskId); if (!t) continue;
    const pref = t.preferredSegment ?? 'any';
    if (pref === 'any') continue;
    const x = iv(b);
    if (x.start < startOfDay(now)) continue;
    if (segmentOf(x.start, state.settings) === pref) continue;
    const roomInSegment = freeSpans(state, x.start, fromOn(x.start, now)).some((f) => segmentOf(f.start, state.settings) === pref);
    if (roomInSegment) total += mins(x.start, x.end);
  }
  return total;
}

/** Unmet budget that had usable free time (in the task's segment when it has one; not on a day at the task cap), plus a daily task's whole budget on a day it lost to weekly sittings. */
export function budgetMiss(state, range, now) {
  const taskById = new Map(state.tasks.map((t) => [t.id, t]));
  const sameDay = (b, day) => startOfDay(new Date(b.start)).getTime() === day.getTime();
  // A daily task with no block on a planned day lost its day: the planner gave its time to weekly sittings. Not when
  // the day hit maxTasksPerDay (the user's own setting), nor when the weekly minutes there could not have held one of
  // its sittings anyway.
  const lostDay = (t, day) => {
    if (t.budgetPeriod !== 'day' || day < startOfDay(now)) return false;
    const live = state.blocks.filter((b) => isLive(b) && sameDay(b, day));
    if (!live.length || state.blocks.some((b) => b.taskId === t.id && sameDay(b, day))) return false;
    if (new Set(live.map((b) => b.taskId)).size >= state.settings.maxTasksPerDay) return false;
    const weekly = sum(live.filter((b) => taskById.get(b.taskId)?.budgetPeriod !== 'day').map((b) => mins(iv(b).start, iv(b).end)));
    return weekly >= Math.min(sessionOf(t, state.settings), t.budgetMinutes);
  };
  let total = 0;
  for (const t of state.tasks) {
    for (const period of periodsIn(t, range, state.settings)) {
      const rem = remainingIn(state, t, period);
      if (rem < state.settings.minBlockMinutes) continue;
      if (lostDay(t, period.start)) { total += rem; continue; }
      let free = 0;
      for (const day of daysIn({ start: period.start < range.start ? range.start : period.start, end: period.end > range.end ? range.end : period.end })) {
        if (day < startOfDay(now) || atCap(state, day)) continue; // a day at the cap is not fillable, as for holes
        const from = fromOn(day, now);
        const pref = t.preferredSegment ?? 'any';
        const dayFree = sum(freeSpans(state, day, from).filter((f) => pref === 'any' || segmentOf(f.start, state.settings) === pref).map((f) => mins(f.start, f.end)));
        free += Math.min(dayFree, Math.max(0, rem - notTodayOn(state, t, day)));
      }
      total += Math.min(rem, free);
    }
  }
  return total;
}

/** The first day from `now` with an availability window still ahead: the day a plan made now starts on. */
const firstAvailableDay = (state, now) => {
  for (let i = 0; i < 14; i += 1) {
    const day = addDays(startOfDay(now), i);
    if (workingIntervals(dayRange(day), state.settings).some((w) => w.end > now)) return day;
  }
  return null;
};

/**
 * After a plan that names tasks (`mustDo`): for each, the minutes it ends the event short of min(session, budget left)
 * on the window's first available day. Budget left is what the task's period had before the event, blocks already on
 * the day count, and nothing below a block's worth is expected. A named task that did not land is friction whatever
 * the planner's reason.
 */
export function mustDoMiss(before, after, event, now) {
  if (!PLANNER_EVENTS.has(event?.type) || !event?.mustDo?.length) return 0;
  const day = firstAvailableDay(after, now);
  if (!day) return 0;
  let total = 0;
  for (const ref of event.mustDo) {
    const t = after.tasks.find((t) => t.id === ref || t.name.toLowerCase() === String(ref).toLowerCase());
    if (!t) continue;
    const period = periodRange(t.budgetPeriod, day, after.settings);
    const left = remainingMinutes(t, before.blocks.filter((b) => b.taskId === t.id), period.start, before.settings);
    const expected = Math.min(sessionOf(t, after.settings), left);
    if (expected < after.settings.minBlockMinutes) continue;
    total += Math.max(0, expected - usedMinutes(t, after.blocks.filter((b) => b.taskId === t.id), dayRange(day)));
  }
  return total;
}

/** Adjacent task changes per day beyond the minimum needed to visit each task once. */
export function switches(state) {
  const byDay = new Map();
  for (const b of state.blocks.filter(isLive)) {
    const key = startOfDay(new Date(b.start)).getTime();
    (byDay.get(key) ?? byDay.set(key, []).get(key)).push(b);
  }
  let total = 0;
  for (const bs of byDay.values()) {
    const sorted = [...bs].sort((a, b) => a.start.localeCompare(b.start));
    let transitions = 0;
    for (let i = 1; i < sorted.length; i += 1) if (sorted[i].taskId !== sorted[i - 1].taskId) transitions += 1;
    total += Math.max(0, transitions - (new Set(sorted.map((b) => b.taskId)).size - 1));
  }
  return total;
}

/** Minutes between the first available minute after now and the first block, when budget remained. */
export function lateStart(state, now) {
  for (let i = 0; i < 14; i += 1) {
    const day = addDays(startOfDay(now), i);
    const windows = workingIntervals(dayRange(day), state.settings).filter((w) => w.end > now);
    if (windows.length === 0) continue;
    if (!anyBudgetLeftOn(state, day) && !state.blocks.some((b) => isLive(b) && startOfDay(new Date(b.start)).getTime() === day.getTime())) return 0;
    const t0 = windows[0].start > now ? windows[0].start : now;
    // The first block still ahead, including one in progress at t0: the user is working, there is no late start.
    const first = state.blocks.filter((b) => isLive(b) && new Date(b.end) > t0).map((b) => new Date(b.start)).sort((a, b) => a - b)[0];
    const availableAfter = sum(windows.map((w) => mins(w.start > t0 ? w.start : t0, w.end)));
    if (!first || startOfDay(first < t0 ? t0 : first).getTime() !== day.getTime()) return anyBudgetLeftOn(state, day) ? availableAfter : 0;
    return Math.max(0, Math.min(availableAfter, mins(t0, first)));
  }
  return 0;
}

/**
 * Days a task starts at a time other than its usual one. For each task with live blocks of any source (the user's own
 * placements are the routine) on at least two scored days (from `now` on, inside the range), the day's start is its
 * first block's time of day; the usual start is the most common one, ties to the earliest; a day whose start differs
 * counts one. A task seen on one day has nothing to compare.
 */
export function consistency(state, range, now) {
  const starts = new Map();
  for (const [key, bs] of byTaskDay(state, () => true)) {
    const [taskId, dayMs] = key.split('|');
    const day = new Date(Number(dayMs));
    if (day < startOfDay(now) || day < startOfDay(range.start) || day >= range.end) continue;
    const first = new Date(Math.min(...bs.map((b) => new Date(b.start).getTime())));
    (starts.get(taskId) ?? starts.set(taskId, []).get(taskId)).push(first.getHours() * 60 + first.getMinutes());
  }
  let total = 0;
  for (const times of starts.values()) {
    if (times.length < 2) continue;
    const counts = new Map();
    for (const t of times) counts.set(t, (counts.get(t) ?? 0) + 1);
    const usual = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    total += times.filter((t) => t !== usual).length;
  }
  return total;
}

export function composite(m, weights) {
  return Object.entries(weights).reduce((n, [k, w]) => n + w * (m[k] ?? 0), 0);
}

/** Metrics after one event: churn unless the user edited a block by hand; the day-shape metrics only after a planner event (absent otherwise). */
export function scoreState(before, after, event, range, now, weights) {
  const m = USER_EDIT_EVENTS.has(event?.type) ? {} : { churn: churn(before, after, event?.allowedChurnBlocks ?? 0, churnExempt(event, before, now)) };
  if (PLANNER_EVENTS.has(event?.type)) {
    Object.assign(m, {
      holes: holes(after, range, now),
      blobs: blobs(after),
      splinters: splinters(after, now),
      off_segment: offSegment(after, now),
      budget_miss: budgetMiss(after, range, now),
      must_do_miss: mustDoMiss(before, after, event, now),
      switches: switches(after),
      late_start: lateStart(after, now),
    });
    // A block an operation moved starts off its usual hour because the user asked for the move: not scored, as for churn.
    if (!ADJUST_EVENTS.has(event?.type)) m.consistency = consistency(after, range, now);
  }
  return { ...m, friction: composite(m, weights), hard: hardViolations(before, after, event), under_commitment: underCommitment(after).blocks };
}

// Re-exported for the replay engine's timelines.
export { atTime };
