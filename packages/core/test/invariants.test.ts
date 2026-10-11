import { describe, it, expect } from 'vitest';
import { appendFileSync } from 'node:fs';
import { MemoryStore } from '../src/store.js';
import { plan, type PlanOptions } from '../src/plan.js';
import { markBlock } from '../src/mark.js';
import { runTool } from '../src/tools.js';
import { expandRecurring, freeIntervals, workingIntervals } from '../src/free.js';
import { periodRange, usedMinutes } from '../src/budget.js';
import { addDays, addMinutes, ceilToSlot, minutesBetween, overlaps, startOfDay } from '../src/time.js';
import { DEFAULT_SETTINGS, type AvailabilityWindow, type Block, type Interval, type Settings, type Task, type TaskSegment } from '../src/types.js';

// Planner invariants over seeded pseudo-random worlds. A failure prints the seed and the case so it can be replayed:
// change SEED or CASES below, or paste the printed case index into `only`.
const SEED = 20261012;
const CASES = 200;
const only: number | null = null;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const local = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const iv = (b: { start: string; end: string }): Interval => ({ start: new Date(b.start), end: new Date(b.end) });
const isLive = (b: Block) => b.status === 'pending' || b.status === 'done';
const isPlanner = (b: Block) => (b.source ?? 'planner') === 'planner';
const show = (b: Block) => `${b.taskId} ${local(new Date(b.start))}-${local(new Date(b.end)).slice(11)} ${b.status}${b.source && b.source !== 'planner' ? ` (${b.source})` : ''}`;

interface World { store: MemoryStore; now: Date; log: string[] }

