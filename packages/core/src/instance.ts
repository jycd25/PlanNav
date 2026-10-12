import { randomUUID } from 'node:crypto';
import type { Block, Interval } from './types.js';
import type { Store } from './store.js';
import { usableSpans } from './baseline.js';
import { expandRecurring, workingIntervals } from './free.js';
import { materializeMissed } from './mark.js';
import { applyTrack } from './track.js';
import { periodRange } from './budget.js';
import { addDays, atTime, ceilToSlot, minutesBetween, overlaps, startOfDay } from './time.js';

/**
 * What an instance operation did to the week: blocks moved (new times), shortened (same end, later start, or an earlier
 * end), dropped (no room for them: kept at their time as missed, so carry_over owes them), created (new blocks), and a
 * one-sentence summary for the assistant to quote. A block an operation moves, shortens, splits or creates gets source 'adjusted': kept by the planner and by a
 * re-apply of the baseline (as a manual block is), and movable by a later operation.
 */
export interface InstanceResult { moved: Block[]; shortened: Block[]; dropped: Block[]; created: Block[]; summary: string }

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmt = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const span = (x: { start: Date; end: Date }) => `${fmt(x.start)}-${fmt(x.end)}`;
const iv = (b: { start: string; end: string }): Interval => ({ start: new Date(b.start), end: new Date(b.end) });
const isLive = (b: Block) => b.status === 'pending' || b.status === 'done';
/** A pending block the operations may move: the planner's, a baseline copy, or one an operation adjusted (never a hand-placed one). */
const isMovable = (b: Block) => b.status === 'pending' && (b.source ?? 'planner') !== 'manual';
const atMinute = (day: Date, minutes: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
const toMinute = (d: Date) => new Date(Math.floor(d.getTime() / 60_000) * 60_000);
const inside = (x: Interval, spans: Interval[]) => spans.some((s) => s.start <= x.start && x.end <= s.end);
const clear = (x: Interval, busy: Interval[]) => !busy.some((o) => overlaps(o, x));

/** The day's usable time: the baseline's spans when a baseline with a task slot exists, else the settings' windows. */
function usable(store: Store, day: Date): Interval[] {
  const baseline = store.getBaseline();
  if (baseline?.slots.some((s) => s.kind === 'task')) return usableSpans(baseline, day.getDay()).map((s) => ({ start: atMinute(day, s.start), end: atMinute(day, s.end) }));
  return workingIntervals({ start: day, end: addDays(day, 1) }, store.getSettings());
}

/** Busy time on `day`: commitments, recurring occurrences, and live blocks other than `except`. */
function busyOn(store: Store, day: Date, except: Set<string>): Interval[] {
  const range = { start: day, end: addDays(day, 1) };
  return [
    ...store.listCommitments({ from: range.start, to: range.end }).map(iv),
    ...expandRecurring(store.listRecurring(), range).map((o) => ({ start: o.start, end: o.end })),
    ...store.listBlocks({ from: range.start, to: range.end }).filter((b) => isLive(b) && !except.has(b.id)).map(iv),
  ];
}

/** The first start at or after `from` where `minutes` fit inside one usable span and clear of busy time. */
function firstFit(minutes: number, from: Date, spans: Interval[], busy: Interval[]): Date | undefined {
  const candidates = [from, ...spans.map((s) => s.start), ...busy.map((b) => b.end)].filter((p) => p >= from).sort((a, b) => a.getTime() - b.getTime());
  for (const p of candidates) {
    const x = { start: p, end: new Date(p.getTime() + minutes * 60_000) };
    if (inside(x, spans) && clear(x, busy)) return p;
  }
  return undefined;
}

const priorityOf = (store: Store, b: Block) => store.getTask(b.taskId)?.priority ?? 99;
const nameOf = (store: Store, b: Block) => store.getTask(b.taskId)?.name ?? 'Unknown task';
/** The block to drop when not everything fits: the lowest priority, then the latest start. */
const victimOf = (store: Store, set: Block[]) => [...set].sort((a, b) => priorityOf(store, b) - priorityOf(store, a) || b.start.localeCompare(a.start))[0];
const noRoom = (spans: Interval[]) => (spans.length ? `no room before ${fmt(spans[spans.length - 1].end)}` : 'no usable time today');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

interface Placement<T> { item: T; start: Date; end: Date }

/**
 * Lays `items` on `day` in order from `cursor`, each where `placeOne` says (given the cursor and the busy time so far);
 * when one cannot be placed, the lowest-priority item not under `protect` is dropped and the day packed again.
 */
function packWithDrops<T extends { block: Block }>(store: Store, day: Date, items: T[], cursor: Date, placeOne: (item: T, cursor: Date, taken: Interval[]) => Interval | undefined, protect: (item: T) => boolean = () => false): { placed: Placement<T>[]; dropped: Block[] } {
  const dropped: Block[] = [];
  let set = items;
  for (;;) {
    const taken = busyOn(store, day, new Set([...set.map((q) => q.block.id), ...dropped.map((b) => b.id)]));
    const placed: Placement<T>[] = [];
    let at = cursor;
    let failed: T | undefined;
    for (const item of set) {
      const x = placeOne(item, at, taken);
      if (!x) { failed = item; break; }
      placed.push({ item, start: x.start, end: x.end }); taken.push(x); at = x.end;
    }
    if (!failed) return { placed, dropped };
    const victim = victimOf(store, set.filter((q) => !protect(q)).map((q) => q.block)) ?? failed.block;
    dropped.push(victim);
    set = set.filter((q) => q.block.id !== victim.id);
  }
}

/** Blank minutes inside `x`: its length minus the busy time it contains (overlapping busy intervals counted once). */
function blankMinutes(x: Interval, busy: Interval[]): number {
  const covered = busy.map((b) => ({ start: Math.max(b.start.getTime(), x.start.getTime()), end: Math.min(b.end.getTime(), x.end.getTime()) })).filter((b) => b.start < b.end).sort((a, b) => a.start - b.start);
  let total = 0; let cursor = -Infinity;
  for (const c of covered) { const s = Math.max(c.start, cursor); if (c.end > s) total += c.end - s; cursor = Math.max(cursor, c.end); }
  return minutesBetween(x.start, x.end) - total / 60_000;
}

/** What to do with the breaks when the shifted day runs past its last usable minute: keep them (the day ends later) or waive them (they shrink to absorb the delay). */
export type Breaks = 'keep' | 'waive';
/** A shift that needs the user's answer first (`needsConfirmation`) changed nothing; its summary is the question to ask. */
export interface ShiftResult extends InstanceResult { needsConfirmation?: true }

/**
 * Today's pending planner and baseline blocks from the first one that ends after `now`, in start order, moved later by
 * the delay (now minus that first block's start; nothing is shifted when now is before it, and nothing ever moves
 * earlier). The breaks (blank time between consecutive blocks; busy time is not a break) keep their length: each block
 * lands at the later of its own time plus the delay and the previous block's end plus their break, pushed past busy
 * time, so the block in progress starts now with its whole length (it keeps its old end instead when the whole no longer
 * fits before busy time: the minutes before now are forfeited). When that ends every block by the day's last usable
 * minute, it is done. Otherwise nothing changes and the result asks (`needsConfirmation`) whether to waive the breaks:
 * `breaks: 'waive'` lets each break shrink to absorb the delay (no block earlier than its own slot) with the day's end
 * as the wall; `breaks: 'keep'` keeps them and lets the day run past the baseline, up to midnight. What would end after
 * the wall is dropped, lowest priority first (never the block in progress), and kept at its time as missed. Done,
 * skipped and manual blocks are not moved, nor a block whose clock is running; a block over at `now` becomes missed.
 * Moved and shortened blocks become 'adjusted'.
 */
export function shiftDay(store: Store, at: Date, opts: { breaks?: Breaks } = {}): ShiftResult {
  const now = toMinute(at);
  materializeMissed(store, now);
  const day = startOfDay(now);
  const midnight = addDays(day, 1);
  const none = { moved: [], shortened: [], dropped: [], created: [] };
  const candidates = store.listBlocks({ from: day, to: midnight }).filter((b) => isMovable(b) && !b.runningSince && new Date(b.end) > now).sort((a, b) => a.start.localeCompare(b.start));
  if (!candidates.length) return { ...none, summary: 'Nothing to shift today.' };
  const delay = minutesBetween(iv(candidates[0]).start, now);
  if (delay <= 0) return { ...none, summary: `Nothing to shift: ${nameOf(store, candidates[0])} starts at ${fmt(iv(candidates[0]).start)}.` };

  const usableToday = usable(store, day);
  const spans = usableToday.length ? usableToday : [{ start: day, end: midnight }];
  const wall = spans[spans.length - 1].end;
  const openEnded = [...spans.slice(0, -1), { start: spans[spans.length - 1].start, end: midnight }];
  const busy = busyOn(store, day, new Set(candidates.map((b) => b.id)));
  const breakBefore = candidates.map((b, i) => (i === 0 ? 0 : Math.max(0, blankMinutes({ start: iv(candidates[i - 1]).end, end: iv(b).start }, busy))));
  const breakSpans = candidates.flatMap((b, i) => (breakBefore[i] > 0 ? [{ start: iv(candidates[i - 1]).end, end: iv(b).start }] : []));
  type Item = { block: Block; minutes: number; gap: number };
  const items: Item[] = candidates.map((block, i) => ({ block, minutes: minutesBetween(iv(block).start, iv(block).end), gap: breakBefore[i] }));
  const inProgress = (b: Block) => new Date(b.start) < now && now < new Date(b.end);
  const plan = (mode: Breaks) => packWithDrops(store, day, items, now, (q, cursor, taken) => {
    const own = iv(q.block);
    const within = mode === 'keep' ? openEnded : spans;
    if (inProgress(q.block)) {
      const whole = { start: cursor, end: new Date(cursor.getTime() + q.minutes * 60_000) };
      if (inside(whole, within) && clear(whole, taken)) return whole;
      const rest = { start: cursor, end: own.end };
      if (rest.start < rest.end && inside(rest, within) && clear(rest, taken)) return rest;
    }
    const target = new Date(mode === 'keep' ? Math.max(own.start.getTime() + delay * 60_000, cursor.getTime() + q.gap * 60_000) : Math.max(own.start.getTime(), cursor.getTime()));
    const fit = firstFit(q.minutes, target, within, taken);
    return fit ? { start: fit, end: new Date(fit.getTime() + q.minutes * 60_000) } : undefined;
  }, (q) => inProgress(q.block));
  const endOf = (p: { placed: Placement<Item>[] }) => (p.placed.length ? new Date(Math.max(...p.placed.map((x) => x.end.getTime()))) : now);
  const fmtEnd = (d: Date) => (d.getTime() >= midnight.getTime() ? 'midnight' : fmt(d));
  const names = (bs: Block[]) => bs.map((b) => nameOf(store, b)).join(', ');

  const keep = plan('keep');
  const overflow = endOf(keep) > wall;
  const mode: Breaks | undefined = opts.breaks ?? (!overflow && !keep.dropped.length ? 'keep' : undefined);
  if (!mode) {
    const waive = plan('waive');
    const issues = [overflow ? `ends the day at ${fmtEnd(endOf(keep))}, past ${fmtEnd(wall)}` : '', keep.dropped.length ? `drops ${names(keep.dropped)} (no room before midnight)` : ''].filter(Boolean).join(' and ');
    const keepThem = overflow && !keep.dropped.length ? 'keep them and end later' : 'keep them';
    const lead = `Shifting ${plural(candidates.length, 'block')} by ${delay} min`;
    const summary = breakSpans.length
      ? `${lead} keeps your breaks (${breakSpans.map(span).join(', ')}) but ${issues}. ${waive.dropped.length ? `Waiving the breaks would still drop ${names(waive.dropped)}; waive them, or ${keepThem}?` : `Waive the breaks to end at ${fmtEnd(endOf(waive))}, or ${keepThem}?`}`
      : `${lead} ${issues}, and there is no break to waive. ${waive.dropped.length ? `Drop ${names(waive.dropped)} to end by ${fmtEnd(wall)}, or shift everything?` : `End at ${fmtEnd(endOf(waive))} instead (nothing moves earlier than its slot), or shift everything?`}`;
    return { ...none, needsConfirmation: true, summary };
  }

  const { placed, dropped } = mode === 'keep' ? keep : plan('waive');
  const moved: Block[] = []; const shortened: Block[] = [];
  for (const p of placed) {
    const x = iv(p.item.block);
    if (x.start.getTime() === p.start.getTime() && x.end.getTime() === p.end.getTime()) continue;
    const updated = store.updateBlock(p.item.block.id, { start: p.start.toISOString(), end: p.end.toISOString(), source: 'adjusted' });
    (x.end.getTime() === p.end.getTime() && p.start > x.start ? shortened : moved).push(updated);
  }
  for (const b of dropped) store.updateBlock(b.id, { status: 'missed', statusChangedAt: now.toISOString() });
  const n = moved.length + shortened.length;
  const droppedNote = dropped.length ? `; dropped ${names(dropped)} (no room before ${mode === 'keep' ? 'midnight' : fmtEnd(wall)})` : '';
  const breaksNote = breakSpans.length ? `, breaks ${mode === 'keep' ? 'kept' : 'waived'}` : '';
  const summary = n ? `Shifted ${plural(n, 'block')} by ${delay} min${breaksNote}; the day ends at ${fmtEnd(endOf({ placed }))}${droppedNote}.` : `Nothing to shift${droppedNote}.`;
  return { moved, shortened, dropped, created: [], summary };
}

/**
 * Adds a commitment `title` (default "Busy") from `from` to `to`, then pushes the pending planner and baseline blocks it
 * overlaps, and every such block after them that day, later in order: each lands at the first fit at or after the
 * previous one's end (a blank stretch absorbs the push), skipping busy time and staying inside the day's usable spans.
 * A block only partly overlapped is split around the carve when both parts are at least the minimum block (the part
 * before it stays, the rest moves as a new block), else it moves whole. What no longer fits is dropped from the lowest
 * priority and kept as missed (carry_over owes it). Done, skipped and manual blocks stay; a carve that overlaps none of the movable blocks moves nothing.
 * Moved, shortened and split blocks become 'adjusted'.
 */
export function carveOut(store: Store, from: Date, to: Date, title?: string): InstanceResult {
  if (to <= from) throw new Error('end must be after start');
  const label = title?.trim() || 'Busy';
  store.addCommitment({ id: randomUUID(), title: label, start: from.toISOString(), end: to.toISOString() });
  const settings = store.getSettings();
  const day = startOfDay(from);
  const carve = { start: from, end: to };
  const todays = store.listBlocks({ from: day, to: addDays(day, 1) }).filter(isMovable).sort((a, b) => a.start.localeCompare(b.start));
  const overlapped = todays.filter((b) => overlaps(iv(b), carve));
  const head = `Carved out ${label} ${span(carve)}`;
  if (!overlapped.length) return { moved: [], shortened: [], dropped: [], created: [], summary: `${head}; nothing to move.` };

  // The queue: overlapped blocks (whole, or the part after the carve as a new block), then every movable block after them.
  const shortened: Block[] = [];
  const splits: Array<{ kept: Block; part: Block }> = [];
  const stamp = new Date().toISOString();
  type Item = { block: Block; minutes: number; target: Date };
  const queue: Item[] = [];
  for (const b of overlapped) {
    const x = iv(b);
    const left = x.start < from ? minutesBetween(x.start, from) : 0;
    const right = minutesBetween(x.start < from ? from : x.start, x.end);
    if (left >= settings.minBlockMinutes && right >= settings.minBlockMinutes) {
      const kept = store.updateBlock(b.id, { end: from.toISOString(), source: 'adjusted' });
      shortened.push(kept);
      const part: Block = { id: randomUUID(), taskId: b.taskId, start: to.toISOString(), end: new Date(to.getTime() + right * 60_000).toISOString(), status: 'pending', source: 'adjusted', createdAt: stamp, statusChangedAt: null };
      splits.push({ kept, part });
      queue.push({ block: part, minutes: right, target: to });
    } else {
      queue.push({ block: b, minutes: minutesBetween(x.start, x.end), target: to });
    }
  }
  for (const b of todays) if (!overlapped.includes(b) && new Date(b.start) >= to) queue.push({ block: b, minutes: minutesBetween(iv(b).start, iv(b).end), target: new Date(b.start) });

  const spans = usable(store, day);
  const partIds = new Set(splits.map((s) => s.part.id));
  const { placed, dropped } = packWithDrops(store, day, queue, to, (q, cursor, taken) => {
    const fit = firstFit(q.minutes, q.target > cursor ? q.target : cursor, spans, taken);
    return fit ? { start: fit, end: new Date(fit.getTime() + q.minutes * 60_000) } : undefined;
  });
  const moved: Block[] = []; const created: Block[] = [];
  for (const p of placed) {
    const x = iv(p.item.block);
    if (partIds.has(p.item.block.id)) {
      const block = { ...p.item.block, start: p.start.toISOString(), end: p.end.toISOString() };
      store.insertBlocks([block]); created.push(block);
    } else if (x.start.getTime() !== p.start.getTime() || x.end.getTime() !== p.end.getTime()) {
      moved.push(store.updateBlock(p.item.block.id, { start: p.start.toISOString(), end: p.end.toISOString(), source: 'adjusted' }));
    }
  }
  // Dropped blocks are kept as missed (a dropped split part too, at the time it would have had), so carry_over owes them.
  for (const b of dropped) {
    if (partIds.has(b.id)) store.insertBlocks([{ ...b, status: 'missed', statusChangedAt: stamp }]);
    else store.updateBlock(b.id, { status: 'missed', statusChangedAt: stamp });
  }

  const parts = [head];
  for (const s of splits) {
    const landed = created.find((c) => c.id === s.part.id);
    parts.push(`split ${nameOf(store, s.kept)}: ${span(iv(s.kept))} kept, ${minutesBetween(iv(s.part).start, iv(s.part).end)} min ${landed ? `to ${span(iv(landed))}` : 'dropped'}`);
  }
  if (moved.length) parts.push(`moved ${moved.map((b) => `${nameOf(store, b)} to ${span(iv(b))}`).join(', ')}`);
  const droppedWhole = dropped.filter((b) => !partIds.has(b.id));
  if (droppedWhole.length) parts.push(`dropped ${droppedWhole.map((b) => nameOf(store, b)).join(', ')} (${noRoom(spans)})`);
  if (parts.length === 1) parts.push('nothing to move');
  return { moved, shortened, dropped, created, summary: `${parts.join('; ')}.` };
}

/**
 * The task's minutes still owed today: its blocks over by `now`, and its missed blocks whatever their time (a block a
 * shift or a carve dropped is missed), owe their planned minutes minus what was done or tracked (a done block with no
 * clock, or a skipped block, owes nothing); said mid-block, the block in progress is shortened to `now` (its clock
 * paused there; the block becomes 'adjusted') and its rest is owed too. A block whose minutes an earlier carry moved
 * (`carriedTo` names a block that still exists) owes nothing again, and a block a carry made that started less than a
 * slot ago is not "said mid-block", so a repeat answers `<task>: already carried to HH:MM-HH:MM.` and changes nothing.
 * The minutes go, exactly, to the first blank gap today after `now` (and after the shortened block's old end) inside
 * the usable span that holds them whole, on the slot grid; else the task's next baseline slot this week is extended
 * earlier or later within blank time (earlier first; the copy becomes 'adjusted'; with the week not applied yet, the
 * minutes sit beside the slot's time); else the week has no room. The blocks that owed are marked with `carriedTo`.
 */
export function carryOver(store: Store, taskId: string, at: Date): InstanceResult {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const now = toMinute(at);
  materializeMissed(store, now);
  const settings = store.getSettings();
  const day = startOfDay(now);
  const none = (summary: string): InstanceResult => ({ moved: [], shortened: [], dropped: [], created: [], summary });
  const mine = store.listBlocks({ from: day, to: addDays(day, 1) }).filter((b) => b.taskId === taskId);
  const carried = (b: Block) => !!b.carriedTo && !!store.getBlock(b.carriedTo);
  const madeByCarry = new Set(mine.filter(carried).map((b) => b.carriedTo!));
  let owed = 0;
  const owing: Block[] = [];
  const shortened: Block[] = [];
  let searchFrom = ceilToSlot(now, settings.slotMinutes);
  for (const b of mine) {
    if (b.status === 'skipped' || carried(b)) continue;
    const x = iv(b);
    if (b.status === 'pending' && x.start < now && now < x.end) {
      if (madeByCarry.has(b.id) && minutesBetween(x.start, now) < settings.slotMinutes) continue; // a carry just made it: not "said mid-block"
      // Said mid-block: stop here and carry the rest.
      if (b.runningSince) applyTrack(store, b.id, 'pause', now);
      shortened.push(store.updateBlock(b.id, { end: now.toISOString(), source: 'adjusted' }));
      owing.push(b);
      owed += minutesBetween(now, x.end);
      if (x.end > searchFrom) searchFrom = ceilToSlot(x.end, settings.slotMinutes);
      continue;
    }
    if (b.status !== 'missed' && (x.end > now || b.runningSince)) continue;
    const planned = b.plannedMinutes ?? minutesBetween(x.start, x.end);
    const credit = b.status === 'done' ? (b.trackedMinutes ?? planned) : (b.trackedMinutes ?? 0);
    if (planned > credit) { owed += planned - credit; owing.push(b); }
  }
  if (owed <= 0) {
    const where = (t: Block) => `${startOfDay(new Date(t.start)).getTime() === day.getTime() ? '' : `${DAY_NAMES[new Date(t.start).getDay()]} `}${span(iv(t))}`;
    const pendingTargets = [...madeByCarry].map((id) => store.getBlock(id)!).filter((t) => t.status === 'pending').sort((a, b) => a.start.localeCompare(b.start));
    return none(pendingTargets.length ? `${task.name}: already carried to ${pendingTargets.map(where).join(', ')}.` : `${task.name}: nothing to carry over today.`);
  }
  const stamp = now.toISOString();
  const make = (start: Date, end: Date): Block => ({ id: randomUUID(), taskId, start: start.toISOString(), end: end.toISOString(), status: 'pending', source: 'adjusted', createdAt: stamp, statusChangedAt: null });
  /** The owing blocks now point at `target`, so their minutes are not owed again while it exists. */
  const result = (target: Block, r: Partial<InstanceResult> & { summary: string }): InstanceResult => {
    for (const b of owing) store.updateBlock(b.id, { carriedTo: target.id });
    return { moved: [], dropped: [], created: [], ...r, shortened: shortened.map((b) => store.getBlock(b.id)!) };
  };

  // 1. A blank gap today.
  const fit = firstFit(owed, searchFrom, usable(store, day), busyOn(store, day, new Set()));
  if (fit) {
    const block = make(fit, new Date(fit.getTime() + owed * 60_000));
    store.insertBlocks([block]);
    return result(block, { created: [block], summary: `${task.name}: ${owed} min carried to ${span(iv(block))}.` });
  }

  // 2. The next baseline slot of the task this week, extended earlier or later within blank time.
  const week = periodRange('week', now, settings);
  const slots = (store.getBaseline()?.slots ?? []).filter((s) => s.kind === 'task' && s.taskId === taskId);
  for (let d = addDays(day, 1); d < week.end; d = addDays(d, 1)) {
    const spans = usable(store, d);
    for (const s of slots.filter((x) => x.day === d.getDay()).sort((a, b) => a.start.localeCompare(b.start))) {
      const slot = { start: atTime(d, s.start), end: atTime(d, s.end) };
      const existing = store.listBlocks({ from: d, to: addDays(d, 1) }).find((b) => b.taskId === taskId && b.status === 'pending' && b.source !== 'manual' && overlaps(iv(b), slot)); // a baseline copy, or one an operation adjusted: extended, not doubled
      const anchor = existing ? iv(existing) : slot;
      const taken = busyOn(store, d, new Set(existing ? [existing.id] : []));
      const earlier = { start: new Date(anchor.start.getTime() - owed * 60_000), end: anchor.start };
      const later = { start: anchor.end, end: new Date(anchor.end.getTime() + owed * 60_000) };
      for (const ext of [earlier, later]) {
        if (!inside(ext, spans) || !clear(ext, taken)) continue;
        const summary = `${task.name}: ${owed} min carried to ${DAY_NAMES[d.getDay()]} ${fmt(ext.start)} (slot extended).`;
        if (existing) {
          // 'adjusted', so a re-apply of the baseline keeps the extension instead of laying the plain slot again.
          const moved = store.updateBlock(existing.id, { start: (ext === earlier ? ext.start : anchor.start).toISOString(), end: (ext === earlier ? anchor.end : ext.end).toISOString(), source: 'adjusted' });
          return result(moved, { moved: [moved], summary });
        }
        const block = make(ext.start, ext.end);
        store.insertBlocks([block]);
        return result(block, { created: [block], summary });
      }
    }
  }
  return { moved: [], shortened, dropped: [], created: [], summary: `${task.name}: ${owed} min, no room this week.` };
}
