import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'plannav.mjs');

test('--version prints the package version', async () => {
  const out = await run([bin, '--version']);
  assert.match(out.trim(), /^\d+\.\d+\.\d+/);
});

test('the bundled server serves the API and the web UI', { skip: !existsSync(join(here, '..', 'dist', 'server.js')) && 'dist not built' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plannav-smoke-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [bin], { env: { ...process.env, PORT: String(port), PLANNAV_DB_PATH: join(dir, 'data.sqlite') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  try {
    const base = `http://127.0.0.1:${port}`;
    const settings = await waitFor(() => fetch(`${base}/api/settings`), log);
    assert.equal(settings.status, 200);
    const body = await settings.json();
    assert.ok(body.assistant, `settings payload has an assistant section: ${JSON.stringify(body)}`);
    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /<div id="root">/);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    rmSync(dir, { recursive: true, force: true });
  }
});

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
  });
}

async function waitFor(fn, log, ms = 10000) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    try { return await fn(); } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not come up: ${last?.message}\n${log}`);
}
