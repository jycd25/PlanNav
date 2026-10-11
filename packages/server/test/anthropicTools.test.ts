import { describe, it, expect } from 'vitest';
import { MemoryStore } from '@ds/core';
import { buildSdkTools } from '../src/assistant/anthropic.js';
import type { AssistantEvent } from '../src/assistant/types.js';

describe('buildSdkTools', () => {
  it('emits tool_result with the SDK tool_use id so the UI can match it to the call', async () => {
    const events: AssistantEvent[] = [];
    const sdkTools = buildSdkTools(new MemoryStore(), (e) => events.push(e), { now: () => new Date(2026, 9, 7, 9) });
    const getNow = sdkTools.find((t) => t.name === 'get_now')!;
    const out = await getNow.run({}, { toolUse: { id: 'toolu_123' } } as any);
    expect(typeof out).toBe('string');
    expect(events).toEqual([{ type: 'tool_result', id: 'toolu_123', name: 'get_now', result: JSON.parse(out as string) }]);
  });
  it('reports tool errors as a result with isError and still returns a string', async () => {
    const events: AssistantEvent[] = [];
    const sdkTools = buildSdkTools(new MemoryStore(), (e) => events.push(e), { now: () => new Date() });
    const mark = sdkTools.find((t) => t.name === 'mark_task')!;
    const out = await mark.run({ task: 'nope', status: 'done' }, { toolUse: { id: 'toolu_9' } } as any);
    expect(events[0]).toMatchObject({ type: 'tool_result', id: 'toolu_9', name: 'mark_task', isError: true });
    expect(JSON.parse(out as string).error).toMatch(/No task matches/);
  });
});
