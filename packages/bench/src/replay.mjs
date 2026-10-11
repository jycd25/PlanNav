// Tier A: replay a scenario's events through the real core tools on an in-memory store, scoring after each event.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_SETTINGS, MemoryStore, normalizeSettings, periodRange, runTool, settingsWithBaseline, startOfDay, addDays } from '@ds/core';
import { METRICS, composite, daysIn, scoreState } from './metrics.mjs';

/** "2026-10-12T07:00" (no offset) -> local Date. ISO with an offset is passed to Date as is. */
export function localDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  if (!m) return new Date(s);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}
/** Tool inputs take loose local times: "2026-10-12T07:00" -> "2026-10-12 07:00". */
const toolTime = (s) => (s ? s.replace('T', ' ') : s);
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * A copy of the store's state. MemoryStore hands out its own objects and updates them in place, so a snapshot that
 * shared them would change under a later move or mark and churn and the protected-block check would compare a state
 * with itself. The settings carry the availability that holds: the baseline's usable spans once a baseline with a task
 * slot exists (the product reads the same), else the settings' windows.
 */
export function snapshot(store) {
  const copy = (xs) => xs.map((x) => ({ ...x }));
  const baseline = store.getBaseline();
  return { settings: settingsWithBaseline(store.getSettings(), baseline), baseline, tasks: copy(store.listTasks()), commitments: copy(store.listCommitments()), recurring: store.listRecurring(), blocks: copy(store.listBlocks()) };
}

/**
 * The scenario's `baseline` as Store.setBaseline takes it: a task slot names its task (`task`, the same slug as blocks,
 * or `taskId`); a slot without one is busy (`title`); `days` lays the same slot on several weekdays.
 */
function baselineInput(raw) {
  const slots = (raw.slots ?? []).flatMap((x) => (x.days ?? [x.day]).map((day) => {
    const taskId = x.taskId ?? (x.task ? slug(x.task) : undefined);
    const kind = x.kind ?? (taskId ? 'task' : 'busy');
    return { day, start: x.start, end: x.end, kind, ...(kind === 'task' ? { taskId } : {}), ...(x.title ? { title: x.title } : {}) };
  }));
  return { slots };
}

export function seedStore(store, scenario, now) {
  store.saveSettings(normalizeSettings({ ...DEFAULT_SETTINGS, ...(scenario.settings ?? {}) }));
  const colors = ['#4f8cff', '#34c759', '#ff9f0a', '#af52de', '#ff375f', '#5ac8fa', '#ffd60a', '#ff6b35'];
  (scenario.tasks ?? []).forEach((t, i) => store.upsertTask({
    id: t.id ?? slug(t.name), name: t.name, color: colors[i % colors.length], priority: t.priority ?? i + 1,
    budgetMinutes: t.budgetMinutes, budgetPeriod: t.budgetPeriod ?? 'day', preferredSegment: t.preferredSegment ?? 'any',
    sessionMinutes: t.sessionMinutes, archived: false, createdAt: now.toISOString(),
  }));
  (scenario.commitments ?? []).forEach((c, i) => store.addCommitment({ id: c.id ?? `c${i}`, title: c.title, start: localDate(c.start).toISOString(), end: localDate(c.end).toISOString() }));
  (scenario.recurring ?? []).forEach((r, i) => store.addRecurring({ id: r.id ?? `r${i}`, title: r.title, days: r.days, start: r.start, end: r.end }));
  // Blocks take absolute local times, or `startIn`/`durationMinutes` relative to now (for dialogue seeds, which run on the wall clock).
  const blockTimes = (b) => b.startIn !== undefined
    ? { start: new Date(now.getTime() + b.startIn * 60_000), end: new Date(now.getTime() + (b.startIn + (b.durationMinutes ?? 60)) * 60_000) }
    : { start: localDate(b.start), end: localDate(b.end) };
  (scenario.blocks ?? []).forEach((b, i) => store.insertBlocks([{
    id: b.id ?? `b${i}`, taskId: b.taskId ?? slug(b.task), start: blockTimes(b).start.toISOString(), end: blockTimes(b).end.toISOString(),
    status: b.status ?? 'pending', source: b.source ?? 'manual', createdAt: now.toISOString(), statusChangedAt: null,
  }]));
  if (scenario.baseline) store.setBaseline(baselineInput(scenario.baseline));
}

const ctxAt = (now) => ({ now: () => now });

