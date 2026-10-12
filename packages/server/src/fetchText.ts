import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 5_000_000;
const MAX_REDIRECTS = 5;

/** Expand a valid IPv6 literal to its eight 16-bit groups (zone id stripped, a dotted IPv4 tail folded into the last two). */
function hextets(ip: string): number[] {
  const groups = ip.replace(/%.*$/, '').split(':');
  const last = groups[groups.length - 1];
  if (last.includes('.')) {
    const [a, b, c, d] = last.split('.').map(Number);
    groups.splice(groups.length - 1, 1, ((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
  }
  const gap = groups.indexOf('');
  if (gap !== -1) {
    const filled = groups.filter((g) => g !== '');
    groups.splice(0, groups.length, ...groups.slice(0, gap).filter((g) => g !== ''), ...Array<string>(8 - filled.length).fill('0'), ...groups.slice(gap).filter((g) => g !== ''));
  }
  return groups.map((g) => parseInt(g, 16));
}

/** The IPv4 an IPv6 address carries, if it is IPv4-mapped (`::ffff:a.b.c.d`, or `::ffff:xxxx:xxxx` as the URL parser writes it), the deprecated SIIT form (`::ffff:0:a.b.c.d`), or IPv4-compatible (`::a.b.c.d`); else null. */
function embeddedIPv4(ip: string): { v4: string; mapped: boolean } | null {
  const h = hextets(ip);
  if (h.length !== 8 || h.slice(0, 4).some((g) => g !== 0)) return null;
  const mapped = (h[4] === 0 && h[5] === 0xffff) || (h[4] === 0xffff && h[5] === 0);
  if (!mapped && (h[4] !== 0 || h[5] !== 0)) return null;
  return { v4: `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`, mapped };
}

function isPrivateIPv4(a: string, { withZeroNet = true } = {}): boolean {
  const [x, y] = a.split('.').map(Number);
  return x === 127 || x === 10 || (withZeroNet && x === 0) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
}

/** Loopback, link-local, private (RFC 1918), CGNAT, unspecified, ULA, and every IPv4-mapped or IPv4-compatible form of those, including the hex form the URL parser produces (`[::ffff:7f00:1]`). */
export function isPrivateAddress(ip: string): boolean {
  const a = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(a) === 4) return isPrivateIPv4(a);
  if (isIP(a) === 6) {
    if (a === '::1' || a === '::') return true;
    const inner = embeddedIPv4(a);
    // Node connects a mapped address as the IPv4 it carries, so 0/8 counts there; the deprecated compatible prefix is
    // not translated by the OS, so only its loopback/private payloads are refused (`::2` stays as public as it was).
    if (inner) return isPrivateIPv4(inner.v4, { withZeroNet: inner.mapped });
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
