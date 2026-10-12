export type BudgetPeriod = 'day' | 'week';
/** How the user likes to work: long deep sittings, shorter varied blocks, or in between. */
export type WorkStyle = 'deep' | 'varied' | 'balanced' | 'unknown';
export const WORK_STYLE_PRESETS: Record<Exclude<WorkStyle, 'unknown'>, { maxBlockMinutes: number; maxTasksPerDay: number }> = {
  deep: { maxBlockMinutes: 120, maxTasksPerDay: 4 },
  balanced: { maxBlockMinutes: 90, maxTasksPerDay: 6 },
  varied: { maxBlockMinutes: 60, maxTasksPerDay: 8 },
};
/** Part of the day a task prefers; 'any' means no preference. */
export type TaskSegment = 'morning' | 'afternoon' | 'evening' | 'any';
export type BlockStatus = 'pending' | 'done' | 'skipped' | 'missed';
/**
 * Who placed the block: the planner (replaced on re-plan), the user by hand (kept, and never moved by an operation), a
 * baseline copy (kept by the planner; replaced by a re-apply), or an instance operation (`adjusted`: kept by the planner
 * and by a re-apply, as manual is, and movable by a later operation, as baseline is).
 */
export type BlockSource = 'planner' | 'manual' | 'baseline' | 'adjusted';

export interface Task {
  id: string;
  name: string;
  color: string;          // hex like #4f8cff
  priority: number;       // 1 = highest
  budgetMinutes: number;  // wished time per period
  budgetPeriod: BudgetPeriod;
  preferredSegment?: TaskSegment; // default 'any'
  sessionMinutes?: number;        // preferred length of one sitting; default settings.maxBlockMinutes
  archived: boolean;
  createdAt: string;      // ISO
}

export interface Block {
  id: string;
  taskId: string;
  start: string;          // ISO UTC
  end: string;            // ISO UTC
  status: BlockStatus;
  source?: BlockSource;   // default 'planner'
  createdAt: string;
  statusChangedAt: string | null;
  trackedMinutes?: number;       // actual minutes recorded (clock stretches plus manual corrections)
  startedAt?: string | null;     // when the user first pressed Start on this block (actual start), whatever day the block is planned on
  finishedAt?: string | null;    // when the user pressed Finish (actual end)
  runningSince?: string | null;  // ISO while the clock runs, else null/absent
  plannedMinutes?: number;       // the length before an early finish shortened the block; the budget still counts it
  note?: string | null;          // the user's words on this block ("did it, not focused", "X and Y share this slot; X got done"): read by the assistant when it plans or adjusts
  carriedTo?: string | null;     // the block carry_over moved this block's owed minutes to (made, or a later slot's copy extended); while that block exists they are not owed again
}

/**
 * One slot of the baseline week: a task's sitting or a busy stretch, on a weekday (0 = Sunday ... 6 = Saturday), local
 * "HH:MM" times; `end` may be "24:00" (the slot runs to midnight).
 */
export interface BaselineSlot { day: number; start: string; end: string; kind: 'task' | 'busy'; taskId?: string; title?: string }
/** The baseline week: the single source of truth every real week copies. Saved whole; each save is a new version. */
export interface Baseline { version: number; savedAt: string; slots: BaselineSlot[] }
/** What a caller hands `Store.setBaseline`: the slots; the store assigns the version and stamps an empty savedAt. */
export interface BaselineInput { slots: BaselineSlot[]; savedAt?: string; version?: number }
/** @deprecated The pre-v2 baseline slot (task slots only); read by `normalizeBaseline`, never written. */
export interface BaselineBlock { taskId: string; day: number; start: string; end: string }
/** @deprecated The pre-v2 baseline shape; read by `normalizeBaseline`, never written. */
export interface LegacyBaseline { blocks: BaselineBlock[]; savedAt: string }

export interface Commitment {
  id: string;
  title: string;
  start: string;
  end: string;
}

/** A window of time the user is willing to work, on the given weekdays (0 = Sunday ... 6 = Saturday). */
export interface AvailabilityWindow { days: number[]; start: string; end: string } // "09:00", "18:00" local

/** A fixed commitment that repeats every week on the given weekdays. */
export interface RecurringCommitment { id: string; title: string; days: number[]; start: string; end: string }

export interface Settings {
  availability: AvailabilityWindow[]; // the baseline week template; empty until orientation
  segments: { morningEnd: string; afternoonEnd: string }; // "12:00", "17:00": morning is before morningEnd, evening from afternoonEnd
  weights: { priority: number; deficit: number }; // how the planner ranks candidates for a slot (0..1 each, not both zero)
  maxTasksPerDay: number; // the cap: a day holds at most this many different tasks (live blocks of any source); one weekly task and a must-do task are admitted beyond it
  workStyle: WorkStyle;   // asked in orientation, observed from routines and saved baselines
  weekStartsOn: number;   // 0 = Sunday (the default, as in Apple Calendar and Google Calendar), 1 = Monday
  slotMinutes: number;    // grid snap, e.g. 15
  minBlockMinutes: number;
  maxBlockMinutes: number;
  reviewWindow: 'day' | 'week';
  memory: string;         // the assistant's memory note: how the user likes their schedule changed, in a few lines; the user sees and edits it in Settings
}

