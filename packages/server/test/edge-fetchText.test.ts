import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// The DNS lookup fetchText uses is replaced by a table: a host resolves to the addresses listed, or not at all.
const dns = vi.hoisted(() => ({ table: new Map<string, string[]>(), calls: [] as string[] }));
vi.mock('node:dns/promises', () => ({
  lookup: async (host: string) => {
    dns.calls.push(host);
    const addrs = dns.table.get(host);
    if (!addrs) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  },
}));

import { assertPublicUrl, fetchText, isPrivateAddress } from '../src/fetchText.js';

beforeEach(() => {
  dns.table.clear();
  dns.calls.length = 0;
  dns.table.set('example.com', ['93.184.216.34']);
  dns.table.set('cdn.example.com', ['93.184.216.35', '2606:2800:220:1:248:1893:25c8:1946']);
  dns.table.set('intranet.example', ['10.0.0.5']);
  dns.table.set('mixed.example', ['93.184.216.34', '192.168.1.1']);
  dns.table.set('v6private.example', ['fd12:3456::1']);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('isPrivateAddress: the ranges and their edges', () => {
  it('covers each range boundary', () => {
    const priv = ['10.0.0.0', '10.255.255.255', '172.16.0.0', '172.31.255.255', '192.168.0.0', '192.168.255.255', '127.0.0.1', '127.255.255.255', '169.254.0.1', '0.0.0.0', '0.1.2.3', '100.64.0.0', '100.127.255.255'];
    for (const a of priv) expect(isPrivateAddress(a), a).toBe(true);
    const pub = ['9.255.255.255', '11.0.0.0', '172.15.255.255', '172.32.0.0', '192.167.255.255', '192.169.0.0', '126.255.255.255', '128.0.0.1', '169.253.0.1', '169.255.0.1', '100.63.255.255', '100.128.0.0', '1.1.1.1', '8.8.4.4'];
    for (const a of pub) expect(isPrivateAddress(a), a).toBe(false);
  });

  it('handles IPv6 loopback, unspecified, ULA, link-local, and the IPv4-mapped forms, case- and space-insensitively', () => {
    for (const a of ['::1', '::', 'fc00::', 'fdff:ffff::1', 'fe80::1', 'fe90::1', 'fea0::1', 'febf::1', 'FD12::1', 'FE80::ABCD', '::ffff:127.0.0.1', '::ffff:192.168.1.1', '::ffff:10.1.1.1', '::FFFF:172.16.0.1', ' ::1 ', '  10.0.0.1\n', 'fe80::1%en0']) { // a zone id is still an IP to node:net
      expect(isPrivateAddress(a), JSON.stringify(a)).toBe(true);
    }
    for (const a of ['::ffff:8.8.8.8', '::ffff:1.1.1.1', 'fec0::1', 'fe7f::1', 'fecf::1', '2001:db8::1', '2606:4700::1111', '::2', 'fb00::1']) {
      expect(isPrivateAddress(a), a).toBe(false);
    }
  });

  it('treats anything that is not an IP as not private (the hostname checks happen elsewhere)', () => {
    for (const a of ['localhost', 'example.com', '', '10.0.0', '256.1.1.1', '10.0.0.1/8', '::ffff:999.1.1.1']) {
      expect(isPrivateAddress(a), JSON.stringify(a)).toBe(false);
    }
  });
});

describe('assertPublicUrl: scheme, credentials, hostname and resolved addresses', () => {
  it('refuses every scheme but https with the exact message, and malformed URLs by name', async () => {
    for (const u of ['http://example.com/a.ics', 'webcal://example.com/a.ics', 'file:///etc/passwd', 'ftp://example.com/a.ics', 'javascript:alert(1)', 'data:text/calendar,BEGIN']) {
      await expect(assertPublicUrl(u), u).rejects.toThrow('Calendar URLs must use https (webcal:// is converted automatically).');
    }
    await expect(assertPublicUrl('not a url')).rejects.toThrow('Not a valid URL: not a url');
    await expect(assertPublicUrl('')).rejects.toThrow('Not a valid URL: ');
    await expect(assertPublicUrl('https://')).rejects.toThrow(/Not a valid URL/);
    expect(dns.calls).toEqual([]); // none of these reached the resolver
  });

  it('refuses credentials before resolving', async () => {
    await expect(assertPublicUrl('https://user:pw@example.com/a.ics')).rejects.toThrow('Calendar URLs must not contain credentials.');
    await expect(assertPublicUrl('https://user@example.com/a.ics')).rejects.toThrow('Calendar URLs must not contain credentials.');
    await expect(assertPublicUrl('https://:pw@example.com/a.ics')).rejects.toThrow('Calendar URLs must not contain credentials.');
    expect(dns.calls).toEqual([]);
  });

  it('refuses localhost names, .localhost and .local hosts, and literal private addresses without a lookup', async () => {
    const msg = 'Calendar URLs must point to a public host, not a private address.';
    for (const u of ['https://localhost/a.ics', 'https://LOCALHOST:8443/a.ics', 'https://api.localhost/a.ics', 'https://printer.local/a.ics', 'https://127.0.0.1/a.ics', 'https://10.1.2.3:443/a', 'https://192.168.0.1/a', 'https://172.16.0.1/a', 'https://169.254.169.254/latest/meta-data', 'https://100.64.0.1/a', 'https://0.0.0.0/a', 'https://[::1]/a.ics', 'https://[fe80::1]/a', 'https://[fd00::1]/a']) {
      await expect(assertPublicUrl(u), u).rejects.toThrow(msg);
    }
    expect(dns.calls).toEqual([]);
  });

  // The WHATWG URL parser rewrites an IPv4-mapped literal to its hex form (`https://[::ffff:127.0.0.1]/` has hostname
  // `[::ffff:7f00:1]`), so the private check must canonicalise every mapped or compatible form to its IPv4 first.
  it('refuses an IPv4-mapped loopback or private literal in the hex form the URL parser produces', async () => {
    const msg = 'Calendar URLs must point to a public host, not a private address.';
    for (const u of ['https://[::ffff:127.0.0.1]/a', 'https://[::ffff:7f00:1]/a', 'https://[::FFFF:7F00:1]/a', 'https://[::ffff:10.0.0.1]/a', 'https://[::ffff:a00:1]/a', 'https://[::ffff:c0a8:101]/a', 'https://[::ffff:a9fe:a9fe]/a', 'https://[::ffff:6440:1]/a', 'https://[::ffff:0:127.0.0.1]/a', 'https://[::ffff:0:7f00:1]/a', 'https://[::127.0.0.1]/a', 'https://[::7f00:1]/a', 'https://[::ffff:0.0.0.0]/a', 'https://[::ffff:0:0]/a']) {
      await expect(assertPublicUrl(u), u).rejects.toThrow(msg);
    }
    expect(dns.calls).toEqual([]);
    const pub = await assertPublicUrl('https://[::ffff:808:808]/a'); // 8.8.8.8 stays public
    expect(pub.hostname).toBe('[::ffff:808:808]');
    await expect(assertPublicUrl('https://[::ffff:8.8.8.8]/a')).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('https://[::ffff:0:808:808]/a')).resolves.toBeInstanceOf(URL);
    expect(dns.calls).toEqual([]);
  });

  it('isPrivateAddress canonicalises IPv4-mapped (hex, dotted, deprecated ::ffff:0:) and IPv4-compatible forms, with or without brackets', () => {
    for (const a of ['::ffff:7f00:1', '::FFFF:7F00:1', '[::ffff:7f00:1]', '::ffff:a00:1', '::ffff:c0a8:101', '::ffff:ac10:1', '::ffff:a9fe:a9fe', '::ffff:6440:1', '::ffff:0:0', '::ffff:0:7f00:1', '::ffff:0:127.0.0.1', '::7f00:1', '::127.0.0.1', '::a00:1', '0:0:0:0:0:ffff:7f00:1', '0000:0000:0000:0000:0000:ffff:7f00:0001', '::ffff:7f00:1%en0']) {
      expect(isPrivateAddress(a), JSON.stringify(a)).toBe(true);
    }
    for (const a of ['::ffff:808:808', '::FFFF:808:808', '[::ffff:808:808]', '::ffff:101:101', '::ffff:0:808:808', '::808:808', '::ffff:ac20:1', '::ffff:a9fd:1', '::ffff:6480:1', '0:0:0:0:0:ffff:808:808', '::fffe:7f00:1', '1::ffff:7f00:1', '::ffff:0:1:7f00:1']) { // the last four are not mapped addresses at all
      expect(isPrivateAddress(a), JSON.stringify(a)).toBe(false);
    }
  });

  it('accepts a public literal address without a lookup, and a public hostname after one; the parsed URL comes back', async () => {
    const ip = await assertPublicUrl('https://93.184.216.34/a.ics?x=1');
    expect(ip.hostname).toBe('93.184.216.34');
    expect(ip.search).toBe('?x=1');
    expect(dns.calls).toEqual([]);
    const named = await assertPublicUrl('HTTPS://Example.COM/A.ics#frag');
    expect(named.protocol).toBe('https:');
    expect(named.hostname).toBe('example.com');
    expect(named.href).toBe('https://example.com/A.ics#frag');
    expect(dns.calls).toEqual(['example.com']);
    const v6 = await assertPublicUrl('https://[2606:4700::1111]/a');
    expect(v6.hostname).toBe('[2606:4700::1111]');
  });

  it('refuses a host that does not resolve, or that resolves to any private address (even one of several)', async () => {
    await expect(assertPublicUrl('https://nope.invalid/a.ics')).rejects.toThrow('Could not resolve nope.invalid.');
    await expect(assertPublicUrl('https://intranet.example/a.ics')).rejects.toThrow('Calendar URLs must point to a public host, not a private address.');
    await expect(assertPublicUrl('https://mixed.example/a.ics')).rejects.toThrow('Calendar URLs must point to a public host, not a private address.');
    await expect(assertPublicUrl('https://v6private.example/a.ics')).rejects.toThrow('Calendar URLs must point to a public host, not a private address.');
    await expect(assertPublicUrl('https://cdn.example.com/a.ics')).resolves.toBeInstanceOf(URL);
  });
});

type Call = { url: string; init: RequestInit };
function stubFetch(handler: (url: string, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, calls.length);
  });
  return calls;
}
const redirect = (status: number, location?: string) => new Response(null, { status, headers: location === undefined ? {} : { location } });