function build(rand: () => number): World {
  const int = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
  const pick = <T,>(xs: T[]): T => xs[int(0, xs.length - 1)];
  const chance = (p: number) => rand() < p;
  const log: string[] = [];

  // Settings: one to three windows a weekday, sometimes one at the weekend; segments, cap and sittings vary.
  const availability: AvailabilityWindow[] = [];
  for (let dow = 0; dow < 7; dow += 1) {
    const n = dow === 0 || dow === 6 ? int(0, 1) : int(1, 3);
    let cursor = int(6, 9) * 60;
    for (let i = 0; i < n; i += 1) {
      const start = cursor + int(0, 2) * 30;
      const end = Math.min(start + int(2, 8) * 30, 23 * 60);
      if (end - start >= 60) availability.push({ days: [dow], start: hhmm(start), end: hhmm(end) });
      cursor = end + int(1, 4) * 30;
      if (cursor >= 21 * 60) break;
    }
  }
  if (!availability.some((w) => w.days[0] >= 1 && w.days[0] <= 5)) availability.push({ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' });
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    availability,
    segments: { morningEnd: pick(['11:00', '12:00', '13:00']), afternoonEnd: pick(['16:00', '17:00', '18:00']) },
    maxTasksPerDay: int(2, 6),
    maxBlockMinutes: pick([60, 90, 120]),
    minBlockMinutes: 30,
    slotMinutes: 15,
    workStyle: pick(['deep', 'balanced', 'varied'] as const),
  };
  const store = new MemoryStore();
  store.saveSettings(settings);
  log.push(`settings cap ${settings.maxTasksPerDay} maxBlock ${settings.maxBlockMinutes} segments ${settings.segments.morningEnd}/${settings.segments.afternoonEnd} windows ${availability.map((w) => `${w.days.join('')}:${w.start}-${w.end}`).join(' ')}`);

  // Tasks: two to nine, daily or weekly, sessions 30-120, random preferences and priorities.
  const taskCount = int(2, 9);
  const tasks: Task[] = [];
  for (let i = 0; i < taskCount; i += 1) {
    const t: Task = {
      id: `t${i}`, name: `Task ${i}`, color: '#000', priority: int(1, 9), budgetMinutes: int(2, 28) * 15, budgetPeriod: chance(0.5) ? 'day' : 'week',
      preferredSegment: pick<TaskSegment>(['any', 'any', 'morning', 'afternoon', 'evening']), sessionMinutes: int(2, 8) * 15, archived: false, createdAt: '2026-10-01T00:00:00.000Z',
    };
    store.upsertTask(t);
    tasks.push(t);
  }
  log.push(`tasks ${tasks.map((t) => `${t.id}:p${t.priority} ${t.budgetMinutes}/${t.budgetPeriod} s${t.sessionMinutes} ${t.preferredSegment}`).join(', ')}`);

  // Now: a day of the week of 2026-10-12, weekend included, at a random hour.
  const now = new Date(2026, 9, 12 + int(0, 6), int(6, 21), pick([0, 15, 30, 45]));
  log.push(`now ${local(now)}`);

  // Recurring and one-off commitments, then a few hand-placed, baseline or adjusted blocks in free time.
  for (let i = 0, n = int(0, 4); i < n; i += 1) {
    const days = [...new Set([int(1, 5), int(1, 5), int(1, 5)].slice(0, int(1, 3)))].sort();
    const start = int(7, 20) * 60 + pick([0, 30]);
    const r = { id: `r${i}`, title: `Recurring ${i}`, days, start: hhmm(start), end: hhmm(Math.min(start + pick([15, 30, 45, 60]), 23 * 60)) };
    store.addRecurring(r);
    log.push(`recurring ${r.days.join('')} ${r.start}-${r.end}`);
  }
  for (let i = 0, n = int(0, 3); i < n; i += 1) {
    const start = new Date(startOfDay(addDays(now, int(0, 6))).getTime() + (int(7, 20) * 60 + pick([0, 30])) * 60_000);
    const end = addMinutes(start, int(1, 4) * 30);
    store.addCommitment({ id: `c${i}`, title: `Commitment ${i}`, start: start.toISOString(), end: end.toISOString() });
    log.push(`commitment ${local(start)}-${local(end).slice(11)}`);
  }
  const busyOn = (day: Date): Interval[] => [
    ...store.listCommitments({ from: day, to: addDays(day, 1) }).map(iv),
    ...expandRecurring(store.listRecurring(), { start: day, end: addDays(day, 1) }).map((o) => ({ start: o.start, end: o.end })),
    ...store.listBlocks({ from: day, to: addDays(day, 1) }).filter(isLive).map(iv),
  ];
  for (let i = 0, n = int(0, 3); i < n; i += 1) {
    const day = startOfDay(addDays(now, int(0, 6)));
    const free = freeIntervals({ start: day < now ? ceilToSlot(now, 15) : day, end: addDays(day, 1) }, busyOn(day), settings).filter((f) => minutesBetween(f.start, f.end) >= 30);
    if (!free.length) continue;
    const slot = pick(free);
    const minutes = Math.min(minutesBetween(slot.start, slot.end), pick([30, 60, 90]));
    const b: Block = { id: `h${i}`, taskId: pick(tasks).id, start: slot.start.toISOString(), end: addMinutes(slot.start, minutes).toISOString(), status: 'pending', source: pick(['manual', 'baseline', 'adjusted'] as const), createdAt: now.toISOString(), statusChangedAt: null };
    store.insertBlocks([b]);
    log.push(`${b.source} block ${show(b)}`);
  }
  return { store, now, log };
}

/** Manual and baseline blocks keep their id, times and source through every step (a mark may change their status). */
function checkProtected(w: World, before: Block[], label: string) {
  for (const b of before.filter((o) => !isPlanner(o) && isLive(o))) {
    const after = w.store.getBlock(b.id);
    expect(after && after.start === b.start && after.end === b.end && after.source === b.source, `${label}: ${b.source} block changed or removed: ${show(b)}\n  ${w.log.join('\n  ')}\n  blocks now:\n    ${w.store.listBlocks().map(show).join('\n    ')}`).toBe(true);
  }
}

/**
 * The structural invariants after a plan: every pending planner block anywhere well placed (a block on a later planned
 * day that a commitment has since covered is removed by any re-plan), hand-placed blocks untouched, budgets kept. Done
 * blocks are history (a commitment added over one is the user's record, not a placement), so pending ones are judged.
 */
function checkInvariants(w: World, before: Block[], created: Block[], label: string) {
  const { store, now } = w;
  const settings = store.getSettings();
  const fail = (what: string) => `${label}: ${what}\n  ${w.log.join('\n  ')}\n  blocks now:\n    ${store.listBlocks().map(show).join('\n    ')}`;
  const live = store.listBlocks().filter(isLive);
  const planner = live.filter((b) => isPlanner(b) && b.status === 'pending');
  for (const b of planner) {
    const x = iv(b);
    const day = startOfDay(x.start);
    expect(minutesBetween(x.start, x.end) >= settings.minBlockMinutes, fail(`block shorter than minBlockMinutes: ${show(b)}`)).toBe(true);
    expect(workingIntervals({ start: day, end: addDays(day, 1) }, settings).some((win) => win.start <= x.start && x.end <= win.end), fail(`block outside availability: ${show(b)}`)).toBe(true);
    const clashes = [
      ...store.listCommitments({ from: day, to: addDays(day, 1) }).map((c) => ({ ...iv(c), what: `commitment ${c.title}` })),
      ...expandRecurring(store.listRecurring(), { start: day, end: addDays(day, 1) }).map((o) => ({ start: o.start, end: o.end, what: `recurring ${o.title}` })),
      ...live.filter((o) => o.id !== b.id).map((o) => ({ ...iv(o), what: `block ${show(o)}` })),
    ].filter((o) => overlaps(o, x));
    expect(clashes.map((c) => c.what), fail(`block overlaps: ${show(b)}`)).toEqual([]);
  }
  for (const b of created) {
    expect(new Date(b.start) >= now, fail(`block created before now (${local(now)}): ${show(b)}`)).toBe(true);
    expect(new Date(b.end) <= addDays(now, 14), fail(`block beyond the 14-day horizon: ${show(b)}`)).toBe(true);
  }
  checkProtected(w, before, label);
  for (const t of store.listTasks()) {
    const periods = new Map<number, Interval>();
    for (const b of live.filter((o) => o.taskId === t.id)) { const p = periodRange(t.budgetPeriod, new Date(b.start), settings); periods.set(p.start.getTime(), p); }
    for (const p of periods.values()) {
      const own = usedMinutes(t, live.filter(isPlanner), p);
      const other = usedMinutes(t, live.filter((o) => !isPlanner(o)), p);
      expect(own <= Math.max(0, t.budgetMinutes - other), fail(`${t.id} over budget in planner blocks: ${own} planner + ${other} other > ${t.budgetMinutes} in the period from ${local(p.start)}`)).toBe(true);
    }
  }
}

function runPlan(w: World, opts: Omit<PlanOptions, 'now'>, label: string) {
  const before = w.store.listBlocks();
  const r = plan(w.store, { now: w.now, ...opts });
  w.log.push(`${label}: created ${r.created.length}, later ${r.later.length}, kept ${r.kept.length}, removed ${r.removed}${r.displaced.length ? `, displaced ${r.displaced.map(show).join(' | ')}` : ''}${r.created.length + r.later.length ? ` -> ${[...r.created, ...r.later].map(show).join(' | ')}` : ''}`);
  checkInvariants(w, before, [...r.created, ...r.later], label);
  // Idempotence: planning again with nothing changed creates and removes nothing and moves no block.
  const snapshot = w.store.listBlocks().map((b) => `${b.id} ${b.start} ${b.end} ${b.status} ${b.source ?? 'planner'}`).sort();
  const again = plan(w.store, { now: w.now, ...opts });
  const after = w.store.listBlocks().map((b) => `${b.id} ${b.start} ${b.end} ${b.status} ${b.source ?? 'planner'}`).sort();
  expect([again.created.length, again.later.length, again.removed], `${label} (second plan): created/later/removed should be 0, got ${again.created.length}/${again.later.length}/${again.removed}\n  ${w.log.join('\n  ')}\n  created: ${[...again.created, ...again.later].map(show).join(' | ')}\n  blocks after the first plan:\n    ${snapshot.join('\n    ')}`).toEqual([0, 0, 0]);
  expect(after, `${label} (second plan): blocks changed\n  ${w.log.join('\n  ')}`).toEqual(snapshot);
}

function runCase(seed: number, index: number) {
  const rand = mulberry32(seed * 1000 + index);
  const int = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
  const pick = <T,>(xs: T[]): T => xs[int(0, xs.length - 1)];
  const w = build(rand);
  const ctx = { now: () => w.now };
  const planOpts = (): Omit<PlanOptions, 'now'> => {
    const kind = int(0, 2);
    if (kind === 0) return { horizon: 'day' };
    if (kind === 1) return { horizon: 'week' };
    return { until: addMinutes(w.now, int(2, 10) * 60) };
  };
  try { runSteps(); } finally { if (process.env.FUZZ_LOG) appendFileSync(process.env.FUZZ_LOG, `case ${index}\n  ${w.log.join('\n  ')}\n`); } // FUZZ_LOG=<file> dumps every case, failed ones too
  function runSteps() {
  runPlan(w, planOpts(), 'plan');
  for (let step = 0, steps = int(2, 6); step < steps; step += 1) {
    const kind = pick(['advance', 'mark', 'marktask', 'commitment', 'move', 'availability', 'replan', 'mustdo'] as const);
    const before = w.store.listBlocks();
    if (kind === 'availability') {
      // The user changes the baseline week through the tool: a window added, or the whole template replaced.
      const windows = [...Array(int(1, 2)).keys()].map(() => {
        const start = int(6, 18) * 60 + pick([0, 30]);
        return { days: pick<string | number[]>(['weekdays', 'weekend', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', [int(0, 6)]]), start: hhmm(start), end: hhmm(Math.min(start + int(2, 8) * 30, 23 * 60)) };
      });
      const mode = pick(['add', 'replace'] as const);
      try {
        runTool(w.store, 'set_availability', { windows, mode }, ctx);
        w.log.push(`set_availability ${mode} ${windows.map((x) => `${JSON.stringify(x.days)} ${x.start}-${x.end}`).join(', ')}`);
      } catch (e) {
        w.log.push(`set_availability refused (${(e as Error).message.slice(0, 60)})`);
      }
    } else if (kind === 'marktask') {
      const t = pick(w.store.listTasks());
      const status = pick(['done', 'skipped'] as const);
      try {
        runTool(w.store, 'mark_task', { task: t.id, status }, ctx);
        w.log.push(`mark_task ${t.id} ${status}`);
      } catch (e) {
        w.log.push(`mark_task ${t.id} refused (${(e as Error).message.slice(0, 50)})`);
      }
    } else if (kind === 'advance') {
      w.now = addMinutes(w.now, int(1, 30) * 60);
      w.log.push(`advance -> ${local(w.now)}`);
    } else if (kind === 'mark') {
      const pending = w.store.listBlocks().filter((b) => b.status === 'pending');
      if (!pending.length) continue;
      const b = pick(pending);
      const status = pick(['done', 'skipped'] as const);
      markBlock(w.store, b.id, status, w.now);
      w.log.push(`mark ${status}: ${show(b)}`);
    } else if (kind === 'commitment') {
      const start = ceilToSlot(addMinutes(w.now, int(1, 48) * 60), 15);
      const end = addMinutes(start, int(1, 4) * 30);
      runTool(w.store, 'add_commitment', { title: `Came up ${step}`, start: local(start), end: local(end) }, ctx);
      w.log.push(`add_commitment ${local(start)}-${local(end).slice(11)}`);
    } else if (kind === 'move') {
      const own = w.store.listBlocks({ from: w.now }).filter((b) => b.status === 'pending' && isPlanner(b));
      if (!own.length) continue;
      const b = pick(own);
      const day = startOfDay(addDays(w.now, int(0, 2)));
      const start = new Date(Math.max(day.getTime(), ceilToSlot(w.now, 15).getTime()) + int(0, 12) * 60 * 60_000);
      const end = addMinutes(start, minutesBetween(new Date(b.start), new Date(b.end)));
      try {
        runTool(w.store, 'move_block', { block_id: b.id, start: local(start), end: local(end) }, ctx);
        w.log.push(`move ${show(b)} -> ${local(start)}`);
      } catch (e) {
        w.log.push(`move refused (${(e as Error).message.slice(0, 60)})`);
      }
    } else if (kind === 'replan') {
      runPlan(w, planOpts(), `replan ${step}`);
    } else {
      const t = pick(w.store.listTasks());
      runPlan(w, { ...planOpts(), mustDo: [t.id] }, `must_do ${t.id} ${step}`);
    }
    if (kind !== 'replan' && kind !== 'mustdo') checkProtected(w, before, `${kind} ${step}`);
    if (process.env.FUZZ_LOG) w.log.push(`  blocks: ${w.store.listBlocks().map(show).join(' | ')}`);
  }
  }
}

describe('planner invariants (seeded fuzz)', () => {
  const cases = only === null ? [...Array(CASES).keys()] : [only];
  for (const i of cases) {
    it(`seed ${SEED} case ${i}`, () => {
      runCase(SEED, i);
    });
  }
});
