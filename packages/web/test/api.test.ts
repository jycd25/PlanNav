import { describe, it, expect } from 'vitest';
import { parseSse } from '../src/api.js';

describe('parseSse', () => {
  it('splits complete events and keeps the remainder', () => {
    const r = parseSse('data: {"type":"text","delta":"hi"}\n\ndata: {"type":"done"}\n\ndata: {"type":"te');
    expect(r.events).toEqual([{ type: 'text', delta: 'hi' }, { type: 'done' }]);
    expect(r.rest).toBe('data: {"type":"te');
  });
  it('ignores comments and blank chunks', () => {
    expect(parseSse(': ping\n\n\n\n').events).toEqual([]);
  });
});
