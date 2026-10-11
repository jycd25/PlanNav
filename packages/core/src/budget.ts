import type { Block, BudgetPeriod, Interval, Settings, Task } from './types.js';
import { addDays, clip, startOfDay, startOfWeek } from './time.js';
import { availableDays } from './types.js';

export function periodRange(period: BudgetPeriod, at: Date, settings: Settings): Interval {
  if (period === 'day') {
    const s = startOfDay(at);
    return { start: s, end: addDays(s, 1) };
  }
  const s = startOfWeek(at, settings.weekStartsOn);
  return { start: s, end: addDays(s, 7) };
}

/** Minutes of done or pending blocks for `task` inside `period` (clipped; an early-finished block counts its planned minutes). */
export function usedMinutes(task: Task, blocks: Block[], period: Interval): number {
  let total = 0;
  for (const b of blocks) {
    if (b.taskId !== task.id) continue;
    if (b.status !== 'done' && b.status !== 'pending') continue;
    if (b.status === 'done' && b.plannedMinutes !== undefined) {
      // Finished early: the block was shortened to now, but the budget still counts the planned length.
      const s = new Date(b.start);
      if (s >= period.start && s < period.end) total += b.plannedMinutes;
      continue;
    }
    const c = clip({ start: new Date(b.start), end: new Date(b.end) }, period);
    if (c) total += (c.end.getTime() - c.start.getTime()) / 60_000;
  }
  return Math.round(total);
}

/** Minutes of skipped or missed blocks for `task` inside `period` (clipped): a block the user skipped, or that ended unmarked, means not that day. */
export function notTodayMinutes(task: Task, blocks: Block[], period: Interval): number {
  let total = 0;
  for (const b of blocks) {
    if (b.taskId !== task.id || (b.status !== 'skipped' && b.status !== 'missed')) continue;
    const c = clip({ start: new Date(b.start), end: new Date(b.end) }, period);
    if (c) total += (c.end.getTime() - c.start.getTime()) / 60_000;
  }
  return Math.round(total);
}

export function remainingMinutes(task: Task, blocks: Block[], at: Date, settings: Settings): number {
  const period = periodRange(task.budgetPeriod, at, settings);
  return Math.max(0, task.budgetMinutes - usedMinutes(task, blocks, period));
}

/** The days with availability from `from`'s day (inclusive) to the end of the budget period that holds it. */
export function availableDaysOfPeriod(from: Date, period: BudgetPeriod, settings: Settings): Date[] {
  const days = availableDays(settings);
  const end = periodRange(period, from, settings).end;
  const out: Date[] = [];
  for (let day = startOfDay(from); day < end; day = addDays(day, 1)) if (days.includes(day.getDay())) out.push(day);
  return out;
}

/** Days with availability from `from` (inclusive) to the end of its week. */
export function availableDaysLeftInWeek(from: Date, settings: Settings): number {
  return Math.max(1, availableDaysOfPeriod(from, 'week', settings).length);
}
