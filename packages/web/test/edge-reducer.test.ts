import { describe, it, expect } from 'vitest';
import { applyEvent, pendingHint, type Message, type Part } from '../src/chat/reducer.js';

const turn = (): Message[] => [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }, { role: 'assistant', parts: [] }];
const tool = (id: string, name: string, extra: Partial<Extract<Part, { type: 'tool' }>> = {}): Part => ({ type: 'tool', id, name, input: {}, pending: true, ...extra });

describe('applyEvent: out-of-order and malformed streams', () => {
  it('a text delta after done still lands on the assistant message (done is a no-op)', () => {
    let m = applyEvent(turn(), { type: 'text', delta: 'Done.' });
    m = applyEvent(m, { type: 'done' });
    m = applyEvent(m, { type: 'text', delta: ' Really.' });
    expect(m[1].parts).toEqual([{ type: 'text', text: 'Done. Really.' }]);
  });

  it('a result without a call gets a row with no input; a second result for the same id overwrites it', () => {
    let m = applyEvent(turn(), { type: 'tool_result', id: 'a', name: 'get_now', result: { now: 1 } });
    m = applyEvent(m, { type: 'tool_result', id: 'a', name: 'get_now', result: { now: 2 }, isError: true });
    expect(m[1].parts).toEqual([{ type: 'tool', id: 'a', name: 'get_now', input: undefined, result: { now: 2 }, isError: true, pending: false }]);
  });

  // Regression (fixed 2026-10-12): the existing test "matches tool results by id even when the call was emitted after the result" states the intent,
  // but reducer.ts:19 pushes a new pending row for every tool_call without checking for an existing row with that id.
  // Expected: one finished row (input {} from the call, result from the result). Actual: two rows, the second pending forever.
  it('a tool_call that arrives after its result fills the existing row instead of adding a pending duplicate', () => {
    let m = applyEvent(turn(), { type: 'tool_result', id: 'a', name: 'get_now', result: 1 });
    m = applyEvent(m, { type: 'tool_call', id: 'a', name: 'get_now', input: {} });
    expect(m[1].parts).toEqual([{ type: 'tool', id: 'a', name: 'get_now', input: {}, result: 1, isError: false, pending: false }]);
  });

  it('duplicate tool_call ids make two pending rows; one result fills the first and leaves the second pending', () => {
    let m = applyEvent(turn(), { type: 'tool_call', id: 'dup', name: 'mark_task', input: { n: 1 } });
    m = applyEvent(m, { type: 'tool_call', id: 'dup', name: 'mark_task', input: { n: 2 } });
    m = applyEvent(m, { type: 'tool_result', id: 'dup', name: 'mark_task', result: 'ok' });
    expect(m[1].parts).toEqual([
      { type: 'tool', id: 'dup', name: 'mark_task', input: { n: 1 }, result: 'ok', isError: false, pending: false },
      { type: 'tool', id: 'dup', name: 'mark_task', input: { n: 2 }, pending: true },
    ]);
  });

  it('a result keeps the call\'s input and its name, and a result whose name differs is still matched by id', () => {
    let m = applyEvent(turn(), { type: 'tool_call', id: 'x', name: 'carve_out', input: { start: '14:00' } });
    m = applyEvent(m, { type: 'tool_result', id: 'x', name: 'renamed', result: null });
    expect(m[1].parts).toEqual([{ type: 'tool', id: 'x', name: 'renamed', input: { start: '14:00' }, result: null, isError: false, pending: false }]);
  });

  it('an error mid-stream leaves the pending tool row pending and appends "Error: …" as text; later text merges into that line', () => {
    let m = applyEvent(turn(), { type: 'text', delta: 'Working' });
    m = applyEvent(m, { type: 'tool_call', id: 't', name: 'shift_day', input: {} });
    m = applyEvent(m, { type: 'error', message: 'stream closed' });
    m = applyEvent(m, { type: 'text', delta: ' tail' });
    expect(m[1].parts).toEqual([
      { type: 'text', text: 'Working' },
      tool('t', 'shift_day'),
      { type: 'text', text: 'Error: stream closed tail' },
    ]);
  });

  it('two errors are two lines, each prefixed', () => {
    let m = applyEvent(turn(), { type: 'error', message: 'one' });
    m = applyEvent(m, { type: 'tool_call', id: '1', name: 'get_now', input: {} });
    m = applyEvent(m, { type: 'error', message: 'two' });
    expect(m[1].parts.filter((p) => p.type === 'text')).toEqual([{ type: 'text', text: 'Error: one' }, { type: 'text', text: 'Error: two' }]);
  });

  it('an empty delta still opens a text part after a tool row, and merges into the tail text otherwise', () => {
    let m = applyEvent(turn(), { type: 'tool_call', id: '1', name: 'get_now', input: {} });
    m = applyEvent(m, { type: 'text', delta: '' });
    expect(m[1].parts[1]).toEqual({ type: 'text', text: '' });
    m = applyEvent(m, { type: 'text', delta: 'x' });
    expect(m[1].parts).toHaveLength(2);
    expect(m[1].parts[1]).toEqual({ type: 'text', text: 'x' });
  });

  it('text is not merged across a tool row', () => {
    let m = applyEvent(turn(), { type: 'text', delta: 'a' });
    m = applyEvent(m, { type: 'tool_call', id: '1', name: 'get_now', input: {} });
    m = applyEvent(m, { type: 'tool_result', id: '1', name: 'get_now', result: 0 });
    m = applyEvent(m, { type: 'text', delta: 'b' });
    expect(m[1].parts.map((p) => p.type)).toEqual(['text', 'tool', 'text']);
    expect((m[1].parts[2] as { text: string }).text).toBe('b');
  });

  it('isError is normalised to a boolean and falsy results (0, null, "") are kept as results', () => {
    let m = applyEvent(turn(), { type: 'tool_call', id: '1', name: 'get_now', input: {} });
    m = applyEvent(m, { type: 'tool_result', id: '1', name: 'get_now', result: 0 });
    expect(m[1].parts[0]).toMatchObject({ result: 0, isError: false, pending: false });
    m = applyEvent(m, { type: 'tool_result', id: '1', name: 'get_now', result: '' });
    expect(m[1].parts[0]).toMatchObject({ result: '', isError: false });
    m = applyEvent(m, { type: 'tool_result', id: '1', name: 'get_now', result: null, isError: true });
    expect(m[1].parts[0]).toMatchObject({ result: null, isError: true });
  });

  it('after a reset (no messages) every event is ignored and the same array is returned', () => {
    const empty: Message[] = [];
    for (const e of [{ type: 'text', delta: 'x' }, { type: 'tool_call', id: '1', name: 'n', input: {} }, { type: 'tool_result', id: '1', name: 'n', result: 1 }, { type: 'error', message: 'e' }, { type: 'done' }] as const) {
      expect(applyEvent(empty, e)).toBe(empty);
    }
    expect(empty).toEqual([]);
  });

  it('never mutates the input: the previous array, its messages and their parts are untouched', () => {
    const before = turn();
    before[1].parts.push({ type: 'text', text: 'a' });
    const snapshot = JSON.parse(JSON.stringify(before));
    const after = applyEvent(before, { type: 'text', delta: 'b' });
    expect(before).toEqual(snapshot);
    expect(after).not.toBe(before);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1].parts).toEqual([{ type: 'text', text: 'ab' }]);
  });

  it('only the last message is ever touched, even when an earlier assistant message exists', () => {
    const m: Message[] = [{ role: 'assistant', parts: [{ type: 'text', text: 'old' }] }, { role: 'user', parts: [{ type: 'text', text: 'again' }] }];
    expect(applyEvent(m, { type: 'text', delta: 'new' })).toBe(m);
    const withTurn: Message[] = [...m, { role: 'assistant', parts: [] }];
    const r = applyEvent(withTurn, { type: 'text', delta: 'new' });
    expect(r[0].parts).toEqual([{ type: 'text', text: 'old' }]);
    expect(r[2].parts).toEqual([{ type: 'text', text: 'new' }]);
  });

  it('a stats event during a stream changes nothing, including a pending row', () => {
    let m = applyEvent(turn(), { type: 'tool_call', id: '1', name: 'get_now', input: {} });
    const before = m[1].parts;
    m = applyEvent(m, { type: 'stats', stats: { wallMs: 10, direct: true } });
    expect(m[1].parts).toEqual(before);
  });
});

describe('pendingHint at the edges of a turn', () => {
  it('shows nothing after an error line, after plain text, and nothing when a pending tool row is last', () => {
    const errored = applyEvent(turn(), { type: 'error', message: 'x' })[1];
    expect(pendingHint(errored, true)).toBeNull();
    const pendingTool: Message = { role: 'assistant', parts: [tool('1', 'get_now')] };
    expect(pendingHint(pendingTool, true)).toBeNull();
    const finishedTool: Message = { role: 'assistant', parts: [{ type: 'text', text: 'a' }, tool('1', 'get_now', { pending: false, result: 1, isError: false })] };
    expect(pendingHint(finishedTool, true)).toBe('Working…');
    expect(pendingHint(finishedTool, false)).toBeNull();
  });
  it('a user message never has a hint, busy or not', () => {
    expect(pendingHint({ role: 'user', parts: [{ type: 'text', text: 'x' }] }, true)).toBeNull();
    expect(pendingHint({ role: 'user', parts: [] }, false)).toBeNull();
  });
});