describe('fetchText: no network, every path mocked', () => {
  it('fetches a public https URL once with manual redirects, a calendar accept header and a timeout signal, and returns the body', async () => {
    const calls = stubFetch(() => new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { status: 200, headers: { 'content-type': 'text/calendar' } }));
    expect(await fetchText('https://example.com/a.ics')).toBe('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.com/a.ics');
    expect(calls[0].init.redirect).toBe('manual');
    expect((calls[0].init.headers as Record<string, string>).accept).toBe('text/calendar, text/plain;q=0.9, */*;q=0.5');
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('never calls fetch for a URL that fails the public check', async () => {
    const calls = stubFetch(() => new Response('x'));
    await expect(fetchText('http://example.com/a.ics')).rejects.toThrow(/https/);
    await expect(fetchText('https://localhost/a.ics')).rejects.toThrow(/private/);
    await expect(fetchText('https://intranet.example/a.ics')).rejects.toThrow(/private/);
    await expect(fetchText('file:///etc/hosts')).rejects.toThrow(/https/);
    expect(calls).toEqual([]);
  });

  it('follows a redirect to another public host, resolving a relative location against the current URL', async () => {
    const calls = stubFetch((url) => (url === 'https://example.com/a.ics' ? redirect(302, '/moved/b.ics') : url === 'https://example.com/moved/b.ics' ? redirect(301, 'https://cdn.example.com/c.ics') : new Response('final')));
    expect(await fetchText('https://example.com/a.ics')).toBe('final');
    expect(calls.map((c) => c.url)).toEqual(['https://example.com/a.ics', 'https://example.com/moved/b.ics', 'https://cdn.example.com/c.ics']);
    expect(dns.calls).toEqual(['example.com', 'example.com', 'cdn.example.com']); // re-checked on every hop
  });

  it('refuses a redirect to a private host, to a literal private address, or to http, and stops there', async () => {
    const privateHost = stubFetch(() => redirect(302, 'https://intranet.example/evil.ics'));
    await expect(fetchText('https://example.com/a.ics')).rejects.toThrow('Calendar URLs must point to a public host, not a private address.');
    expect(privateHost).toHaveLength(1);
    vi.unstubAllGlobals();
    const literal = stubFetch(() => redirect(307, 'https://10.0.0.1/evil.ics'));
    await expect(fetchText('https://example.com/a.ics')).rejects.toThrow(/private address/);
    expect(literal).toHaveLength(1);
    vi.unstubAllGlobals();
    const metadata = stubFetch(() => redirect(302, 'https://169.254.169.254/latest/meta-data/'));
    await expect(fetchText('https://example.com/a.ics')).rejects.toThrow(/private address/);
    expect(metadata).toHaveLength(1);
    vi.unstubAllGlobals();
    const mappedLoopback = stubFetch(() => redirect(302, 'https://[::ffff:7f00:1]/evil.ics'));
    await expect(fetchText('https://example.com/a.ics')).rejects.toThrow(/private address/);
    expect(mappedLoopback).toHaveLength(1);
    vi.unstubAllGlobals();
    const mappedMetadata = stubFetch(() => redirect(302, 'https://[::ffff:169.254.169.254]/latest/meta-data/'));
    await expect(fetchText('https://example.com/a.ics')).rejects.toThrow(/private address/);
    expect(mappedMetadata).toHaveLength(1);
    vi.unstubAllGlobals();
    const compatLoopback = stubFetch(() => redirect(302, 'https://[::7f00:1]/evil.ics'));
    await expect(fetchText('https://example.com/a.ics')).rejects.toThrow(/private address/);
    expect(compatLoopback).toHaveLength(1);
    vi.unstubAllGlobals();
    const downgrade = stubFetch(() => redirect(302, 'http://example.com/a.ics'));
    await expect(fetchText('https://example.com/a.ics')).rejects.toThrow(/must use https/);
    expect(downgrade).toHaveLength(1);
    vi.unstubAllGlobals();
    const creds = stubFetch(() => redirect(302, 'https://u:p@example.com/a.ics'));
    await expect(fetchText('https://example.com/a.ics')).rejects.toThrow(/credentials/);
    expect(creds).toHaveLength(1);
  });

  it('follows a redirect to a public IPv4-mapped literal', async () => {
    const calls = stubFetch((url) => (url === 'https://example.com/a.ics' ? redirect(302, 'https://[::ffff:8.8.8.8]/c.ics') : new Response('mapped')));
    expect(await fetchText('https://example.com/a.ics')).toBe('mapped');
    expect(calls.map((c) => c.url)).toEqual(['https://example.com/a.ics', 'https://[::ffff:808:808]/c.ics']);
  });

  it('a redirect without a location names the status; too many redirects stop after six fetches', async () => {
    const noLocation = stubFetch(() => redirect(303));
    await expect(fetchText('https://example.com/a.ics')).rejects.toThrow('Could not fetch the calendar: redirect without a location (303).');
    expect(noLocation).toHaveLength(1);
    vi.unstubAllGlobals();
    const loop = stubFetch((_u, n) => redirect(302, `https://example.com/${n}.ics`));
    await expect(fetchText('https://example.com/0.ics')).rejects.toThrow('Could not fetch the calendar: too many redirects.');
    expect(loop.map((c) => c.url)).toEqual(['https://example.com/0.ics', 'https://example.com/1.ics', 'https://example.com/2.ics', 'https://example.com/3.ics', 'https://example.com/4.ics', 'https://example.com/5.ics']);
  });

  it('exactly five redirects are still followed', async () => {
    const calls = stubFetch((_u, n) => (n <= 5 ? redirect(302, `https://example.com/${n}.ics`) : new Response('ok')));
    expect(await fetchText('https://example.com/0.ics')).toBe('ok');
    expect(calls).toHaveLength(6);
  });

  it('a non-2xx status is an error with the status and text', async () => {
    stubFetch(() => new Response('nope', { status: 404, statusText: 'Not Found' }));
    await expect(fetchText('https://example.com/a.ics')).rejects.toThrow('Could not fetch the calendar: 404 Not Found');
    vi.unstubAllGlobals();
    stubFetch(() => new Response('', { status: 500, statusText: 'Internal Server Error' }));
    await expect(fetchText('https://example.com/a.ics')).rejects.toThrow('Could not fetch the calendar: 500 Internal Server Error');
  });

  it('refuses a declared content-length over 5 MB before reading the body', async () => {
    let read = false;
    const body = new ReadableStream<Uint8Array>({ pull(c) { read = true; c.enqueue(new TextEncoder().encode('x')); c.close(); } }, { highWaterMark: 0 });
    stubFetch(() => new Response(body, { status: 200, headers: { 'content-length': String(5_000_001) } }));
    await expect(fetchText('https://example.com/a.ics')).rejects.toThrow('The calendar file is larger than 5 MB.');
    expect(read).toBe(false);
  });

  it('stops reading a streamed body that grows past 5 MB and cancels the stream; one at the limit is fine', async () => {
    let cancelled = false;
    const chunk = new Uint8Array(1_000_000).fill(120); // 'x'
    let pulled = 0;
    const make = (chunks: number) => new ReadableStream<Uint8Array>({
      pull(c) { pulled += 1; if (chunks-- > 0) c.enqueue(chunk); else c.close(); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    stubFetch(() => new Response(make(50), { status: 200 }));
    await expect(fetchText('https://example.com/a.ics')).rejects.toThrow('The calendar file is larger than 5 MB.');
    expect(cancelled).toBe(true);
    expect(pulled).toBe(6); // the sixth chunk crossed the cap; nothing more was read
    vi.unstubAllGlobals();
    stubFetch(() => new Response(make(5), { status: 200 }));
    const text = await fetchText('https://example.com/a.ics');
    expect(text).toHaveLength(5_000_000);
    expect(text[0]).toBe('x');
  });

  it('a response without a body is the empty string; a multi-byte body is decoded as UTF-8 across chunk boundaries', async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    expect(await fetchText('https://example.com/a.ics')).toBe('');
    vi.unstubAllGlobals();
    const bytes = new TextEncoder().encode('SUMMARY:Café ✓ Zürich');
    const stream = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3)); c.close(); },
    });
    stubFetch(() => new Response(stream, { status: 200 }));
    expect(await fetchText('https://example.com/a.ics')).toBe('SUMMARY:Café ✓ Zürich');
  });

  it('a fetch that throws (network down, timeout) propagates its error', async () => {
    stubFetch(() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
    await expect(fetchText('https://example.com/a.ics')).rejects.toThrow(/aborted due to timeout/);
  });
});
