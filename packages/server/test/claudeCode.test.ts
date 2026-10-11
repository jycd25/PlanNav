import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, MemoryStore, STANDARD_WEEK } from '@ds/core';
import { ClaudeCodeProvider, buildClaudeArgs, claudeEnv, formatTurnLine, parseStreamJsonLine, toAssistantEvents, type ClaudeCodeConfig } from '../src/assistant/claudeCode.js';
import type { AssistantEvent } from '../src/assistant/types.js';

const fakeClaude = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

describe('parseStreamJsonLine', () => {
  it('ignores non-JSON and unknown events', () => {
    expect(parseStreamJsonLine('')).toEqual([]);
    expect(parseStreamJsonLine('Warning: something')).toEqual([]);
    expect(parseStreamJsonLine('{"type":"system","subtype":"init"}')).toEqual([]);
    expect(parseStreamJsonLine('{"type":"rate_limit_event"}')).toEqual([]);
    expect(parseStreamJsonLine('{not json')).toEqual([]);
  });

  it('extracts text and tool calls from assistant messages, stripping the mcp prefix', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'text', text: 'Planning now.' },
      { type: 'tool_use', id: 'tu1', name: 'mcp__scheduler__plan_schedule', input: { horizon: 'day' } },
    ] } });
    expect(parseStreamJsonLine(line)).toEqual([
      { kind: 'text', text: 'Planning now.' },
      { kind: 'tool_call', id: 'tu1', name: 'plan_schedule', input: { horizon: 'day' } },
    ]);
  });

  it('extracts tool results from user messages', () => {
    const line = JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: '{"created":[]}' }], is_error: false },
    ] } });
    expect(parseStreamJsonLine(line)).toEqual([{ kind: 'tool_result', id: 'tu1', content: '{"created":[]}', isError: false }]);
    const str = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'plain', is_error: true }] } });
    expect(parseStreamJsonLine(str)).toEqual([{ kind: 'tool_result', id: 'tu2', content: 'plain', isError: true }]);
  });

  it('extracts the session id from the result event', () => {
    expect(parseStreamJsonLine('{"type":"result","session_id":"abc","is_error":false}')).toEqual([{ kind: 'result', sessionId: 'abc', isError: false, stats: {} }]);
  });

  it('keeps the timing, round trips and cache usage of the result event', () => {
    const line = JSON.stringify({
      type: 'result', session_id: 'abc', is_error: false, duration_ms: 7900, duration_api_ms: 5100, ttft_ms: 2100, num_turns: 2,
      usage: { input_tokens: 12, output_tokens: 40, cache_read_input_tokens: 35337, cache_creation_input_tokens: 15726 },
    });
    expect(parseStreamJsonLine(line)).toEqual([{ kind: 'result', sessionId: 'abc', isError: false, stats: {
      durationMs: 7900, durationApiMs: 5100, ttftMs: 2100, numTurns: 2, inputTokens: 12, outputTokens: 40, cacheReadTokens: 35337, cacheCreationTokens: 15726,
    } }]);
  });

  it('drops stats fields that are not numbers', () => {
    const line = JSON.stringify({ type: 'result', session_id: 'abc', is_error: false, duration_ms: 'soon', ttft_ms: null, num_turns: 1 });
    expect(parseStreamJsonLine(line)).toEqual([{ kind: 'result', sessionId: 'abc', isError: false, stats: { numTurns: 1 } }]);
  });
});

describe('formatTurnLine', () => {
  it('writes one line per turn: wall, api, ttft, rounds, cache read and creation in thousands', () => {
    expect(formatTurnLine({ wallMs: 7930, durationApiMs: 5100, ttftMs: 2100, numTurns: 2, cacheReadTokens: 35337, cacheCreationTokens: 15726 }))
      .toBe('turn 7.9s api 5.1s ttft 2.1s rounds 2 cache_read 35k cache_create 16k');
  });
  it('shows a dash for what the CLI did not report, and marks a direct turn', () => {
    expect(formatTurnLine({ wallMs: 120 })).toBe('turn 0.1s api - ttft - rounds - cache_read - cache_create -');
    expect(formatTurnLine({ wallMs: 80, direct: true })).toBe('turn 0.1s direct');
  });
});

