import { describe, it, expect } from 'vitest';
import { buildClaudeArgs, claudeEnv, formatTurnLine, MAX_TURNS, mcpServerCommand, parseStreamJsonLine, toAssistantEvents, wrapMessage, type ParsedEvent } from '../src/assistant/claudeCode.js';

// Only the pure parts: nothing here spawns a process.

describe('wrapMessage', () => {
  it('puts the context in a <context> block, a blank line, then the user\'s words exactly', () => {
    expect(wrapMessage('## Context\nline', 'hi there')).toBe('<context>\n## Context\nline\n</context>\n\nhi there');
    expect(wrapMessage('', '')).toBe('<context>\n\n</context>\n\n');
    expect(wrapMessage('c', 'text with\n\nblank lines and </context> inside')).toBe('<context>\nc\n</context>\n\ntext with\n\nblank lines and </context> inside'); // the user's words are not altered
  });
});

describe('buildClaudeArgs', () => {
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

  it('long-lived mode: -p with stream-json input and no message; one-shot mode: -p with the text; extra args come first', () => {
    const live = buildClaudeArgs({ systemPrompt: 'S', mcpConfig: '{"m":1}' });
    expect(live.slice(0, 3)).toEqual(['-p', '--input-format', 'stream-json']);
    const once = buildClaudeArgs({ text: 'hello world', systemPrompt: 'S', mcpConfig: '{}' });
    expect(once.slice(0, 2)).toEqual(['-p', 'hello world']);
    expect(once).not.toContain('--input-format');
    const extra = buildClaudeArgs({ text: 'x', systemPrompt: 'S', mcpConfig: '{}', extraArgs: ['/path/fake.mjs', '--flag'] });
    expect(extra.slice(0, 4)).toEqual(['/path/fake.mjs', '--flag', '-p', 'x']);
  });

  it('an empty text is still a one-shot message (only undefined means long-lived)', () => {
    const args = buildClaudeArgs({ text: '', systemPrompt: 'S', mcpConfig: '{}' });
    expect(args.slice(0, 2)).toEqual(['-p', '']);
    expect(args).not.toContain('--input-format');
  });

  it('passes the prompt and the MCP config verbatim, the snapshot off, and the max turns constant; model and session only when given', () => {
    const prompt = 'line one\nline "two" with <context> and 日本語';
    const cfg = JSON.stringify({ mcpServers: { scheduler: { command: 'node', args: ['a'] } } });
    const args = buildClaudeArgs({ systemPrompt: prompt, mcpConfig: cfg, model: 'opus', session: 'sess-1' });
    expect(flag(args, '--system-prompt')).toBe(prompt);
    expect(flag(args, '--mcp-config')).toBe(cfg);
    expect(flag(args, '--system-prompt-snapshot')).toBe('off');
    expect(flag(args, '--max-turns')).toBe(String(MAX_TURNS));
    expect(MAX_TURNS).toBe(25);
    expect(args.slice(-4)).toEqual(['--model', 'opus', '--resume', 'sess-1']);
    const bare = buildClaudeArgs({ systemPrompt: 'S', mcpConfig: '{}', model: '', session: '' });
    expect(bare).not.toContain('--model'); // empty strings count as not given
    expect(bare).not.toContain('--resume');
    expect(bare[bare.length - 1]).toBe('S');
  });

  it('every flag appears once, in a fixed order, and the lockdown set is complete', () => {
    const args = buildClaudeArgs({ systemPrompt: 'S', mcpConfig: '{}' });
    const flags = args.filter((a) => a.startsWith('--'));
    expect(new Set(flags).size).toBe(flags.length);
    expect(flags).toEqual(['--input-format', '--output-format', '--verbose', '--include-partial-messages', '--strict-mcp-config', '--mcp-config', '--allowedTools', '--permission-mode', '--restricted', '--tools', '--max-turns', '--system-prompt-snapshot', '--system-prompt']);
  });
});

describe('claudeEnv', () => {
  it('overrides a database path and a tool-search flag already in the base, keeps everything else, and never mutates the base', () => {
    const base = { HOME: '/h', PLANNAV_DB_PATH: '/old.sqlite', ENABLE_TOOL_SEARCH: 'true', DS_DB_PATH: '/legacy.sqlite' };
    const env = claudeEnv('/new.sqlite', base);
    expect(env).toEqual({ HOME: '/h', PLANNAV_DB_PATH: '/new.sqlite', ENABLE_TOOL_SEARCH: 'false', DS_DB_PATH: '/legacy.sqlite' });
    expect(base.PLANNAV_DB_PATH).toBe('/old.sqlite');
    expect(claudeEnv(':memory:', {})).toEqual({ PLANNAV_DB_PATH: ':memory:', ENABLE_TOOL_SEARCH: 'false' });
  });
});

