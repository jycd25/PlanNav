import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AvailabilityWindow, Block, RecurringCommitment, Settings, Task, TaskSegment, WorkStyle } from './types.js';
import { TASK_COLORS, WORK_STYLE_PRESETS, isAvailabilityWindow } from './types.js';
import type { Store } from './store.js';
import { capThatFits, plan } from './plan.js';
import { createBlock, findTaskBlock, markBlock, materializeMissed, moveBlock } from './mark.js';
import { summarize } from './stats.js';
import { trackBlock } from './track.js';
import { periodRange, remainingMinutes } from './budget.js';
import { addDays, atTime, startOfDay, startOfWeek } from './time.js';
import { expandRecurring, settingsWithBaseline, workingIntervals } from './free.js';
import { applyToWeek, refreshBudgets } from './baseline.js';
import { inferSegment } from './segments.js';
import { setupStatus } from './setup.js';
import { importIcs } from './icsImport.js';
import { inferWorkStyle } from './routine.js';
import { baselineFromEvents, importAsBaseline, type ImportBaselineResult } from './importBaseline.js';
import { carryOver, carveOut, shiftDay, type InstanceResult } from './instance.js';

export interface ToolContext {
  now: () => Date;
  /** Fetch a URL as text (provided by the host). Absent in contexts without network access. */
  fetchText?: (url: string) => Promise<string>;
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  run: (store: Store, input: z.infer<S>, ctx: ToolContext) => unknown | Promise<unknown>;
}

export type BlockView = Block & { taskName: string };

function view(store: Store, b: Block): BlockView {
  return { ...b, taskName: store.getTask(b.taskId)?.name ?? 'Unknown task' };
}

function def<S extends z.ZodObject>(t: ToolDef<S>): ToolDef<S> { return t; }

