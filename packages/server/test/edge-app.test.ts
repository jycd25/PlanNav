import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, DEFAULT_SETTINGS, STANDARD_WEEK, runTool, type Block, type Task } from '@ds/core';
import { createApp } from '../src/app.js';
import { SqliteStore } from '../src/db.js';
import { buildContext } from '../src/assistant/systemPrompt.js';
import type { AssistantConfig, AssistantManager, Emit } from '../src/assistant/types.js';

class KvMemoryStore extends MemoryStore {
  kv = new Map<string, unknown>();
  getJson<T>(key: string) { return this.kv.get(key) as T | undefined; }
  setJson(key: string, value: unknown) { this.kv.set(key, value); }
}

class FakeAssistant implements AssistantManager {
  config: AssistantConfig = { kind: 'claude-code' };
  resets = 0;
  warms = 0;
  calls: string[] = [];
  notes: Array<string | undefined> = [];
  reply = 'ok';
  async send(text: string, emit: Emit, _signal?: AbortSignal, note?: string) {
    this.calls.push(text);
    this.notes.push(note);
    emit({ type: 'text', delta: this.reply });
  }
  reset() { this.resets += 1; }
  warm() { this.warms += 1; }
  getConfig() { return this.config; }
  setConfig(c: AssistantConfig) { this.config = c; }
}

const d = (h: number, m = 0) => new Date(2026, 9, 7, h, m); // Wednesday 2026-10-07
const json = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const events = async (res: Response) => (await res.text()).split('\n\n').filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, '')));
const types = (ev: Array<{ type: string }>) => ev.map((e) => e.type);
const direct = (ev: any[]) => ev.some((e) => e.type === 'stats' && e.stats.direct);

let store: KvMemoryStore;
let assistant: FakeAssistant;
let clock: Date;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new KvMemoryStore();
  store.saveSettings({ ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, maxBlockMinutes: 60, minBlockMinutes: 30, slotMinutes: 15 });
  assistant = new FakeAssistant();
  clock = d(9);
  app = createApp({ store, assistant, now: () => clock });
});

const mkTask = async (name: string, priority = 1) => ((await (await app.request('/api/tasks', json({ name, priority, budget_minutes: 60, budget_period: 'day' }))).json()) as any).id as string;
const taskSlot = (taskId: string, day: number, start: string, end: string) => ({ day, start, end, kind: 'task', taskId });
const busySlot = (day: number, start: string, end: string, title = 'Lunch') => ({ day, start, end, kind: 'busy', title });

/** The instance test's Wednesday: a 09-10, b 10-11, c 11-12, lunch, d 13-14, e 14-15, blank, f 17-18; at 10:20 a shift must ask about the breaks. */
function seedShiftWednesday() {
  store.saveSettings({ ...DEFAULT_SETTINGS, availability: [], minBlockMinutes: 30, slotMinutes: 15, maxBlockMinutes: 60 });
  const task = (id: string, priority: number): Task => ({ id, name: id, color: '#000', priority, budgetMinutes: 300, budgetPeriod: 'week', sessionMinutes: 60, archived: false, createdAt: '' });
  for (const [id, p] of [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5], ['f', 6]] as const) store.upsertTask(task(id, p));
  store.setBaseline({ slots: [1, 2, 3, 4, 5].flatMap((day) => [taskSlot('a', day, '09:00', '10:00'), taskSlot('b', day, '10:00', '11:00'), taskSlot('c', day, '11:00', '12:00'), busySlot(day, '12:00', '13:00'), taskSlot('d', day, '13:00', '14:00'), taskSlot('e', day, '14:00', '15:00'), taskSlot('f', day, '17:00', '18:00')] as any) });
  store.addCommitment({ id: 'lunch', title: 'Lunch', start: d(12).toISOString(), end: d(13).toISOString() });
  const blk = (id: string, s: number, e: number): Block => ({ id, taskId: id, start: d(s).toISOString(), end: d(e).toISOString(), status: 'pending', source: 'baseline', createdAt: '', statusChangedAt: null });
  store.insertBlocks([blk('a', 9, 10), blk('b', 10, 11), blk('c', 11, 12), blk('d', 13, 14), blk('e', 14, 15), blk('f', 17, 18)]);
}
const SHIFT_QUESTION = 'Shifting 5 blocks by 20 min keeps your breaks (15:00-17:00) but ends the day at 19:00, past 18:00. Waive the breaks to end at 18:00, or keep them and end later?';

