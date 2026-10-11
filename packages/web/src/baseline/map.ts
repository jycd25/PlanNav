import type { Baseline, BaselineSlot, Commitment } from '@ds/core';
import type { BlockView } from '../api.js';
import { addDays, startOfWeek } from '../time.js';

/**
 * The Baseline tab draws the template week with the ordinary calendar by giving it seven synthetic dates: the week of
 * Monday 2001-01-01 (no daylight-saving change falls in it, so every day has 24 hours). These helpers map a weekday slot
 * ("Wednesday 09:30-11:00") to those dates and back.
 */
export const REFERENCE_MONDAY = new Date(2001, 0, 1);

/** The seven reference dates, starting on `weekStartsOn` (0 = Sunday ... 6 = Saturday). */
export function referenceWeek(weekStartsOn: number): Date[] {
  const first = startOfWeek(REFERENCE_MONDAY, weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

/** Where a weekday slot falls in the reference week `days`; an end of "24:00" is the next midnight. */
export function slotRange(slot: Pick<BaselineSlot, 'day' | 'start' | 'end'>, days: Date[]): { start: Date; end: Date } {
  const day = days.find((d) => d.getDay() === slot.day) ?? days[0];
  const at = (min: number) => { const r = new Date(day); r.setMinutes(min); return r; };
  return { start: at(toMin(slot.start)), end: at(toMin(slot.end)) };
}

/** The weekday slot a dragged range describes, or null when it is empty, inverted or crosses midnight (ending at midnight is "24:00"). */
export function slotFromRange(start: Date, end: Date): Pick<BaselineSlot, 'day' | 'start' | 'end'> | null {
  if (end.getTime() <= start.getTime()) return null;
  const midnight = new Date(start); midnight.setHours(0, 0, 0, 0);
  const nextMidnight = addDays(midnight, 1);
  if (end.getTime() > nextMidnight.getTime()) return null;
  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin = end.getTime() === nextMidnight.getTime() ? 24 * 60 : end.getHours() * 60 + end.getMinutes();
  return { day: start.getDay(), start: hhmm(startMin), end: hhmm(endMin) };
}

/** The id the calendar uses for slot `i`, and back. */
export const slotId = (i: number) => `slot:${i}`;
export function slotIndex(id: string): number | null {
  const m = /^slot:(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** The slots as the calendar's items: task slots as blocks, busy slots as commitments. */
export function calendarFromSlots(slots: BaselineSlot[], days: Date[], taskNames: Map<string, string>): { blocks: BlockView[]; commitments: Commitment[] } {
  const blocks: BlockView[] = [];
  const commitments: Commitment[] = [];
  slots.forEach((s, i) => {
    const { start, end } = slotRange(s, days);
    if (s.kind === 'busy') {
      commitments.push({ id: slotId(i), title: s.title ?? 'Busy', start: start.toISOString(), end: end.toISOString() });
    } else {
      const taskId = s.taskId ?? '';
      blocks.push({ id: slotId(i), taskId, taskName: taskNames.get(taskId) ?? 'Unknown task', start: start.toISOString(), end: end.toISOString(), status: 'pending', source: 'baseline', createdAt: '', statusChangedAt: null });
    }
  });
  return { blocks, commitments };
}

/** The slots with slot `id` moved to [start, end), or null when the id is unknown or the range is not a slot. */
export function moveSlot(slots: BaselineSlot[], id: string, start: Date, end: Date): BaselineSlot[] | null {
  const i = slotIndex(id);
  const range = slotFromRange(start, end);
  if (i === null || i >= slots.length || !range) return null;
  return slots.map((s, j) => (j === i ? { ...s, ...range } : s));
}

export type PartOfDay = 'morning' | 'afternoon' | 'evening' | 'varies';
const partOf = (min: number): PartOfDay => (min < 12 * 60 ? 'morning' : min < 17 * 60 ? 'afternoon' : 'evening');

/**
 * What the baseline says about a task: minutes a week across its slots, its most common slot length (ties: the longer),
 * its slot count, and the part of day its slots start in (the default segment edges 12:00 and 17:00; "varies" when they
 * differ; null with no slot).
 */
export function taskSlotSummary(slots: BaselineSlot[], taskId: string): { weeklyMinutes: number; sessionMinutes: number; slots: number; partOfDay: PartOfDay | null } {
  const mine = slots.filter((s) => s.kind === 'task' && s.taskId === taskId);
  const lengths = mine.map((s) => toMin(s.end) - toMin(s.start));
  const counts = new Map<number, number>();
  for (const l of lengths) counts.set(l, (counts.get(l) ?? 0) + 1);
  const modal = [...counts.entries()].sort((x, y) => y[1] - x[1] || y[0] - x[0])[0];
  const parts = new Set(mine.map((s) => partOf(toMin(s.start))));
  const partOfDay = parts.size === 0 ? null : parts.size === 1 ? [...parts][0] : 'varies';
  return { weeklyMinutes: lengths.reduce((n, l) => n + l, 0), sessionMinutes: modal ? modal[0] : 0, slots: lengths.length, partOfDay };
}

/**
 * The Baseline tab's draft: the slots being edited, whether they differ from what was saved, and the saved version they
 * started from. It lives in App so a tab switch does not lose it.
 */
export interface Draft { slots: BaselineSlot[]; dirty: boolean; baseVersion: number }

/** A clean draft follows the saved baseline (a save, a revert, the assistant); unsaved edits are never overwritten. */
export function syncDraft(draft: Draft, saved: Baseline | null): Draft {
  if (draft.dirty) return draft;
  const version = saved?.version ?? 0;
  if (version === draft.baseVersion) return draft;
  return { slots: saved?.slots ?? [], dirty: false, baseVersion: version };
}

/** The version saved elsewhere since a dirty draft started (Save would overwrite it), else null. */
export function newerSavedVersion(draft: Draft, saved: Baseline | null): number | null {
  return draft.dirty && saved && saved.version !== draft.baseVersion ? saved.version : null;
}

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One line for an apply's result: blocks created, busy slots copied, blocks replaced, and each skipped slot with its reason. */
export function describeApply(r: { created: unknown[]; commitments: unknown[]; replaced: number; skipped: Array<{ slot: BaselineSlot; reason: string }> }, taskNames: Map<string, string>): string {
  const parts = [`${plural(r.created.length, 'block')} created`];
  if (r.commitments.length) parts.push(plural(r.commitments.length, 'busy slot'));
  parts.push(`${r.replaced} replaced`);
  const skipped = r.skipped.map(({ slot, reason }) => `${slot.kind === 'busy' ? slot.title ?? 'Busy' : taskNames.get(slot.taskId ?? '') ?? 'Unknown task'} ${SHORT_DAYS[slot.day]} ${slot.start}–${slot.end}: ${reason}`);
  parts.push(`${r.skipped.length} skipped${skipped.length ? ` (${skipped.join('; ')})` : ''}`);
  return `${parts.join(', ')}.`;
}
