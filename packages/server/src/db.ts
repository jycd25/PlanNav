import { DatabaseSync } from 'node:sqlite';
import { normalizeBaseline, normalizeSettings, type Baseline, type BaselineInput, type Block, type Commitment, type ExportBundle, type ImportRecord, type Range, type RecurringCommitment, type Settings, type Store, type Task } from '@ds/core';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, priority INTEGER NOT NULL,
  budget_minutes INTEGER NOT NULL, budget_period TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, status_changed_at TEXT,
  tracked_minutes INTEGER, running_since TEXT, planned_minutes INTEGER
);
CREATE INDEX IF NOT EXISTS blocks_start ON blocks(start);
CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS commitments_start ON commitments(start);
CREATE TABLE IF NOT EXISTS recurring (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, days TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS baselines (version INTEGER PRIMARY KEY, saved_at TEXT NOT NULL, json TEXT NOT NULL);
`;

type TaskRow = { id: string; name: string; color: string; priority: number; budget_minutes: number; budget_period: string; preferred_segment: string | null; session_minutes: number | null; archived: number; created_at: string };
type BlockRow = { id: string; task_id: string; start: string; end: string; status: string; source: string | null; created_at: string; status_changed_at: string | null; tracked_minutes: number | null; running_since: string | null; planned_minutes: number | null; note: string | null; started_at: string | null; finished_at: string | null; carried_to?: string | null };
type CommitmentRow = { id: string; title: string; start: string; end: string };
type RecurringRow = { id: string; title: string; days: string; start: string; end: string };

const toTask = (r: TaskRow): Task => ({
  id: r.id, name: r.name, color: r.color, priority: r.priority, budgetMinutes: r.budget_minutes,
  budgetPeriod: r.budget_period as Task['budgetPeriod'], preferredSegment: (r.preferred_segment ?? 'any') as Task['preferredSegment'], sessionMinutes: r.session_minutes ?? undefined, archived: r.archived === 1, createdAt: r.created_at,
});
const toBlock = (r: BlockRow): Block => ({
  id: r.id, taskId: r.task_id, start: r.start, end: r.end, status: r.status as Block['status'],
  source: (r.source ?? 'planner') as Block['source'], createdAt: r.created_at, statusChangedAt: r.status_changed_at,
  trackedMinutes: r.tracked_minutes ?? undefined, runningSince: r.running_since ?? null, plannedMinutes: r.planned_minutes ?? undefined,
  ...(r.carried_to ? { carriedTo: r.carried_to } : {}),
  ...(r.note ? { note: r.note } : {}),
  ...(r.started_at ? { startedAt: r.started_at } : {}),
  ...(r.finished_at ? { finishedAt: r.finished_at } : {}),
});
const toCommitment = (r: CommitmentRow): Commitment => ({ id: r.id, title: r.title, start: r.start, end: r.end });
const toRecurring = (r: RecurringRow): RecurringCommitment => ({ id: r.id, title: r.title, days: JSON.parse(r.days) as number[], start: r.start, end: r.end });

function rangeClause(range?: Range): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (range?.from) { parts.push('end > ?'); params.push(range.from.toISOString()); }
  if (range?.to) { parts.push('start < ?'); params.push(range.to.toISOString()); }
  return { sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params };
}

export class SqliteStore implements Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Additive column migrations for databases created by earlier versions. */
  private migrate() {
    const cols = (this.db.prepare('PRAGMA table_info(tasks)').all() as unknown as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('preferred_segment')) this.db.exec("ALTER TABLE tasks ADD COLUMN preferred_segment TEXT NOT NULL DEFAULT 'any'");
    if (!cols.includes('session_minutes')) this.db.exec('ALTER TABLE tasks ADD COLUMN session_minutes INTEGER');
    const bcols = (this.db.prepare('PRAGMA table_info(blocks)').all() as unknown as Array<{ name: string }>).map((c) => c.name);
    if (!bcols.includes('source')) this.db.exec("ALTER TABLE blocks ADD COLUMN source TEXT NOT NULL DEFAULT 'planner'");
    if (!bcols.includes('tracked_minutes')) this.db.exec('ALTER TABLE blocks ADD COLUMN tracked_minutes INTEGER');
    if (!bcols.includes('running_since')) this.db.exec('ALTER TABLE blocks ADD COLUMN running_since TEXT');
    if (!bcols.includes('planned_minutes')) this.db.exec('ALTER TABLE blocks ADD COLUMN planned_minutes INTEGER');
    if (!bcols.includes('carried_to')) this.db.exec('ALTER TABLE blocks ADD COLUMN carried_to TEXT');
    if (!bcols.includes('note')) this.db.exec('ALTER TABLE blocks ADD COLUMN note TEXT');
    if (!bcols.includes('started_at')) this.db.exec('ALTER TABLE blocks ADD COLUMN started_at TEXT');
    if (!bcols.includes('finished_at')) this.db.exec('ALTER TABLE blocks ADD COLUMN finished_at TEXT');
    // Settings saved before 2026-10-09 carry weekStartsOn 1 from the old default, not a choice: once, read it as Sunday (Apple Calendar, Google Calendar).
    if (!this.getJson('week_start_chosen')) {
      const saved = this.getJson<{ weekStartsOn?: unknown }>('settings');
      if (saved && saved.weekStartsOn === 1) this.setJson('settings', { ...saved, weekStartsOn: 0 });
      this.setJson('week_start_chosen', true);
    }
    this.adoptKvBaseline();
  }

  /** A baseline saved before versions existed lives only in kv (possibly the old { blocks } shape): it becomes the first row. */
  private adoptKvBaseline() {
    const empty = (this.db.prepare('SELECT COUNT(*) AS n FROM baselines').get() as unknown as { n: number }).n === 0;
    if (!empty) return;
    const b = normalizeBaseline(this.getJson<unknown>('baseline'));
    if (b) this.db.prepare('INSERT INTO baselines (version, saved_at, json) VALUES (?, ?, ?)').run(b.version, b.savedAt, JSON.stringify(b));
  }

  close() { this.db.close(); }

  listTasks(includeArchived = false): Task[] {
    const rows = this.db.prepare(`SELECT * FROM tasks${includeArchived ? '' : ' WHERE archived = 0'} ORDER BY priority, name`).all() as unknown as TaskRow[];
    return rows.map(toTask);
  }
  getTask(id: string): Task | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow | undefined;
    return r ? toTask(r) : undefined;
  }
  upsertTask(t: Task): Task {
    this.db.prepare(`INSERT INTO tasks (id, name, color, priority, budget_minutes, budget_period, preferred_segment, session_minutes, archived, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, priority = excluded.priority,
        budget_minutes = excluded.budget_minutes, budget_period = excluded.budget_period, preferred_segment = excluded.preferred_segment,
        session_minutes = excluded.session_minutes, archived = excluded.archived`)
      .run(t.id, t.name, t.color, t.priority, t.budgetMinutes, t.budgetPeriod, t.preferredSegment ?? 'any', t.sessionMinutes ?? null, t.archived ? 1 : 0, t.createdAt);
    return this.getTask(t.id)!;
  }
  archiveTask(id: string) { this.db.prepare('UPDATE tasks SET archived = 1 WHERE id = ?').run(id); }

  listBlocks(range?: Range): Block[] {
    const { sql, params } = rangeClause(range);
    return (this.db.prepare(`SELECT * FROM blocks${sql} ORDER BY start`).all(...params) as unknown as BlockRow[]).map(toBlock);
  }
  getBlock(id: string): Block | undefined {
    const r = this.db.prepare('SELECT * FROM blocks WHERE id = ?').get(id) as unknown as BlockRow | undefined;
    return r ? toBlock(r) : undefined;
  }
  insertBlocks(blocks: Block[]) {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO blocks (id, task_id, start, end, status, source, created_at, status_changed_at, tracked_minutes, running_since, planned_minutes, carried_to, note, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const b of blocks) stmt.run(b.id, b.taskId, b.start, b.end, b.status, b.source ?? 'planner', b.createdAt, b.statusChangedAt, b.trackedMinutes ?? null, b.runningSince ?? null, b.plannedMinutes ?? null, b.carriedTo ?? null, b.note ?? null, b.startedAt ?? null, b.finishedAt ?? null);
  }
  deleteBlocks(ids: string[]) {
    const stmt = this.db.prepare('DELETE FROM blocks WHERE id = ?');
    for (const id of ids) stmt.run(id);
  }
  updateBlock(id: string, patch: Partial<Pick<Block, 'status' | 'start' | 'end' | 'statusChangedAt' | 'source' | 'trackedMinutes' | 'runningSince' | 'plannedMinutes' | 'carriedTo' | 'note' | 'startedAt' | 'finishedAt'>>): Block {
    const b = this.getBlock(id);
    if (!b) throw new Error(`Block not found: ${id}`);
    const next = { ...b, ...patch };
    for (const k of ['note', 'startedAt', 'finishedAt', 'trackedMinutes', 'plannedMinutes'] as const) if (next[k] === null || next[k] === undefined || next[k] === '') delete next[k];
    this.db.prepare('UPDATE blocks SET start = ?, end = ?, status = ?, source = ?, status_changed_at = ?, tracked_minutes = ?, running_since = ?, planned_minutes = ?, carried_to = ?, note = ?, started_at = ?, finished_at = ? WHERE id = ?')
      .run(next.start, next.end, next.status, next.source ?? 'planner', next.statusChangedAt, next.trackedMinutes ?? null, next.runningSince ?? null, next.plannedMinutes ?? null, next.carriedTo ?? null, next.note ?? null, next.startedAt ?? null, next.finishedAt ?? null, id);
    return next;
  }

  listCommitments(range?: Range): Commitment[] {
    const { sql, params } = rangeClause(range);
    return (this.db.prepare(`SELECT * FROM commitments${sql} ORDER BY start`).all(...params) as unknown as CommitmentRow[]).map(toCommitment);
  }
  addCommitment(c: Commitment): Commitment {
    this.db.prepare('INSERT OR REPLACE INTO commitments (id, title, start, end) VALUES (?, ?, ?, ?)').run(c.id, c.title, c.start, c.end);
    return c;
  }
  deleteCommitment(id: string) { this.db.prepare('DELETE FROM commitments WHERE id = ?').run(id); }

  listRecurring(): RecurringCommitment[] {
    return (this.db.prepare('SELECT * FROM recurring ORDER BY start, title').all() as unknown as RecurringRow[]).map(toRecurring);
  }
  addRecurring(r: RecurringCommitment): RecurringCommitment {
    this.db.prepare('INSERT OR REPLACE INTO recurring (id, title, days, start, end) VALUES (?, ?, ?, ?, ?)').run(r.id, r.title, JSON.stringify(r.days), r.start, r.end);
    return r;
  }
  deleteRecurring(id: string) { this.db.prepare('DELETE FROM recurring WHERE id = ?').run(id); }

  getImportRecord(source: string): ImportRecord | undefined {
    const r = this.getJson<ImportRecord | string[]>(`import:${source}`);
    if (!r) return undefined;
    return Array.isArray(r) ? { ids: r, events: [], importedAt: '' } : r; // older records held only ids
  }
  setImportRecord(source: string, record: ImportRecord) { this.setJson(`import:${source}`, record); }
  /** Every saved baseline version, oldest first. */
  listBaselines(): Baseline[] {
    this.adoptKvBaseline();
    return (this.db.prepare('SELECT json FROM baselines ORDER BY version').all() as unknown as Array<{ json: string }>).map((r) => JSON.parse(r.json) as Baseline);
  }
  getBaseline(): Baseline | undefined { return this.listBaselines().pop(); }
  /** Save the baseline as a new version (last + 1, savedAt stamped when empty); kv `baseline` keeps the latest. */
  setBaseline(input: BaselineInput): Baseline {
    const n = normalizeBaseline(input);
    if (!n) throw new Error('Not a baseline: expected { slots: [...] }.');
    this.adoptKvBaseline();
    const last = (this.db.prepare('SELECT MAX(version) AS v FROM baselines').get() as unknown as { v: number | null }).v ?? 0;
    const saved: Baseline = { version: last + 1, savedAt: n.savedAt || new Date().toISOString(), slots: n.slots };
    this.db.prepare('INSERT INTO baselines (version, saved_at, json) VALUES (?, ?, ?)').run(saved.version, saved.savedAt, JSON.stringify(saved));
    this.setJson('baseline', saved);
    return saved;
  }

  listImportSources(): string[] {
    return (this.db.prepare("SELECT key FROM kv WHERE key LIKE 'import:%'").all() as unknown as Array<{ key: string }>).map((r) => r.key.slice('import:'.length));
  }

  /** Settings are normalized on read, which also migrates the pre-template shape ({ workingHours, workDays }). */
  getSettings(): Settings {
    return normalizeSettings(this.getJson<unknown>('settings'));
  }
  saveSettings(s: Settings) { this.setJson('settings', s); }

  /** A kv row that is not valid JSON (a crash mid-write, a hand edit) reads as absent, with one warning, so the app still opens; the next save replaces it. */
  getJson<T>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as unknown as { value: string } | undefined;
    if (!r) return undefined;
    try { return JSON.parse(r.value) as T; } catch { console.warn(`rerouteday: the "${key}" row in the database is not valid JSON; using defaults until it is saved again.`); return undefined; }
  }
  setJson(key: string, value: unknown) {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }
  deleteKey(key: string) { this.db.prepare('DELETE FROM kv WHERE key = ?').run(key); }

  exportAll(): ExportBundle {
    return { exportedAt: new Date().toISOString(), tasks: this.listTasks(true), blocks: this.listBlocks(), commitments: this.listCommitments(), recurring: this.listRecurring(), settings: this.getSettings() };
  }
}
