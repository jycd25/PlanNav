import { describe, it, expect } from 'vitest';
import { assertPublicUrl, isPrivateAddress } from '../src/fetchText.js';

describe('isPrivateAddress', () => {
  it('flags loopback, link-local, private ranges, and ULA', () => {
    for (const a of ['127.0.0.1', '127.9.9.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '172.32.0.1', '142.250.1.1', '2607:f8b0::1']) expect(isPrivateAddress(a), a).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  it('requires https and rejects private hosts', async () => {
    await expect(assertPublicUrl('http://example.com/a.ics')).rejects.toThrow(/https/);
    await expect(assertPublicUrl('https://127.0.0.1/a.ics')).rejects.toThrow(/private/i);
    await expect(assertPublicUrl('https://localhost/a.ics')).rejects.toThrow(/private/i);
    await expect(assertPublicUrl('https://[::1]/a.ics')).rejects.toThrow(/private/i);
    await expect(assertPublicUrl('https://user:pw@example.com/a.ics')).rejects.toThrow(/credentials/i);
  });
});
