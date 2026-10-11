import { describe, it, expect } from 'vitest';
import { applyEvent, pendingHint, type Message } from '../src/chat/reducer.js';

describe('applyEvent', () => {
  it('builds an assistant message from a stream of events', () => {
    let m: Message[] = [{ role: 'user', parts: [{ type: 'text', text: 'plan my day' }] }, { role: 'assistant', parts: [] }];
    m = applyEvent(m, { type: 'text', delta: 'Plan' });
    m = applyEvent(m, { type: 'text', delta: 'ning.' });
    m = applyEvent(m, { type: 'tool_call', id: '1', name: 'plan_schedule', input: {} });
    m = applyEvent(m, { type: 'tool_result', id: '1', name: 'plan_schedule', result: { created: [] } });
    m = applyEvent(m, { type: 'text', delta: ' Done.' });
    expect(m[1].parts).toEqual([
      { type: 'text', text: 'Planning.' },
      { type: 'tool', id: '1', name: 'plan_schedule', input: {}, result: { created: [] }, isError: false, pending: false },
      { type: 'text', text: ' Done.' },
    ]);
  });
  it('matches tool results by id even when the call was emitted after the result', () => {
    let m: Message[] = [{ role: 'assistant', parts: [] }];
    m = applyEvent(m, { type: 'tool_result', id: 'x', name: 'get_now', result: 1 });
    expect(m[0].parts).toEqual([{ type: 'tool', id: 'x', name: 'get_now', input: undefined, result: 1, isError: false, pending: false }]);
  });
  it('appends errors as text', () => {
    const m = applyEvent([{ role: 'assistant', parts: [] }], { type: 'error', message: 'boom' });
    expect(m[0].parts).toEqual([{ type: 'text', text: 'Error: boom' }]);
  });
  it('a turn\'s stats event adds nothing to the message', () => {
    const m = applyEvent([{ role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] }], { type: 'stats', stats: { wallMs: 7900, ttftMs: 2100, numTurns: 2 } });
    expect(m[0].parts).toEqual([{ type: 'text', text: 'Done.' }]);
  });
  it('ignores events when the last message is not an assistant turn', () => {
    const m: Message[] = [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
    expect(applyEvent(m, { type: 'text', delta: 'x' })).toBe(m);
  });
});

describe('pendingHint: something is always moving while a reply is on its way', () => {
  const tool = (pending: boolean) => ({ type: 'tool' as const, id: '1', name: 'mark_task', input: {}, pending });
  it('Thinking… before anything arrives, Working… after a finished tool row while the reply is written, nothing once text streams or when idle', () => {
    expect(pendingHint({ role: 'assistant', parts: [] }, true)).toBe('Thinking…');
    expect(pendingHint({ role: 'assistant', parts: [tool(false)] }, true)).toBe('Working…');
    expect(pendingHint({ role: 'assistant', parts: [tool(true)] }, true)).toBeNull(); // the pending tool row shows it
    expect(pendingHint({ role: 'assistant', parts: [tool(false), { type: 'text', text: 'Leet' }] }, true)).toBeNull();
    expect(pendingHint({ role: 'assistant', parts: [] }, false)).toBeNull();
    expect(pendingHint({ role: 'user', parts: [] }, true)).toBeNull();
  });
});
