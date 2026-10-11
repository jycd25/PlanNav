import type { Block, BlockStatus, BudgetPeriod, Interval, Task } from './types.js';
import { clip } from './time.js';

export interface TaskSummary {
  taskId: string;
  name: string;
  budgetMinutes: number;
  budgetPeriod: BudgetPeriod;
  scheduledMinutes: number;
  doneMinutes: number;
  trackedMinutes: number;
  counts: Record<BlockStatus, number>;
  completionRate: number | null;
}

export function summarize(tasks: Task[], blocks: Block[], window: Interval): TaskSummary[] {
  return tasks.map((t) => {
    const counts: Record<BlockStatus, number> = { pending: 0, done: 0, skipped: 0, missed: 0 };
    let scheduled = 0;
    let done = 0;
    let tracked = 0;
    for (const b of blocks) {
      if (b.taskId !== t.id) continue;
      const s = new Date(b.start);
      if (s >= window.start && s < window.end) tracked += b.trackedMinutes ?? 0;
      const c = clip({ start: new Date(b.start), end: new Date(b.end) }, window);
      if (!c) continue;
      const mins = (c.end.getTime() - c.start.getTime()) / 60_000;
      counts[b.status] += 1;
      scheduled += mins;
      if (b.status === 'done') done += mins;
    }
    const decided = counts.done + counts.skipped + counts.missed;
    return {
      taskId: t.id,
      name: t.name,
      budgetMinutes: t.budgetMinutes,
      budgetPeriod: t.budgetPeriod,
      scheduledMinutes: Math.round(scheduled),
      doneMinutes: Math.round(done),
      trackedMinutes: tracked,
      counts,
      completionRate: decided === 0 ? null : counts.done / decided,
    };
  });
}