describe('parseStreamJsonLine: partial messages (the reply streamed as it is written)', () => {
  const ev = (event: unknown, parent: string | null = null) => JSON.stringify({ type: 'stream_event', event, parent_tool_use_id: parent });
  it('reads text deltas and message starts; ignores other deltas and a subagent\'s stream', () => {
    expect(parseStreamJsonLine(ev({ type: 'message_start', message: {} }))).toEqual([{ kind: 'message_start' }]);
    expect(parseStreamJsonLine(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Lee' } }))).toEqual([{ kind: 'text_delta', text: 'Lee' }]);
    expect(parseStreamJsonLine(ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"' } }))).toEqual([]);
    expect(parseStreamJsonLine(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }, 'tu1'))).toEqual([]);
    expect(parseStreamJsonLine(ev({ type: 'message_stop' }))).toEqual([]);
  });
});

describe('toAssistantEvents: streamed text is not repeated by the complete message', () => {
  it('emits the deltas, then drops the text of that message\'s complete assistant event (tool calls still pass)', () => {
    const names = new Map<string, string>();
    const st = { streamed: false };
    const out = [
      ...toAssistantEvents({ kind: 'message_start' }, names, st),
      ...toAssistantEvents({ kind: 'text_delta', text: 'Leetcode ' }, names, st),
      ...toAssistantEvents({ kind: 'text_delta', text: 'marked done.' }, names, st),
      ...toAssistantEvents({ kind: 'text', text: 'Leetcode marked done.' }, names, st),
      ...toAssistantEvents({ kind: 'message_start' }, names, st),
      ...toAssistantEvents({ kind: 'text', text: 'Unstreamed.' }, names, st),
    ];
    expect(out).toEqual([{ type: 'text', delta: 'Leetcode ' }, { type: 'text', delta: 'marked done.' }, { type: 'text', delta: 'Unstreamed.' }]);
  });
});

describe('parseStreamJsonLine: built-in CLI tools', () => {
  it('ignores tool calls that are not scheduler MCP tools (e.g. ToolSearch)', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'ts1', name: 'ToolSearch', input: { query: 'select:mcp__scheduler__plan_schedule' } },
      { type: 'tool_use', id: 'tu1', name: 'mcp__scheduler__plan_schedule', input: {} },
    ] } });
    expect(parseStreamJsonLine(line)).toEqual([{ kind: 'tool_call', id: 'tu1', name: 'plan_schedule', input: {} }]);
  });
});

describe('toAssistantEvents', () => {
  it('maps parsed events to assistant events, parsing JSON results and dropping results for unknown ids (the result event is the provider\'s)', () => {
    const names = new Map<string, string>();
    expect(toAssistantEvents({ kind: 'text', text: 'hi' }, names)).toEqual([{ type: 'text', delta: 'hi' }]);
    expect(toAssistantEvents({ kind: 'tool_call', id: 'a', name: 'get_now', input: {} }, names)).toEqual([{ type: 'tool_call', id: 'a', name: 'get_now', input: {} }]);
    expect(toAssistantEvents({ kind: 'tool_result', id: 'a', content: '{"ok":true}', isError: false }, names)).toEqual([{ type: 'tool_result', id: 'a', name: 'get_now', result: { ok: true }, isError: false }]);
    expect(toAssistantEvents({ kind: 'tool_result', id: 'a', content: 'plain text', isError: true }, names)).toEqual([{ type: 'tool_result', id: 'a', name: 'get_now', result: 'plain text', isError: true }]);
    expect(toAssistantEvents({ kind: 'tool_result', id: 'unknown', content: '', isError: false }, names)).toEqual([]);
    expect(toAssistantEvents({ kind: 'result', sessionId: 's', isError: false, stats: {} }, names)).toEqual([]);
  });
});

