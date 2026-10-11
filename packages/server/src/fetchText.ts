import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 5_000_000;
const MAX_REDIRECTS = 5;

/** Loopback, link-local, private (RFC 1918), ULA, unspecified, and IPv4-mapped forms of those. */
export function isPrivateAddress(ip: string): boolean {
  let a = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  if (isIP(a) === 4) {
    const [x, y] = a.split('.').map(Number);
    return x === 127 || x === 10 || x === 0 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
  }
  if (isIP(a) === 6) {
    if (a === '::1' || a === '::') return true;
    return a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb');
  }
  return false;
}

/** Reject URLs that are not https or that resolve to a private address. Returns the parsed URL. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`Not a valid URL: ${raw}`); }
  if (url.protocol !== 'https:') throw new Error('Calendar URLs must use https (webcal:// is converted automatically).');
  if (url.username || url.password) throw new Error('Calendar URLs must not contain credentials.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Calendar URLs must point to a public host, not a private address.');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((r) => r.address);
  if (addresses.length === 0) throw new Error(`Could not resolve ${host}.`);
  if (addresses.some(isPrivateAddress)) throw new Error('Calendar URLs must point to a public host, not a private address.');
  return url;
}

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new Error('The calendar file is larger than 5 MB.');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { await reader.cancel(); throw new Error('The calendar file is larger than 5 MB.'); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Fetch a calendar URL as text: https only, public hosts only (re-checked on every redirect), 15 s timeout, 5 MB cap. */
export async function fetchText(raw: string): Promise<string> {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'manual', headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5' } });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`Could not fetch the calendar: redirect without a location (${res.status}).`);
      url = await assertPublicUrl(new URL(location, url).toString());
      continue;
    }
    if (!res.ok) throw new Error(`Could not fetch the calendar: ${res.status} ${res.statusText}`);
    return readCapped(res);
  }
  throw new Error('Could not fetch the calendar: too many redirects.');
}
