import type { Block, BlockStatus } from './types.js';
import type { Store } from './store.js';
import { randomUUID } from 'node:crypto';
import { applyTrack, trackBlock } from './track.js';
import { addDays, ceilToSlot, floorToSlot, startOfDay } from './time.js';

export function markBlock(store: Store, id: string, status: BlockStatus, at: Date): Block {
  const b = store.getBlock(id);
  if (!b) throw new Error(`Block not found: ${id}`);
  // Marking a block stops its clock and keeps the minutes; the block keeps its planned end (only Finish shortens it).
  if (b.runningSince) trackBlock(store, id, 'pause', at);
  const patch: Parameters<Store['updateBlock']>[1] = { status, statusChangedAt: at.toISOString() };
  // Reset (pending) undoes the clock: the planned length comes back and the actual start, finish and minutes are cleared.
  if (status === 'pending') {
    if (b.plannedMinutes) { patch.end = new Date(new Date(b.start).getTime() + b.plannedMinutes * 60_000).toISOString(); patch.plannedMinutes = undefined; }
    Object.assign(patch, { trackedMinutes: undefined, runningSince: null, startedAt: null, finishedAt: null });
  }
  return store.updateBlock(id, patch);
}

export function moveBlock(store: Store, id: string, start: Date, end: Date): Block {
  if (!store.getBlock(id)) throw new Error(`Block not found: ${id}`);
  if (end <= start) throw new Error('end must be after start');
  // A block the user moved is theirs now: the planner will plan around it instead of replacing it.
  return store.updateBlock(id, { start: start.toISOString(), end: end.toISOString(), source: 'manual' });
}

/**
 * The block the user most likely means by "task X" right now:
 * the one containing now, else the latest one that started earlier today, else the next one today.
 */
export function findTaskBlock(store: Store, taskId: string, now: Date): Block | undefined {
  const day = startOfDay(now);
  const today = store.listBlocks({ from: day, to: addDays(day, 1) }).filter((b) => b.taskId === taskId);
  const t = now.getTime();
  const containing = today.find((b) => new Date(b.start).getTime() <= t && t < new Date(b.end).getTime());
  if (containing) return containing;
  const earlier = today.filter((b) => new Date(b.start).getTime() <= t);
  if (earlier.length) return earlier[earlier.length - 1];
  return today[0];
}

/** Pending blocks whose slot has already ended were never marked: they become `missed` (a negative signal); one that was worked on is finished at its end (a running clock only once its day is over). */
export function materializeMissed(store: Store, now: Date): Block[] {
  const out: Block[] = [];
  for (const b of store.listBlocks({ to: now })) {
    if (b.status === 'pending' && new Date(b.end) <= now) {
      // A running clock is left alone while the block's calendar day is still today (the overrun is the interesting number);
      // once that day is over it is stopped at the block's end, but only when it started before that end (it ran into the
      // day's end): a clock started after the end (a past block the user started today) is left running. A block with
      // recorded minutes was worked on: finish it, not missed.
      if (b.runningSince && (startOfDay(now).getTime() <= startOfDay(new Date(b.end)).getTime() || new Date(b.runningSince) >= new Date(b.end))) continue;
      if (b.runningSince || (b.trackedMinutes ?? 0) > 0) { out.push(applyTrack(store, b.id, 'finish', new Date(b.end)).block); continue; }
      out.push(store.updateBlock(b.id, { status: 'missed', statusChangedAt: now.toISOString() }));
    }
  }
  return out;
}

/** A block placed by hand (drag on the calendar). Snapped to the slot grid; the task must exist. */
export function createBlock(store: Store, taskId: string, start: Date, end: Date, now: Date): Block {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const slot = store.getSettings().slotMinutes;
  const s = floorToSlot(start, slot);
  const e = ceilToSlot(end, slot);
  if (e <= s) throw new Error('end must be after start');
  const block: Block = { id: randomUUID(), taskId, start: s.toISOString(), end: e.toISOString(), status: 'pending', source: 'manual', createdAt: now.toISOString(), statusChangedAt: null };
  store.insertBlocks([block]);
  return block;
}