describe('ClaudeCodeProvider', () => {
  it('drops a stale session and retries once without --resume', async () => {
    let session: string | undefined = 'stale';
    const provider = new ClaudeCodeProvider({
      dbPath: ':memory:', store: new MemoryStore(), claudeBin: process.execPath, claudeArgs: [fakeClaude],
      sessionStore: { get: () => session, set: (id) => { session = id; } },
    });
    const events: AssistantEvent[] = [];
    await provider.send('hello', (e) => events.push(e));
    expect(events.filter((e) => e.type !== 'stats')).toEqual([{ type: 'text', delta: 'echo: hello' }]);
    expect(session).toBe('fresh-session');
  });

  it('emits one stats event per turn (after the reply) with the wall clock and the CLI\'s numbers, and logs one line', async () => {
    const lines: string[] = [];
    const provider = new ClaudeCodeProvider({
      dbPath: ':memory:', store: new MemoryStore(), claudeBin: process.execPath, claudeArgs: [fakeClaude],
      sessionStore: { get: () => undefined, set: () => {} }, log: (l) => lines.push(l),
    });
    const events: AssistantEvent[] = [];
    await provider.send('hello', (e) => events.push(e));
    const stats = events.filter((e) => e.type === 'stats');
    expect(stats).toHaveLength(1);
    expect(events[events.length - 1].type).toBe('stats');
    const s = (stats[0] as Extract<AssistantEvent, { type: 'stats' }>).stats;
    expect(s).toMatchObject({ durationMs: 900, durationApiMs: 700, ttftMs: 400, numTurns: 1, cacheReadTokens: 30000, cacheCreationTokens: 2000 });
    expect(s.wallMs).toBeGreaterThan(0);
    expect(s.direct).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^turn \d+\.\ds api 0\.7s ttft 0\.4s rounds 1 cache_read 30k cache_create 2k$/);
  });
});