describe('mcpServerCommand', () => {
  it('runs the MCP server with this node binary, warnings off, from dist when built or from source through tsx', () => {
    const { command, args } = mcpServerCommand();
    expect(command).toBe(process.execPath);
    expect(args[0]).toBe('--disable-warning=ExperimentalWarning');
    const entry = args[args.length - 1];
    expect(entry).toMatch(/[\\/]mcp\.(js|ts)$/);
    if (entry.endsWith('.ts')) expect(args.slice(1, 3)).toEqual(['--import', 'tsx']);
    else expect(args).toHaveLength(2);
  });
});

describe('formatTurnLine: rounding and dashes', () => {
  it('rounds seconds to one decimal and tokens to thousands, half up', () => {
    expect(formatTurnLine({ wallMs: 49 })).toBe('turn 0.0s api - ttft - rounds - cache_read - cache_create -');
    expect(formatTurnLine({ wallMs: 50 })).toBe('turn 0.1s api - ttft - rounds - cache_read - cache_create -');
    expect(formatTurnLine({ wallMs: 12_345, durationApiMs: 999, ttftMs: 0, numTurns: 0, cacheReadTokens: 499, cacheCreationTokens: 1500 })).toBe('turn 12.3s api 1.0s ttft 0.0s rounds 0 cache_read 0k cache_create 2k');
    expect(formatTurnLine({ wallMs: 1000, cacheReadTokens: 2_499_999 })).toBe('turn 1.0s api - ttft - rounds - cache_read 2500k cache_create -');
  });

  it('a direct turn shows only the wall clock, whatever else is set', () => {
    expect(formatTurnLine({ wallMs: 1234, direct: true, durationApiMs: 5, numTurns: 3 })).toBe('turn 1.2s direct');
    expect(formatTurnLine({ wallMs: 0, direct: true })).toBe('turn 0.0s direct');
    expect(formatTurnLine({ wallMs: 10, direct: false })).toBe('turn 0.0s api - ttft - rounds - cache_read - cache_create -');
  });
});

describe('parseStreamJsonLine: shapes the CLI may send', () => {
  const line = (o: unknown) => JSON.stringify(o);

  it('skips an empty text block and a tool_use without a string name, keeps order within one message', () => {
    const out = parseStreamJsonLine(line({ type: 'assistant', message: { content: [
      { type: 'text', text: '' },
      { type: 'tool_use', id: 'x', name: 42, input: {} },
      { type: 'tool_use', id: 'y', name: 'mcp__scheduler__get_now', input: null },
      { type: 'text', text: 'after' },
      { type: 'thinking', thinking: 'hmm' },
    ] } }));
    expect(out).toEqual([{ kind: 'tool_call', id: 'y', name: 'get_now', input: null }, { kind: 'text', text: 'after' }]);
  });

  it('a tool name that only looks like the prefix is not stripped; an exact prefix with nothing after is an empty name', () => {
    expect(parseStreamJsonLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__scheduler_get_now', input: {} }] } }))).toEqual([]);
    expect(parseStreamJsonLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__other__get_now', input: {} }] } }))).toEqual([]);
    expect(parseStreamJsonLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__scheduler__', input: {} }] } }))).toEqual([{ kind: 'tool_call', id: 'a', name: '', input: {} }]);
  });

  it('tool results: text parts joined by newlines, non-text parts dropped, a missing content is the empty string, is_error coerced', () => {
    const out = parseStreamJsonLine(line({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'one' }, { type: 'image', source: {} }, { type: 'text', text: 'two' }] },
      { type: 'tool_result', tool_use_id: 'b' },
      { type: 'tool_result', tool_use_id: 'c', content: 7, is_error: 1 },
      { type: 'text', text: 'a user text block is not a result' },
    ] } }));
    expect(out).toEqual([
      { kind: 'tool_result', id: 'a', content: 'one\ntwo', isError: false },
      { kind: 'tool_result', id: 'b', content: '', isError: false },
      { kind: 'tool_result', id: 'c', content: '7', isError: true },
    ]);
  });

  it('messages whose content is not an array yield nothing', () => {
    expect(parseStreamJsonLine(line({ type: 'assistant', message: { content: 'plain' } }))).toEqual([]);
    expect(parseStreamJsonLine(line({ type: 'assistant', message: null }))).toEqual([]);
    expect(parseStreamJsonLine(line({ type: 'assistant' }))).toEqual([]);
    expect(parseStreamJsonLine(line({ type: 'user', message: { content: {} } }))).toEqual([]);
  });

  it('a result needs a string session id; is_error and the stats are coerced from whatever was sent', () => {
    expect(parseStreamJsonLine(line({ type: 'result', is_error: true }))).toEqual([]);
    expect(parseStreamJsonLine(line({ type: 'result', session_id: 7 }))).toEqual([]);
    expect(parseStreamJsonLine(line({ type: 'result', session_id: 's', is_error: 'yes', duration_ms: Infinity, num_turns: 2.5, usage: null }))).toEqual([{ kind: 'result', sessionId: 's', isError: true, stats: { numTurns: 2.5 } }]);
    expect(parseStreamJsonLine(line({ type: 'result', session_id: 's', usage: { cache_read_input_tokens: 0 } }))).toEqual([{ kind: 'result', sessionId: 's', isError: false, stats: { cacheReadTokens: 0 } }]);
  });

  it('stream events: only text deltas and message starts of the top-level stream, with a string delta', () => {
    const ev = (event: unknown, parent?: unknown) => line({ type: 'stream_event', event, ...(parent === undefined ? {} : { parent_tool_use_id: parent }) });
    expect(parseStreamJsonLine(ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 7 } }))).toEqual([]);
    expect(parseStreamJsonLine(ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: '' } }))).toEqual([{ kind: 'text_delta', text: '' }]);
    expect(parseStreamJsonLine(ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }, 'tu1'))).toEqual([]);
    expect(parseStreamJsonLine(ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }, null))).toEqual([{ kind: 'text_delta', text: 'x' }]);
    expect(parseStreamJsonLine(ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }, ''))).toEqual([{ kind: 'text_delta', text: 'x' }]); // an empty parent id is no parent
    expect(parseStreamJsonLine(ev({ type: 'content_block_start', content_block: { type: 'text', text: 'ignored' } }))).toEqual([]);
    expect(parseStreamJsonLine(ev(null))).toEqual([]);
    expect(parseStreamJsonLine(line({ type: 'stream_event' }))).toEqual([]);
  });

  it('tolerates surrounding whitespace, rejects JSON that is not an object, and never throws', () => {
    expect(parseStreamJsonLine('   {"type":"result","session_id":"s"}  \r')).toEqual([{ kind: 'result', sessionId: 's', isError: false, stats: {} }]);
    expect(parseStreamJsonLine('[{"type":"result","session_id":"s"}]')).toEqual([]);
    expect(parseStreamJsonLine('"a string"')).toEqual([]);
    expect(parseStreamJsonLine('null')).toEqual([]);
    expect(parseStreamJsonLine('{"type":"result","session_id":"s"} trailing')).toEqual([]);
    expect(parseStreamJsonLine('{}')).toEqual([]);
  });
});