/** `opts.dir`: the scenario file's directory, which an `import_baseline` event's `ics` path is relative to. */
export async function applyEvent(store, ev, now, opts = {}) {
  const ctx = ctxAt(now);
  switch (ev.type) {
    case 'plan': return runTool(store, 'plan_schedule', { until: toolTime(ev.until), horizon: ev.horizon, must_do: ev.mustDo }, ctx);
    case 'replan_until': return runTool(store, 'plan_schedule', { until: toolTime(ev.until), must_do: ev.mustDo }, ctx);
    case 'add_commitment': return runTool(store, 'add_commitment', { title: ev.title, start: toolTime(ev.start), end: toolTime(ev.end) }, ctx);
    case 'extend_availability': return runTool(store, 'set_availability', { windows: ev.windows, mode: 'add' }, ctx);
    case 'set_availability': return runTool(store, 'set_availability', { windows: ev.windows, mode: 'replace' }, ctx);
    case 'mark_done': return runTool(store, 'mark_task', { task: ev.task, status: 'done' }, ctx);
    case 'mark_skipped': return runTool(store, 'mark_task', { task: ev.task, status: 'skipped' }, ctx);
    case 'move_block': return runTool(store, 'move_block', { task: ev.task, block_id: ev.blockId, start: toolTime(ev.start), end: toolTime(ev.end), allow_outside_availability: ev.allowOutside, allow_overlap: ev.allowOverlap }, ctx);
    case 'add_block': return runTool(store, 'add_block', { task: ev.task, start: toolTime(ev.start), end: toolTime(ev.end), allow_outside_availability: ev.allowOutside, allow_overlap: ev.allowOverlap }, ctx);
    case 'save_baseline': return runTool(store, 'save_baseline', { confirm: true, days: ev.days }, ctx);
    case 'apply_baseline': return runTool(store, 'apply_baseline', { week_of: ev.weekOf }, ctx);
    case 'clear_schedule': return runTool(store, 'clear_schedule', {}, ctx);
    case 'shift_day': return runTool(store, 'shift_day', {}, ctx);
    case 'carve_out': return runTool(store, 'carve_out', { from: toolTime(ev.from), to: toolTime(ev.to), title: ev.title }, ctx);
    case 'carry_over': return runTool(store, 'carry_over', { task: ev.task }, ctx);
    case 'import_baseline': {
      if (!opts.dir) throw new Error('import_baseline needs the scenario\'s directory to read its ics file from');
      return runTool(store, 'import_as_baseline', { ics: readFileSync(join(opts.dir, ev.ics), 'utf8') }, ctx);
    }
    case 'advance': return null;
    default: throw new Error(`Unknown event type: ${ev.type}`);
  }
}

const label = (ev) => ev.type + (ev.until ? ` until ${ev.until}` : '') + (ev.horizon ? ` ${ev.horizon}` : '') + (ev.task ? ` ${ev.task}` : '') + (ev.title ? ` ${ev.title}` : '') + (ev.from ? ` ${ev.from}` : '') + (ev.to ? ` -> ${ev.to}` : '') + (ev.ics ? ` ${ev.ics}` : '');

function timelines(state, range, now) {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const names = new Map(state.tasks.map((t) => [t.id, t.name]));
  const lines = [];
  for (const day of daysIn(range)) {
    const end = addDays(day, 1);
    const items = [
      ...state.blocks.filter((b) => (b.status === 'pending' || b.status === 'done') && new Date(b.start) >= day && new Date(b.start) < end)
        .map((b) => ({ start: new Date(b.start), end: new Date(b.end), text: `${names.get(b.taskId) ?? b.taskId}${b.source && b.source !== 'planner' ? ` (${b.source})` : ''}${b.status === 'done' ? ' ✓' : ''}` })),
      ...state.commitments.filter((c) => new Date(c.start) >= day && new Date(c.start) < end).map((c) => ({ start: new Date(c.start), end: new Date(c.end), text: `[${c.title}]` })),
    ].sort((a, b) => a.start - b.start);
    if (!items.length) continue;
    lines.push(`${DAYS[day.getDay()]} ${day.getMonth() + 1}/${day.getDate()}${startOfDay(now).getTime() === day.getTime() ? ' (today)' : ''}: ${items.map((i) => `${hm(i.start)}-${hm(i.end)} ${i.text}`).join(' | ')}`);
  }
  return lines;
}

/** Each metric averaged over the events that scored it (churn after every event, the day shape after planner events); friction is the weighted sum of those means. */
function aggregate(results, weights) {
  const mean = (k) => { const xs = results.filter((r) => r[k] !== undefined).map((r) => r[k]); return xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : 0; };
  const m = Object.fromEntries(METRICS.map((k) => [k, mean(k)]));
  const msList = results.filter((r) => r.ms !== undefined).map((r) => r.ms).sort((a, b) => a - b);
  const p95 = msList.length ? msList[Math.min(msList.length - 1, Math.floor(msList.length * 0.95))] : 0;
  return {
    ...m, friction: composite(m, weights),
    p95_ms: p95, hard: results.reduce((n, r) => n + (r.hard?.length ?? 0), 0), errors: results.filter((r) => r.error).length, slow: results.filter((r) => (r.ms ?? 0) > 200).length,
    under_commitment: results.reduce((n, r) => n + (r.under_commitment ?? 0), 0),
  };
}

/** `opts.dir`: the scenario file's directory (for `import_baseline`). Returns the final state as `state`. */
export async function runScenario(scenario, weights, opts = {}) {
  const store = new MemoryStore();
  let now = localDate(scenario.now);
  seedStore(store, scenario, now);
  const settings = store.getSettings();
  const range = scenario.range ? { start: localDate(scenario.range.from), end: localDate(scenario.range.to) } : periodRange('week', now, settings);
  const results = [];
  for (const ev of scenario.events ?? []) {
    if (ev.type === 'advance') { now = localDate(ev.to); results.push({ event: label(ev), advanced: true }); continue; }
    const before = snapshot(store);
    const t0 = performance.now();
    try { await applyEvent(store, ev, now, opts); } catch (e) { results.push({ event: label(ev), error: e instanceof Error ? e.message : String(e), ms: performance.now() - t0 }); continue; }
    const ms = performance.now() - t0;
    const after = snapshot(store);
    results.push({ event: label(ev), ms, ...scoreState(before, after, ev, range, now, weights) });
  }
  const state = snapshot(store);
  return { name: scenario.name, results, timelines: timelines(state, range, now), summary: aggregate(results, weights), state };
}
