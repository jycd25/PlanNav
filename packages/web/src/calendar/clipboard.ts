/** Copy and paste of blocks: a copy is the task and the length; a paste lays that length at a clicked time on the slot grid. */
import { startOfDay } from '../time.js';

export interface BlockClip { taskId: string; taskName: string; minutes: number }

export function clipFromBlock(b: { taskId: string; taskName: string; start: string; end: string }): BlockClip {
  return { taskId: b.taskId, taskName: b.taskName, minutes: Math.round((new Date(b.end).getTime() - new Date(b.start).getTime()) / 60_000) };
}

/** The pasted range: start on the slot grid at `minutesOfDay` on `day`, the copied length; pulled back so it ends by midnight. */
export function pasteRange(clip: BlockClip, day: Date, minutesOfDay: number, slotMinutes: number): { start: Date; end: Date } {
  const slot = Math.max(1, slotMinutes);
  let startMin = Math.floor(Math.max(0, minutesOfDay) / slot) * slot;
  if (startMin + clip.minutes > 24 * 60) startMin = Math.max(0, Math.floor((24 * 60 - clip.minutes) / slot) * slot);
  const d0 = startOfDay(day);
  return { start: new Date(d0.getTime() + startMin * 60_000), end: new Date(d0.getTime() + (startMin + clip.minutes) * 60_000) };
}