/** Resolve a task by id, exact name, or unique partial name (case-insensitive). Errors list the options. */
export function resolveTask(store: Store, ref: string): Task {
  const all = store.listTasks(true);
  const trimmed = ref.trim();
  const byId = all.find((t) => t.id === trimmed);
  if (byId) return byId;
  const active = all.filter((t) => !t.archived);
  const needle = trimmed.toLowerCase();
  const exact = active.filter((t) => t.name.toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  const partial = active.filter((t) => t.name.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0];
  const quote = (ts: Task[]) => ts.map((t) => `"${t.name}"`).join(', ');
  if (partial.length > 1) throw new Error(`"${ref}" matches several tasks: ${quote(partial)}. Use the exact name or id.`);
  throw new Error(`No task matches "${ref}". Known tasks: ${active.length ? quote(active) : '(none)'}.`);
}

const TIME_FORMATS = 'Use ISO 8601 like 2026-10-07T17:00:00+02:00, or "YYYY-MM-DD HH:MM", or "17:00" for today, or "tomorrow 09:00".';
const BARE_TIME = /^\d{1,2}:\d{2}$/;

/** What the suggestion (plan_schedule without a baseline) still needs, as the next step for the assistant. */
const SUGGEST_NEEDS = {
  availability: 'Ask when they usually work, then set_availability; or they draw their week on the Baseline tab or import a past week as their baseline.',
  tasks: 'Ask which tasks they want time for, each with minutes per day or week and a priority (1 = highest); record each with upsert_task.',
} as const;

/** Parse a date-time the model may give loosely. Local time unless an offset is given. */
export function parseWhen(input: string, now: Date): Date {
  const s = input.trim();
  const hhmm = (h: string, m: string) => `${h.padStart(2, '0')}:${m}`;
  let m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) return atTime(now, hhmm(m[1], m[2]));
  m = /^(today|tomorrow)\s+(\d{1,2}):(\d{2})$/i.exec(s);
  if (m) return atTime(addDays(now, m[1].toLowerCase() === 'tomorrow' ? 1 : 0), hhmm(m[2], m[3]));
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Cannot understand time "${input}". ${TIME_FORMATS}`);
  return d;
}

const DAY_WORDS: Record<string, number[]> = {
  sun: [0], sunday: [0], mon: [1], monday: [1], tue: [2], tues: [2], tuesday: [2], wed: [3], weds: [3], wednesday: [3],
  thu: [4], thur: [4], thurs: [4], thursday: [4], fri: [5], friday: [5], sat: [6], saturday: [6],
  weekdays: [1, 2, 3, 4, 5], weekday: [1, 2, 3, 4, 5], weekend: [0, 6], weekends: [0, 6],
  daily: [0, 1, 2, 3, 4, 5, 6], everyday: [0, 1, 2, 3, 4, 5, 6], all: [0, 1, 2, 3, 4, 5, 6],
};

/** Weekday numbers from numbers, names ("mon", "Wednesday"), or groups ("weekdays", "weekend", "daily"). */
export function parseDays(input: unknown): number[] {
  const items = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[,/]|\band\b|\s+/) : [input];
  const out = new Set<number>();
  for (const raw of items) {
    if (typeof raw === 'number') {
      if (!Number.isInteger(raw) || raw < 0 || raw > 6) throw new Error(`Day ${raw} is out of range; use 0 (Sunday) to 6 (Saturday) or names like "mon".`);
      out.add(raw);
      continue;
    }
    const word = String(raw).trim().toLowerCase();
    if (!word) continue;
    if (/^[0-6]$/.test(word)) { out.add(Number(word)); continue; }
    const days = DAY_WORDS[word];
    if (!days) throw new Error(`Unknown day "${raw}". Use names like mon, tue, wed, thu, fri, sat, sun, or "weekdays", "weekend", "daily".`);
    for (const d of days) out.add(d);
  }
  if (out.size === 0) throw new Error('At least one day is required.');
  return [...out].sort();
}

const HHMM_LOOSE = /^(\d{1,2}):(\d{2})$/;
function normalizeHhmm(s: string, what: string): string {
  const m = HHMM_LOOSE.exec(s.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`${what} must be HH:MM (24h), e.g. "09:00" or "20:30"; got "${s}".`);
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function toWindow(w: { days: unknown; start: string; end: string }): AvailabilityWindow {
  const win = { days: parseDays(w.days), start: normalizeHhmm(w.start, 'start'), end: normalizeHhmm(w.end, 'end') };
  if (win.end <= win.start) throw new Error(`end (${win.end}) must be after start (${win.start}).`);
  if (!isAvailabilityWindow(win)) throw new Error('Invalid window.');
  return win;
}

const daysField = z.union([z.string(), z.array(z.union([z.string(), z.number()]))]).describe('Weekdays: names ("mon", "Wednesday"), groups ("weekdays", "weekend", "daily"), or numbers 0 (Sun) to 6 (Sat)');
const hhmmField = (what: string) => z.string().describe(`${what} as HH:MM in 24h local time, e.g. "09:00" or "20:30"`);

function resolveRecurring(store: Store, ref: string): RecurringCommitment {
  const all = store.listRecurring();
  const needle = ref.trim().toLowerCase();
  const byId = all.find((r) => r.id === ref.trim());
  if (byId) return byId;
  const exact = all.filter((r) => r.title.toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  const partial = all.filter((r) => r.title.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0];
  const quote = (rs: RecurringCommitment[]) => rs.map((r) => `"${r.title}"`).join(', ');
  if (partial.length > 1) throw new Error(`"${ref}" matches several recurring commitments: ${quote(partial)}. Use the exact title or id.`);
  throw new Error(`No recurring commitment matches "${ref}". Known: ${all.length ? quote(all) : '(none)'}.`);
}

const MAX_HORIZON_DAYS = 14;
const MAX_TITLE = 80;
const MAX_BUDGET_MINUTES = 7 * 24 * 60;
const MAX_WINDOWS = 14;
const MAX_COMMITMENT_MS = 24 * 60 * 60 * 1000;
const titleField = (what: string) => z.string().trim().min(1).max(MAX_TITLE, `${what} must be at most ${MAX_TITLE} characters`).describe(`${what} (at most ${MAX_TITLE} characters)`);

const SEGMENT_WORDS: Array<[RegExp, TaskSegment]> = [
  [/^(no preference|none|any|anytime|whenever|flexible|no)$/i, 'any'],
  [/morning|\bam\b|early|dawn-ish|first thing/i, 'morning'],
  [/afternoon|after lunch|midday|noon|\bpm\b/i, 'afternoon'],
  [/evening|night|late|after work|after dinner/i, 'evening'],
];
/** "mornings", "after lunch", "night", "no preference" -> a segment. */
export function parseSegment(input: unknown): TaskSegment {
  if (input === undefined || input === null || input === '') return 'any';
  const word = String(input).trim();
  for (const [re, seg] of SEGMENT_WORDS) if (re.test(word)) return seg;
  throw new Error(`Unknown part of day "${word}". Use morning, afternoon, evening, or any.`);
}

export function importSummary(r: { commitments: unknown[]; events: unknown[]; skipped: number; removed: string[]; calendarName?: string }): string {
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const past = r.events.length - r.commitments.length;
  let s = `Imported ${n(r.commitments.length, 'upcoming event')} for the next 90 days${r.calendarName ? ` from "${r.calendarName}"` : ''}; ${r.skipped} skipped${r.removed.length ? `; ${r.removed.length} removed` : ''}.`;
  if (past > 0) s += ` ${n(past, 'past event')} kept: say "use it as my baseline" (import_as_baseline) to make the baseline week from them.`;
  return s;
}

function latestImport(store: Store, source?: string) {
  if (source) {
    const rec = store.getImportRecord(source);
    if (!rec) throw new Error(`No import found for "${source}". Known sources: ${store.listImportSources().join(', ') || '(none)'}.`);
    return { source, record: rec };
  }
  const all = store.listImportSources().map((src) => ({ source: src, record: store.getImportRecord(src)! })).filter((x) => x.record);
  if (all.length === 0) throw new Error('No imported calendar yet. Import an .ics file or a calendar URL first.');
  all.sort((a, b) => (b.record.importedAt ?? '').localeCompare(a.record.importedAt ?? ''));
  return all[0];
}

/** "deep", "long sessions", "shorter varied blocks", "mix" -> a work style. */
export function parseWorkStyle(input: string): Exclude<WorkStyle, 'unknown'> {
  const w = input.trim().toLowerCase();
  if (/deep|long|focus|few/.test(w)) return 'deep';
  if (/varied|short|fragment|many|switch/.test(w)) return 'varied';
  if (/balanced|mix|between|both|medium/.test(w)) return 'balanced';
  throw new Error(`Unknown work style "${input}". Use deep, varied, or balanced.`);
}

function applyWorkStyle(store: Store, style: Exclude<WorkStyle, 'unknown'>): Settings {
  const s = store.getSettings();
  const preset = WORK_STYLE_PRESETS[style];
  const next: Settings = { ...s, workStyle: style, maxBlockMinutes: preset.maxBlockMinutes, maxTasksPerDay: preset.maxTasksPerDay, minBlockMinutes: Math.min(s.minBlockMinutes, preset.maxBlockMinutes) };
  store.saveSettings(next);
  return next;
}

const whenField = (what: string) => z.string().describe(`${what}. ${TIME_FORMATS}`);
const taskRef = z.string().describe('Task id, or task name (case-insensitive; a unique partial name is accepted)');
const statusField = z.enum(['done', 'skipped', 'pending']).describe('done = completed (positive signal); skipped = not done today, its time is not re-planned today (negative signal; a block that just ended unmarked counts as missed and is not re-placed the same day either, unless plan_schedule names its task in must_do); pending = undo');

/** Reject placements outside availability or on top of something else, unless the caller explicitly allows it. */
function assertPlacement(store: Store, start: Date, end: Date, opts: { excludeBlockId?: string; allowOutside?: boolean; allowOverlap?: boolean }) {
  const settings = store.getSettings();
  const fmt = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (!opts.allowOutside) {
    const day = startOfDay(start);
    const windows = workingIntervals({ start: day, end: addDays(day, 1) }, settings, store.getBaseline());
    const inside = windows.some((w) => w.start <= start && end <= w.end);
    if (!inside) {
      const list = windows.length ? windows.map((w) => `${fmt(w.start)}-${fmt(w.end)}`).join(', ') : 'none';
      throw new Error(`That time is outside your availability: ${fmt(start)}-${fmt(end)} is not inside ${DAY_NAMES[day.getDay()]}'s windows (${list}). Pass allow_outside_availability: true to place it anyway, or change availability first.`);
    }
  }
  if (!opts.allowOverlap) {
    const range = { from: start, to: end };
    const clashes: string[] = [];
    for (const c of store.listCommitments(range)) clashes.push(`"${c.title}" ${fmtTime(c.start)}-${fmtTime(c.end)}`);
    for (const r of expandRecurring(store.listRecurring(), { start, end })) clashes.push(`"${r.title}" ${fmt(r.start)}-${fmt(r.end)}`);
    for (const b of store.listBlocks(range)) if (b.id !== opts.excludeBlockId && (b.status === 'pending' || b.status === 'done')) clashes.push(`"${store.getTask(b.taskId)?.name ?? 'block'}" ${fmtTime(b.start)}-${fmtTime(b.end)}`);
    if (clashes.length) throw new Error(`That time overlaps ${clashes.join(' and ')}. Pick another time, or pass allow_overlap: true.`);
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** A note on a block is the user's words; this cap keeps the prompt's Context and the calendar popover readable. */
export const MAX_NOTE_CHARS = 2000;
const timeOf = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** The instance operations' blocks with task names, and the summary as it is. */
function instanceView(store: Store, r: InstanceResult) {
  const views = (xs: Block[]) => xs.map((b) => view(store, b));
  return { moved: views(r.moved), shortened: views(r.shortened), dropped: views(r.dropped), created: views(r.created), summary: r.summary };
}

export function importBaselineSummary(r: ImportBaselineResult): string {
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const names = (ts: Task[]) => ` (${ts.map((t) => t.name).join(', ')})`;
  const days = [...new Set(r.baseline.slots.map((x) => x.day))].sort().map((d) => DAY_NAMES[d]).join(', ');
  const parts = [`Baseline v${r.baseline.version} saved from ${n(r.weeksSeen, 'week')}: ${n(r.baseline.slots.length, 'slot')} on ${days}`];
  if (r.tasks.created.length) parts.push(`${n(r.tasks.created.length, 'new task')}${names(r.tasks.created)}`);
  if (r.tasks.matched.length) parts.push(`${n(r.tasks.matched.length, 'task')} matched${names(r.tasks.matched)}`);
  if (r.tasks.revived.length) parts.push(`${n(r.tasks.revived.length, 'task')} revived${names(r.tasks.revived)}`);
  if (r.oneOffs.length) {
    const shown = r.oneOffs.slice(0, 3).map((e) => `${e.title} ${DAY_NAMES[new Date(e.start).getDay()]} ${fmtTime(e.start)}-${fmtTime(e.end)}`).join(', ');
    parts.push(`${n(r.oneOffs.length, 'one-off')} left out (${shown}${r.oneOffs.length > 3 ? `, and ${r.oneOffs.length - 3} more` : ''})`);
  }
  return `${parts.join('; ')}.${r.tasks.created.length ? ' Edit titles that are busy time, not work, in the Baseline tab.' : ''}`;
}

/** A busy-time title as data: one line, cut at 60 characters, quotes escaped, angle brackets as ‹ ›. */
function quoteTitle(t: string): string {
  const flat = t.replace(/\s+/g, ' ').trim();
  const cut = flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
  return `"${cut.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '‹').replace(/>/g, '›')}"`;
}

/**
 * get_schedule's one sentence: blocks and busy time in start order ("Today: Leetcode 07:00-08:00 (done), "Dentist"
 * 11:00-12:00, Building 14:00-16:00."), the weekday named when the range spans days, the first eight named and the
 * rest counted so a reply that quotes it stays short. Titles of busy time are quoted: they are data.
 */
function scheduleSummary(blocks: BlockView[], busy: Array<{ title: string; start: string; end: string }>, from: Date, to: Date, today: Date): string {
  const MAX_NAMED = 8;
  const isToday = from.getTime() === today.getTime() && to.getTime() === addDays(today, 1).getTime();
  const oneDay = startOfDay(from).getTime() === startOfDay(new Date(to.getTime() - 1)).getTime();
  const items = [
    ...blocks.map((b) => ({ start: b.start, text: `${b.taskName} ${fmtTime(b.start)}-${fmtTime(b.end)}${b.status === 'pending' ? '' : ` (${b.status})`}` })),
    ...busy.map((c) => ({ start: c.start, text: `${quoteTitle(c.title)} ${fmtTime(c.start)}-${fmtTime(c.end)}` })),
  ].sort((a, b) => a.start.localeCompare(b.start));
  if (!items.length) return isToday ? 'Nothing planned today.' : 'Nothing planned in that range.';
  const named = items.slice(0, MAX_NAMED).map((i) => (oneDay ? i.text : `${DAY_NAMES[new Date(i.start).getDay()]} ${i.text}`));
  const more = items.length > MAX_NAMED ? `, and ${items.length - MAX_NAMED} more` : '';
  const prefix = isToday ? 'Today: ' : oneDay ? `${DAY_NAMES[from.getDay()]}: ` : '';
  return `${prefix}${named.join(', ')}${more}.`;
}

/** "Deep work 09:00-10:00", with the weekday added when the plan spans more than one day (or when asked). */
function describeBlocks(blocks: BlockView[], withDay?: boolean): string {
  const days = new Set(blocks.map((b) => startOfDay(new Date(b.start)).getTime()));
  const multiDay = withDay ?? days.size > 1;
  return blocks
    .map((b) => `${b.taskName} ${multiDay ? `${DAY_NAMES[new Date(b.start).getDay()]} ` : ''}${fmtTime(b.start)}-${fmtTime(b.end)}`)
    .join(', ');
}

export const tools: ToolDef[] = [
  def({
    name: 'get_now',
    description: 'Current local date-time, the availability windows that hold (the usable time the baseline week implies; the settings\' windows only while no baseline exists) and the baseline version. Call it when unsure what "now" or "today" is. Example: {} -> { now, local, availability, baseline }',
    schema: z.object({}),
    run: (store, _input, ctx) => {
      const now = ctx.now();
      const baseline = store.getBaseline();
      const s = settingsWithBaseline(store.getSettings(), baseline);
      return { now: now.toISOString(), local: now.toString(), availability: s.availability, baseline: baseline ? { version: baseline.version, savedAt: baseline.savedAt } : null, segments: s.segments, slotMinutes: s.slotMinutes };
    },
  }),
  def({
    name: 'list_tasks',
    description: 'List the user\'s tasks with id, priority (1 = highest) and time budget per day or week. Example: {} -> { tasks: [...] }',
    schema: z.object({ include_archived: z.boolean().optional().describe('Also return archived tasks (default false)') }),
    run: (store, input) => ({ tasks: store.listTasks(input.include_archived ?? false) }),
  }),
  def({
    name: 'upsert_task',
    description: 'Create a task, or update the task with the same id or the same name. Budget is minutes per day or per week; preferred_segment says which part of the day it should land in. When preferred_segment is omitted the name decides ("Morning learning" prefers mornings); say so in your reply. Example: { "name": "Deep work", "priority": 1, "budget_minutes": 120, "budget_period": "day", "preferred_segment": "morning" }',
    schema: z.object({
      id: z.string().optional().describe('Existing task id to update (optional; the name also matches an existing task)'),
      name: titleField('Task name'),
      priority: z.coerce.number().int().min(1).max(99).describe('1 = highest priority'),
      budget_minutes: z.coerce.number().int().min(1).max(MAX_BUDGET_MINUTES, `budget_minutes is too large (max ${MAX_BUDGET_MINUTES}, a full week)`).describe('Wished minutes per period, e.g. 120'),
      budget_period: z.enum(['day', 'week']).describe('Whether budget_minutes is per day or per week'),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Hex colour like #4f8cff (optional; assigned automatically)'),
      preferred_segment: z.string().optional().describe('Part of the day the task prefers: morning, afternoon, evening, or any (default any). Loose words like "mornings", "after lunch", "night" are fine'),
      session_minutes: z.coerce.number().int().min(15).max(8 * 60).optional().describe('Preferred length of one sitting in minutes, e.g. 120 (default: the max block setting)'),
    }),
    run: (store, input, ctx) => {
      const byName = store.listTasks(true).find((t) => t.name.toLowerCase() === input.name.trim().toLowerCase());
      const existing = (input.id ? store.getTask(input.id) : undefined) ?? byName;
      const count = store.listTasks(true).length;
      const task: Task = {
        id: existing?.id ?? randomUUID(),
        name: input.name.trim(),
        priority: input.priority,
        budgetMinutes: input.budget_minutes,
        budgetPeriod: input.budget_period,
        color: input.color ?? existing?.color ?? TASK_COLORS[count % TASK_COLORS.length],
        preferredSegment: input.preferred_segment !== undefined ? parseSegment(input.preferred_segment)
          : existing?.preferredSegment && existing.preferredSegment !== 'any' ? existing.preferredSegment
          : inferSegment(input.name) ?? 'any',
        sessionMinutes: input.session_minutes ?? existing?.sessionMinutes,
        archived: false,
        createdAt: existing?.createdAt ?? ctx.now().toISOString(),
      };
      return store.upsertTask(task);
    },
  }),
  def({
    name: 'archive_task',
    description: 'Archive a task so it is no longer scheduled; its past blocks are kept. Example: { "task": "Email" }',
    schema: z.object({ task: taskRef }),
    run: (store, input) => { const t = resolveTask(store, input.task); store.archiveTask(t.id); return { ok: true, archived: t.name }; },
  }),
  def({
    name: 'get_schedule',
    description: 'Blocks, commitments and the usable time (availability) in a range (default: today). Use it to see what is planned or to find a block id. Example: { "from": "2026-10-07", "to": "2026-10-08" }',
    schema: z.object({ from: whenField('Range start, inclusive (default: start of today)').optional(), to: whenField('Range end, exclusive (default: end of today)').optional() }),
    run: (store, input, ctx) => {
      materializeMissed(store, ctx.now());
      const day = startOfDay(ctx.now());
      const from = input.from ? parseWhen(input.from, ctx.now()) : day;
      const to = input.to ? parseWhen(input.to, ctx.now()) : addDays(day, 1);
      const blocks = store.listBlocks({ from, to }).map((b) => view(store, b));
      const commitments = store.listCommitments({ from, to });
      const recurring = expandRecurring(store.listRecurring(), { start: from, end: to }).map((r) => ({ recurringId: r.recurringId, title: r.title, start: r.start.toISOString(), end: r.end.toISOString() }));
      return {
        from: from.toISOString(), to: to.toISOString(),
        blocks, commitments, recurring,
        availability: workingIntervals({ start: from, end: to }, store.getSettings(), store.getBaseline()).map((w) => ({ start: w.start.toISOString(), end: w.end.toISOString() })),
        summary: scheduleSummary(blocks, [...commitments, ...recurring], from, to, day),
      };
    },
  }),
  def({
    name: 'plan_schedule',
    description: 'Suggest a baseline (only when none exists): plan from now until `until` (default: end of today\'s availability, or through the next available day when less than one sitting of today is left; horizon "week" plans the rest of the week). Keeps its own pending blocks in that window that still fit and fills the free time around them; only blocks that no longer fit (under a new commitment, outside changed availability, over a reduced budget) are replaced. Later days it already planned keep every block; free time there gets whole sittings while budget remains (reported in `later`). Marks past unfinished blocks as missed, keeps done blocks, avoids commitments, and ranks tasks by priority and remaining budget (must_do tasks first). Use for "suggest a schedule" and, before a baseline exists, "plan my day"; "something came up" is carve_out. Example: { "until": "17:00", "must_do": ["Deep work"] }',
    schema: z.object({
      until: whenField('Plan up to this time (optional). A bare time already past today, like "16:00" at 20:40, means that time tomorrow, so pass it as said').optional(),
      horizon: z.enum(['day', 'week']).optional().describe('"day" (default) or "week"; ignored when until is given'),
      must_do: z.array(z.string()).max(10).optional().describe('Task names (or ids) the user wants done today, also the way to redo a block they did not finish (an unmarked block that ended is missed and not re-placed the same day otherwise); they are placed before everything else, and on a full day the adjacent run of kept planner blocks whose blocks together matter least gives way for one sitting, counting each block as half a point plus its task\'s priority score (never a manual or baseline block)'),
    }),
    run: (store, input, ctx) => {
      // With a baseline the week is the baseline applied and adjusted: blank time stays blank, so the suggestion refuses.
      if (store.getBaseline()?.slots.some((x) => x.kind === 'task')) return { ok: false, note: 'A baseline is set, so the week is the baseline, not a suggestion: lay it with apply_baseline (or Apply on the Baseline tab), then adjust it with shift_day, carve_out or carry_over. plan_schedule suggests a schedule only without a baseline.' };
      const now = ctx.now();
      const status = setupStatus(store);
      const mustDoTasks = (input.must_do ?? []).map((ref) => resolveTask(store, ref));
      // The suggestion needs working hours and tasks, not a baseline (it is how a baseline gets suggested).
      const missing = [...(status.hasAvailability ? [] : ['availability' as const]), ...(status.hasTasks ? [] : ['tasks' as const])];
      if (missing.length) {
        const next_step = missing[0] === 'availability' ? SUGGEST_NEEDS.availability : SUGGEST_NEEDS.tasks;
        return {
          setup: true,
          created: [],
          missing,
          next_step,
          summary: `Not planned: no ${missing.map((m) => (m === 'availability' ? 'working hours' : 'tasks')).join(' and ')} yet. ${next_step}`,
        };
      }
      let until = input.until ? parseWhen(input.until, now) : undefined;
      // A bare time already past ("free until 16:00" said at 20:40) means that time tomorrow: a window ending before now is never meant.
      if (until && until <= now && BARE_TIME.test(input.until!.trim())) until = addDays(until, 1);
      const limit = addDays(now, MAX_HORIZON_DAYS);
      let capped = false;
      if (until && until > limit) { until = limit; capped = true; }
      const r = plan(store, { now, until, horizon: input.horizon, mustDo: mustDoTasks.map((t) => t.id) });
      const created = r.created.map((b) => view(store, b));
      const kept = r.kept.map((b) => view(store, b));
      const later = r.later.map((b) => view(store, b));
      const settings = settingsWithBaseline(store.getSettings(), store.getBaseline());
      const today = workingIntervals({ start: startOfDay(now), end: addDays(startOfDay(now), 1) }, settings);
      const lastToday = today[today.length - 1];
      const notes: string[] = [];
      if (capped) notes.push(`Planned up to ${DAY_NAMES[limit.getDay()]} ${limit.toISOString().slice(0, 10)} only: ${MAX_HORIZON_DAYS} days per call is the limit.`);
      // A block that became missed in this plan (it ended unmarked) is named with the way to redo it, since missed means
      // not today unless the user says so; a block with tracked minutes was finished instead and is not named.
      const nowMissed = r.missed.filter((b) => b.status === 'missed').map((b) => view(store, b));
      if (nowMissed.length) {
        const when = (b: BlockView) => `${b.taskName} ${startOfDay(new Date(b.start)).getTime() === startOfDay(now).getTime() ? '' : `${DAY_NAMES[new Date(b.start).getDay()]} `}${fmtTime(b.start)}`;
        notes.push(`${nowMissed.map(when).join(', ')} missed (say "I didn't finish ${nowMissed[0].taskName}" to redo it).`);
      }
      // Must-do: say where the task landed, or why it did not, never that it was placed when it was not.
      const displaced = r.displaced.map((b) => view(store, b));
      const extended = r.extended.map((b) => view(store, b));
      const placed = [...kept, ...created].sort((a, b) => a.start.localeCompare(b.start));
      const firstAvailable = workingIntervals(r.window, settings)[0]?.start ?? now;
      const dayWord = (day: Date) => (startOfDay(day).getTime() === startOfDay(now).getTime() ? 'today' : `on ${DAY_NAMES[day.getDay()]}`);
      for (const t of mustDoTasks) {
        // A block that grew to a whole sitting is named by its new span; a sitting added beside an earlier scrap by its start.
        const grown = extended.find((b) => b.taskId === t.id);
        const mine = created.find((b) => b.taskId === t.id) ?? placed.find((b) => b.taskId === t.id);
        if (grown) notes.push(`${t.name} extended to ${fmtTime(grown.start)}-${fmtTime(grown.end)}, as asked.`);
        else if (!mine) {
          const dayStart = startOfDay(firstAvailable);
          const todays = store.listBlocks({ from: dayStart, to: addDays(dayStart, 1) }).filter((b) => b.taskId === t.id && (b.status === 'pending' || b.status === 'done'));
          if (todays.length) notes.push(`${t.name} already has ${todays.map((b) => `${fmtTime(b.start)}-${fmtTime(b.end)}${b.status === 'done' ? ' (done)' : ''}`).join(', ')} ${dayWord(dayStart)}.`);
          else {
            const period = periodRange(t.budgetPeriod, firstAvailable, settings);
            const left = remainingMinutes(t, store.listBlocks({ from: period.start, to: period.end }), firstAvailable, settings);
            notes.push(`${t.name} was not placed: ${left < settings.minBlockMinutes ? `its ${t.budgetPeriod === 'day' ? 'daily' : 'weekly'} budget is already done or planned` : 'no free time in the window and no planner block to give way'}.`);
          }
        } else if (mine === placed[0]) notes.push(`${t.name} first, as asked.`);
        else notes.push(`${t.name} ${startOfDay(new Date(mine.start)).getTime() === startOfDay(now).getTime() ? 'at' : DAY_NAMES[new Date(mine.start).getDay()]} ${fmtTime(mine.start)}, as asked.`);
      }
      // A task that gave way and keeps another sitting in its period is named with its time; one left with none is said plainly.
      const orphaned = displaced.filter((b) => {
        const period = periodRange(store.getTask(b.taskId)!.budgetPeriod, new Date(b.start), settings);
        return !store.listBlocks({ from: period.start, to: period.end }).some((o) => o.taskId === b.taskId && (o.status === 'pending' || o.status === 'done'));
      });
      const rest = displaced.filter((b) => !orphaned.includes(b));
      if (rest.length) notes.push(`${describeBlocks(rest)} gave way.`);
      for (const name of new Set(orphaned.map((b) => b.taskName))) {
        const b = orphaned.find((o) => o.taskName === name)!;
        notes.push(`"${name}" gave way and has no other sitting ${store.getTask(b.taskId)!.budgetPeriod === 'day' ? dayWord(new Date(b.start)) : 'this week'}.`);
      }
      if (!lastToday) notes.push('There is no availability today.');
      else if (lastToday.end <= now) notes.push(`Availability for today ended at ${fmtTime(lastToday.end.toISOString())}.`);
      // What a re-plan did to the blocks that were already there, so the assistant can say "kept as they were" instead of
      // describing the whole schedule again.
      const diff = (verb: string) => [
        kept.length ? `${kept.length} kept as ${kept.length === 1 ? 'it was' : 'they were'}` : '',
        r.removed ? `${r.removed} ${verb}` : '',
      ].filter(Boolean).join(', ');
      // Sittings the re-plan added to already planned days after the window, named apart so the assistant can say so. The
      // first two are named and the rest counted, so a reply that quotes the summary stays inside the word cap.
      const thisWeek = later.every((b) => new Date(b.start) < periodRange('week', now, settings).end);
      const laterNote = later.length ? `${later.length} more sitting${later.length === 1 ? '' : 's'} ${thisWeek ? 'later in the week' : 'on later days'} (${describeBlocks(later.slice(0, 2), true)}${later.length > 2 ? ` and ${later.length - 2} more` : ''})` : '';
      let summary: string;
      if (created.length) {
        const firstDay = startOfDay(new Date(created[0].start)).getTime() !== startOfDay(now).getTime() ? ` Planned from ${DAY_NAMES[new Date(created[0].start).getDay()]}.` : '';
        const changes = diff('replaced');
        const list = changes ? `${changes}; ${created.length} added` : `${created.length} block${created.length === 1 ? '' : 's'}`;
        summary = `${notes.join(' ')}${firstDay} ${list}: ${describeBlocks(created)}${laterNote ? `, and ${laterNote}` : ''}`.trim();
      } else if (kept.length) {
        summary = r.removed
          ? `${notes.join(' ')} ${diff('removed')}; no free time was left to re-place ${r.removed === 1 ? 'it' : 'them'}.`.trim()
          : `${notes.join(' ')} ${laterNote ? `${diff('')}; ${laterNote}.` : `Nothing to change: ${diff('')}.`}`.trim();
      } else if (workingIntervals(r.window, settings).length === 0) {
        summary = `No availability between ${fmtTime(r.window.start.toISOString())} and ${fmtTime(r.window.end.toISOString())}. ${notes.join(' ')} To work in that time, add a window with set_availability (for example an evening window), then plan again.`.replace(/\s+/g, ' ');
      } else {
        summary = `${notes.join(' ')} ${r.removed ? `${diff('removed')}. ` : ''}No blocks created: the free time in the window is already used or every task has used its budget for the period.`.trim();
      }
      if (laterNote && !created.length && !(kept.length && !r.removed)) summary += ` ${laterNote}.`;
      // A day carrying more distinct tasks (live blocks of any source) than the cap is named, so the assistant can offer a
      // lighter day; a day at the cap is within the user's setting. Only a must-do or hand-placed blocks take a day past it.
      const perDay = new Map<number, Set<string>>();
      for (const b of store.listBlocks({ from: startOfDay(r.window.start), to: r.window.end })) {
        if (b.status !== 'pending' && b.status !== 'done') continue;
        const day = startOfDay(new Date(b.start)).getTime();
        perDay.set(day, (perDay.get(day) ?? new Set()).add(b.taskId));
      }
      const busiest = [...perDay].sort((a, b) => b[1].size - a[1].size || a[0] - b[0])[0];
      if (busiest && busiest[1].size > settings.maxTasksPerDay) summary += ` Busiest day: ${DAY_NAMES[new Date(busiest[0]).getDay()]}, ${busiest[1].size} tasks.`;
      // A task the first day owes a sitting that found no room (a saved routine, hand-placed blocks or commitments fill the day):
      // named with the way out, so it is not silently dropped. A named (must do) task has its own note above.
      const noRoom = r.unplaced.filter((t) => !r.overCap.some((o) => o.id === t.id));
      if (noRoom.length) summary += ` No room for: ${noRoom.map((t) => t.name).join(', ')} (say "must do ${noRoom[0].name}" or free a slot).`;
      // A weekly budget the week can no longer meet (the window holds its last available day) is named with its minutes.
      // The advice names the smallest cap at which this plan would meet every budget (a day holds max(1, cap - daily
      // tasks) weekly places, so the first cap worth naming is the daily tasks plus two); when no cap would, the week's
      // free time is what is short and the way out is less weekly work.
      const fits = r.weeklyUnmet.length || r.overCap.length ? capThatFits(store, { now, until, horizon: input.horizon, mustDo: mustDoTasks.map((t) => t.id) }) : undefined;
      const raise = fits === undefined ? undefined : `raise max_tasks_per_day to ${fits}`;
      if (r.weeklyUnmet.length) summary += ` Weekly budget unmet: ${r.weeklyUnmet.map((x) => `${x.task.name} ${x.minutes} min`).join(', ')} (${raise ? `${raise} or free a slot` : 'fewer weekly tasks or smaller budgets'}).`;
      // A task the per-day cap kept off every day it wanted is the user's setting at work, not a full day: named with the dial.
      // On a day plan the sentence is about the day (and only a task with no block anywhere in its week is named, see `plan`).
      if (r.overCap.length) summary += ` The cap of ${settings.maxTasksPerDay} tasks a day kept ${r.overCap.map((t) => t.name).join(', ')} off ${input.horizon === 'week' ? 'every day' : dayWord(firstAvailable)}; ${raise ? `${raise} or drop a task` : 'fewer weekly tasks or smaller budgets'}.`;
      return {
        window: { start: r.window.start.toISOString(), end: r.window.end.toISOString() },
        created,
        kept,
        later,
        missed: r.missed.map((b) => view(store, b)),
        removed: r.removed,
        displaced,
        extended,
        summary,
      };
    },
  }),
  def({
    name: 'mark_block',
    description: 'Set one block\'s status by block id (from get_schedule). Example: { "block_id": "…", "status": "done" }',
    schema: z.object({ block_id: z.string().describe('Block id from get_schedule or plan_schedule'), status: statusField }),
    run: (store, input, ctx) => view(store, markBlock(store, input.block_id, input.status, ctx.now())),
  }),
  def({
    name: 'move_block',
    description: 'Move one block to a new start (and optionally a new end), keeping its length unless end is given. Pick the block by block_id, or by task (the block of that task the user most likely means right now). The moved block is kept by later re-plans. Example: { "task": "Leetcode", "start": "10:00" }',
    schema: z.object({
      block_id: z.string().optional().describe('Block id from get_schedule'),
      task: taskRef.optional(),
      start: whenField('New start'),
      end: whenField('New end (optional; default keeps the current length)').optional(),
      allow_outside_availability: z.boolean().optional().describe('Place it even outside the availability windows (default false)'),
      allow_overlap: z.boolean().optional().describe('Place it even on top of another block or commitment (default false)'),
    }),
    run: (store, input, ctx) => {
      const now = ctx.now();
      let block = input.block_id ? store.getBlock(input.block_id) : undefined;
      if (!block && input.task) { const t = resolveTask(store, input.task); block = findTaskBlock(store, t.id, now); if (!block) throw new Error(`No block for "${t.name}" today. Use get_schedule to find one, or add_block to create one.`); }
      if (!block) throw new Error('Give block_id or task.');
      const start = parseWhen(input.start, now);
      const length = new Date(block.end).getTime() - new Date(block.start).getTime();
      const end = input.end ? parseWhen(input.end, now) : new Date(start.getTime() + length);
      assertPlacement(store, start, end, { excludeBlockId: block.id, allowOutside: input.allow_outside_availability, allowOverlap: input.allow_overlap });
      return view(store, moveBlock(store, block.id, start, end));
    },
  }),
  def({
    name: 'add_block',
    description: 'Place one block of a task by hand at a given time. It is kept by later re-plans. Example: { "task": "Leetcode", "start": "tomorrow 09:00", "end": "tomorrow 10:00" }',
    schema: z.object({
      task: taskRef, start: whenField('Start'), end: whenField('End'),
      allow_outside_availability: z.boolean().optional().describe('Place it even outside the availability windows (default false)'),
      allow_overlap: z.boolean().optional().describe('Place it even on top of another block or commitment (default false)'),
    }),
    run: (store, input, ctx) => {
      const t = resolveTask(store, input.task);
      const now = ctx.now();
      const start = parseWhen(input.start, now);
      const end = parseWhen(input.end, now);
      assertPlacement(store, start, end, { allowOutside: input.allow_outside_availability, allowOverlap: input.allow_overlap });
      return view(store, createBlock(store, t.id, start, end, now));
    },
  }),
  def({
    name: 'delete_block',
    description: 'Delete one block by id (from get_schedule). To delete many, use clear_schedule. Example: { "block_id": "…" }',
    schema: z.object({ block_id: z.string().describe('Block id') }),
    run: (store, input) => {
      if (!store.getBlock(input.block_id)) throw new Error(`Block not found: ${input.block_id}`);
      store.deleteBlocks([input.block_id]);
      return { ok: true };
    },
  }),
  def({
    name: 'mark_task',
    description: 'Mark the block of a task that the user means right now (the one happening now, else the latest one today) as done or skipped. Prefer this when the user names a task. Example: { "task": "Deep work", "status": "done" }',
    schema: z.object({ task: taskRef, status: statusField }),
    run: (store, input, ctx) => {
      const t = resolveTask(store, input.task);
      const b = findTaskBlock(store, t.id, ctx.now());
      if (!b) throw new Error(`No block for "${t.name}" today. Use get_schedule to find one on another day, or plan_schedule first.`);
      return view(store, markBlock(store, b.id, input.status, ctx.now()));
    },
  }),
  def({
    name: 'note_block',
    description: 'Write the user\'s note on a block, in their words ("did the session but not focused", "Leetcode and Reading share this slot; Reading got done", anything they want remembered about that sitting): it is kept with the block, shown in the calendar and in your Context for the next two weeks, and weighed when scheduling. Pick the block by block_id (from get_schedule), or by task (the block of that task the user means right now). An empty note clears it. Not a calendar change. Example: { "task": "Leetcode", "note": "did it, not focused" }',
    schema: z.object({
      task: taskRef.optional(), block_id: z.string().optional().describe('Block id from get_schedule'),
      note: z.string().max(MAX_NOTE_CHARS, `A note is at most ${MAX_NOTE_CHARS} characters`).describe('The note, in the user\'s words; empty clears it'),
    }),
    run: (store, input, ctx) => {
      const now = ctx.now();
      let block = input.block_id ? store.getBlock(input.block_id) : undefined;
      if (!block && input.task) { const t = resolveTask(store, input.task); block = findTaskBlock(store, t.id, now); if (!block) throw new Error(`No block for "${t.name}" today. Use get_schedule to find one on another day.`); }
      if (!block && input.block_id) throw new Error(`Block not found: ${input.block_id}`);
      if (!block) throw new Error('Give a task or a block_id');
      const note = input.note.replace(/\s+/g, ' ').trim();
      const updated = store.updateBlock(block.id, { note: note || null });
      const when = `${DAY_NAMES[new Date(updated.start).getDay()]} ${timeOf(new Date(updated.start))}`;
      const name = store.getTask(updated.taskId)?.name ?? 'Unknown task';
      const summary = note ? `Noted on "${name}" ${when}: "${note}".` : `Cleared the note on "${name}" ${when}.`;
      return { block: view(store, updated), summary };
    },
  }),
  def({
    name: 'track_time',
    description: 'Run the clock on a block or log actual minutes: start (pauses any other running block; works on a block of any day, which stays where it is while the clock records the actual start), pause, finish (marks done; an early finish shortens the block and keeps the planned length), set (log minutes by hand). Pick the block by block_id, or by task (the block of that task the user most likely means right now). Example: { "task": "Deep work", "action": "start" }; { "task": "Deep work", "action": "finish" }; { "task": "Reading", "action": "set", "minutes": 45 }',
    schema: z.object({
      task: taskRef.optional(), block_id: z.string().optional().describe('Block id from get_schedule'),
      action: z.enum(['start', 'pause', 'finish', 'set']).describe('start | pause | finish | set (minutes required)'),
      minutes: z.number().int().min(0).max(24 * 60).optional().describe('Actual minutes, with action "set"'),
    }),
    run: (store, input, ctx) => {
      const now = ctx.now();
      let block = input.block_id ? store.getBlock(input.block_id) : undefined;
      if (!block && input.task) { const t = resolveTask(store, input.task); block = findTaskBlock(store, t.id, now); if (!block) throw new Error(`No block for "${t.name}" today. Use get_schedule to find one, or add_block first.`); }
      if (!block && input.block_id) throw new Error(`Block not found: ${input.block_id}`);
      if (!block) throw new Error('Give block_id or task.');
      const r = trackBlock(store, block.id, input.action, now, input.minutes);
      const name = store.getTask(r.block.taskId)?.name ?? 'Unknown task';
      const range = `${fmtTime(r.block.start)}-${fmtTime(r.block.end)}`;
      const pausedNote = r.paused.length ? `; paused ${r.paused.map((p) => `"${store.getTask(p.taskId)?.name ?? '?'}" at ${p.trackedMinutes ?? 0} min`).join(', ')}` : '';
      const summary = input.action === 'start' ? `Started "${name}" ${range}${pausedNote}.`
        : input.action === 'pause' ? `Paused "${name}" at ${r.elapsedMinutes} min.`
        : input.action === 'finish' ? (r.block.trackedMinutes === undefined ? `Finished "${name}" (no clock).` : `Finished "${name}" after ${r.elapsedMinutes} min${r.block.plannedMinutes ? ` (planned ${r.block.plannedMinutes})` : ''}.`)
        : `Logged ${r.block.trackedMinutes ?? 0} min on "${name}".`;
      return { ok: true, block: view(store, r.block), paused: r.paused.map((p) => view(store, p)), elapsedMinutes: r.elapsedMinutes, summary };
    },
  }),
  def({
    name: 'add_commitment',
    description: 'Add a meeting or appointment so planning avoids that time. Example: { "title": "Standup", "start": "10:00", "end": "10:30" }',
    schema: z.object({ title: titleField('Title'), start: whenField('Start time'), end: whenField('End time') }),
    run: (store, input, ctx) => {
      const start = parseWhen(input.start, ctx.now());
      const end = parseWhen(input.end, ctx.now());
      if (end <= start) throw new Error('end must be after start');
      if (end.getTime() - start.getTime() > MAX_COMMITMENT_MS) throw new Error('A commitment can be at most 24 hours long. Use add_recurring_commitment for weekly fixed time, or set_availability for days off.');
      return store.addCommitment({ id: randomUUID(), title: input.title.trim(), start: start.toISOString(), end: end.toISOString() });
    },
  }),
  def({
    name: 'remove_commitment',
    description: 'Remove a commitment by id (from get_schedule). Example: { "commitment_id": "…" }',
    schema: z.object({ commitment_id: z.string().describe('Commitment id') }),
    run: (store, input) => { store.deleteCommitment(input.commitment_id); return { ok: true }; },
  }),
  def({
    name: 'get_setup_status',
    description: 'Whether a baseline week exists (ready); if not, missing is ["baseline"] and next_step is the one line to say about setting one up. Example: {} -> { ready, missing, next_step }',
    schema: z.object({}),
    run: (store) => setupStatus(store),
  }),
  def({
    name: 'set_availability',
    description: 'Set the availability windows: when the user is willing to work, each window days plus start and end; mode "replace" (default) sets the whole template, "add" appends. Applies only without a baseline: once a baseline week exists its slots say when the user works, and this tool makes no change and says to edit the Baseline tab. Example: { "windows": [{ "days": "weekdays", "start": "09:00", "end": "18:00" }, { "days": ["mon","tue","wed","thu"], "start": "20:00", "end": "22:30" }] }',
    schema: z.object({
      windows: z.array(z.object({ days: daysField, start: hhmmField('Window start'), end: hhmmField('Window end') })).max(MAX_WINDOWS, `At most ${MAX_WINDOWS} windows per call`).describe('Availability windows'),
      mode: z.enum(['replace', 'add']).optional().describe('"replace" (default) or "add"'),
    }),
    run: (store, input) => {
      if (store.getBaseline()?.slots.some((x) => x.kind === 'task')) return { ok: false, note: 'A baseline is set; edit it on the Baseline tab (or say "this is my baseline" after arranging the week). Availability windows apply only without a baseline.' };
      if (input.windows.length === 0) throw new Error('At least one window is required.');
      const windows = input.windows.map(toWindow);
      const settings = store.getSettings();
      const availability = input.mode === 'add' ? [...settings.availability, ...windows] : windows;
      if (availability.length > MAX_WINDOWS) throw new Error(`At most ${MAX_WINDOWS} availability windows in total; replace the template instead of adding more.`);
      const next: Settings = { ...settings, availability };
      store.saveSettings(next);
      return { availability: next.availability, setup: setupStatus(store) };
    },
  }),
  def({
    name: 'add_recurring_commitment',
    description: 'Add a fixed commitment that repeats every week (standup, class, gym). Planning avoids it. Example: { "title": "Standup", "days": "weekdays", "start": "10:00", "end": "10:30" }',
    schema: z.object({ title: titleField('Title'), days: daysField, start: hhmmField('Start'), end: hhmmField('End') }),
    run: (store, input) => {
      const w = toWindow({ days: input.days, start: input.start, end: input.end });
      return store.addRecurring({ id: randomUUID(), title: input.title.trim(), days: w.days, start: w.start, end: w.end });
    },
  }),
  def({
    name: 'remove_recurring_commitment',
    description: 'Remove a weekly recurring commitment by title or id. Example: { "recurring": "Standup" }',
    schema: z.object({ recurring: z.string().describe('Title (case-insensitive, unique partial accepted) or id') }),
    run: (store, input) => { const r = resolveRecurring(store, input.recurring); store.deleteRecurring(r.id); return { ok: true, removed: r.title }; },
  }),
  def({
    name: 'set_work_style',
    description: 'Record how the user likes to work and set the matching defaults: deep (120-min sittings, at most 4 tasks a day), balanced (90 min, 6 tasks), or varied (60 min, 8 tasks). Example: { "style": "deep" }',
    schema: z.object({ style: z.string().describe('deep, balanced, or varied; loose words like "long sessions" or "shorter blocks" are fine') }),
    run: (store, input) => {
      const style = parseWorkStyle(input.style);
      return { settings: applyWorkStyle(store, style), summary: `Work style set to ${style}: sittings of ${WORK_STYLE_PRESETS[style].maxBlockMinutes} min, up to ${WORK_STYLE_PRESETS[style].maxTasksPerDay} tasks a day.` };
    },
  }),
  def({
    name: 'update_settings',
    description: 'Change planning sizes and day segments: slot grid, minimum and maximum block length, week start, review window, when morning ends and when evening starts. Availability is set with set_availability. Example: { "max_block_minutes": 120, "morning_end": "11:30" }',
    schema: z.object({
      slot_minutes: z.coerce.number().int().min(5).max(60).optional().describe('Grid snap in minutes (5 to 60)'),
      min_block_minutes: z.coerce.number().int().min(5).optional().describe('Shortest block in minutes'),
      max_block_minutes: z.coerce.number().int().min(5).optional().describe('Longest block in minutes'),
      week_starts_on: daysField.optional().describe('Weekday the week starts on, e.g. "mon" or 1'),
      review_window: z.enum(['day', 'week']).optional().describe('Period for statistics'),
      morning_end: hhmmField('When morning ends (default 12:00)').optional(),
      afternoon_end: hhmmField('When afternoon ends and evening starts (default 17:00)').optional(),
      max_tasks_per_day: z.coerce.number().int().min(1).max(50).optional().describe('How many different tasks a day may hold at most (default 5); one weekly task a day always fits; a task kept off by it is named in the plan summary'),
      priority_weight: z.coerce.number().min(0).max(1).optional().describe('How much priority counts when picking the next block (0 to 1, default 0.6)'),
      deficit_weight: z.coerce.number().min(0).max(1).optional().describe('How much remaining budget counts, which produces rotation (0 to 1, default 0.4)'),
    }),
    run: (store, input) => {
      const s = store.getSettings();
      const next: Settings = {
        ...s,
        slotMinutes: input.slot_minutes ?? s.slotMinutes,
        minBlockMinutes: input.min_block_minutes ?? s.minBlockMinutes,
        maxBlockMinutes: input.max_block_minutes ?? s.maxBlockMinutes,
        weekStartsOn: input.week_starts_on !== undefined ? parseDays(input.week_starts_on)[0] : s.weekStartsOn,
        reviewWindow: input.review_window ?? s.reviewWindow,
        segments: {
          morningEnd: input.morning_end !== undefined ? normalizeHhmm(input.morning_end, 'morning_end') : s.segments.morningEnd,
          afternoonEnd: input.afternoon_end !== undefined ? normalizeHhmm(input.afternoon_end, 'afternoon_end') : s.segments.afternoonEnd,
        },
      };
      next.weights = { priority: input.priority_weight ?? s.weights.priority, deficit: input.deficit_weight ?? s.weights.deficit };
      next.maxTasksPerDay = input.max_tasks_per_day ?? s.maxTasksPerDay;
      if (next.weights.priority + next.weights.deficit <= 0) throw new Error('At least one of priority_weight and deficit_weight must be above zero.');
      if (next.segments.morningEnd >= next.segments.afternoonEnd) throw new Error(`morning_end (${next.segments.morningEnd}) must be before afternoon_end (${next.segments.afternoonEnd}).`);
      if (next.minBlockMinutes > next.maxBlockMinutes) throw new Error(`min_block_minutes (${next.minBlockMinutes}) must not exceed max_block_minutes (${next.maxBlockMinutes}).`);
      store.saveSettings(next);
      return { settings: next };
    },
  }),
  def({
    name: 'import_calendar',
    description: 'Import existing events from a calendar URL (a Google Calendar "secret address in iCal format", or any .ics link; webcal:// is accepted). Every event in the next 90 days, including each occurrence of repeating ones, becomes a commitment. Re-importing the same URL refreshes: changed events update, removed ones disappear. Example: { "url": "https://calendar.google.com/calendar/ical/…/private-…/basic.ics" }',
    schema: z.object({ url: z.string().describe('https:// or webcal:// link to an .ics feed') }),
    run: async (store, input, ctx) => {
      if (!ctx.fetchText) throw new Error('Fetching URLs is not available in this context. Ask the user to use the Import button for a file instead.');
      let url = input.url.trim().replace(/^webcal:\/\//i, 'https://');
      if (!/^https?:\/\//i.test(url)) throw new Error('The calendar URL must start with http://, https:// or webcal://.');
      const text = await ctx.fetchText(url);
      const r = importIcs(store, text, ctx.now(), url);
      return { ...r, events: undefined, summary: importSummary(r) };
    },
  }),
  def({
    name: 'clear_schedule',
    description: 'Delete planned (pending) blocks, by default everything from now on. Done blocks are kept unless include_done is true. Example: { "from": "tomorrow 00:00", "to": "tomorrow 23:59" }',
    schema: z.object({
      from: whenField('Start of the range (default: now)').optional(),
      to: whenField('End of the range (default: one year ahead)').optional(),
      include_done: z.boolean().optional().describe('Also delete blocks marked done (default false)'),
    }),
    run: (store, input, ctx) => {
      const now = ctx.now();
      const from = input.from ? parseWhen(input.from, now) : now;
      const to = input.to ? parseWhen(input.to, now) : addDays(now, 365);
      const victims = store.listBlocks({ from, to }).filter((b) => b.status === 'pending' || (input.include_done && b.status === 'done'));
      store.deleteBlocks(victims.map((b) => b.id));
      return { removed: victims.length, from: from.toISOString(), to: to.toISOString() };
    },
  }),
  def({
    name: 'save_baseline',
    description: 'Save a week (default: the current week) as the baseline week, a new version: its task blocks become task slots (which task sits where on each weekday) and its one-off commitments busy slots. Use when the user says the current layout is their baseline. Example: {}',
    schema: z.object({
      from: whenField('Start of the range to snapshot (default: start of this week)').optional(),
      to: whenField('End of the range (default: end of this week)').optional(),
      days: daysField.optional().describe('Only keep these weekdays, e.g. "fri" or ["mon","tue"]'),
      confirm: z.boolean().optional().describe('Save even if some days are only partly planned (default false: the tool asks first)'),
    }),
    run: (store, input, ctx) => {
      const now = ctx.now();
      const settings = store.getSettings();
      const from = input.from ? parseWhen(input.from, now) : startOfWeek(now, settings.weekStartsOn);
      const to = input.to ? parseWhen(input.to, now) : addDays(startOfWeek(now, settings.weekStartsOn), 7);
      const keepDays = input.days !== undefined ? new Set(parseDays(input.days)) : null;
      const onKeptDay = (x: { start: string }) => !keepDays || keepDays.has(new Date(x.start).getDay());
      const blocks = store.listBlocks({ from, to }).filter((b) => (b.status === 'pending' || b.status === 'done') && onKeptDay(b));
      const commitments = store.listCommitments({ from, to }).filter(onKeptDay);
      if (blocks.length === 0) throw new Error('No blocks in that week to save. Arrange the week first (plan, drag, or right-click), then save it as the baseline.');
      if (!input.confirm && !keepDays) {
        // A day with blocks covering less than half of its availability is probably not meant as a template day.
        const partial: string[] = [];
        for (let day = startOfDay(from); day < to; day = addDays(day, 1)) {
          const dayBlocks = blocks.filter((b) => startOfDay(new Date(b.start)).getTime() === day.getTime());
          if (!dayBlocks.length) continue;
          const avail = workingIntervals({ start: day, end: addDays(day, 1) }, settings, store.getBaseline()).reduce((n, w) => n + (w.end.getTime() - w.start.getTime()) / 60000, 0);
          const covered = dayBlocks.reduce((n, b) => n + (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000, 0);
          if (avail > 0 && covered / avail < 0.5) partial.push(DAY_NAMES[day.getDay()]);
        }
        if (partial.length) {
          return { needsConfirmation: true, partialDays: partial, summary: `${partial.join(', ')} ${partial.length === 1 ? 'is' : 'are'} only partly planned. Ask whether to keep those days (then call again with confirm: true) or leave them out (call again with days set to the days to keep).` };
        }
      }
      // An end on a later day is midnight of the slot's day.
      const endOf = (x: { start: string; end: string }) => (startOfDay(new Date(x.end)).getTime() > startOfDay(new Date(x.start)).getTime() ? '24:00' : fmtTime(x.end));
      const template = blocks.map((b) => ({ taskId: b.taskId, taskName: store.getTask(b.taskId)?.name ?? 'Unknown task', day: new Date(b.start).getDay(), start: fmtTime(b.start), end: endOf(b) }))
        .sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
      const busy = commitments.map((c) => ({ day: new Date(c.start).getDay(), start: fmtTime(c.start), end: endOf(c), title: c.title }))
        .sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
      store.setBaseline({ slots: [...template.map(({ taskId, day, start, end }) => ({ day, start, end, kind: 'task' as const, taskId })), ...busy.map((x) => ({ ...x, kind: 'busy' as const }))], savedAt: now.toISOString() });
      const version = store.getBaseline()!.version;
      refreshBudgets(store, store.getBaseline()!); // each slotted task's budget and session now come from the baseline
      // The saved week is settled: lock its blocks so later re-plans edit around them instead of regenerating.
      for (const b of blocks) if (b.source !== 'baseline') store.updateBlock(b.id, { source: 'baseline' });
      const days = [...new Set([...template, ...busy].map((x) => x.day))].sort();
      const observed = inferWorkStyle(blocks.map((b) => (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000));
      const observedStyle = { ...observed, differsFromSetting: observed.style !== 'unknown' && observed.style !== settings.workStyle };
      const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
      return { blocks: template, busy, version, observedStyle, summary: `Saved ${n(template.length, 'task slot')} and ${n(busy.length, 'busy slot')} on ${days.map((d) => DAY_NAMES[d]).join(', ')} as baseline v${version}.` };
    },
  }),
  def({
    name: 'apply_baseline',
    description: 'Copy the baseline week onto a week (default: next week): its task slots become blocks the planner keeps, its busy slots commitments. Earlier copies still ahead are replaced, so a re-apply never duplicates; a block the user moved, shortened or split is that sitting and stays; a slot under a commitment or over another task\'s block is skipped and named. Example: { "week_of": "next week" }',
    schema: z.object({ week_of: z.string().optional().describe('"next week" (default), "this week", or any date inside the target week') }),
    run: (store, input, ctx) => {
      const now = ctx.now();
      const settings = store.getSettings();
      const baseline = store.getBaseline();
      if (!baseline || !baseline.slots.some((x) => x.kind === 'task')) throw new Error('No baseline saved yet. Arrange a week, then say "this is my baseline" (save_baseline), or import a past week (import_as_baseline).');
      const word = (input.week_of ?? 'next week').trim().toLowerCase();
      const anchor = word === 'next week' ? addDays(now, 7) : word === 'this week' ? now : parseWhen(input.week_of!, now);
      const weekStart = startOfWeek(anchor, settings.weekStartsOn);
      const r = applyToWeek(store, baseline, weekStart, now);
      const busy = r.commitments.length ? ` and ${r.commitments.length} busy slot${r.commitments.length === 1 ? '' : 's'}` : '';
      const skippedNote = r.skipped.length ? `; skipped ${r.skipped.map((x) => `${store.getTask(x.slot.taskId!)?.name ?? 'Unknown task'} ${DAY_NAMES[x.slot.day]} ${x.slot.start} (${x.reason})`).join(', ')}` : '';
      return {
        week: { start: weekStart.toISOString(), end: addDays(weekStart, 7).toISOString() },
        created: r.created.map((b) => view(store, b)),
        commitments: r.commitments,
        replaced: r.replaced,
        skipped: r.skipped,
        summary: `Copied ${r.created.length} baseline block${r.created.length === 1 ? '' : 's'}${busy} onto the week of ${DAY_NAMES[weekStart.getDay()]} ${weekStart.toISOString().slice(0, 10)}${r.replaced ? `, replacing ${r.replaced}` : ''}${skippedNote}.`,
      };
    },
  }),
  def({
    name: 'import_as_baseline',
    description: 'Make the baseline week from a past calendar, verbatim: the events of the last 60 days, grouped by weekday and time; what repeats in at least half of the weeks seen becomes a task slot (its title matched to a task by name, an archived one revived, or a new task made), the rest are left out as one-offs. Give the .ics text, a calendar URL, or nothing to use the last imported calendar. Example: {} -> { baseline, tasks, oneOffs, summary }',
    schema: z.object({
      ics: z.string().optional().describe('The .ics text of a calendar export (optional)'),
      url: z.string().optional().describe('https:// or webcal:// link to an .ics feed (optional)'),
    }),
    run: (store, input, ctx) => {
      const now = ctx.now();
      const finish = (r: ImportBaselineResult, source?: string) => ({ ...r, source, summary: importBaselineSummary(r) });
      if (input.ics) return finish(importAsBaseline(store, input.ics, now));
      if (input.url) {
        if (!ctx.fetchText) throw new Error('Fetching URLs is not available in this context. Ask the user to use the Import button for a file instead.');
        const url = input.url.trim().replace(/^webcal:\/\//i, 'https://');
        if (!/^https?:\/\//i.test(url)) throw new Error('The calendar URL must start with http://, https:// or webcal://.');
        return ctx.fetchText(url).then((text) => finish(importAsBaseline(store, text, now), url));
      }
      const { source, record } = latestImport(store);
      return finish(baselineFromEvents(store, record.events, now), source);
    },
  }),
  def({
    name: 'shift_day',
    description: 'Shift the rest of today to start now ("I am late, move everything up"): the block containing now starts now (its end unchanged), each later pending block moves up to the previous one\'s end, skipping busy time inside the day\'s usable span; what would end after the day\'s last usable minute is dropped, lowest priority first. Done, skipped and hand-placed blocks stay. Example: {} -> { moved, shortened, dropped, summary: "Shifted 4 blocks to start now; dropped Reading (no room before 21:00)." }',
    schema: z.object({}),
    run: (store, _input, ctx) => {
      const v = instanceView(store, shiftDay(store, ctx.now()));
      // Name what now runs when (the first three, the rest counted), so a reply that quotes the summary names the change.
      const changed = [...v.shortened, ...v.moved].sort((a, b) => a.start.localeCompare(b.start));
      if (!changed.length || !v.summary.includes('to start now')) return v;
      const named = `${describeBlocks(changed.slice(0, 3), false)}${changed.length > 3 ? `, and ${changed.length - 3} more` : ''}`;
      return { ...v, summary: v.summary.replace('to start now', `to start now: ${named}`) };
    },
  }),
  def({
    name: 'carve_out',
    description: 'Something came up: add a busy stretch and push the blocks under it, and the pending blocks after them, later in order, skipping busy time; a block only partly under it is split around it when both parts are at least the minimum block; what no longer fits that day is dropped, lowest priority first. Example: { "from": "14:00", "to": "15:00", "title": "Dentist" } -> { moved, shortened, dropped, created, summary }',
    schema: z.object({ from: whenField('Start of the busy time'), to: whenField('End of the busy time'), title: titleField('Title').optional().describe('What it is (default "Busy")') }),
    run: (store, input, ctx) => {
      const now = ctx.now();
      return instanceView(store, carveOut(store, parseWhen(input.from, now), parseWhen(input.to, now), input.title));
    },
  }),
  def({
    name: 'carry_over',
    description: 'Carry a task\'s minutes still owed today (its blocks over by now, minus what was done or tracked) to the first blank gap today that holds them whole, else extend its next baseline slot this week earlier or later within blank time; else it says there is no room. Example: { "task": "Leetcode" } -> { created, moved, summary: "Leetcode: 40 min carried to 16:00-16:40." }',
    schema: z.object({ task: taskRef }),
    run: (store, input, ctx) => instanceView(store, carryOver(store, resolveTask(store, input.task).id, ctx.now())),
  }),
  def({
    name: 'get_summary',
    description: 'Per-task completion statistics for the current day or week: scheduled vs done minutes, counts by status, completion rate. Example: { "window": "week" }',
    schema: z.object({ window: z.enum(['day', 'week']).optional().describe('"day" or "week" (default: the configured review window)') }),
    run: (store, input, ctx) => {
      materializeMissed(store, ctx.now());
      const settings = store.getSettings();
      const window = input.window ?? settings.reviewWindow;
      const w = periodRange(window, ctx.now(), settings);
      const tasks = summarize(store.listTasks(true), store.listBlocks({ from: w.start, to: w.end }), w);
      const label = window === 'day' ? 'Today' : 'This week';
      const busy = tasks.filter((t) => t.scheduledMinutes > 0);
      const sum = (k: 'doneMinutes' | 'scheduledMinutes') => busy.reduce((n, t) => n + t[k], 0);
      const summary = busy.length
        ? `${label}: ${sum('doneMinutes')} of ${sum('scheduledMinutes')} min done. ${busy.map((t) => `${t.name} ${t.doneMinutes}/${t.scheduledMinutes} min`).join(', ')}.`
        : `${label}: nothing scheduled yet.`;
      return { window: { start: w.start.toISOString(), end: w.end.toISOString() }, tasks, summary };
    },
  }),
];

export function getTool(name: string): ToolDef {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Unknown tool: ${name}`);
  return t;
}

/** Validate input and run the tool. Most tools are synchronous; `import_calendar` returns a Promise. */
export function runTool(store: Store, name: string, input: unknown, ctx: ToolContext): unknown | Promise<unknown> {
  const t = getTool(name);
  const parsed = t.schema.parse(input ?? {});
  return t.run(store, parsed, ctx);
}
