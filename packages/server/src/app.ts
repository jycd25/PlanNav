import { performance } from 'node:perf_hooks';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { addDays, applyToWeek, createBlock, expandRecurring, importAsBaseline, importBaselineSummary, importIcs, importSummary, markBlock, materializeMissed, moveBlock, runTool, setupStatus, normalizeBaseline, refreshBudgets, startOfDay, startOfWeek, toIcs, trackBlock, type Baseline, type Block, type Settings, type Store, MAX_NOTE_CHARS } from '@ds/core';
import type { AssistantConfig, AssistantEvent, AssistantManager } from './assistant/types.js';
import { directReply, matchDirect } from './directActions.js';

export interface KvStore {
  getJson<T>(key: string): T | undefined;
  setJson(key: string, value: unknown): void;
}

export interface AppDeps {
  store: Store & KvStore;
  assistant: AssistantManager;
  now?: () => Date;
  /** Fetch a URL as text, for calendar imports. */
  fetchText?: (url: string) => Promise<string>;
}

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
const windowSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1, 'a window needs at least one day'),
  start: hhmm,
  end: hhmm,
}).refine((w) => w.end > w.start, { message: 'window end must be after start' });
const settingsSchema = z.object({
  availability: z.array(windowSchema),
  segments: z.object({ morningEnd: hhmm, afternoonEnd: hhmm }).refine((g) => g.morningEnd < g.afternoonEnd, { message: 'morning must end before the afternoon ends' }).optional(),
  weights: z.object({ priority: z.number().min(0).max(1), deficit: z.number().min(0).max(1) }).refine((w) => w.priority + w.deficit > 0, { message: 'at least one weight must be above zero' }).optional(),
  maxTasksPerDay: z.number().int().min(1).max(50).optional(),
  workStyle: z.enum(['deep', 'balanced', 'varied', 'unknown']).optional(),
  weekStartsOn: z.number().int().min(0).max(6),
  slotMinutes: z.number().int().min(5).max(60),
  minBlockMinutes: z.number().int().min(5),
  maxBlockMinutes: z.number().int().min(5),
  reviewWindow: z.enum(['day', 'week']),
});

const assistantSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('anthropic'), apiKey: z.string().optional(), model: z.string().min(1) }),
  z.object({ kind: z.literal('claude-code'), model: z.string().optional() }),
]);