describe('toAssistantEvents: the id map and the streamed flag', () => {
  it('names results from calls seen earlier, in any order, and parses JSON of every kind', () => {
    const names = new Map<string, string>();
    toAssistantEvents({ kind: 'tool_call', id: 'a', name: 'get_now', input: {} }, names);
    toAssistantEvents({ kind: 'tool_call', id: 'b', name: 'mark_task', input: { task: 'x' } }, names);
    expect(names).toEqual(new Map([['a', 'get_now'], ['b', 'mark_task']]));
    expect(toAssistantEvents({ kind: 'tool_result', id: 'b', content: '[1,2]', isError: false }, names)).toEqual([{ type: 'tool_result', id: 'b', name: 'mark_task', result: [1, 2], isError: false }]);
    expect(toAssistantEvents({ kind: 'tool_result', id: 'a', content: 'null', isError: false }, names)).toEqual([{ type: 'tool_result', id: 'a', name: 'get_now', result: null, isError: false }]);
    expect(toAssistantEvents({ kind: 'tool_result', id: 'a', content: '', isError: true }, names)).toEqual([{ type: 'tool_result', id: 'a', name: 'get_now', result: '', isError: true }]);
    expect(toAssistantEvents({ kind: 'tool_result', id: 'a', content: '{"summary":"x"} extra', isError: false }, names)[0]).toMatchObject({ result: '{"summary":"x"} extra' });
    // a second call with the same id renames it
    toAssistantEvents({ kind: 'tool_call', id: 'a', name: 'get_schedule', input: {} }, names);
    expect(toAssistantEvents({ kind: 'tool_result', id: 'a', content: '{}', isError: false }, names)[0]).toMatchObject({ name: 'get_schedule' });
  });

  it('the complete text of a streamed message is dropped only until the next message_start; a fresh default state streams nothing', () => {
    const names = new Map<string, string>();
    const st = { streamed: false };
    const run = (evs: ParsedEvent[]) => evs.flatMap((e) => toAssistantEvents(e, names, st));
    expect(run([{ kind: 'text', text: 'A' }])).toEqual([{ type: 'text', delta: 'A' }]); // not streamed: the complete text is the reply
    expect(run([{ kind: 'message_start' }, { kind: 'text_delta', text: 'B' }, { kind: 'text', text: 'B' }, { kind: 'text', text: 'B again' }])).toEqual([{ type: 'text', delta: 'B' }]); // every complete text of that message is dropped
    expect(st.streamed).toBe(true);
    expect(run([{ kind: 'message_start' }])).toEqual([]);
    expect(st.streamed).toBe(false);
    expect(run([{ kind: 'text', text: 'C' }])).toEqual([{ type: 'text', delta: 'C' }]);
    // without a state argument each call starts unstreamed
    expect(toAssistantEvents({ kind: 'text_delta', text: 'D' }, names)).toEqual([{ type: 'text', delta: 'D' }]);
    expect(toAssistantEvents({ kind: 'text', text: 'D' }, names)).toEqual([{ type: 'text', delta: 'D' }]);
    expect(toAssistantEvents({ kind: 'result', sessionId: 's', isError: true, stats: { numTurns: 1 } }, names)).toEqual([]);
  });
});
