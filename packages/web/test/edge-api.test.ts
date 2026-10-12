import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as api from '../src/api.js';
import type { AssistantEvent } from '../src/api.js';

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const errJson = (status: number, body: unknown, statusText = '') => new Response(JSON.stringify(body), { status, statusText, headers: { 'content-type': 'application/json' } });
const lastCall = () => fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit | undefined];

describe('request: errors', () => {
  it('a JSON error body becomes the Error message', async () => {
    fetchMock.mockResolvedValue(errJson(404, { error: 'Task not found: x' }, 'Not Found'));
    await expect(api.archiveTask('x')).rejects.toThrow('Task not found: x');
  });
  it('a 409 with a non-JSON body falls back to "409 Conflict"', async () => {
    fetchMock.mockResolvedValue(new Response('<html>conflict</html>', { status: 409, statusText: 'Conflict' }));
    await expect(api.saveBaseline([])).rejects.toThrow('409 Conflict');
  });
  it('a JSON error body without an "error" key falls back to the status line', async () => {
    fetchMock.mockResolvedValue(errJson(500, { message: 'nope' }, 'Internal Server Error'));
    await expect(api.getSettings()).rejects.toThrow('500 Internal Server Error');
  });
  it('an empty body with no status text gives "<status> "', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 502 }));
    await expect(api.getBaseline()).rejects.toThrow('502 ');
  });
  it('a network failure propagates the fetch error untouched', async () => {
    const netErr = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValue(netErr);
    await expect(api.getState(new Date(0), new Date(1))).rejects.toBe(netErr);
  });
  it('a 2xx with a malformed JSON body rejects with the parse error', async () => {
    fetchMock.mockResolvedValue(new Response('{not json', { status: 200 }));
    await expect(api.getSettings()).rejects.toThrow(SyntaxError);
  });
  it('the JSON error wins even on 409', async () => {
    fetchMock.mockResolvedValue(errJson(409, { error: 'Baseline version 3 was saved since' }, 'Conflict'));
    await expect(api.saveBaseline([])).rejects.toThrow('Baseline version 3 was saved since');
  });
});

describe('request: exact URLs, methods and bodies', () => {
  beforeEach(() => fetchMock.mockImplementation(async () => okJson({ ok: true })));

  it('getState encodes both bounds as ISO strings in the query and sends a JSON content-type', async () => {
    await api.getState(new Date('2026-10-05T04:00:00.000Z'), new Date('2026-10-12T04:00:00.000Z'));
    const [url, init] = lastCall();
    expect(url).toBe('/api/state?from=2026-10-05T04:00:00.000Z&to=2026-10-12T04:00:00.000Z');
    expect(init!.method).toBeUndefined();
    expect(init!.body).toBeUndefined();
    expect(init!.headers).toEqual({ 'content-type': 'application/json' });
  });
  it('putSettings PUTs the exact JSON', async () => {
    await api.putSettings({ settings: { memory: '- a' } as never });
    const [url, init] = lastCall();
    expect(url).toBe('/api/settings');
    expect(init!.method).toBe('PUT');
    expect(init!.body).toBe('{"settings":{"memory":"- a"}}');
  });
  it('trackBlock omits minutes unless given, and sends 0 when given 0', async () => {
    await api.trackBlock('b1', 'start');
    expect(lastCall()[1]!.body).toBe('{"action":"start"}');
    await api.trackBlock('b1', 'set', 45);
    expect(lastCall()).toEqual(['/api/blocks/b1/track', expect.objectContaining({ method: 'POST', body: '{"action":"set","minutes":45}' })]);
    await api.trackBlock('b1', 'set', 0);
    expect(lastCall()[1]!.body).toBe('{"action":"set","minutes":0}');
  });
  it('DELETEs carry no body', async () => {
    await api.deleteBlock('b1');
    expect(lastCall()).toEqual(['/api/blocks/b1', expect.objectContaining({ method: 'DELETE', body: undefined })]);
    await api.deleteRecurring('r1');
    expect(lastCall()[0]).toBe('/api/recurring/r1');
  });
  it('applyBaseline sends {} without a week and {weekOf} with one', async () => {
    await api.applyBaseline();
    expect(lastCall()[1]!.body).toBe('{}');
    await api.applyBaseline('2026-10-05');
    expect(lastCall()[1]!.body).toBe('{"weekOf":"2026-10-05"}');
  });
  it('importAsBaseline picks the endpoint by source and adds asBaseline', async () => {
    await api.importAsBaseline({ ics: 'BEGIN:VCALENDAR' });
    expect(lastCall()).toEqual(['/api/import', expect.objectContaining({ body: '{"ics":"BEGIN:VCALENDAR","asBaseline":true}' })]);
    await api.importAsBaseline({ url: 'https://x/basic.ics' });
    expect(lastCall()).toEqual(['/api/import-url', expect.objectContaining({ body: '{"url":"https://x/basic.ics","asBaseline":true}' })]);
  });
  it('resetChat and warmChat are empty POSTs', async () => {
    await api.resetChat();
    expect(lastCall()).toEqual(['/api/chat/reset', expect.objectContaining({ method: 'POST', body: undefined })]);
    await api.warmChat();
    expect(lastCall()[0]).toBe('/api/chat/warm');
  });
  it('patchBlock sends only the fields given, including an empty note', async () => {
    await api.patchBlock('b1', { note: '' });
    expect(lastCall()).toEqual(['/api/blocks/b1', expect.objectContaining({ method: 'PATCH', body: '{"note":""}' })]);
  });
  it('revertBaseline sends the version as a number', async () => {
    await api.revertBaseline(3);
    expect(lastCall()).toEqual(['/api/baseline/revert', expect.objectContaining({ method: 'POST', body: '{"version":3}' })]);
  });
});

