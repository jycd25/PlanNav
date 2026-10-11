import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openerCommand, shouldOpen } from '../lib/open.mjs';

test('openerCommand picks the platform opener', () => {
  assert.deepEqual(openerCommand('http://x/', 'darwin'), ['open', ['http://x/']]);
  assert.deepEqual(openerCommand('http://x/', 'linux'), ['xdg-open', ['http://x/']]);
  assert.deepEqual(openerCommand('http://x/', 'win32'), ['cmd', ['/c', 'start', '', 'http://x/']]);
});

test('shouldOpen is on by default and off with --no-open, PLANNAV_OPEN=0, or CI', () => {
  assert.equal(shouldOpen([], {}), true);
  assert.equal(shouldOpen(['--no-open'], {}), false);
  assert.equal(shouldOpen([], { PLANNAV_OPEN: '0' }), false);
  assert.equal(shouldOpen([], { PLANNAV_OPEN: 'false' }), false);
  assert.equal(shouldOpen([], { CI: 'true' }), false);
});