describe('ClaudeCodeProvider: one long-lived CLI per chat', () => {
  let record: string;
  const records = () => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []) as Array<{ pid: number; args: string[]; content: string }>;
  const make = (over: Partial<ClaudeCodeConfig> = {}) => {
    let session: string | undefined;
    const store = new MemoryStore();
    store.saveSettings({ ...DEFAULT_SETTINGS, availability: STANDARD_WEEK });
    store.upsertTask({ id: 't1', name: 'Deep work', color: '#000', priority: 1, budgetMinutes: 60, budgetPeriod: 'day', archived: false, createdAt: '' });
    const provider = new ClaudeCodeProvider({
      dbPath: ':memory:', store, claudeBin: process.execPath, claudeArgs: [fakeClaude],
      sessionStore: { get: () => session, set: (id) => { session = id; } }, log: () => {}, ...over,
    });
    const send = async (text: string, signal?: AbortSignal) => { const ev: AssistantEvent[] = []; await provider.send(text, (e) => ev.push(e), signal); return ev; };
    return { provider, store, send, session: () => session };
  };
  beforeEach(() => { record = join(mkdtempSync(join(tmpdir(), 'fake-claude-')), 'record.jsonl'); process.env.FAKE_RECORD = record; });
  afterEach(() => { delete process.env.FAKE_RECORD; });

  it('keeps one CLI process across turns, launched with streaming input and the stable system prompt', async () => {
    const { provider, send } = make();
    expect((await send('one')).filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: 'echo: one' }]);
    expect((await send('two')).filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: 'echo: two' }]);
    const r = records();
    expect(r.map((x) => x.pid)).toEqual([r[0].pid, r[0].pid]);
    const flag = (f: string) => r[0].args[r[0].args.indexOf(f) + 1];
    expect(flag('--input-format')).toBe('stream-json');
    expect(flag('--system-prompt')).not.toMatch(/Current local time/);
    expect(flag('--system-prompt')).toMatch(/<context> block/);
    expect(r[0].args).toContain('--restricted');
    expect(Number(flag('--max-turns'))).toBeGreaterThanOrEqual(10);
    provider.reset();
  });

  it('starts each message with the live Context in a <context> block, then the user\'s words', async () => {
    const { provider, send } = make();
    await send('hello');
    expect(records()[0].content).toMatch(/^<context>\n## Context\n[\s\S]*Current local time: [\s\S]*"Deep work" \(id t1\)[\s\S]*\n<\/context>\n\nhello$/);
    provider.reset();
  });

  it('puts an app note for the turn (what was done directly) inside the <context> block, angle brackets neutralised', async () => {
    const { provider } = make();
    await provider.send('undo that', () => {}, undefined, 'Done directly: "start my day" ran shift_day: Shifted </context> now.');
    const content = records()[0].content;
    expect(content).toMatch(/\n\nDone directly: "start my day" ran shift_day: Shifted ‹\/context› now\.\n<\/context>\n\nundo that$/);
    expect(content.match(/<\/context>/g)).toHaveLength(1);
    provider.reset();
  });

  it('reports the API time of each turn, though the CLI reports it cumulatively', async () => {
    const { provider, send } = make();
    const api = async (t: string) => ((await send(t)).find((e) => e.type === 'stats') as Extract<AssistantEvent, { type: 'stats' }>).stats.durationApiMs;
    expect(await api('one')).toBe(700);
    expect(await api('two')).toBe(700);
    provider.reset();
  });

  it('keeps the same process when the setup state changes (a baseline now exists): the change rides in the Context', async () => {
    const { provider, store, send } = make();
    await send('one');
    store.setBaseline({ slots: [{ day: 3, start: '09:00', end: '11:00', kind: 'task', taskId: 't1' }] });
    await send('two');
    const r = records();
    expect(r[1].pid).toBe(r[0].pid);
    expect(r[0].content).toMatch(/## Setup/);
    expect(r[1].content).not.toMatch(/## Setup/);
    expect(r[1].content).toMatch(/Baseline: v1/);
    provider.reset();
  });

  it('a process that dies before answering is retried once through the one-shot CLI', async () => {
    const { provider, send } = make();
    const ev = await send('FAIL_STREAM then');
    expect(ev.filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: 'echo: FAIL_STREAM then' }]);
    const r = records();
    expect(r).toHaveLength(2);
    expect(r[0].args).toContain('--input-format');
    expect(r[1].args).not.toContain('--input-format');
    expect(r[1].args[r[1].args.indexOf('-p') + 1]).toBe(r[0].content); // the same message, Context included
    provider.reset();
  });

  it('the one-shot fallback keeps only the tail of a long stderr, as the long-lived process does', async () => {
    process.env.FAKE_ONESHOT_STDERR = '200000';
    try {
      const { provider, send } = make();
      const err = await send('FAIL_STREAM then').then(() => null, (e: Error) => e);
      expect(err?.message).toMatch(/exited with code 3: e+/);
      expect(err!.message.length).toBeLessThan(4200);
      provider.reset();
    } finally {
      delete process.env.FAKE_ONESHOT_STDERR;
    }
  });

  it('a turn that never answers times out and stops the process; the next turn starts a new one', async () => {
    const { provider, send } = make({ turnTimeoutMs: 300 });
    await send('one');
    await expect(send('HANG please')).rejects.toThrow(/did not answer/i);
    await send('three');
    const r = records();
    expect(r[2].pid).not.toBe(r[0].pid);
    provider.reset();
  });

  it('an aborted turn stops the process; the next turn resumes in a new one', async () => {
    const { provider, send } = make();
    await send('one');
    const ac = new AbortController();
    const p = send('HANG please', ac.signal);
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toThrow();
    await send('three');
    const r = records();
    expect(r[2].pid).not.toBe(r[0].pid);
    expect(r[2].args[r[2].args.indexOf('--resume') + 1]).toBe('fresh-session');
    provider.reset();
  });

  it('a signal already aborted before the turn rejects as stopped and cleans up (the next turn resumes in a new process)', async () => {
    const { provider, send } = make();
    await send('one');
    const ac = new AbortController();
    ac.abort();
    await expect(send('two', ac.signal)).rejects.toThrow(/stopped/i);
    await send('three');
    const r = records();
    expect(r.map((x) => x.content.split('\n\n').pop())).toEqual(['one', 'three']);
    expect(r[1].pid).not.toBe(r[0].pid);
    provider.reset();
  });

  it('an error result rejects the turn and stops the process', async () => {
    const { provider, send } = make();
    await expect(send('ERROR_RESULT')).rejects.toThrow(/reported an error/);
    await send('next');
    expect(records()[1].pid).not.toBe(records()[0].pid);
    provider.reset();
  });

  it('keeps at most one long-lived CLI per host process: a second chat\'s process stops the first (which resumes if used again)', async () => {
    const a = make();
    const b = make();
    await a.send('one');
    await b.send('two');
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await new Promise((r) => setTimeout(r, 200));
    const r = records();
    expect(alive(r[0].pid)).toBe(false);
    expect(alive(r[1].pid)).toBe(true);
    await a.send('three');
    expect(records()[2].args[records()[2].args.indexOf('--resume') + 1]).toBe('fresh-session');
    a.provider.reset();
    b.provider.reset();
  });

  it('warm starts the process before the first message (once), and the first message uses it', async () => {
    process.env.FAKE_RECORD_SPAWN = '1';
    try {
      const { provider, send } = make();
      provider.warm();
      provider.warm();
      for (let i = 0; i < 50 && records().length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      await send('one');
      const r = records();
      expect(r.map((x) => x.content.split('\n\n').pop())).toEqual(['<spawn>', 'one']);
      expect(r[1].pid).toBe(r[0].pid);
      provider.reset();
    } finally {
      delete process.env.FAKE_RECORD_SPAWN;
    }
  });

  it('a reset during a reply settles the turn at once ("stopped"), not at the turn timeout; the next message works', async () => {
    const { provider, send } = make({ turnTimeoutMs: 10_000 });
    const t0 = Date.now();
    const p = send('HANG please');
    setTimeout(() => provider.reset(), 200);
    await expect(p).rejects.toThrow(/stopped/i);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect((await send('next')).filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: 'echo: next' }]);
    provider.reset();
  });

  it('another chat\'s process starting during a reply settles that reply at once ("stopped")', async () => {
    const a = make({ turnTimeoutMs: 10_000 });
    const b = make();
    const t0 = Date.now();
    const p = a.send('HANG please');
    setTimeout(() => b.provider.warm(), 200);
    await expect(p).rejects.toThrow(/stopped/i);
    expect(Date.now() - t0).toBeLessThan(2000);
    a.provider.reset();
    b.provider.reset();
  });

  it('reset stops the process and forgets the session', async () => {
    const { provider, send, session } = make();
    await send('one');
    expect(session()).toBe('fresh-session');
    provider.reset();
    expect(session()).toBeUndefined();
    await send('two');
    const r = records();
    expect(r[1].pid).not.toBe(r[0].pid);
    expect(r[1].args).not.toContain('--resume');
    provider.reset();
  });
});

