import type { AvailabilityWindow, Baseline, Interval, RecurringCommitment, Settings } from './types.js';
import { addDays, atTime, ceilToSlot, clip, floorToSlot, mergeIntervals, minutesBetween, startOfDay, subtractIntervals } from './time.js';
import { availabilityFrom } from './baseline.js';

/**
 * The availability that holds: the baseline's usable spans when a baseline with a task slot is given (the baseline week
 * is the source of truth), else the settings' windows (the fallback while no baseline exists).
 */
export function effectiveAvailability(settings: Settings, baseline?: Baseline): AvailabilityWindow[] {
  return baseline?.slots.some((s) => s.kind === 'task') ? availabilityFrom(baseline) : settings.availability;
}

/** The settings with the availability that holds (see `effectiveAvailability`): what the planner and the tools read. */
export function settingsWithBaseline(settings: Settings, baseline?: Baseline): Settings {
  return { ...settings, availability: effectiveAvailability(settings, baseline) };
}

/** Availability windows on each day of the range (see `effectiveAvailability`), merged per day and clipped to the range. */
export function workingIntervals(window: Interval, settings: Settings, baseline?: Baseline): Interval[] {
  const availability = effectiveAvailability(settings, baseline);
  const out: Interval[] = [];
  for (let day = startOfDay(window.start); day < window.end; day = addDays(day, 1)) {
    const todays = availability
      .filter((w) => w.days.includes(day.getDay()))
      .map((w) => ({ start: atTime(day, w.start), end: atTime(day, w.end) }));
    for (const merged of mergeIntervals(todays)) {
      const c = clip(merged, window);
      if (c) out.push(c);
    }
  }
  return out;
}

export interface RecurringOccurrence extends Interval { title: string; recurringId: string }

/** Concrete occurrences of weekly recurring commitments inside the range, clipped. */
export function expandRecurring(recurring: RecurringCommitment[], window: Interval): RecurringOccurrence[] {
  const out: RecurringOccurrence[] = [];
  for (let day = startOfDay(window.start); day < window.end; day = addDays(day, 1)) {
    for (const r of recurring) {
      if (!r.days.includes(day.getDay())) continue;
      const c = clip({ start: atTime(day, r.start), end: atTime(day, r.end) }, window);
      if (c) out.push({ ...c, title: r.title, recurringId: r.id });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Working time minus busy time, snapped to the slot grid, gaps under minBlockMinutes dropped. */
export function freeIntervals(window: Interval, busy: Interval[], settings: Settings, baseline?: Baseline): Interval[] {
  const free = subtractIntervals(workingIntervals(window, settings, baseline), busy);
  const out: Interval[] = [];
  for (const f of free) {
    const start = ceilToSlot(f.start, settings.slotMinutes);
    const end = floorToSlot(f.end, settings.slotMinutes);
    if (minutesBetween(start, end) >= settings.minBlockMinutes) out.push({ start, end });
  }
  return out;
}