describe('parseSse edges', () => {
  it('joins multi-line data fields with a newline before parsing', () => {
    expect(parse('data: {"a":\ndata: 1}\n\n')).toEqual({ events: [{ a: 1 }], rest: '' });
  });
  it('accepts "data:" without a space and ignores event/id lines', () => {
    expect(parse('event: message\nid: 7\ndata:{"type":"done"}\n\n')).toEqual({ events: [{ type: 'done' }], rest: '' });
  });
  it('skips a malformed event but keeps the good ones around it', () => {
    expect(parse('data: {"type":"done"}\n\ndata: {bad\n\ndata: 2\n\n').events).toEqual([{ type: 'done' }, 2]);
  });
  it('an event without a terminating blank line stays in rest, byte for byte', () => {
    expect(parse('data: {"type":"done"}')).toEqual({ events: [], rest: 'data: {"type":"done"}' });
  });
  it('CRLF blank lines are not event boundaries (the server sends LF)', () => {
    expect(parse('data: {"type":"done"}\r\n\r\n')).toEqual({ events: [], rest: 'data: {"type":"done"}\r\n\r\n' });
  });
  it('empty input', () => {
    expect(parse('')).toEqual({ events: [], rest: '' });
  });
});
const parse = (s: string) => api.parseSse(s);

describe('chat(): the streaming reader', () => {
  const stream = (chunks: string[]) => new ReadableStream<Uint8Array>({
    start(c) { const enc = new TextEncoder(); for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
  });
  const collect = async (gen: AsyncGenerator<AssistantEvent>) => { const out: AssistantEvent[] = []; for await (const e of gen) out.push(e); return out; };

  it('yields events in order even when a chunk boundary splits an event and a multi-byte character', async () => {
    const body = 'data: {"type":"text","delta":"héllo"}\n\ndata: {"type":"done"}\n\n';
    const bytes = new TextEncoder().encode(body);
    const cut = body.indexOf('é') + 1; // byte offset lands inside the two-byte "é"
    fetchMock.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice(0, cut)); c.enqueue(bytes.slice(cut, cut + 20)); c.enqueue(bytes.slice(cut + 20)); c.close(); } }), { status: 200 }));
    expect(await collect(api.chat('hi'))).toEqual([{ type: 'text', delta: 'héllo' }, { type: 'done' }]);
  });
  it('posts the message as JSON and passes the abort signal through', async () => {
    fetchMock.mockResolvedValue(new Response(stream(['data: {"type":"done"}\n\n']), { status: 200 }));
    const ac = new AbortController();
    await collect(api.chat('plan my day', ac.signal));
    const [url, init] = lastCall();
    expect(url).toBe('/api/chat');
    expect(init).toMatchObject({ method: 'POST', body: '{"message":"plan my day"}', headers: { 'content-type': 'application/json' } });
    expect(init!.signal).toBe(ac.signal);
  });
  it('a trailing event without its blank line is never yielded', async () => {
    fetchMock.mockResolvedValue(new Response(stream(['data: {"type":"text","delta":"a"}\n\ndata: {"type":"done"}']), { status: 200 }));
    expect(await collect(api.chat('x'))).toEqual([{ type: 'text', delta: 'a' }]);
  });
  it('a non-OK response throws the JSON error, or "chat failed: <status>" without one', async () => {
    fetchMock.mockResolvedValue(errJson(429, { error: 'Rate limited' }));
    await expect(collect(api.chat('x'))).rejects.toThrow('Rate limited');
    fetchMock.mockResolvedValue(new Response('busy', { status: 503 }));
    await expect(collect(api.chat('x'))).rejects.toThrow('chat failed: 503');
  });
  it('an OK response without a body is reported as a failure with its status', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: null, json: async () => ({}) } as unknown as Response);
    await expect(collect(api.chat('x'))).rejects.toThrow('chat failed: 200');
  });
  it('an aborted fetch rejects before any event', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));
    await expect(collect(api.chat('x'))).rejects.toMatchObject({ name: 'AbortError' });
  });
});