describe('ClaudeCodeProvider: process lifetime', () => {
  it('answers as soon as the result arrives instead of waiting for the CLI to exit, and stops the CLI', async () => {
    process.env.FAKE_LINGER_MS = '5000';
    try {
      const provider = new ClaudeCodeProvider({
        dbPath: ':memory:', store: new MemoryStore(), claudeBin: process.execPath, claudeArgs: [fakeClaude],
        sessionStore: { get: () => undefined, set: () => {} }, log: () => {},
      });
      const events: AssistantEvent[] = [];
      const t0 = Date.now();
      await provider.send('hello', (e) => events.push(e));
      expect(Date.now() - t0).toBeLessThan(2500);
      expect(events.filter((e) => e.type !== 'stats')).toEqual([{ type: 'text', delta: 'echo: hello' }]);
    } finally {
      delete process.env.FAKE_LINGER_MS;
    }
  });
});

describe('buildClaudeArgs', () => {
  it('locks the CLI down and bounds the number of turns', () => {
    const args = buildClaudeArgs({ text: 'hi', systemPrompt: 'sys', mcpConfig: '{}', model: 'sonnet', session: 'abc' });
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(args.slice(0, 2)).toEqual(['-p', 'hi']);
    expect(flag('--output-format')).toBe('stream-json');
    expect(args).toContain('--restricted');
    expect(args).toContain('--strict-mcp-config');
    expect(flag('--permission-mode')).toBe('dontAsk');
    expect(flag('--allowedTools')).toBe('mcp__scheduler');
    expect(flag('--system-prompt-snapshot')).toBe('off'); // a resumed session takes the prompt it is given, not the one it started with
    expect(Number(flag('--max-turns'))).toBeGreaterThanOrEqual(10);
    expect(Number(flag('--max-turns'))).toBeLessThanOrEqual(40);
    expect(flag('--model')).toBe('sonnet');
    expect(flag('--resume')).toBe('abc');
    // No built-in tools at all (Read, Write, Task, WebSearch… ~40k tokens of schemas): only the scheduler's MCP tools.
    expect(args).toContain('--tools');
    expect(flag('--tools')).toBe('');
    expect(args).toContain('--include-partial-messages'); // the reply streams to the chat as it is written
    const fresh = buildClaudeArgs({ text: 'hi', systemPrompt: 'sys', mcpConfig: '{}' });
    expect(fresh).not.toContain('--resume');
    expect(fresh).not.toContain('--model');
  });
});

describe('claudeEnv', () => {
  it('turns the CLI\'s tool search off, so the scheduler tools are loaded up front and a tool turn needs no ToolSearch round trip', () => {
    const env = claudeEnv('/tmp/x.sqlite', { PATH: '/bin', ENABLE_TOOL_SEARCH: 'true' });
    expect(env.ENABLE_TOOL_SEARCH).toBe('false');
    expect(env.PLANNAV_DB_PATH).toBe('/tmp/x.sqlite');
    expect(env.PATH).toBe('/bin');
  });
});