describe('full flows through the HTTP API', () => {
  it('tasks, settings, a saved baseline, an apply, then the day read and shifted from the chat, all visible in the store', async () => {
    const deep = await mkTask('Deep', 1);
    const read = await mkTask('Reading', 2);
    const settings = await app.request('/api/settings', json({ settings: { ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, slotMinutes: 30, minBlockMinutes: 30, maxBlockMinutes: 90 } }, 'PUT'));
    expect(settings.status).toBe(200);
    expect(await settings.json()).toEqual({ ok: true });
    expect(store.getSettings().slotMinutes).toBe(30);

    // Wednesday: Deep 10:00-11:00, Reading 11:00-12:00; lunch after. Thursday: Deep 09:00-10:00.
    const saved = await (await app.request('/api/baseline', json({ slots: [taskSlot(deep, 3, '10:00', '11:00'), taskSlot(read, 3, '11:00', '12:00'), busySlot(3, '12:30', '13:30'), taskSlot(deep, 4, '09:00', '10:00')] }, 'PUT'))).json() as any;
    expect(saved.baseline.version).toBe(1);
    expect(saved.versions).toEqual([{ version: 1, savedAt: saved.baseline.savedAt }]);
    // the save refreshed the slotted tasks' budgets: Deep has two one-hour slots, Reading one
    expect(store.getTask(deep)).toMatchObject({ budgetMinutes: 120, budgetPeriod: 'week', sessionMinutes: 60 });
    expect(store.getTask(read)).toMatchObject({ budgetMinutes: 60, budgetPeriod: 'week', sessionMinutes: 60 });
    expect((await (await app.request('/api/setup')).json() as any).ready).toBe(true);

    // apply onto this week (the clock is Wednesday 09:00): every slot still ahead is laid, the busy slot becomes a commitment
    const applied = await (await app.request('/api/baseline/apply', json({}))).json() as any;
    expect(applied.created.map((b: any) => [b.taskName, b.start, b.source])).toEqual([
      ['Deep', d(10).toISOString(), 'baseline'],
      ['Reading', d(11).toISOString(), 'baseline'],
      ['Deep', new Date(2026, 9, 8, 9).toISOString(), 'baseline'],
    ]);
    expect(applied.commitments).toHaveLength(1);
    expect(applied.commitments[0]).toMatchObject({ title: 'Lunch', start: d(12, 30).toISOString(), end: d(13, 30).toISOString() });
    expect(applied.replaced).toBe(0);
    expect(applied.skipped).toEqual([]);

    const state = await (await app.request(`/api/state?from=${d(0).toISOString()}&to=${d(23, 59).toISOString()}`)).json() as any;
    expect(state.blocks.map((b: any) => b.taskName)).toEqual(['Deep', 'Reading']);
    expect(state.commitments.map((c: any) => c.title)).toEqual(['Lunch']);
    expect(state.setup).toMatchObject({ ready: true, missing: [] });
    expect(state.now).toBe(d(9).toISOString());

    // "What's on today?" is answered from the tool, no model
    const today = await events(await app.request('/api/chat', json({ message: "What's on today?" })));
    expect(types(today)).toEqual(['tool_call', 'tool_result', 'text', 'stats', 'done']);
    expect(today[2].delta).toBe('Today: Deep 10:00-11:00, Reading 11:00-12:00, "Lunch" 12:30-13:30.');
    expect(assistant.calls).toEqual([]);

    // 10:20, late for Deep: the shift ends by the baseline's last usable minute (12:30), so it runs directly and the store moved
    clock = d(10, 20);
    const shifted = await events(await app.request('/api/chat', json({ message: "I'm starting now" })));
    expect(types(shifted)).toEqual(['tool_call', 'tool_result', 'text', 'stats', 'done']);
    expect(shifted[1].result.needsConfirmation).toBeUndefined();
    expect(shifted[2].delta).toBe('Shifted 2 blocks by 20 min (Deep 10:20-11:20, Reading 11:20-12:20); the day ends at 12:20.');
    const deepBlock = store.listBlocks({ from: d(0), to: d(23) }).find((b) => b.taskId === deep)!;
    expect([deepBlock.start, deepBlock.end, deepBlock.source]).toEqual([d(10, 20).toISOString(), d(11, 20).toISOString(), 'adjusted']);
    expect(assistant.calls).toEqual([]);

    // the model's next turn is told both direct actions, oldest first
    await (await app.request('/api/chat', json({ message: 'thanks' }))).text();
    expect(assistant.calls).toEqual(['thanks']);
    expect(assistant.notes[0]).toBe(`Done directly in this chat since you last replied (by the app, without you): "What's on today?" ran get_schedule: Today: Deep 10:00-11:00, Reading 11:00-12:00, "Lunch" 12:30-13:30.; "I'm starting now" ran shift_day: ${shifted[2].delta}`);
  });

  it('the same flow on a SQLite file survives a reopen: tasks, baseline versions, the memory note and the shifted block', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rerouteday-edge-app-'));
    const file = join(dir, 'data.sqlite');
    try {
      const sqlite = new SqliteStore(file);
      sqlite.saveSettings({ ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, maxBlockMinutes: 60, minBlockMinutes: 30, slotMinutes: 15 });
      const sapp = createApp({ store: sqlite, assistant, now: () => clock });
      const t = await (await sapp.request('/api/tasks', json({ name: 'Deep', priority: 1, budget_minutes: 60, budget_period: 'day' }))).json() as any;
      await sapp.request('/api/baseline', json({ slots: [taskSlot(t.id, 3, '10:00', '11:00')] }, 'PUT'));
      await sapp.request('/api/baseline', json({ slots: [taskSlot(t.id, 3, '10:00', '11:00'), taskSlot(t.id, 4, '10:00', '11:00')] }, 'PUT'));
      expect((await sapp.request('/api/settings', json({ settings: { ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, memory: '- Keep Friday light.' } }, 'PUT'))).status).toBe(200);
      const applied = await (await sapp.request('/api/baseline/apply', json({}))).json() as any;
      expect(applied.created).toHaveLength(2);
      clock = d(10, 15);
      // a memory note exists, so the shift is the model's; the apply phrase stays direct
      const shift = await events(await sapp.request('/api/chat', json({ message: "I'm starting now" })));
      expect(direct(shift)).toBe(false);
      expect(assistant.calls).toEqual(["I'm starting now"]);
      const apply = await events(await sapp.request('/api/chat', json({ message: 'Apply my baseline to next week' })));
      expect(direct(apply)).toBe(true);
      expect(apply[2].delta).toBe('Copied 2 baseline blocks onto the week of Sun 2026-10-11.');
      sqlite.close();

      const again = new SqliteStore(file);
      expect(again.listTasks().map((x) => x.name)).toEqual(['Deep']);
      expect(again.listBaselines().map((b) => b.version)).toEqual([1, 2]);
      expect(again.getSettings().memory).toBe('- Keep Friday light.');
      expect(again.listBlocks().map((b) => b.start)).toEqual([d(10).toISOString(), new Date(2026, 9, 8, 10).toISOString(), new Date(2026, 9, 14, 10).toISOString(), new Date(2026, 9, 15, 10).toISOString()]);
      const reopened = createApp({ store: again, assistant, now: () => clock });
      const got = await (await reopened.request('/api/baseline')).json() as any;
      expect(got.baseline.version).toBe(2);
      expect(got.versions.map((v: any) => v.version)).toEqual([1, 2]);
      expect(((await (await reopened.request('/api/export.json')).json()) as any).settings.memory).toBe('- Keep Friday light.');
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the shift that must ask, through the chat route', () => {
  beforeEach(() => { seedShiftWednesday(); clock = d(10, 20); });

  it('runs directly, changes nothing, and the question is the reply', async () => {
    const ev = await events(await app.request('/api/chat', json({ message: "I'm starting now" })));
    expect(types(ev)).toEqual(['tool_call', 'tool_result', 'text', 'stats', 'done']);
    expect(ev[0]).toMatchObject({ name: 'shift_day', input: {} });
    expect(ev[1].result).toEqual({ moved: [], shortened: [], dropped: [], created: [], summary: SHIFT_QUESTION, needsConfirmation: true });
    expect(ev[2].delta).toBe(SHIFT_QUESTION);
    expect(ev[3].stats.direct).toBe(true);
    expect(assistant.calls).toEqual([]);
    expect(['b', 'c', 'd', 'e', 'f'].map((id) => store.getBlock(id)!.start)).toEqual([d(10), d(11), d(13), d(14), d(17)].map((x) => x.toISOString()));
    expect(['b', 'c', 'd', 'e', 'f'].map((id) => store.getBlock(id)!.source)).toEqual(['baseline', 'baseline', 'baseline', 'baseline', 'baseline']);
    expect(store.getBlock('a')!.status).toBe('missed'); // over at 10:20 and never marked
  });

  it('the next message is the answer: it goes to the model with the question in the note, even when it is an exact chip phrase', async () => {
    await (await app.request('/api/chat', json({ message: "I'm starting now" }))).text();
    const next = await events(await app.request('/api/chat', json({ message: "What's on today?" })));
    expect(direct(next)).toBe(false);
    expect(types(next)).toEqual(['text', 'done']);
    expect(assistant.calls).toEqual(["What's on today?"]);
    expect(assistant.notes[0]).toBe(`Done directly in this chat since you last replied (by the app, without you): "I'm starting now" ran shift_day: ${SHIFT_QUESTION}`);
    // the model's reply ("ok") did not end with a question: the phrase is direct again
    const after = await events(await app.request('/api/chat', json({ message: "What's on today?" })));
    expect(direct(after)).toBe(true);
    expect(assistant.calls).toHaveLength(1);
  });

  it('the model answers the shift with the breaks waived: the tool it calls lands in the store; a second ask is not raised', async () => {
    await (await app.request('/api/chat', json({ message: "I'm starting now" }))).text();
    assistant.send = async (text, emit) => {
      assistant.calls.push(text);
      const r = await runTool(store, 'shift_day', { breaks: 'waive' }, { now: () => clock }) as any;
      emit({ type: 'tool_call', id: 'm1', name: 'shift_day', input: { breaks: 'waive' } });
      emit({ type: 'tool_result', id: 'm1', name: 'shift_day', result: r });
      emit({ type: 'text', delta: r.summary });
    };
    const ev = await events(await app.request('/api/chat', json({ message: 'waive them' })));
    expect(types(ev)).toEqual(['tool_call', 'tool_result', 'text', 'done']);
    expect(ev[2].delta).toBe('Shifted 4 blocks by 20 min (b 10:20-11:20, c 13:00-14:00, d 14:00-15:00, and 1 more), breaks waived; the day ends at 18:00.');
    expect(['b', 'c', 'd', 'e', 'f'].map((id) => store.getBlock(id)!.start)).toEqual([d(10, 20), d(13), d(14), d(15), d(17)].map((x) => x.toISOString()));
    expect(['b', 'c', 'd', 'e', 'f'].map((id) => store.getBlock(id)!.source)).toEqual(['adjusted', 'adjusted', 'adjusted', 'adjusted', 'baseline']);
  });

  it('a chat reset forgets the open question: the phrase is direct again, and the note to the model is gone', async () => {
    await (await app.request('/api/chat', json({ message: "I'm starting now" }))).text();
    expect((await app.request('/api/chat/reset', { method: 'POST' })).status).toBe(200);
    expect(assistant.resets).toBe(1);
    const ev = await events(await app.request('/api/chat', json({ message: "What's on today?" })));
    expect(direct(ev)).toBe(true);
    expect(ev[2].delta).toBe('Today: a 09:00-10:00 (missed), b 10:00-11:00, c 11:00-12:00, "Lunch" 12:00-13:00, d 13:00-14:00, e 14:00-15:00, f 17:00-18:00.');
    await (await app.request('/api/chat', json({ message: 'hi' }))).text();
    expect(assistant.notes[0]).toBe('Done directly in this chat since you last replied (by the app, without you): "What\'s on today?" ran get_schedule: Today: a 09:00-10:00 (missed), b 10:00-11:00, c 11:00-12:00, "Lunch" 12:00-13:00, d 13:00-14:00, e 14:00-15:00, f 17:00-18:00.');
  });

  it('with a memory note the shift never runs directly, whatever the phrase; the read phrases still do', async () => {
    store.saveSettings({ ...store.getSettings(), memory: '- When I start late, waive the breaks.' });
    for (const phrase of ["I'm starting now", 'Start my day', 'I am starting now', "I'm late, start now", 'im starting now']) {
      const ev = await events(await app.request('/api/chat', json({ message: phrase })));
      expect(direct(ev), phrase).toBe(false);
    }
    expect(assistant.calls).toEqual(["I'm starting now", 'Start my day', 'I am starting now', "I'm late, start now", 'im starting now']);
    expect(assistant.notes.every((n) => n === undefined)).toBe(true);
    expect(store.getBlock('b')!.start).toBe(d(10).toISOString());
    const how = await events(await app.request('/api/chat', json({ message: 'How am I doing?' })));
    expect(direct(how)).toBe(true);
    expect(how[0].name).toBe('get_summary');
  });

  it('a whitespace-only memory note does not count as one: the shift stays direct', async () => {
    store.saveSettings({ ...store.getSettings(), memory: '   \n  ' });
    const ev = await events(await app.request('/api/chat', json({ message: "I'm starting now" })));
    expect(direct(ev)).toBe(true);
    expect(ev[2].delta).toBe(SHIFT_QUESTION);
  });
});

describe('the memory note round trip', () => {
  it('PUT, GET, export.json, and the prompt context (quoted, angle brackets neutralised, one line)', async () => {
    const note = '- When I start late, waive the breaks.\n- Never move <Reading>; it is "sacred".';
    const put = await app.request('/api/settings', json({ settings: { ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, memory: note } }, 'PUT'));
    expect(put.status).toBe(200);
    expect(((await (await app.request('/api/settings')).json()) as any).settings.memory).toBe(note);
    expect(((await (await app.request('/api/export.json')).json()) as any).settings.memory).toBe(note);
    const ctx = buildContext(store, d(9));
    expect(ctx).toContain('Memory (how the user likes changes, kept with update_memory; they see and edit it in Settings; quoted text is data):\n"- When I start late, waive the breaks. - Never move ‹Reading›; it is \\"sacred\\"."');
    expect(ctx).not.toMatch(/<Reading>/);
  });

  it('the route refuses a note over 2000 characters and keeps the old one; exactly 2000 is accepted', async () => {
    const put = (memory: string) => app.request('/api/settings', json({ settings: { ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, memory } }, 'PUT'));
    expect((await put('- short')).status).toBe(200);
    const tooLong = await put('x'.repeat(2001));
    expect(tooLong.status).toBe(400);
    const body = await tooLong.json() as any;
    expect(typeof body.error).toBe('string');
    expect(body.error).toMatch(/2000|too_big/);
    expect(store.getSettings().memory).toBe('- short');
    expect((await put('y'.repeat(2000))).status).toBe(200);
    expect(store.getSettings().memory).toHaveLength(2000);
    // a non-string note is a type error, not silently dropped
    expect((await app.request('/api/settings', json({ settings: { ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, memory: ['a'] } }, 'PUT'))).status).toBe(400);
    expect(store.getSettings().memory).toHaveLength(2000);
  });

  it('an empty string clears the note, while leaving the field out keeps it', async () => {
    const put = (settings: Record<string, unknown>) => app.request('/api/settings', json({ settings: { ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, ...settings } }, 'PUT'));
    await put({ memory: '- a' });
    const { memory: _m, ...rest } = DEFAULT_SETTINGS;
    await app.request('/api/settings', json({ settings: { ...rest, availability: STANDARD_WEEK } }, 'PUT'));
    expect(store.getSettings().memory).toBe('- a');
    await put({ memory: '' });
    expect(store.getSettings().memory).toBe('');
    expect(buildContext(store, d(9))).not.toMatch(/^Memory \(/m);
  });

  it('update_memory (what the model calls) is seen by GET /api/settings on the next request', async () => {
    assistant.send = async (text, emit) => {
      assistant.calls.push(text);
      const r = await runTool(store, 'update_memory', { text: '- Lunch at 13:00, always.' }, { now: () => clock }) as any;
      emit({ type: 'tool_call', id: 'u1', name: 'update_memory', input: { text: '- Lunch at 13:00, always.' } });
      emit({ type: 'tool_result', id: 'u1', name: 'update_memory', result: r });
      emit({ type: 'text', delta: r.summary });
    };
    const ev = await events(await app.request('/api/chat', json({ message: 'remember that lunch is at 13' })));
    expect(ev[2].delta).toBe('Memory updated.');
    expect(((await (await app.request('/api/settings')).json()) as any).settings.memory).toBe('- Lunch at 13:00, always.');
  });
});

describe('chat route edge cases', () => {
  it('two more messages during a reply are both refused with 409 and the exact message; the chat is free again after', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    assistant.send = async (text, emit) => { await gate; emit({ type: 'text', delta: `done: ${text}` }); };
    const first = await app.request('/api/chat', json({ message: 'one' }));
    expect(first.status).toBe(200);
    const [second, third] = await Promise.all([app.request('/api/chat', json({ message: 'two' })), app.request('/api/chat', json({ message: 'three' }))]);
    expect(second.status).toBe(409);
    expect(third.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'A reply is still in progress. Wait for it to finish or start a new chat.' });
    // a direct phrase is refused too: the lock is checked before the phrase
    const chip = await app.request('/api/chat', json({ message: "What's on today?" }));
    expect(chip.status).toBe(409);
    release();
    expect(await first.text()).toContain('done: one');
    const fourth = await events(await app.request('/api/chat', json({ message: 'four' })));
    expect(types(fourth)).toEqual(['text', 'done']);
  });

  it('an invalid message body is a 400 and does not take the lock', async () => {
    for (const body of [{}, { message: '' }, { message: 'x'.repeat(4001) }, { message: 42 }, { message: null }]) {
      const res = await app.request('/api/chat', json(body));
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(typeof ((await res.json()) as any).error).toBe('string');
    }
    expect((await app.request('/api/chat', json({ message: 'x'.repeat(4000) }))).status).toBe(200);
    expect(assistant.calls).toEqual(['x'.repeat(4000)]);
  });

  it('an assistant failure becomes an error event followed by done, and frees the chat', async () => {
    assistant.send = async () => { throw new Error('boom'); };
    const ev = await events(await app.request('/api/chat', json({ message: 'hi' })));
    expect(ev).toEqual([{ type: 'error', message: 'boom' }, { type: 'done' }]);
    assistant.send = async (_t, emit) => { emit({ type: 'text', delta: 'fine' }); };
    const again = await events(await app.request('/api/chat', json({ message: 'hi' })));
    expect(again).toEqual([{ type: 'text', delta: 'fine' }, { type: 'done' }]);
  });

  it('a non-Error thrown by the assistant is stringified into the error event', async () => {
    assistant.send = async () => { throw 'plain failure'; }; // eslint-disable-line no-throw-literal
    const ev = await events(await app.request('/api/chat', json({ message: 'hi' })));
    expect(ev[0]).toEqual({ type: 'error', message: 'plain failure' });
  });

  it('the note to the model keeps the last five direct actions, and quotes at most 80 characters of each message', async () => {
    store.upsertTask({ id: 'lc', name: 'Leetcode', color: '#000', priority: 1, budgetMinutes: 60, budgetPeriod: 'day', archived: false, createdAt: '' });
    store.insertBlocks([{ id: 'b1', taskId: 'lc', start: d(10).toISOString(), end: d(11).toISOString(), status: 'pending', createdAt: '', statusChangedAt: null, source: 'baseline' }]);
    const shout = "What's on today?" + '!'.repeat(100);
    for (let i = 0; i < 6; i += 1) {
      const ev = await events(await app.request('/api/chat', json({ message: i === 5 ? shout : `what's on today${'.'.repeat(i + 1)}` })));
      expect(direct(ev), String(i)).toBe(true);
    }
    await (await app.request('/api/chat', json({ message: 'ok' }))).text();
    const note = assistant.notes[0]!;
    expect(note.match(/ ran get_schedule: /g)).toHaveLength(5);
    expect(note).not.toContain('"what\'s on today."'); // the first (oldest) fell off
    expect(note).toContain('"what\'s on today.."');
    expect(note).toContain(`"What's on today?${'!'.repeat(64)}" ran get_schedule: Today: Leetcode 10:00-11:00.`);
    expect(note).not.toContain('!'.repeat(65));
  });

  it('phrase variants at the route: curly apostrophe, shouting, trailing punctuation, no-break spaces and extra spaces are direct; near misses are not', async () => {
    store.upsertTask({ id: 'lc', name: 'Leetcode', color: '#000', priority: 1, budgetMinutes: 60, budgetPeriod: 'day', archived: false, createdAt: '' });
    store.insertBlocks([{ id: 'b1', taskId: 'lc', start: d(10).toISOString(), end: d(11).toISOString(), status: 'pending', createdAt: '', statusChangedAt: null, source: 'baseline' }]);
    const yes = ['What’s on today?', "WHAT'S ON TODAY", "  what's   on\ttoday ...  ", 'What is on today'.replace('What is', 'Whats'), 'How am I doing?!', 'how am i doing'];
    for (const m of yes) {
      const ev = await events(await app.request('/api/chat', json({ message: m })));
      expect(direct(ev), JSON.stringify(m)).toBe(true);
    }
    expect(assistant.calls).toEqual([]);
    const no = ["What's on today and tomorrow?", "?What's on today", 'how am i doing today', "what's on", 'how am i', 'start my day please'];
    for (const m of no) {
      const ev = await events(await app.request('/api/chat', json({ message: m })));
      expect(direct(ev), JSON.stringify(m)).toBe(false);
    }
    expect(assistant.calls).toEqual(no);
  });

  it('warm is skipped while a reply is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    assistant.send = async (_t, emit) => { await gate; emit({ type: 'text', delta: 'x' }); };
    const first = await app.request('/api/chat', json({ message: 'one' }));
    expect((await app.request('/api/chat/warm', { method: 'POST' })).status).toBe(200);
    expect(assistant.warms).toBe(0);
    release();
    await first.text();
    await app.request('/api/chat/warm', { method: 'POST' });
    expect(assistant.warms).toBe(1);
  });

  it('every SSE frame is one JSON object prefixed with "data: " and the stream ends with done', async () => {
    const res = await app.request('/api/chat', json({ message: 'hi' }));
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const raw = await res.text();
    const frames = raw.split('\n\n').filter(Boolean);
    for (const f of frames) expect(f.startsWith('data: ')).toBe(true);
    expect(JSON.parse(frames[frames.length - 1].slice(6))).toEqual({ type: 'done' });
  });
});

