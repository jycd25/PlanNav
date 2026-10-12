// Edge cases of the npm package without publishing or a network: build.mjs run in an isolated tree (the bundler keeps
// the dependencies external and inlines the workspace code; the missing-build message), the bin's flags, and the
// opener helpers against a local server. Nothing here touches this package's own dist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openerCommand, shouldOpen, waitForServer } from '../lib/open.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..');
const bin = join(pkgDir, 'bin', 'plannav.mjs');
const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;

/** Runs node on `args`; resolves { code, out, err }. */
function run(args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (code) => resolve({ code, out, err }));
  });
}

/**
 * A throwaway monorepo slice: build.mjs copied next to a package.json naming two dependencies, this package's
 * node_modules linked in (esbuild resolves from there), tiny @ds/server and @ds/web builds, and a root README.
 */
function buildTree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannav-build-'))); // macOS: /var -> /private/var, as Node resolves the module's own path
  const plannav = join(root, 'packages', 'plannav');
  const server = join(root, 'packages', 'server', 'dist');
  const web = join(root, 'packages', 'web', 'dist', 'assets');
  mkdirSync(plannav, { recursive: true }); mkdirSync(server, { recursive: true }); mkdirSync(web, { recursive: true });
  cpSync(join(pkgDir, 'build.mjs'), join(plannav, 'build.mjs'));
  symlinkSync(join(pkgDir, 'node_modules'), join(plannav, 'node_modules'), 'dir');
  writeFileSync(join(plannav, 'package.json'), JSON.stringify({ name: 'plannav', dependencies: { hono: '^4', zod: '^4' } }));
  writeFileSync(join(server, 'index.js'), 'import { Hono } from "hono";\nimport { greet } from "./util.js";\nexport const app = new Hono();\nconsole.log(greet("server"));\n');
  writeFileSync(join(server, 'util.js'), 'export const greet = (x) => `hello ${x}`;\n');
  writeFileSync(join(server, 'mcp.js'), 'import { z } from "zod";\nexport const schema = z.string();\n');
  writeFileSync(join(web, '..', 'index.html'), '<!doctype html><div id="root"></div>\n');
  writeFileSync(join(web, 'a.css'), 'body{}\n');
  writeFileSync(join(root, 'README.md'), '# Root README\n\nThe source of truth.\n');
  return { root, plannav, server, web: join(web, '..') };
}

test('build.mjs bundles the server entries with the dependencies external and the workspace code inlined, copies the web build and the root README', async () => {
  const t = buildTree();
  try {
    const r = await run([join(t.plannav, 'build.mjs')], { cwd: t.plannav });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'plannav build: dist/server.js, dist/mcp.js, dist/web, README.md\n');
    const dist = join(t.plannav, 'dist');
    for (const f of ['server.js', 'mcp.js', join('web', 'index.html'), join('web', 'assets', 'a.css')]) assert.ok(existsSync(join(dist, f)), `${f} is in dist`);
    const server = readFileSync(join(dist, 'server.js'), 'utf8');
    assert.match(server, /^import \{ Hono \} from "hono";$/m, 'hono stays an import');
    assert.doesNotMatch(server, /from "\.\/util\.js"/, 'the relative module is inlined');
    assert.match(server, /`hello \$\{x\}`/, 'the inlined module\'s code is present');
    const mcp = readFileSync(join(dist, 'mcp.js'), 'utf8');
    assert.match(mcp, /^import \{ z \} from "zod";$/m);
    assert.equal(readFileSync(join(t.plannav, 'README.md'), 'utf8'), readFileSync(join(t.root, 'README.md'), 'utf8'));
    assert.equal(readFileSync(join(dist, 'web', 'index.html'), 'utf8'), '<!doctype html><div id="root"></div>\n');
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('build.mjs refuses when @ds/server or @ds/web is not built: exit 1, the exact message naming the missing file, and the old dist untouched', async () => {
  const t = buildTree();
  try {
    const stale = join(t.plannav, 'dist', 'stale.txt');
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, 'old');
    rmSync(join(t.server, 'index.js'));
    let r = await run([join(t.plannav, 'build.mjs')], { cwd: t.plannav });
    assert.equal(r.code, 1);
    assert.equal(r.err, `plannav build: @ds/server is not built (${join(t.server, 'index.js')} missing). Run \`pnpm build\` from the repo root.\n`);
    assert.equal(r.out, '');
    assert.ok(existsSync(stale), 'dist is not cleared before the check passes');
    writeFileSync(join(t.server, 'index.js'), 'export const app = 1;\n');
    rmSync(join(t.web, 'index.html'));
    r = await run([join(t.plannav, 'build.mjs')], { cwd: t.plannav });
    assert.equal(r.code, 1);
    assert.equal(r.err, `plannav build: @ds/web is not built (${join(t.web, 'index.html')} missing). Run \`pnpm build\` from the repo root.\n`);
    assert.ok(existsSync(stale));
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('the bin: --help and -h print the usage and exit 0 without starting anything; --help wins over --version', async () => {
  for (const flag of ['--help', '-h']) {
    const r = await run([bin, flag]);
    assert.equal(r.code, 0);
    assert.equal(r.err, '');
    assert.equal(r.out.split('\n')[0], 'plannav — local-first calendar with a scheduling assistant');
    assert.match(r.out, /^  plannav --no-open       start without opening a browser$/m);
    assert.match(r.out, /^  PLANNAV_DB_PATH   SQLite file \(default ~\/\.plannav\/data\.sqlite\)$/m);
  }
  const both = await run([bin, '--version', '--help']);
  assert.equal(both.out.split('\n')[0], 'plannav — local-first calendar with a scheduling assistant');
});

test('the bin: --version and -v print exactly the package.json version', async () => {
  for (const flag of ['--version', '-v']) {
    const r = await run([bin, flag]);
    assert.equal(r.code, 0);
    assert.equal(r.out, `${version}\n`);
    assert.equal(r.err, '');
  }
});

test('shouldOpen: an empty CI is not CI, PLANNAV_OPEN=1 opens, --no-open is found anywhere in argv; openerCommand defaults to this platform', () => {
  assert.equal(shouldOpen([], { CI: '' }), true);
  assert.equal(shouldOpen([], { PLANNAV_OPEN: '1' }), true);
  assert.equal(shouldOpen(['--port', '1', '--no-open'], {}), false);
  assert.equal(shouldOpen(['--no-open'], { PLANNAV_OPEN: '1' }), false);
  assert.deepEqual(openerCommand('http://x/'), openerCommand('http://x/', process.platform));
  assert.deepEqual(openerCommand('http://x/', 'freebsd'), ['xdg-open', ['http://x/']]);
});

test('waitForServer: a zero budget times out at once; a closed port rejects with the fetch error', async () => {
  await assert.rejects(waitForServer('http://127.0.0.1:1/', 0), { message: 'timed out' });
  await assert.rejects(waitForServer('http://127.0.0.1:1/', 200), (e) => e instanceof TypeError && e.message === 'fetch failed');
});

test('waitForServer: keeps polling through a failing response until an ok one; a server that never answers ok rejects with its last status', async () => {
  let hits = 0;
  const server = createServer((req, res) => { hits += 1; res.statusCode = hits < 3 ? 503 : 200; res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    await waitForServer(url, 5000);
    assert.equal(hits, 3);
    hits = -1000; // every further answer is 503
    await assert.rejects(waitForServer(url, 400), { message: 'status 503' });
  } finally {
    await new Promise((r) => server.close(r));
  }
});