/** The memory note's longest form, in characters. */
export const MEMORY_MAX = 2000;

export interface Interval { start: Date; end: Date }

export const STANDARD_WEEK: AvailabilityWindow[] = [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }];

export const DEFAULT_SEGMENTS = { morningEnd: '12:00', afternoonEnd: '17:00' };

export const DEFAULT_WEIGHTS = { priority: 0.6, deficit: 0.4 };

export const DEFAULT_SETTINGS: Settings = {
  availability: [],
  segments: { ...DEFAULT_SEGMENTS },
  weights: { ...DEFAULT_WEIGHTS },
  maxTasksPerDay: 5,
  workStyle: 'unknown',
  weekStartsOn: 0,
  slotMinutes: 15,
  minBlockMinutes: 30,
  maxBlockMinutes: 90,
  reviewWindow: 'week',
  memory: '',
};

export const TASK_COLORS = ['#4f8cff', '#34c759', '#ff9f0a', '#af52de', '#ff375f', '#5ac8fa', '#ffd60a', '#ff6b35'];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isDayList = (v: unknown): v is number[] => Array.isArray(v) && v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);

export function isAvailabilityWindow(v: unknown): v is AvailabilityWindow {
  if (!v || typeof v !== 'object') return false;
  const w = v as Record<string, unknown>;
  return isDayList(w.days) && typeof w.start === 'string' && HHMM.test(w.start) && typeof w.end === 'string' && HHMM.test(w.end) && w.end > w.start;
}

/** Build a valid Settings from whatever was stored, migrating the pre-template shape ({ workingHours, workDays }). */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  let availability: AvailabilityWindow[] = [];
  if (Array.isArray(r.availability)) {
    availability = r.availability.filter(isAvailabilityWindow).map((w) => ({ days: [...w.days].sort(), start: w.start, end: w.end }));
  } else if (r.workingHours && typeof r.workingHours === 'object') {
    const wh = r.workingHours as Record<string, unknown>;
    const days = isDayList(r.workDays) ? r.workDays : [1, 2, 3, 4, 5];
    const w = { days: [...days].sort(), start: wh.start, end: wh.end };
    if (isAvailabilityWindow(w)) availability = [w];
  }
  const num = (k: keyof Settings, min: number) => (Number.isFinite(r[k]) && (r[k] as number) >= min ? (r[k] as number) : DEFAULT_SETTINGS[k] as number);
  let segments = { ...DEFAULT_SEGMENTS };
  if (r.segments && typeof r.segments === 'object') {
    const g = r.segments as Record<string, unknown>;
    if (typeof g.morningEnd === 'string' && HHMM.test(g.morningEnd) && typeof g.afternoonEnd === 'string' && HHMM.test(g.afternoonEnd) && g.morningEnd < g.afternoonEnd) {
      segments = { morningEnd: g.morningEnd, afternoonEnd: g.afternoonEnd };
    }
  }
  let weights = { ...DEFAULT_WEIGHTS };
  if (r.weights && typeof r.weights === 'object') {
    const w = r.weights as Record<string, unknown>;
    const ok = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;
    if (ok(w.priority) && ok(w.deficit) && w.priority + w.deficit > 0) weights = { priority: w.priority, deficit: w.deficit };
  }
  return {
    availability,
    segments,
    weights,
    weekStartsOn: Number.isInteger(r.weekStartsOn) && (r.weekStartsOn as number) >= 0 && (r.weekStartsOn as number) <= 6 ? (r.weekStartsOn as number) : DEFAULT_SETTINGS.weekStartsOn,
    slotMinutes: num('slotMinutes', 5),
    minBlockMinutes: num('minBlockMinutes', 5),
    maxBlockMinutes: num('maxBlockMinutes', 5),
    reviewWindow: r.reviewWindow === 'day' ? 'day' : 'week',
    maxTasksPerDay: typeof r.maxTasksPerDay === 'number' && r.maxTasksPerDay >= 1 && r.maxTasksPerDay <= 50 ? Math.floor(r.maxTasksPerDay) : DEFAULT_SETTINGS.maxTasksPerDay,
    workStyle: r.workStyle === 'deep' || r.workStyle === 'varied' || r.workStyle === 'balanced' ? r.workStyle : 'unknown',
    memory: typeof r.memory === 'string' ? r.memory.trim().slice(0, MEMORY_MAX) : '',
  };
}

/** Weekdays that have at least one availability window. */
export function availableDays(settings: Settings): number[] {
  return [...new Set(settings.availability.flatMap((w) => w.days))].sort();
}