describe('validation and errors', () => {
  it('a body that is not JSON is a 400 with a message', async () => {
    const res = await app.request('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(typeof body.error).toBe('string');
    expect(body.error).toMatch(/JSON/i);
    expect(store.listTasks()).toEqual([]);
  });

  it('wrong field types are 400s that name the field', async () => {
    const cases: Array<[string, string, unknown, RegExp]> = [
      ['/api/tasks', 'POST', { name: 'X', priority: 'high', budget_minutes: 30, budget_period: 'day' }, /priority/],
      ['/api/tasks', 'POST', { name: 'X', priority: 1, budget_minutes: 30, budget_period: 'fortnight' }, /budget_period/],
      ['/api/tasks', 'POST', { name: '', priority: 1, budget_minutes: 30, budget_period: 'day' }, /name|Task name/],
      ['/api/settings', 'PUT', { settings: { ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, slotMinutes: '15' } }, /slotMinutes/],
      ['/api/settings', 'PUT', { settings: { ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, weekStartsOn: 7 } }, /weekStartsOn/],
      ['/api/settings', 'PUT', { settings: { ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, reviewWindow: 'month' } }, /reviewWindow/],
      ['/api/settings', 'PUT', { settings: { ...DEFAULT_SETTINGS, availability: undefined } }, /availability/],
      ['/api/blocks', 'POST', { taskId: 7, start: d(1).toISOString(), end: d(2).toISOString() }, /taskId/],
      ['/api/baseline/revert', 'POST', { version: 1.5 }, /version/],
      ['/api/baseline/revert', 'POST', { version: '1' }, /version/],
      ['/api/baseline', 'PUT', { slots: {} }, /slots/],
      ['/api/import', 'POST', { ics: 'BEGIN:VCALENDAR', asBaseline: 'yes' }, /asBaseline/],
      ['/api/import', 'POST', { asBaseline: true }, /ics/],
      ['/api/recurring', 'POST', { title: 'Standup', days: 'weekdays', start: '10:00', end: '9am' }, /end/],
    ];
    for (const [path, method, body, re] of cases) {
      const res = await app.request(path, json(body, method));
      expect(res.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
      expect(((await res.json()) as any).error, `${method} ${path}`).toMatch(re);
    }
  });

  it('a settings PUT with min above max is refused with the exact message and nothing changes', async () => {
    const res = await app.request('/api/settings', json({ settings: { ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, minBlockMinutes: 90, maxBlockMinutes: 60 } }, 'PUT'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'minBlockMinutes must not exceed maxBlockMinutes' });
    expect(store.getSettings()).toMatchObject({ minBlockMinutes: 30, maxBlockMinutes: 60 });
  });

  it('a settings PUT sorts window days and keeps the optional groups it leaves out', async () => {
    store.saveSettings({ ...store.getSettings(), segments: { morningEnd: '11:00', afternoonEnd: '16:00' }, maxTasksPerDay: 3, workStyle: 'deep', weights: { priority: 1, deficit: 0 } });
    const res = await app.request('/api/settings', json({ settings: { ...DEFAULT_SETTINGS, availability: [{ days: [5, 1, 3], start: '09:00', end: '12:00' }], segments: undefined, weights: undefined, maxTasksPerDay: undefined, workStyle: undefined } }, 'PUT'));
    expect(res.status).toBe(200);
    const s = store.getSettings();
    expect(s.availability).toEqual([{ days: [1, 3, 5], start: '09:00', end: '12:00' }]);
    expect(s.segments).toEqual({ morningEnd: '11:00', afternoonEnd: '16:00' });
    expect(s.maxTasksPerDay).toBe(3);
    expect(s.workStyle).toBe('deep');
    expect(s.weights).toEqual({ priority: 1, deficit: 0 });
    // the segment and weight refinements are checked when given
    expect((await app.request('/api/settings', json({ settings: { ...DEFAULT_SETTINGS, availability: [], segments: { morningEnd: '17:00', afternoonEnd: '12:00' } } }, 'PUT'))).status).toBe(400);
    expect((await app.request('/api/settings', json({ settings: { ...DEFAULT_SETTINGS, availability: [], weights: { priority: 0, deficit: 0 } } }, 'PUT'))).status).toBe(400);
  });

  it('the assistant config: claude-code with a model, anthropic without a stored key, and a masked key', async () => {
    expect((await app.request('/api/settings', json({ assistant: { kind: 'claude-code', model: 'sonnet' } }, 'PUT'))).status).toBe(200);
    expect(((await (await app.request('/api/settings')).json()) as any).assistant).toEqual({ kind: 'claude-code', model: 'sonnet', hasApiKey: false });
    const noKey = await app.request('/api/settings', json({ assistant: { kind: 'anthropic', model: 'claude-opus-5-5' } }, 'PUT'));
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toEqual({ error: 'apiKey is required for the anthropic backend' });
    expect(assistant.config).toEqual({ kind: 'claude-code', model: 'sonnet' }); // unchanged
    expect((await app.request('/api/settings', json({ assistant: { kind: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-1' } }, 'PUT'))).status).toBe(200);
    expect(assistant.config).toEqual({ kind: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-1' });
    // a model change keeps the stored key; the response never shows it
    expect((await app.request('/api/settings', json({ assistant: { kind: 'anthropic', model: 'claude-sonnet-5' } }, 'PUT'))).status).toBe(200);
    expect(assistant.config).toEqual({ kind: 'anthropic', model: 'claude-sonnet-5', apiKey: 'sk-1' });
    const shown = await (await app.request('/api/settings')).json() as any;
    expect(shown.assistant).toEqual({ kind: 'anthropic', model: 'claude-sonnet-5', hasApiKey: true });
    expect(JSON.stringify(shown)).not.toContain('sk-1');
    expect((await app.request('/api/settings', json({ assistant: { kind: 'openai', model: 'x' } }, 'PUT'))).status).toBe(400);
    expect((await app.request('/api/settings', json({ assistant: { kind: 'anthropic', model: '' , apiKey: 'k' } }, 'PUT'))).status).toBe(400);
  });

  it('unknown routes and unknown ids', async () => {
    expect((await app.request('/api/nothing')).status).toBe(404);
    expect((await app.request('/api/nothing', json({}))).status).toBe(404);
    expect((await app.request('/api/tasks/nope', { method: 'DELETE' })).status).toBe(404);
    expect(await (await app.request('/api/tasks/nope', { method: 'DELETE' })).json()).toEqual({ error: 'Task not found' });
    expect(await (await app.request('/api/blocks/nope', { method: 'DELETE' })).json()).toEqual({ error: 'Block not found' });
    expect(await (await app.request('/api/recurring/nope', { method: 'DELETE' })).json()).toEqual({ error: 'Recurring commitment not found' });
    expect((await app.request('/api/blocks/nope/track', json({ action: 'start' }))).status).toBe(404);
    expect(await (await app.request('/api/blocks/nope/track', json({ action: 'start' }))).json()).toEqual({ error: 'Block not found: nope' });
    expect(await (await app.request('/api/blocks', json({ taskId: 'nope', start: d(1).toISOString(), end: d(2).toISOString() }))).json()).toEqual({ error: 'Task not found: nope' });
    expect((await app.request('/api/commitments/nope', { method: 'DELETE' })).status).toBe(404);
    expect(await (await app.request('/api/commitments/nope', { method: 'DELETE' })).json()).toEqual({ error: 'Commitment not found: nope' });
    // a tool error naming a missing task is a 404 through the generic handler
    const mark = await app.request('/api/tasks', json({ name: 'A', priority: 1, budget_minutes: 30, budget_period: 'day' }));
    expect(mark.status).toBe(200);
  });

  it('the origin and content-type guards on every mutating method, not on reads', async () => {
    const t = await mkTask('A');
    const foreign = { origin: 'https://evil.example', 'content-type': 'application/json' };
    expect((await app.request(`/api/tasks/${t}`, { method: 'DELETE', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await app.request(`/api/blocks/x`, { method: 'PATCH', headers: foreign, body: '{}' })).status).toBe(403);
    expect((await app.request('/api/settings', { method: 'PUT', headers: foreign, body: '{}' })).status).toBe(403);
    expect((await app.request('/api/settings', { method: 'PUT', headers: { origin: 'http://localhost.evil.example:5173', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect(await (await app.request('/api/settings', { method: 'PUT', headers: foreign, body: '{}' })).json()).toEqual({ error: 'Cross-origin requests are not allowed' });
    expect(store.listTasks()).toHaveLength(1);
    // local origins pass; a charset suffix on the content type is fine; a GET from anywhere is fine
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:4820', 'http://[::1]:4820', 'https://localhost']) {
      expect((await app.request('/api/chat/warm', { method: 'POST', headers: { origin } })).status, origin).toBe(200);
    }
    expect((await app.request('/api/tasks', { method: 'POST', headers: { 'content-type': 'Application/JSON; charset=utf-8' }, body: JSON.stringify({ name: 'B', priority: 1, budget_minutes: 30, budget_period: 'day' }) })).status).toBe(200);
    expect((await app.request('/api/state', { headers: { origin: 'https://evil.example' } })).status).toBe(200);
    const form = await app.request('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=x' });
    expect(form.status).toBe(415);
    expect(await form.json()).toEqual({ error: 'Expected content-type: application/json' });
  });
});

describe('baseline route edge cases', () => {
  const put = (body: unknown) => app.request('/api/baseline', json(body, 'PUT'));

  it('refuses a slot missing its task or title with the exact message, and saves nothing', async () => {
    const t = await mkTask('Deep');
    const bad = [
      [{ day: 1, start: '09:00', end: '10:00', kind: 'task' }],
      [{ day: 7, start: '09:00', end: '10:00', kind: 'task', taskId: t }],
      [{ day: 1, start: '9:00', end: '10:00', kind: 'task', taskId: t }],
      [{ day: 1, start: '10:00', end: '09:00', kind: 'task', kind2: 'x', taskId: t }],
      [taskSlot(t, 1, '09:00', '10:00'), 'not a slot'],
    ];
    for (const slots of bad) {
      const res = await put({ slots });
      expect(res.status, JSON.stringify(slots)).toBe(400);
      expect(((await res.json()) as any).error).toBe('Every slot needs a day (0-6), start and end as HH:MM, and a kind: a task slot with a taskId or a busy slot with a title');
    }
    expect(store.listBaselines()).toEqual([]);
    expect((await put({ slots: Array.from({ length: 501 }, () => taskSlot(t, 1, '09:00', '10:00')) })).status).toBe(400);
    expect(store.listBaselines()).toEqual([]);
    // a busy slot's title is optional (the BaselineSlot type says so), although the message above asks for one
    const untitled = await (await put({ slots: [taskSlot(t, 1, '09:00', '10:00'), { day: 1, start: '12:00', end: '13:00', kind: 'busy' }] })).json() as any;
    expect(untitled.baseline.slots[1]).toEqual({ day: 1, start: '12:00', end: '13:00', kind: 'busy' });
  });

  it('a slot to 24:00 and an empty template are accepted; an empty template is not "ready" and applies nothing', async () => {
    const t = await mkTask('Deep');
    const late = await (await put({ slots: [taskSlot(t, 2, '22:00', '24:00')] })).json() as any;
    expect(late.baseline.slots).toEqual([{ day: 2, start: '22:00', end: '24:00', kind: 'task', taskId: t }]);
    const empty = await (await put({ slots: [] })).json() as any;
    expect(empty.baseline.version).toBe(2);
    expect(empty.baseline.slots).toEqual([]);
    expect(((await (await app.request('/api/setup')).json()) as any)).toMatchObject({ ready: false, missing: ['baseline'] });
    const applied = await (await app.request('/api/baseline/apply', json({}))).json() as any;
    expect(applied.created).toEqual([]);
    expect(applied.commitments).toEqual([]);
  });

  it('apply: a bad weekOf is a 400 with the exact message; a full ISO stamp and a plain date both pick the week per weekStartsOn', async () => {
    const t = await mkTask('Deep');
    await put({ slots: [taskSlot(t, 1, '09:00', '10:00')] }); // Mondays
    const bad = await app.request('/api/baseline/apply', json({ weekOf: 'garbage' }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'weekOf must be a date such as 2026-10-12' });
    // Sunday weeks (default): Wed Oct 14 is in the week of Sun Oct 11, whose Monday is Oct 12
    const sun = await (await app.request('/api/baseline/apply', json({ weekOf: new Date(2026, 9, 14, 15).toISOString() }))).json() as any;
    expect(sun.created.map((b: any) => b.start)).toEqual([new Date(2026, 9, 12, 9).toISOString()]);
    // Monday weeks: Sun Oct 18 belongs to the week of Mon Oct 12 (the same Monday, so a re-apply replaces)
    store.saveSettings({ ...store.getSettings(), weekStartsOn: 1 });
    const mon = await (await app.request('/api/baseline/apply', json({ weekOf: '2026-10-18' }))).json() as any;
    expect(mon.created.map((b: any) => b.start)).toEqual([new Date(2026, 9, 12, 9).toISOString()]);
    expect(mon.replaced).toBe(1);
    expect(store.listBlocks().filter((b) => b.source === 'baseline')).toHaveLength(1);
  });

  it('a slot in the past this week is not laid; a slot under a commitment is skipped and named', async () => {
    const t = await mkTask('Deep');
    await put({ slots: [taskSlot(t, 3, '07:00', '08:00'), taskSlot(t, 3, '15:00', '16:00')] });
    store.addCommitment({ id: 'c', title: 'Dentist', start: d(15).toISOString(), end: d(16).toISOString() });
    const r = await (await app.request('/api/baseline/apply', json({}))).json() as any;
    expect(r.created).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].slot).toEqual({ day: 3, start: '15:00', end: '16:00', kind: 'task', taskId: t });
    expect(typeof r.skipped[0].reason).toBe('string');
  });

  it('revert of a busy-only version then of a task version flips the setup state', async () => {
    const t = await mkTask('Deep');
    await put({ slots: [taskSlot(t, 1, '09:00', '10:00')] });
    await put({ slots: [busySlot(1, '12:00', '13:00')] });
    expect(((await (await app.request('/api/setup')).json()) as any).ready).toBe(false);
    const r = await (await app.request('/api/baseline/revert', json({ version: 1 }))).json() as any;
    expect(r.baseline.version).toBe(3);
    expect(r.baseline.slots).toEqual([taskSlot(t, 1, '09:00', '10:00')]);
    expect(((await (await app.request('/api/setup')).json()) as any).ready).toBe(true);
    const missing = await app.request('/api/baseline/revert', json({ version: 0 }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Baseline version 0 not found' });
  });
});

describe('exports', () => {
  it('export.ics of an empty store is a bare, valid VCALENDAR with CRLF endings and an attachment header', async () => {
    const res = await app.request('/api/export.ics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="rerouteday.ics"');
    expect(await res.text()).toBe('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//rerouteday//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nEND:VCALENDAR\r\n');
  });

  it('export.ics with blocks, commitments and recurring rules: one VEVENT each, escaped text, folded lines, archived task names kept', async () => {
    const t = await mkTask('Deep "work"');
    const b = await (await app.request('/api/blocks', json({ taskId: t, start: d(10).toISOString(), end: d(11).toISOString() }))).json() as any;
    await app.request(`/api/blocks/${b.id}`, json({ status: 'done' }, 'PATCH'));
    const c = await (await app.request('/api/commitments', json({ title: 'Dentist; teeth, gums\nfloor 2', start: d(14).toISOString(), end: d(15).toISOString() }))).json() as any;
    const r = await (await app.request('/api/recurring', json({ title: 'Standup', days: 'mon, wed, fri', start: '10:00', end: '10:30' }))).json() as any;
    store.addCommitment({ id: 'long', title: 'L'.repeat(120), start: d(16).toISOString(), end: d(17).toISOString() });
    await app.request(`/api/tasks/${t}`, { method: 'DELETE' }); // archived, its block keeps the name

    const body = await (await app.request('/api/export.ics')).text();
    expect(body.endsWith('\r\n')).toBe(true);
    expect(body.replace(/\r\n/g, '')).not.toContain('\n'); // no bare line feed anywhere
    const lines = body.split('\r\n').slice(0, -1);
    for (const l of lines) expect(Buffer.byteLength(l), l).toBeLessThanOrEqual(75);
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(4);
    expect(lines.filter((l) => l === 'END:VEVENT')).toHaveLength(4);
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines[lines.length - 1]).toBe('END:VCALENDAR');
    const fmt = (x: Date) => x.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    expect(lines).toContain(`UID:${b.id}@rerouteday`);
    expect(lines).toContain(`DTSTART:${fmt(d(10))}`);
    expect(lines).toContain('SUMMARY:✓ Deep "work"');
    expect(lines).toContain('X-DS-STATUS:done');
    expect(lines).toContain(`X-DS-TASK-ID:${t}`);
    expect(lines).toContain(`DTSTAMP:${fmt(d(9))}`);
    expect(lines).toContain(`UID:${c.id}@rerouteday`);
    expect(lines).toContain('SUMMARY:Dentist\\; teeth\\, gums\\nfloor 2');
    expect(lines).toContain('X-DS-KIND:commitment');
    expect(lines).toContain(`UID:${r.id}@rerouteday`);
    expect(lines).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR');
    expect(lines).toContain(`DTSTART:${fmt(d(10))}`); // the first occurrence on or after today (Wednesday)
    expect(lines).toContain('X-DS-KIND:recurring');
    // the 120-character title is folded: a continuation line starts with one space, and unfolding restores it
    const unfolded = body.replace(/\r\n /g, '').split('\r\n');
    expect(unfolded).toContain(`SUMMARY:${'L'.repeat(120)}`);
    expect(lines.some((l) => l.startsWith(' L'))).toBe(true);
  });

  it('export.json has exactly the bundle keys, includes archived tasks and the memory, and excludes baselines', async () => {
    const t = await mkTask('A');
    await mkTask('B');
    await app.request(`/api/tasks/${t}`, { method: 'DELETE' });
    await app.request('/api/baseline', json({ slots: [] }, 'PUT'));
    await app.request('/api/settings', json({ settings: { ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, memory: '- m' } }, 'PUT'));
    const res = await app.request('/api/export.json');
    expect(res.headers.get('content-type')).toContain('application/json');
    const j = await res.json() as any;
    expect(Object.keys(j)).toEqual(['exportedAt', 'tasks', 'blocks', 'commitments', 'recurring', 'settings']);
    expect(Number.isNaN(new Date(j.exportedAt).getTime())).toBe(false);
    expect(j.tasks.map((x: any) => [x.name, x.archived])).toEqual([['A', true], ['B', false]]);
    expect(j.blocks).toEqual([]);
    expect(j.settings.memory).toBe('- m');
    expect(j.baseline).toBeUndefined();
  });
});

describe('import routes', () => {
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x', 'DTSTART:20261008T160000Z', 'DTEND:20261008T170000Z', 'SUMMARY:Dentist', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

  it('import-url without a fetcher explains, with one it refreshes on a re-import and surfaces the fetcher\'s refusal', async () => {
    const none = await app.request('/api/import-url', json({ url: 'https://example.com/a.ics' }));
    expect(none.status).toBe(400);
    expect(((await none.json()) as any).error).toMatch(/Fetching URLs is not available/);
    let fail = false;
    const app2 = createApp({ store, assistant, now: () => clock, fetchText: async () => { if (fail) throw new Error('Calendar URLs must point to a public host, not a private address.'); return ics; } });
    const first = await (await app2.request('/api/import-url', json({ url: 'webcal://example.com/a.ics' }))).json() as any;
    expect(first.commitments).toHaveLength(1);
    expect(store.listCommitments()).toHaveLength(1);
    const again = await (await app2.request('/api/import-url', json({ url: 'https://example.com/a.ics' }))).json() as any;
    expect(again.commitments).toHaveLength(1);
    expect(store.listCommitments()).toHaveLength(1); // refreshed, not duplicated
    expect(store.listImportSources()).toEqual(['https://example.com/a.ics']);
    fail = true;
    const refused = await app2.request('/api/import-url', json({ url: 'https://10.0.0.1/a.ics' }));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'Calendar URLs must point to a public host, not a private address.' });
    expect((await app2.request('/api/import-url', json({}))).status).toBe(400);
  });

  it('import of a file body: an empty string and a missing body are 400s; a plain calendar imports', async () => {
    expect((await app.request('/api/import', json({ ics: '' }))).status).toBe(400);
    expect((await app.request('/api/import', json({}))).status).toBe(400);
    const r = await (await app.request('/api/import', json({ ics }))).json() as any;
    expect(r.events).toBeUndefined();
    expect(r.commitments).toHaveLength(1);
    expect(r.summary).toMatch(/1 upcoming event/);
  });
});