export function createApp(deps: AppDeps) {
  const { store, assistant } = deps;
  const now = deps.now ?? (() => new Date());
  const ctx = { now, fetchText: deps.fetchText };
  const app = new Hono();

  const view = (b: Block) => ({ ...b, taskName: store.getTask(b.taskId)?.name ?? 'Unknown task' });

  // The server is local-only, but a browser can still be tricked into posting here from another site.
  // Mutating requests must be JSON (which forces a CORS preflight) and, when an Origin is present, local.
  const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'OPTIONS') {
      const origin = c.req.header('origin');
      if (origin && !LOCAL_ORIGIN.test(origin)) return c.json({ error: 'Cross-origin requests are not allowed' }, 403);
      const type = c.req.header('content-type');
      if (type && !type.toLowerCase().includes('application/json')) return c.json({ error: 'Expected content-type: application/json' }, 415);
    }
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof z.ZodError) return c.json({ error: err.message }, 400);
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(msg)) return c.json({ error: msg }, 404);
    return c.json({ error: msg }, 400);
  });

  app.get('/api/state', (c) => {
    materializeMissed(store, now());
    const day = startOfDay(now());
    const from = c.req.query('from') ? new Date(c.req.query('from')!) : day;
    const to = c.req.query('to') ? new Date(c.req.query('to')!) : addDays(day, 1);
    const rules = store.listRecurring();
    return c.json({
      now: now().toISOString(),
      tasks: store.listTasks(),
      blocks: store.listBlocks({ from, to }).map(view),
      commitments: store.listCommitments({ from, to }),
      recurring: expandRecurring(rules, { start: from, end: to }).map((r) => ({ recurringId: r.recurringId, title: r.title, start: r.start.toISOString(), end: r.end.toISOString() })),
      recurringRules: rules,
      settings: store.getSettings(),
      setup: setupStatus(store),
    });
  });
  app.get('/api/setup', (c) => c.json(setupStatus(store)));

  app.post('/api/recurring', async (c) => c.json(await runTool(store, 'add_recurring_commitment', await c.req.json(), ctx)));
  app.delete('/api/recurring/:id', (c) => {
    if (!store.listRecurring().some((r) => r.id === c.req.param('id'))) throw new HttpError(404, 'Recurring commitment not found');
    store.deleteRecurring(c.req.param('id'));
    return c.json({ ok: true });
  });

  // `asBaseline: true` makes the baseline week from the calendar's past events instead of importing commitments.
  app.post('/api/import', async (c) => {
    const { ics, asBaseline } = z.object({ ics: z.string().min(1), asBaseline: z.boolean().optional() }).parse(await c.req.json());
    if (asBaseline) {
      const r = importAsBaseline(store, ics, now());
      return c.json({ ...r, summary: importBaselineSummary(r) });
    }
    const r = importIcs(store, ics, now());
    return c.json({ ...r, events: undefined, summary: importSummary(r) });
  });
  app.post('/api/import-url', async (c) => {
    const { asBaseline, ...input } = z.object({ asBaseline: z.boolean().optional() }).passthrough().parse(await c.req.json());
    return c.json(await runTool(store, asBaseline ? 'import_as_baseline' : 'import_calendar', input, ctx));
  });

  app.post('/api/tasks', async (c) => c.json(await runTool(store, 'upsert_task', await c.req.json(), ctx)));
  app.delete('/api/tasks/:id', async (c) => {
    if (!store.getTask(c.req.param('id'))) throw new HttpError(404, 'Task not found');
    return c.json(await runTool(store, 'archive_task', { task: c.req.param('id') }, ctx));
  });

  app.post('/api/blocks', async (c) => {
    const body = z.object({ taskId: z.string(), start: z.string(), end: z.string() }).parse(await c.req.json());
    if (!store.getTask(body.taskId)) throw new HttpError(404, `Task not found: ${body.taskId}`);
    return c.json(view(createBlock(store, body.taskId, new Date(body.start), new Date(body.end), now())));
  });

  app.post('/api/blocks/:id/track', async (c) => {
    const id = c.req.param('id');
    if (!store.getBlock(id)) throw new HttpError(404, `Block not found: ${id}`);
    const body = z.object({ action: z.enum(['start', 'pause', 'finish', 'set']), minutes: z.number().optional() }).parse(await c.req.json());
    const r = trackBlock(store, id, body.action, now(), body.minutes);
    return c.json({ block: view(r.block), paused: r.paused.map(view), elapsedMinutes: r.elapsedMinutes });
  });

  app.patch('/api/blocks/:id', async (c) => {
    const id = c.req.param('id');
    if (!store.getBlock(id)) throw new HttpError(404, `Block not found: ${id}`);
    const body = z.object({
      status: z.enum(['pending', 'done', 'skipped', 'missed']).optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      note: z.string().max(MAX_NOTE_CHARS).optional(),
    }).parse(await c.req.json());
    let b = store.getBlock(id)!;
    if (body.start && body.end) b = moveBlock(store, id, new Date(body.start), new Date(body.end));
    if (body.status) b = markBlock(store, id, body.status, now());
    if (body.note !== undefined) { const note = body.note.replace(/\s+/g, ' ').trim(); b = store.updateBlock(id, { note: note || null }); }
    return c.json(view(b));
  });
  app.delete('/api/blocks/:id', (c) => {
    if (!store.getBlock(c.req.param('id'))) throw new HttpError(404, 'Block not found');
    store.deleteBlocks([c.req.param('id')]);
    return c.json({ ok: true });
  });

  app.post('/api/commitments', async (c) => c.json(await runTool(store, 'add_commitment', await c.req.json(), ctx)));
  app.delete('/api/commitments/:id', async (c) => c.json(await runTool(store, 'remove_commitment', { commitment_id: c.req.param('id') }, ctx)));

  app.post('/api/plan', async (c) => c.json(await runTool(store, 'plan_schedule', await c.req.json().catch(() => ({})), ctx)));
  app.get('/api/summary', async (c) => c.json(await runTool(store, 'get_summary', { window: c.req.query('window') }, ctx)));

  app.get('/api/settings', (c) => {
    const a = assistant.getConfig();
    const publicAssistant = a.kind === 'anthropic'
      ? { kind: 'anthropic', model: a.model, hasApiKey: Boolean(a.apiKey) }
      : { kind: 'claude-code', model: a.model, hasApiKey: false };
    return c.json({ settings: store.getSettings(), assistant: publicAssistant });
  });
  app.put('/api/settings', async (c) => {
    const body = z.object({ settings: settingsSchema.optional(), assistant: assistantSchema.optional() }).parse(await c.req.json());
    if (body.settings) {
      if (body.settings.minBlockMinutes > body.settings.maxBlockMinutes) throw new HttpError(400, 'minBlockMinutes must not exceed maxBlockMinutes');
      const current = store.getSettings();
      const settings: Settings = { ...body.settings, segments: body.settings.segments ?? current.segments, weights: body.settings.weights ?? current.weights, maxTasksPerDay: body.settings.maxTasksPerDay ?? current.maxTasksPerDay, workStyle: body.settings.workStyle ?? current.workStyle, availability: body.settings.availability.map((w) => ({ ...w, days: [...w.days].sort() })) };
      store.saveSettings(settings);
    }
    if (body.assistant) {
      const current = assistant.getConfig();
      let next: AssistantConfig;
      if (body.assistant.kind === 'anthropic') {
        const apiKey = body.assistant.apiKey ?? (current.kind === 'anthropic' ? current.apiKey : '');
        if (!apiKey) throw new HttpError(400, 'apiKey is required for the anthropic backend');
        next = { kind: 'anthropic', apiKey, model: body.assistant.model };
      } else {
        next = { kind: 'claude-code', model: body.assistant.model };
      }
      assistant.setConfig(next);
    }
    return c.json({ ok: true });
  });

  // The baseline: a template week, saved whole as numbered versions; applying copies it onto a real week.
  const baselineView = () => ({
    baseline: store.getBaseline() ?? null,
    versions: store.listBaselines().map((b) => ({ version: b.version, savedAt: b.savedAt })),
  });
  const saveSlots = (raw: unknown[]): Baseline => {
    const n = normalizeBaseline({ slots: raw });
    if (!n || n.slots.length !== raw.length) throw new HttpError(400, 'Every slot needs a day (0-6), start and end as HH:MM, and a kind: a task slot with a taskId or a busy slot with a title');
    store.setBaseline({ slots: n.slots });
    refreshBudgets(store, store.getBaseline()!); // each slotted task's budget and session now come from the baseline
    return store.getBaseline()!;
  };
  const slotsBody = z.object({ slots: z.array(z.unknown()).max(500) });
  app.get('/api/baseline', (c) => c.json(baselineView()));
  app.put('/api/baseline', async (c) => {
    saveSlots(slotsBody.parse(await c.req.json()).slots);
    return c.json(baselineView());
  });
  app.post('/api/baseline/revert', async (c) => {
    const { version } = z.object({ version: z.number().int() }).parse(await c.req.json());
    const old = store.listBaselines().find((b) => b.version === version);
    if (!old) throw new HttpError(404, `Baseline version ${version} not found`);
    saveSlots(old.slots);
    return c.json(baselineView());
  });
  app.post('/api/baseline/apply', async (c) => {
    const { weekOf } = z.object({ weekOf: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
    const baseline = store.getBaseline();
    if (!baseline) throw new HttpError(404, 'No baseline saved yet');
    const at = weekOf === undefined ? now() : new Date(/^\d{4}-\d{2}-\d{2}$/.test(weekOf) ? `${weekOf}T00:00:00` : weekOf);
    if (Number.isNaN(at.getTime())) throw new HttpError(400, 'weekOf must be a date such as 2026-10-12');
    const r = applyToWeek(store, baseline, startOfWeek(at, store.getSettings().weekStartsOn), now());
    return c.json({ ...r, created: r.created.map(view) });
  });

  app.get('/api/export.ics', (c) => {
    const body = toIcs({ blocks: store.listBlocks(), tasks: store.listTasks(true), commitments: store.listCommitments(), recurring: store.listRecurring(), now: now() });
    return c.body(body, 200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="plannav.ics"' });
  });
  app.get('/api/export.json', (c) => c.json(store.exportAll()));

  // One assistant reply at a time: two concurrent runs would race on the database and the CLI session. `chatTurn` counts
  // turns, so a turn that a reset abandoned cannot free the chat for a newer one when it ends.
  let chatInFlight = false;
  let chatTurn = 0;
  // What direct actions did since the model last spoke, told to the model (as app-written context) with the next message
  // it answers.
  let directLog: string[] = [];
  let directSeq = 0;
  // The last reply in this chat ended with a question: the next message is probably its answer, so no direct action.
  let lastReplyAsked = false;
  /** Run an exact-phrase direct action; null when the text is not one or its tool fails (the model then takes it). */
  const runDirect = async (message: string, emit: (e: AssistantEvent) => void): Promise<boolean> => {
    const t0 = performance.now();
    const action = matchDirect(message);
    if (!action) return false;
    let result: unknown;
    try { result = await runTool(store, action.tool, action.input, ctx); } catch { return false; }
    const reply = directReply(result);
    if (!reply) return false;
    const id = `direct-${++directSeq}`;
    emit({ type: 'tool_call', id, name: action.tool, input: action.input });
    emit({ type: 'tool_result', id, name: action.tool, result });
    emit({ type: 'text', delta: reply });
    emit({ type: 'stats', stats: { wallMs: performance.now() - t0, direct: true } });
    directLog = [...directLog, `"${message.trim().slice(0, 80)}" ran ${action.tool}: ${reply}`].slice(-5);
    return true;
  };
  app.post('/api/chat', async (c) => {
    const { message } = z.object({ message: z.string().min(1).max(4000) }).parse(await c.req.json());
    if (chatInFlight) throw new HttpError(409, 'A reply is still in progress. Wait for it to finish or start a new chat.');
    chatInFlight = true;
    const turn = ++chatTurn;
    return streamSSE(c, async (stream) => {
      let queue = Promise.resolve();
      let replyText = '';
      const emit = (e: AssistantEvent) => {
        if (e.type === 'text') replyText += e.delta;
        queue = queue.then(() => stream.writeSSE({ data: JSON.stringify(e) }));
      };
      try {
        if (lastReplyAsked || !(await runDirect(message, emit))) {
          const note = directLog.length ? `Done directly in this chat since you last replied (by the app, without you): ${directLog.join('; ')}` : undefined;
          await assistant.send(message, emit, c.req.raw.signal, note);
          // Forgotten only once a turn carried it; a failed turn leaves it for the next one.
          if (turn === chatTurn) directLog = [];
        }
      } catch (err) {
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        if (turn === chatTurn) { chatInFlight = false; lastReplyAsked = replyText.trim().endsWith('?'); }
      }
      emit({ type: 'done' });
      await queue;
    });
  });
  // The chat panel opened (or a new chat began): start the assistant's slow parts now, not on the first message.
  app.post('/api/chat/warm', (c) => { if (!chatInFlight) assistant.warm(); return c.json({ ok: true }); });
  app.post('/api/chat/reset', (c) => { assistant.reset(); chatInFlight = false; chatTurn += 1; directLog = []; lastReplyAsked = false; return c.json({ ok: true }); });

  return app;
}
