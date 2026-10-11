import type { Store } from './store.js';

export interface SetupStatus {
  /** A baseline week exists (one with at least one task slot): the only setup there is. */
  ready: boolean;
  hasAvailability: boolean;
  hasTasks: boolean;
  recurringCount: number;
  commitmentCount: number;
  /** What setup still needs: the baseline week, or nothing. */
  missing: Array<'baseline'>;
  /** The line the assistant says when there is no baseline yet, or null when ready. */
  next_step: string | null;
}

/** Setup is one line, not a question script: the three ways to get a baseline week. */
export const SETUP_LINE = "No baseline yet. Say: import a past week with the Import button and tick 'Use as my baseline', or draw your week on the Baseline tab; or ask me to suggest one from your tasks.";

export function setupStatus(store: Store): SetupStatus {
  const settings = store.getSettings();
  // The baseline week is the source of truth: a baseline with a task slot says when the user works.
  const hasBaseline = !!store.getBaseline()?.slots.some((s) => s.kind === 'task');
  const hasAvailability = settings.availability.length > 0 || hasBaseline;
  const hasTasks = store.listTasks().length > 0;
  return {
    ready: hasBaseline,
    hasAvailability,
    hasTasks,
    recurringCount: store.listRecurring().length,
    commitmentCount: store.listCommitments({ from: new Date() }).length,
    missing: hasBaseline ? [] : ['baseline'],
    next_step: hasBaseline ? null : SETUP_LINE,
  };
}
