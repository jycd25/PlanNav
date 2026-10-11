import type { Baseline, BaselineInput, Block, Commitment, RecurringCommitment, Settings, Task } from './types.js';
import { DEFAULT_SETTINGS } from './types.js';
import { normalizeBaseline } from './baseline.js';

export interface Range { from?: Date; to?: Date }

export interface ImportRecord {
  ids: string[];
  events: Array<{ title: string; start: string; end: string }>;
  importedAt: string;
}

export interface ExportBundle {
  exportedAt: string;
  tasks: Task[];
  blocks: Block[];
  commitments: Commitment[];
  recurring: RecurringCommitment[];
  settings: Settings;
}

export interface Store {
  listTasks(includeArchived?: boolean): Task[];
  getTask(id: string): Task | undefined;
  upsertTask(task: Task): Task;
  archiveTask(id: string): void;

  listBlocks(range?: Range): Block[];
  getBlock(id: string): Block | undefined;
  insertBlocks(blocks: Block[]): void;
  deleteBlocks(ids: string[]): void;
  updateBlock(id: string, patch: Partial<Pick<Block, 'status' | 'start' | 'end' | 'statusChangedAt' | 'source' | 'trackedMinutes' | 'runningSince' | 'plannedMinutes' | 'carriedTo' | 'note' | 'startedAt' | 'finishedAt'>>): Block;

  listCommitments(range?: Range): Commitment[];
  addCommitment(c: Commitment): Commitment;
  deleteCommitment(id: string): void;

  listRecurring(): RecurringCommitment[];
  addRecurring(r: RecurringCommitment): RecurringCommitment;
  deleteRecurring(id: string): void;

  /** What the last import from `source` (a URL or `file:<name>`) produced: commitment ids for refresh, and every event for routine learning. */
  getImportRecord(source: string): ImportRecord | undefined;
  setImportRecord(source: string, record: ImportRecord): void;
  listImportSources(): string[];

  /** The latest baseline version, normalized (an old-shape value reads as version 1 task slots); undefined when none. */
  getBaseline(): Baseline | undefined;
  /** Save the baseline as a new version: version = the last + 1, an empty savedAt stamped with the time of saving. */
  setBaseline(b: BaselineInput): void;
  /** Every saved version, oldest first. */
  listBaselines(): Baseline[];

  getSettings(): Settings;
  saveSettings(s: Settings): void;

  exportAll(): ExportBundle;
}

export function inRange(item: { start: string; end: string }, range?: Range): boolean {
  if (!range) return true;
  const s = new Date(item.start).getTime();
  const e = new Date(item.end).getTime();
  if (range.from && e <= range.from.getTime()) return false;
  if (range.to && s >= range.to.getTime()) return false;
  return true;
}

const byStart = (a: { start: string }, b: { start: string }) => a.start.localeCompare(b.start);

export class MemoryStore implements Store {
  private tasks = new Map<string, Task>();
  private blocks = new Map<string, Block>();
  private commitments = new Map<string, Commitment>();
  private recurring = new Map<string, RecurringCommitment>();
  private imports = new Map<string, ImportRecord>();
  private settings: Settings = { ...DEFAULT_SETTINGS };

  listTasks(includeArchived = false): Task[] {
    return [...this.tasks.values()]
      .filter((t) => includeArchived || !t.archived)
      .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  }
  getTask(id: string) { return this.tasks.get(id); }
  upsertTask(task: Task) { this.tasks.set(task.id, { ...task }); return { ...task }; }
  archiveTask(id: string) { const t = this.tasks.get(id); if (t) t.archived = true; }

  listBlocks(range?: Range) { return [...this.blocks.values()].filter((b) => inRange(b, range)).sort(byStart); }
  getBlock(id: string) { return this.blocks.get(id); }
  insertBlocks(blocks: Block[]) { for (const b of blocks) this.blocks.set(b.id, { ...b }); }
  deleteBlocks(ids: string[]) { for (const id of ids) this.blocks.delete(id); }
  updateBlock(id: string, patch: Partial<Pick<Block, 'status' | 'start' | 'end' | 'statusChangedAt' | 'source' | 'trackedMinutes' | 'runningSince' | 'plannedMinutes' | 'carriedTo' | 'note' | 'startedAt' | 'finishedAt'>>) {
    const b = this.blocks.get(id);
    if (!b) throw new Error(`Block not found: ${id}`);
    Object.assign(b, patch);
    for (const k of ['note', 'startedAt', 'finishedAt'] as const) if (patch[k] === null) delete b[k];
    return { ...b };
  }

  listCommitments(range?: Range) { return [...this.commitments.values()].filter((c) => inRange(c, range)).sort(byStart); }
  addCommitment(c: Commitment) { this.commitments.set(c.id, { ...c }); return { ...c }; }
  deleteCommitment(id: string) { this.commitments.delete(id); }

  listRecurring() { return [...this.recurring.values()].map((r) => ({ ...r, days: [...r.days] })).sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title)); }
  addRecurring(r: RecurringCommitment) { this.recurring.set(r.id, { ...r, days: [...r.days] }); return { ...r, days: [...r.days] }; }
  deleteRecurring(id: string) { this.recurring.delete(id); }

  getImportRecord(source: string) { const r = this.imports.get(source); return r ? JSON.parse(JSON.stringify(r)) as ImportRecord : undefined; }
  setImportRecord(source: string, record: ImportRecord) { this.imports.set(source, JSON.parse(JSON.stringify(record))); }
  listImportSources() { return [...this.imports.keys()]; }

  private baselines: Baseline[] = [];
  listBaselines(): Baseline[] { return JSON.parse(JSON.stringify(this.baselines)) as Baseline[]; }
  getBaseline(): Baseline | undefined { const b = this.baselines[this.baselines.length - 1]; return b ? JSON.parse(JSON.stringify(b)) as Baseline : undefined; }
  setBaseline(b: BaselineInput): Baseline {
    const n = normalizeBaseline(b);
    if (!n) throw new Error('Not a baseline: expected { slots: [...] }.');
    const saved: Baseline = { version: (this.baselines[this.baselines.length - 1]?.version ?? 0) + 1, savedAt: n.savedAt || new Date().toISOString(), slots: n.slots };
    this.baselines.push(saved);
    return JSON.parse(JSON.stringify(saved)) as Baseline;
  }

  getSettings() { return { ...this.settings, availability: this.settings.availability.map((w) => ({ ...w, days: [...w.days] })) }; }
  saveSettings(s: Settings) { this.settings = { ...s, availability: s.availability.map((w) => ({ ...w, days: [...w.days] })) }; }

  exportAll(): ExportBundle {
    return {
      exportedAt: new Date().toISOString(),
      tasks: this.listTasks(true),
      blocks: this.listBlocks(),
      commitments: this.listCommitments(),
      recurring: this.listRecurring(),
      settings: this.getSettings(),
    };
  }
}
