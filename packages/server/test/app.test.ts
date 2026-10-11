import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, DEFAULT_SETTINGS, STANDARD_WEEK } from '@ds/core';
import { createApp } from '../src/app.js';
import { SqliteStore } from '../src/db.js';
import type { AssistantConfig, AssistantManager, Emit } from '../src/assistant/types.js';

class KvMemoryStore extends MemoryStore {
  kv = new Map<string, unknown>();
  getJson<T>(key: string) { return this.kv.get(key) as T | undefined; }
  setJson(key: string, value: unknown) { this.kv.set(key, value); }
}

class FakeAssistant implements AssistantManager {
  config: AssistantConfig = { kind: 'claude-code' };
  resets = 0;
  async send(text: string, emit: Emit, _signal?: AbortSignal, _note?: string) {
    emit({ type: 'text', delta: `echo: ${text}` });
    emit({ type: 'tool_call', id: '1', name: 'get_now', input: {} });
    emit({ type: 'tool_result', id: '1', name: 'get_now', result: { ok: true } });
  }
  reset() { this.resets += 1; }
  warms = 0;
  warm() { this.warms += 1; }
  getConfig() { return this.config; }
  setConfig(c: AssistantConfig) { this.config = c; }
}

const d = (h: number, m = 0) => new Date(2026, 9, 7, h, m);
let store: KvMemoryStore;
let assistant: FakeAssistant;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new KvMemoryStore();
  store.saveSettings({ ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, maxBlockMinutes: 60, minBlockMinutes: 30, slotMinutes: 15 });
  assistant = new FakeAssistant();
  app = createApp({ store, assistant, now: () => d(9) });
});

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('api', () => {
  it('creates tasks, plans, patches blocks, and reports state', async () => {
    const t = await (await app.request('/api/tasks', json({ name: 'Deep', priority: 1, budget_minutes: 60, budget_period: 'day' }))).json() as any;
    expect(t.id).toBeTruthy();

    const planned = await (await app.request('/api/plan', json({}))).json() as any;
    expect(planned.created.length).toBe(1);

    const state = await (await app.request(`/api/state?from=${d(0).toISOString()}&to=${d(23).toISOString()}`)).json() as any;
    expect(state.blocks.length).toBe(1);
    expect(state.blocks[0].taskName).toBe('Deep');
    expect(state.tasks.length).toBe(1);

    const id = state.blocks[0].id;
    const done = await (await app.request(`/api/blocks/${id}`, { ...json({ status: 'done' }), method: 'PATCH' })).json() as any;
    expect(done.status).toBe('done');
    const moved = await (await app.request(`/api/blocks/${id}`, { ...json({ start: d(13).toISOString(), end: d(14).toISOString() }), method: 'PATCH' })).json() as any;
    expect(moved.start).toBe(d(13).toISOString());

    const bad = await app.request(`/api/blocks/${id}`, { ...json({ start: d(14).toISOString(), end: d(13).toISOString() }), method: 'PATCH' });
    expect(bad.status).toBe(400);
    const missing = await app.request('/api/blocks/nope', { ...json({ status: 'done' }), method: 'PATCH' });
    expect(missing.status).toBe(404);

    // A note on the block: the user's words, kept with the block; an empty note clears it; over 2000 characters is refused.
    const noted = await (await app.request(`/api/blocks/${id}`, { ...json({ note: '  did it, not focused ' }), method: 'PATCH' })).json() as any;
    expect(noted.note).toBe('did it, not focused');
    expect(noted.status).toBe('done');
    const inState = await (await app.request(`/api/state?from=${d(0).toISOString()}&to=${d(23).toISOString()}`)).json() as any;
    expect(inState.blocks[0].note).toBe('did it, not focused');
    const cleared = await (await app.request(`/api/blocks/${id}`, { ...json({ note: '' }), method: 'PATCH' })).json() as any;
    expect(cleared.note ?? null).toBeNull();
    const tooLong = await app.request(`/api/blocks/${id}`, { ...json({ note: 'x'.repeat(2001) }), method: 'PATCH' });
    expect(tooLong.status).toBe(400);

    const del = await app.request(`/api/blocks/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(store.getBlock(id)).toBeUndefined();
  });

  it('tracks actual time on a block: start, pause, finish and set, persisted across a store reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-track-'));
    const file = join(dir, 'ds.sqlite');
    try {
      const sqlite = new SqliteStore(file);
      sqlite.saveSettings({ ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, maxBlockMinutes: 60, minBlockMinutes: 30, slotMinutes: 15 });
      let clock = d(9);
      const tapp = createApp({ store: sqlite, assistant, now: () => clock });
      const t = await (await tapp.request('/api/tasks', json({ name: 'Deep', priority: 1, budget_minutes: 60, budget_period: 'day' }))).json() as any;
      const b = await (await tapp.request('/api/blocks', json({ taskId: t.id, start: d(10).toISOString(), end: d(11).toISOString() }))).json() as any;
      const track = (id: string, body: unknown) => tapp.request(`/api/blocks/${id}/track`, json(body));

      // the evening before, the block is on another day: Finish is refused until started; Start runs the clock where the block is and records the actual start
      clock = new Date(2026, 9, 6, 20);
      expect((await track(b.id, { action: 'finish' })).status).toBe(400);
      expect(((await (await track(b.id, { action: 'finish' })).json()) as any).error).toMatch(/not today/);
      const early = await (await track(b.id, { action: 'start' })).json() as any;
      expect(early.block.start).toBe(d(10).toISOString());
      expect(early.block.end).toBe(d(11).toISOString());
      expect(early.block.startedAt).toBe(new Date(2026, 9, 6, 20).toISOString());
      expect(sqlite.getBlock(b.id)!.runningSince).toBe(new Date(2026, 9, 6, 20).toISOString());
      expect(sqlite.getBlock(b.id)!.startedAt).toBe(new Date(2026, 9, 6, 20).toISOString());
      // changed their mind: Reset undoes the start (clock, minutes and start time cleared), the block stays where it was
      clock = new Date(2026, 9, 6, 20, 5);
      const reset = await (await tapp.request(`/api/blocks/${b.id}`, { ...json({ status: 'pending' }), method: 'PATCH' })).json() as any;
      expect(reset.status).toBe('pending'); expect(reset.runningSince ?? null).toBeNull(); expect(reset.startedAt ?? null).toBeNull(); expect(reset.trackedMinutes ?? null).toBeNull();
      expect(sqlite.getBlock(b.id)!.start).toBe(d(10).toISOString());

      clock = d(9, 50);
      const started = await (await track(b.id, { action: 'start' })).json() as any;
      expect(started.block.runningSince).toBe(d(9, 50).toISOString());
      expect(started.block.taskName).toBe('Deep');
      expect(started.paused).toEqual([]);

      clock = d(10, 20);
      const paused = await (await track(b.id, { action: 'pause' })).json() as any;
      expect(paused.block.trackedMinutes).toBe(30);
      expect(paused.block.runningSince).toBeNull();
      expect(paused.elapsedMinutes).toBe(paused.block.trackedMinutes);

      const set = await (await track(b.id, { action: 'set', minutes: 45 })).json() as any;
      expect(set.block.trackedMinutes).toBe(45);

      const finished = await (await track(b.id, { action: 'finish' })).json() as any;
      expect(finished.block.status).toBe('done');
      expect(finished.block.plannedMinutes).toBe(60);
      expect(finished.block.trackedMinutes).toBe(45);

      expect((await track(b.id, { action: 'set', minutes: -5 })).status).toBe(400);
      expect((await track(b.id, { action: 'nope' })).status).toBe(400);
      expect((await track('nope', { action: 'start' })).status).toBe(404);

      sqlite.close();
      const reopened = new SqliteStore(file);
      const again = reopened.getBlock(b.id)!;
      expect(again.trackedMinutes).toBe(45);
      expect(again.plannedMinutes).toBe(60);
      expect(again.runningSince ?? null).toBeNull();
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('moving a block through the API marks it manual so re-planning keeps it', async () => {
    const t = await (await app.request('/api/tasks', json({ name: 'Deep', priority: 1, budget_minutes: 60, budget_period: 'day' }))).json() as any;
    const planned = await (await app.request('/api/plan', json({}))).json() as any;
    const id = planned.created[0].id;
    const moved = await (await app.request(`/api/blocks/${id}`, { ...json({ start: d(13).toISOString(), end: d(14).toISOString() }), method: 'PATCH' })).json() as any;
    expect(moved.source).toBe('manual');
    const again = await (await app.request('/api/plan', json({}))).json() as any;
    expect(again.removed).toBe(0);
    expect(store.getBlock(id)).toBeTruthy();
    expect(t.id).toBeTruthy();
  });

  it('creates a block by hand', async () => {
    const t = await (await app.request('/api/tasks', json({ name: 'Deep', priority: 1, budget_minutes: 60, budget_period: 'day' }))).json() as any;
    const b = await (await app.request('/api/blocks', json({ taskId: t.id, start: d(13).toISOString(), end: d(14).toISOString() }))).json() as any;
    expect(b.taskName).toBe('Deep');
    expect(b.status).toBe('pending');
    expect((await app.request('/api/blocks', json({ taskId: 'nope', start: d(13).toISOString(), end: d(14).toISOString() }))).status).toBe(404);
  });

  it('manages commitments and archives tasks', async () => {
    const c = await (await app.request('/api/commitments', json({ title: 'Standup', start: d(10).toISOString(), end: d(10, 30).toISOString() }))).json() as any;
    expect(c.id).toBeTruthy();
    expect((await app.request(`/api/commitments/${c.id}`, { method: 'DELETE' })).status).toBe(200);
    const t = await (await app.request('/api/tasks', json({ name: 'X', priority: 1, budget_minutes: 30, budget_period: 'day' }))).json() as any;
    expect((await app.request(`/api/tasks/${t.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(store.listTasks()).toEqual([]);
  });

  it('exports ics and json', async () => {
    const ics = await app.request('/api/export.ics');
    expect(ics.headers.get('content-type')).toContain('text/calendar');
    expect(await ics.text()).toContain('BEGIN:VCALENDAR');
    const j = await (await app.request('/api/export.json')).json() as any;
    expect(j.settings).toBeTruthy();
  });

  it('masks the api key in settings', async () => {
    const put = await app.request('/api/settings', { ...json({ assistant: { kind: 'anthropic', apiKey: 'sk-secret', model: 'claude-opus-5-5' } }), method: 'PUT' });
    expect(put.status).toBe(200);
    const got = await (await app.request('/api/settings')).json() as any;
    expect(got.assistant).toEqual({ kind: 'anthropic', model: 'claude-opus-5-5', hasApiKey: true });
    expect(JSON.stringify(got)).not.toContain('sk-secret');
    const put2 = await app.request('/api/settings', { ...json({ settings: { ...DEFAULT_SETTINGS, availability: STANDARD_WEEK, slotMinutes: 30 } }), method: 'PUT' });
    expect(put2.status).toBe(200);
    expect(store.getSettings().slotMinutes).toBe(30);
    const bad = await app.request('/api/settings', { ...json({ assistant: { kind: 'anthropic', model: 'x' } }), method: 'PUT' });
    expect(bad.status).toBe(200); // key already stored, so omitting it keeps the old one
    assistant.config = { kind: 'claude-code' };
    const bad2 = await app.request('/api/settings', { ...json({ assistant: { kind: 'anthropic', model: 'x' } }), method: 'PUT' });
    expect(bad2.status).toBe(400);
  });

  it('rejects mutating requests that are not JSON or come from a foreign origin', async () => {
    const plain = await app.request('/api/tasks', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"name":"x","priority":1,"budget_minutes":30,"budget_period":"day"}' });
    expect(plain.status).toBe(415);
    const foreign = await app.request('/api/chat', { ...json({ message: 'hi' }), headers: { 'content-type': 'application/json', origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
    const local = await app.request('/api/chat/reset', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' } });
    expect(local.status).toBe(200);
    expect(store.listTasks()).toEqual([]);
  });

  it('accepts an empty template but rejects malformed windows', async () => {
    const empty = await app.request('/api/settings', { ...json({ settings: { ...DEFAULT_SETTINGS, availability: [] } }), method: 'PUT' });
    expect(empty.status).toBe(200);
    const inverted = await app.request('/api/settings', { ...json({ settings: { ...DEFAULT_SETTINGS, availability: [{ days: [1], start: '18:00', end: '09:00' }] } }), method: 'PUT' });
    expect(inverted.status).toBe(400);
    const noDays = await app.request('/api/settings', { ...json({ settings: { ...DEFAULT_SETTINGS, availability: [{ days: [], start: '09:00', end: '18:00' }] } }), method: 'PUT' });
    expect(noDays.status).toBe(400);
  });

  it('exposes setup status and recurring occurrences in state', async () => {
    const before = await (await app.request(`/api/state?from=${d(0).toISOString()}&to=${d(23).toISOString()}`)).json() as any;
    expect(before.setup).toMatchObject({ ready: false, missing: ['baseline'] });
    const rec = await (await app.request('/api/recurring', json({ title: 'Standup', days: 'weekdays', start: '10:00', end: '10:30' }))).json() as any;
    expect(rec.days).toEqual([1, 2, 3, 4, 5]);
    const state = await (await app.request(`/api/state?from=${d(0).toISOString()}&to=${d(23).toISOString()}`)).json() as any;
    expect(state.recurring).toEqual([{ recurringId: rec.id, title: 'Standup', start: d(10).toISOString(), end: d(10, 30).toISOString() }]);
    expect(state.recurringRules.length).toBe(1);
    expect((await app.request(`/api/recurring/${rec.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(store.listRecurring()).toEqual([]);
    const setup = await (await app.request('/api/setup')).json() as any;
    expect(setup.hasAvailability).toBe(true);
  });

  it('imports an ics file body and a url', async () => {
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x', 'DTSTART:20261008T160000Z', 'DTEND:20261008T170000Z', 'SUMMARY:Dentist', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const r = await (await app.request('/api/import', json({ ics }))).json() as any;
    expect(r.commitments.length).toBe(1);
    expect(store.listCommitments().length).toBe(1);
    const fetched: string[] = [];
    const app2 = createApp({ store, assistant, now: () => d(9), fetchText: async (u) => { fetched.push(u); return ics; } });
    const r2 = await (await app2.request('/api/import-url', json({ url: 'webcal://example.com/a.ics' }))).json() as any;
    expect(fetched).toEqual(['https://example.com/a.ics']);
    expect(r2.summary).toMatch(/1 upcoming event/);
    const bad = await app2.request('/api/import-url', json({ url: 'ftp://x' }));
    expect(bad.status).toBe(400);
  });

  it('an import as baseline with no routine in it is a 400 with the reason, and nothing is saved', async () => {
    const ev = (date: string, title: string) => ['BEGIN:VEVENT', `UID:${date}`, `DTSTART:${date}T090000`, `DTEND:${date}T100000`, `SUMMARY:${title}`, 'END:VEVENT'].join('\r\n');
    const ics = ['BEGIN:VCALENDAR', ev('20260914', 'A'), ev('20260921', 'B'), ev('20260928', 'C'), ev('20261005', 'D'), 'END:VCALENDAR'].join('\r\n');
    const res = await app.request('/api/import', json({ ics, asBaseline: true }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/^No routine to import: .*Export one typical week/);
    expect(store.getBaseline()).toBeUndefined();
    const empty = await app.request('/api/import', json({ ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR', asBaseline: true }));
    expect(empty.status).toBe(400);
  });

  it('imports an ics file or a url as the baseline week when asked', async () => {
    const ev = (uid: string, date: string) => ['BEGIN:VEVENT', `UID:${uid}`, `DTSTART:${date}T090000`, `DTEND:${date}T100000`, 'SUMMARY:Leetcode', 'END:VEVENT'].join('\r\n');
    const ics = ['BEGIN:VCALENDAR', ev('a', '20260928'), ev('b', '20261005'), 'END:VCALENDAR'].join('\r\n');
    const r = await (await app.request('/api/import', json({ ics, asBaseline: true }))).json() as any;
    expect(r.baseline.version).toBe(1);
    expect(r.baseline.slots).toEqual([{ day: 1, start: '09:00', end: '10:00', kind: 'task', taskId: r.tasks.created[0].id }]);
    expect(r.tasks.created.map((t: any) => t.name)).toEqual(['Leetcode']);
    expect(r.summary).toMatch(/Leetcode/);
    expect(store.listCommitments()).toEqual([]);
    const app2 = createApp({ store, assistant, now: () => d(9), fetchText: async () => ics });
    const r2 = await (await app2.request('/api/import-url', json({ url: 'https://example.com/a.ics', asBaseline: true }))).json() as any;
    expect(r2.baseline.version).toBe(2);
    expect(r2.tasks.matched.map((t: any) => t.name)).toEqual(['Leetcode']);
    expect(store.listCommitments()).toEqual([]);
  });

  it('reports an unmarked past block as missed in state', async () => {
    const t = await (await app.request('/api/tasks', json({ name: 'A', priority: 1, budget_minutes: 60, budget_period: 'day' }))).json() as any;
    store.insertBlocks([{ id: 'old', taskId: t.id, start: d(7).toISOString(), end: d(8).toISOString(), status: 'pending', createdAt: '', statusChangedAt: null }]);
    const state = await (await app.request(`/api/state?from=${d(0).toISOString()}&to=${d(23).toISOString()}`)).json() as any;
    expect(state.blocks[0].status).toBe('missed');
  });

  it('refuses a second chat message while one is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    assistant.send = async (text, emit) => { await gate; emit({ type: 'text', delta: `done: ${text}` }); };
    const first = app.request('/api/chat', json({ message: 'one' }));
    await new Promise((r) => setTimeout(r, 10));
    const second = await app.request('/api/chat', json({ message: 'two' }));
    expect(second.status).toBe(409);
    expect(((await second.json()) as any).error).toMatch(/in progress/i);
    release();
    const res = await first;
    expect(await res.text()).toContain('done: one');
    const third = await app.request('/api/chat', json({ message: 'three' }));
    expect(third.status).toBe(200);
    await third.text();
  });

  it('a reset during a reply frees the chat, and that stale reply ending later does not free a newer one', async () => {
    const gates: Array<() => void> = [];
    assistant.send = async (text, emit) => { await new Promise<void>((r) => gates.push(r)); emit({ type: 'text', delta: `done: ${text}` }); };
    const first = app.request('/api/chat', json({ message: 'one' }));
    await new Promise((r) => setTimeout(r, 10));
    await app.request('/api/chat/reset', { method: 'POST' });
    const second = app.request('/api/chat', json({ message: 'two' }));
    await new Promise((r) => setTimeout(r, 10));
    gates[0](); // the stale first reply ends now
    await (await first).text();
    const third = await app.request('/api/chat', json({ message: 'three' }));
    expect(third.status).toBe(409); // the second reply is still in flight
    gates[1]();
    expect(await (await second).text()).toContain('done: two');
    const fourth = await app.request('/api/chat', json({ message: 'four' }));
    expect(fourth.status).toBe(200);
    gates[2]();
    await fourth.text();
  });

  it('warms the assistant on request (the chat panel opening), so the first message does not wait for it to start', async () => {
    expect((await app.request('/api/chat/warm', { method: 'POST' })).status).toBe(200);
    expect(assistant.warms).toBe(1);
  });

  it('streams chat events as SSE and resets', async () => {
    const res = await app.request('/api/chat', json({ message: 'hi' }));
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    const events = body.split('\n\n').filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, '')));
    expect(events.map((e) => e.type)).toEqual(['text', 'tool_call', 'tool_result', 'done']);
    expect((await app.request('/api/chat/reset', { method: 'POST' })).status).toBe(200);
    expect(assistant.resets).toBe(1);
  });
});

describe('direct actions in the chat route', () => {
  const events = async (res: Response) => (await res.text()).split('\n\n').filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, '')));
  const seedDay = () => {
    store.upsertTask({ id: 'lc', name: 'Leetcode', color: '#000', priority: 1, budgetMinutes: 60, budgetPeriod: 'day', archived: false, createdAt: '' });
    store.upsertTask({ id: 'bd', name: 'Building', color: '#000', priority: 2, budgetMinutes: 120, budgetPeriod: 'day', archived: false, createdAt: '' });
    store.insertBlocks([
      { id: 'b1', taskId: 'lc', start: d(8, 30).toISOString(), end: d(9, 30).toISOString(), status: 'pending', createdAt: '', statusChangedAt: null, source: 'baseline' },
      { id: 'b2', taskId: 'bd', start: d(10).toISOString(), end: d(12).toISOString(), status: 'pending', createdAt: '', statusChangedAt: null, source: 'baseline' },
    ]);
  };
  let calls: string[];
  beforeEach(() => {
    calls = [];
    const send = assistant.send.bind(assistant);
    assistant.send = async (text, emit) => { calls.push(text); await send(text, emit); };
  });

  it('runs the tool without the model for an exact chip phrase: tool row, the summary as the reply, a direct stats event', async () => {
    seedDay();
    const ev = await events(await app.request('/api/chat', json({ message: "I'm starting now." })));
    expect(calls).toEqual([]);
    expect(ev.map((e) => e.type)).toEqual(['tool_call', 'tool_result', 'text', 'stats', 'done']);
    expect(ev[0]).toMatchObject({ name: 'shift_day', input: {} });
    expect(ev[1]).toMatchObject({ id: ev[0].id, name: 'shift_day' });
    expect(ev[2].delta).toBe(ev[1].result.summary);
    expect(ev[2].delta).toMatch(/Leetcode|Shifted|shift/i);
    expect(ev[3].stats).toMatchObject({ direct: true });
    expect(store.getBlock('b1')!.start).toBe(d(9).toISOString()); // the day really shifted
  });

  it('answers "What\'s on today?" and "How am I doing?" from the read tools', async () => {
    seedDay();
    const sched = await events(await app.request('/api/chat', json({ message: "What's on today?" })));
    expect(sched.find((e) => e.type === 'text').delta).toBe('Today: Leetcode 08:30-09:30, Building 10:00-12:00.');
    const how = await events(await app.request('/api/chat', json({ message: 'How am I doing?' })));
    expect(how.find((e) => e.type === 'tool_call').name).toBe('get_summary');
    expect(how.find((e) => e.type === 'text').delta).toMatch(/0 of 180 min done/);
    expect(calls).toEqual([]);
  });

  it('a near match goes to the model unchanged', async () => {
    seedDay();
    const ev = await events(await app.request('/api/chat', json({ message: "I'm starting now, but skip Reading" })));
    expect(calls).toEqual(["I'm starting now, but skip Reading"]);
    expect(ev.some((e) => e.type === 'stats' && e.stats.direct)).toBe(false);
    expect(store.getBlock('b1')!.start).toBe(d(8, 30).toISOString());
  });

  it('a direct tool that fails (no baseline to apply) falls back to the model, which can explain', async () => {
    const ev = await events(await app.request('/api/chat', json({ message: 'Apply my baseline to this week' })));
    expect(calls).toEqual(['Apply my baseline to this week']);
    expect(ev.map((e) => e.type)).toEqual(['text', 'tool_call', 'tool_result', 'done']);
  });

  it('after a reply that ended with a question, an exact phrase goes to the model (it is probably the answer); otherwise it runs directly', async () => {
    seedDay();
    let reply = 'Move Leetcode to 10:00 and Building to 14:00. OK?';
    const send = assistant.send;
    assistant.send = async (text, emit) => { calls.push(text); emit({ type: 'text', delta: reply }); };
    await (await app.request('/api/chat', json({ message: 'adjust today' }))).text();
    const answer = await events(await app.request('/api/chat', json({ message: 'Start my day' })));
    expect(calls).toEqual(['adjust today', 'Start my day']);
    expect(answer.some((e) => e.type === 'stats' && e.stats.direct)).toBe(false);
    expect(store.getBlock('b1')!.start).toBe(d(8, 30).toISOString()); // nothing shifted
    reply = 'Done.';
    await (await app.request('/api/chat', json({ message: 'ok' }))).text();
    const direct = await events(await app.request('/api/chat', json({ message: 'Start my day' })));
    expect(direct.some((e) => e.type === 'stats' && e.stats.direct)).toBe(true);
    expect(calls).toHaveLength(3);
    // A new chat forgets the last question.
    reply = 'Anything else?';
    await (await app.request('/api/chat', json({ message: 'hm' }))).text();
    await app.request('/api/chat/reset', { method: 'POST' });
    const fresh = await events(await app.request('/api/chat', json({ message: "What's on today?" })));
    expect(fresh.some((e) => e.type === 'stats' && e.stats.direct)).toBe(true);
    assistant.send = send;
  });

  it('tells the model on its next turn what was done directly, once, as app-written context (not among the user\'s words); a new chat forgets it', async () => {
    seedDay();
    const notes: Array<string | undefined> = [];
    assistant.send = async (text, emit, _signal, note) => { calls.push(text); notes.push(note); emit({ type: 'text', delta: 'ok' }); };
    await (await app.request('/api/chat', json({ message: "I'm starting now" }))).text();
    await (await app.request('/api/chat', json({ message: 'undo that' }))).text();
    expect(calls).toEqual(['undo that']); // the user's words alone
    expect(notes[0]).toMatch(/^Done directly in this chat since you last replied \(by the app, without you\): "I'm starting now" ran shift_day: .+$/s);
    await (await app.request('/api/chat', json({ message: 'thanks' }))).text();
    expect(calls[1]).toBe('thanks');
    expect(notes[1]).toBeUndefined();
    await (await app.request('/api/chat', json({ message: "What's on today?" }))).text();
    await app.request('/api/chat/reset', { method: 'POST' });
    await (await app.request('/api/chat', json({ message: 'hello' }))).text();
    expect(calls[2]).toBe('hello');
    expect(notes[2]).toBeUndefined();
  });

  it('keeps the note on what was done directly for the next turn when the turn that carried it failed', async () => {
    seedDay();
    const notes: Array<string | undefined> = [];
    let fail = true;
    assistant.send = async (text, emit, _signal, note) => { notes.push(note); if (fail) throw new Error('claude did not answer in time'); emit({ type: 'text', delta: 'ok' }); };
    await (await app.request('/api/chat', json({ message: "I'm starting now" }))).text();
    const failed = await events(await app.request('/api/chat', json({ message: 'undo that' })));
    expect(failed.some((e) => e.type === 'error')).toBe(true);
    fail = false;
    await (await app.request('/api/chat', json({ message: 'undo that' }))).text();
    await (await app.request('/api/chat', json({ message: 'thanks' }))).text();
    expect(notes[0]).toMatch(/"I'm starting now" ran shift_day/);
    expect(notes[1]).toBe(notes[0]);
    expect(notes[2]).toBeUndefined();
  });
});

describe('baseline routes', () => {
  const put = (body: unknown) => app.request('/api/baseline', { ...json(body), method: 'PUT' });
  const taskSlot = (taskId: string, day: number, start: string, end: string) => ({ day, start, end, kind: 'task', taskId });
  const busySlot = (day: number, start: string, end: string, title = 'Gym') => ({ day, start, end, kind: 'busy', title });
  const mkTask = async (name = 'Deep') => ((await (await app.request('/api/tasks', json({ name, priority: 1, budget_minutes: 60, budget_period: 'day' }))).json()) as any).id as string;

  it('a save (PUT, or a revert) refreshes each slotted task\'s budget, period and session from the baseline; a task with no slot keeps its numbers', async () => {
    const deep = await mkTask('Deep');
    const other = await mkTask('Other');
    await put({ slots: [1, 2, 3, 4, 5].map((day) => taskSlot(deep, day, '09:00', '10:30')) });
    expect(store.getTask(deep)).toMatchObject({ budgetMinutes: 450, budgetPeriod: 'week', sessionMinutes: 90 });
    expect(store.getTask(other)).toMatchObject({ budgetMinutes: 60, budgetPeriod: 'day' });
    expect(store.getTask(other)!.sessionMinutes).toBeUndefined();
    await put({ slots: [taskSlot(deep, 1, '09:00', '10:00'), taskSlot(deep, 3, '09:00', '10:00'), taskSlot(other, 2, '14:00', '16:00')] });
    expect(store.getTask(deep)).toMatchObject({ budgetMinutes: 120, budgetPeriod: 'week', sessionMinutes: 60 });
    expect(store.getTask(other)).toMatchObject({ budgetMinutes: 120, budgetPeriod: 'week', sessionMinutes: 120 });
    await app.request('/api/baseline/revert', json({ version: 1 }));
    expect(store.getTask(deep)).toMatchObject({ budgetMinutes: 450, sessionMinutes: 90 });
    expect(store.getTask(other)).toMatchObject({ budgetMinutes: 120, sessionMinutes: 120 }); // no slot in version 1: kept
  });

  it('has no baseline and no versions at first', async () => {
    const r = await (await app.request('/api/baseline')).json() as any;
    expect(r).toEqual({ baseline: null, versions: [] });
  });

  it('saves versions, returns the latest with the version list, and reverts as a new latest', async () => {
    const t = await mkTask();
    const first = [taskSlot(t, 1, '09:00', '10:00')];
    const second = [taskSlot(t, 1, '09:00', '10:00'), busySlot(2, '12:00', '13:00')];
    const a = await (await put({ slots: first })).json() as any;
    expect(a.baseline.version).toBe(1);
    const b = await (await put({ slots: second })).json() as any;
    expect(b.baseline.version).toBe(2);
    expect(b.versions.map((v: any) => v.version)).toEqual([1, 2]);

    const got = await (await app.request('/api/baseline')).json() as any;
    expect(got.baseline.version).toBe(2);
    expect(got.baseline.slots.length).toBe(2);
    expect(got.versions.length).toBe(2);
    expect(got.versions[0].savedAt).toBeTruthy();

    const rev = await app.request('/api/baseline/revert', json({ version: 1 }));
    expect(rev.status).toBe(200);
    const r = await rev.json() as any;
    expect(r.baseline.version).toBe(3);
        expect(r.versions.map((v: any) => v.version)).toEqual([1, 2, 3]);
    const all = store.listBaselines();
    expect(all[2].slots).toEqual(all[0].slots);
    expect(all[0].slots.length).toBe(1);
  });

  it('refuses a bad save, an unknown revert version, and an apply with no baseline', async () => {
    expect((await put({})).status).toBe(400);
    expect((await put({ slots: 'x' })).status).toBe(400);
    expect((await app.request('/api/baseline/revert', json({ version: 7 }))).status).toBe(404);
    expect((await app.request('/api/baseline/revert', json({}))).status).toBe(400);
    expect((await app.request('/api/baseline/apply', json({}))).status).toBe(404);
    expect(store.listBaselines()).toEqual([]);
  });

  it('applies next week: blocks and commitments land in the store, and a re-apply replaces them', async () => {
    const t = await mkTask();
    await put({ slots: [taskSlot(t, 1, '09:00', '10:00'), taskSlot(t, 3, '09:00', '10:00'), busySlot(2, '12:00', '13:00')] });
    const week = new Date(2026, 9, 12); // Monday after the clock's Wednesday
    const to = new Date(2026, 9, 19);
    const res = await app.request('/api/baseline/apply', json({ weekOf: '2026-10-12' }));
    expect(res.status).toBe(200);
    const r = await res.json() as any;
    expect(r.created.length).toBe(2);
    expect(r.commitments.length).toBe(1);
    expect(r.replaced).toBe(0);
    expect(store.listBlocks({ from: week, to }).filter((b) => b.source === 'baseline').length).toBe(2);
    expect(store.listCommitments({ from: week, to }).length).toBe(1);

    const again = await (await app.request('/api/baseline/apply', json({ weekOf: '2026-10-12' }))).json() as any;
    expect(again.created.length).toBe(2);
    expect(again.replaced).toBe(2);
    expect(store.listBlocks({ from: week, to }).filter((b) => b.source === 'baseline').length).toBe(2);
    expect(store.listCommitments({ from: week, to }).length).toBe(1);
  });

  it('applies to the current week when weekOf is left out, and refuses a bad date', async () => {
    const t = await mkTask();
    await put({ slots: [taskSlot(t, 5, '09:00', '10:00')] }); // Friday; the clock is Wednesday 9:00
    const r = await (await app.request('/api/baseline/apply', json({}))).json() as any;
    expect(r.created.length).toBe(1);
    expect(r.created[0].start).toBe(new Date(2026, 9, 9, 9).toISOString());
    expect((await app.request('/api/baseline/apply', json({ weekOf: 'next week' }))).status).toBe(400);
  });

  it('reads a legacy baseline from a SQLite file as version 1', async () => {
    const sqlite = new SqliteStore(':memory:');
    sqlite.setJson('baseline', { savedAt: '2026-10-01T08:00:00.000Z', blocks: [{ taskId: 't1', day: 1, start: '09:00', end: '10:00' }] });
    const sapp = createApp({ store: sqlite, assistant, now: () => d(9) });
    const r = await (await sapp.request('/api/baseline')).json() as any;
    expect(r.baseline.version).toBe(1);
    expect(r.baseline.slots.length).toBe(1);
    expect(r.versions).toEqual([{ version: 1, savedAt: '2026-10-01T08:00:00.000Z' }]);
  });
});
