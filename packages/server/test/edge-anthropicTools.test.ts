import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, MemoryStore, STANDARD_WEEK, tools } from '@ds/core';
import { buildSdkTools } from '../src/assistant/anthropic.js';
import type { AssistantEvent } from '../src/assistant/types.js';

// The SDK tool wrappers alone: no client, no network.
const ctx = { now: () => new Date(2026, 9, 7, 9) };

describe('buildSdkTools', () => {
  it('wraps every core tool once, keeping its name and description, in the core order', () => {
    const sdk = buildSdkTools(new MemoryStore(), () => {}, ctx);
    expect(sdk.map((t) => t.name)).toEqual(tools.map((t) => t.name));
    expect(new Set(sdk.map((t) => t.name)).size).toBe(tools.length);
    for (const [i, t] of sdk.entries()) expect((t as { description?: string }).description, t.name).toBe(tools[i].description);
  });

  it('falls back to one counter shared by every tool for the id when the SDK gives no tool_use context', async () => {
    const events: AssistantEvent[] = [];
    const sdk = buildSdkTools(new MemoryStore(), (e) => events.push(e), ctx);
    const now = sdk.find((t) => t.name === 'get_now')!;
    const status = sdk.find((t) => t.name === 'get_setup_status')!;
    await now.run({}, undefined as never);
    await now.run({}, {} as never);
    await status.run({}, { toolUse: undefined } as never);
    await now.run({}, { toolUse: { id: 'toolu_real' } } as never);
    await status.run({}, undefined as never);
    expect(events.map((e) => (e as { id: string }).id)).toEqual(['get_now-0', 'get_now-1', 'get_setup_status-2', 'toolu_real', 'get_setup_status-3']);
    // a second buildSdkTools starts its own counter
    const other: AssistantEvent[] = [];
    await buildSdkTools(new MemoryStore(), (e) => other.push(e), ctx).find((t) => t.name === 'get_now')!.run({}, undefined as never);
    expect((other[0] as { id: string }).id).toBe('get_now-0');
  });

  it('a tool that changes the store does so, and the string it returns is the JSON of the emitted result', async () => {
    const store = new MemoryStore();
    store.saveSettings({ ...DEFAULT_SETTINGS, availability: STANDARD_WEEK });
    const events: AssistantEvent[] = [];
    const sdk = buildSdkTools(store, (e) => events.push(e), ctx);
    const memory = sdk.find((t) => t.name === 'update_memory')!;
    const out = await memory.run({ text: '  - Lunch at 13:00.  ' }, { toolUse: { id: 'm1' } } as never);
    expect(JSON.parse(out as string)).toEqual({ memory: '- Lunch at 13:00.', summary: 'Memory updated.' });
    expect(events).toEqual([{ type: 'tool_result', id: 'm1', name: 'update_memory', result: { memory: '- Lunch at 13:00.', summary: 'Memory updated.' } }]);
    expect(store.getSettings().memory).toBe('- Lunch at 13:00.');
    const upsert = sdk.find((t) => t.name === 'upsert_task')!;
    const task = JSON.parse(await upsert.run({ name: 'Reading', priority: 2, budget_minutes: 30, budget_period: 'day' }, { toolUse: { id: 't1' } } as never) as string);
    expect(store.getTask(task.id)).toMatchObject({ name: 'Reading', priority: 2, budgetMinutes: 30 });
  });

  it('a schema violation is reported as an error result, not thrown, and the message names the field', async () => {
    const events: AssistantEvent[] = [];
    const sdk = buildSdkTools(new MemoryStore(), (e) => events.push(e), ctx);
    const memory = sdk.find((t) => t.name === 'update_memory')!;
    const out = JSON.parse(await memory.run({ text: 'x'.repeat(2001) }, { toolUse: { id: 'm2' } } as never) as string);
    expect(typeof out.error).toBe('string');
    expect(out.error).toMatch(/2000|too_big/);
    expect(events[0]).toMatchObject({ type: 'tool_result', id: 'm2', name: 'update_memory', isError: true });
    expect((events[0] as { result: { error: string } }).result.error).toBe(out.error);
    const shift = sdk.find((t) => t.name === 'shift_day')!;
    const bad = JSON.parse(await shift.run({ breaks: 'maybe' }, { toolUse: { id: 's1' } } as never) as string);
    expect(bad.error).toMatch(/breaks/);
  });

  it('a non-Error failure inside a tool is stringified', async () => {
    const events: AssistantEvent[] = [];
    const store = new MemoryStore();
    store.getSettings = () => { throw 'settings exploded'; }; // eslint-disable-line no-throw-literal
    const sdk = buildSdkTools(store, (e) => events.push(e), ctx);
    const out = JSON.parse(await sdk.find((t) => t.name === 'update_memory')!.run({ text: 'a' }, { toolUse: { id: 'x' } } as never) as string);
    expect(out).toEqual({ error: 'settings exploded' });
    expect(events[0]).toEqual({ type: 'tool_result', id: 'x', name: 'update_memory', result: { error: 'settings exploded' }, isError: true });
  });

  it('import_calendar without a fetcher in the context explains instead of reaching the network', async () => {
    const events: AssistantEvent[] = [];
    const sdk = buildSdkTools(new MemoryStore(), (e) => events.push(e), ctx);
    const out = JSON.parse(await sdk.find((t) => t.name === 'import_calendar')!.run({ url: 'https://example.com/a.ics' }, { toolUse: { id: 'i' } } as never) as string);
    expect(out.error).toBe('Fetching URLs is not available in this context. Ask the user to use the Import button for a file instead.');
    const fetched: string[] = [];
    const withFetch = buildSdkTools(new MemoryStore(), () => {}, { ...ctx, fetchText: async (u) => { fetched.push(u); return 'BEGIN:VCALENDAR\r\nEND:VCALENDAR'; } });
    const ok = JSON.parse(await withFetch.find((t) => t.name === 'import_calendar')!.run({ url: 'webcal://example.com/a.ics' }, { toolUse: { id: 'j' } } as never) as string);
    expect(fetched).toEqual(['https://example.com/a.ics']);
    expect(ok.error).toBeUndefined();
    expect(ok.commitments).toEqual([]);
  });
});
