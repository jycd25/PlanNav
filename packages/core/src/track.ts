import type { Block } from './types.js';
import type { Store } from './store.js';
import { startOfDay } from './time.js';

export type TrackAction = 'start' | 'pause' | 'finish' | 'set';
export interface TrackResult { block: Block; paused: Block[]; elapsedMinutes: number }
const MAX_MINUTES = 24 * 60;

/** Tracked minutes plus the running stretch up to `now`. */
export function elapsedMinutes(b: Pick<Block, 'trackedMinutes' | 'runningSince'>, now: Date): number {
  const running = b.runningSince ? Math.max(0, (now.getTime() - new Date(b.runningSince).getTime()) / 60_000) : 0;
  return Math.round((b.trackedMinutes ?? 0) + running);
}

function stopClock(store: Store, b: Block, now: Date): Block {
  if (!b.runningSince) return b;
  return store.updateBlock(b.id, { trackedMinutes: elapsedMinutes(b, now), runningSince: null });
}

/**
 * The timer's guard in front of every transition. Any pending block may be started, whatever day it is planned on: the
 * block stays where it is (planned time) and the clock records the actual start. Finish on a block of another day needs
 * a start first (a block never worked is marked done, not finished); pause and set are never refused.
 */
export function trackBlock(store: Store, id: string, action: TrackAction, now: Date, minutes?: number): TrackResult {
  const b = store.getBlock(id);
  if (!b) throw new Error(`Block not found: ${id}`);
  const otherDay = startOfDay(new Date(b.start)).getTime() !== startOfDay(now).getTime();
  const everStarted = !!(b.startedAt || b.runningSince || b.trackedMinutes !== undefined);
  if (action === 'finish' && otherDay && !everStarted) throw new Error('That block is not today and was never started; start it or mark it done.');
  return applyTrack(store, id, action, now, minutes);
}

/**
 * One function owns every transition of a block's clock: start (pausing any other running block), pause, finish
 * (done; an early finish shortens the block to now and keeps the planned length), set (a manual correction).
 * No day guard here: the sweep that closes a past block at its own end calls this directly.
 */
export function applyTrack(store: Store, id: string, action: TrackAction, now: Date, minutes?: number): TrackResult {
  const b = store.getBlock(id);
  if (!b) throw new Error(`Block not found: ${id}`);
  const paused: Block[] = [];
  switch (action) {
    case 'start': {
      if (b.status !== 'pending') throw new Error('Only a pending block can be started');
      for (const other of store.listBlocks()) if (other.id !== id && other.runningSince) paused.push(stopClock(store, other, now));
      const block = b.runningSince ? b : store.updateBlock(id, { runningSince: now.toISOString(), startedAt: b.startedAt ?? now.toISOString() });
      return { block, paused, elapsedMinutes: elapsedMinutes(block, now) };
    }
    case 'pause': {
      const block = stopClock(store, b, now);
      return { block, paused, elapsedMinutes: elapsedMinutes(block, now) };
    }
    case 'finish': {
      const stopped = stopClock(store, b, now);
      const start = new Date(stopped.start); const end = new Date(stopped.end);
      const slot = store.getSettings().slotMinutes;
      const patch: Parameters<Store['updateBlock']>[1] = { status: 'done', statusChangedAt: now.toISOString(), finishedAt: now.toISOString() };
      const sameDay = startOfDay(start).getTime() === startOfDay(now).getTime();
      if (sameDay && now < end) {
        // An early finish ends the block at the exact minute (the calendar shows what happened), never earlier than one
        // slot after its start, and keeps the planned length so the budget still counts it.
        const floor = new Date(start.getTime() + slot * 60_000);
        const newEnd = now > floor ? now : floor;
        patch.end = (newEnd > end ? end : newEnd).toISOString();
        patch.plannedMinutes = stopped.plannedMinutes ?? Math.round((end.getTime() - start.getTime()) / 60_000);
      }
      const block = store.updateBlock(id, patch);
      return { block, paused, elapsedMinutes: elapsedMinutes(block, now) };
    }
    case 'set': {
      if (minutes === undefined || !Number.isFinite(minutes) || minutes < 0 || minutes > MAX_MINUTES) throw new Error(`minutes must be between 0 and ${MAX_MINUTES}`);
      const block = store.updateBlock(id, { trackedMinutes: Math.round(minutes), runningSince: null });
      return { block, paused, elapsedMinutes: elapsedMinutes(block, now) };
    }
  }
}
