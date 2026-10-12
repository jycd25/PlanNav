#!/usr/bin/env node
// Starts the RerouteDay server with the built web UI, then opens it in the browser. Re-executes node with the SQLite
// experimental warning silenced, which a shebang line cannot do portably.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser, shouldOpen, waitForServer } from '../lib/open.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`rerouteday — local-first calendar with a scheduling assistant

Usage:
  rerouteday                 start the server, then open http://127.0.0.1:4820 in your browser
  rerouteday --no-open       start without opening a browser

Environment:
  PORT              port to listen on (default 4820)
  HOST              bind address (default 127.0.0.1; set 0.0.0.0 to expose on the network)
  REROUTEDAY_DB_PATH   SQLite file (default ~/.rerouteday/data.sqlite)
  REROUTEDAY_OPEN=0    never open a browser (same as --no-open)

Pick the assistant backend in Settings: the Claude Code CLI (\`claude\` on your PATH) or an Anthropic API key.`);
  process.exit(0);
}
if (args.includes('--version') || args.includes('-v')) {
  console.log(JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version);
  process.exit(0);
}

const serverArgs = args.filter((a) => a !== '--no-open');
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(here, '..', 'dist', 'server.js'), ...serverArgs], { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

if (shouldOpen(args)) {
  const port = process.env.PORT ?? '4820';
  const host = process.env.HOST && process.env.HOST !== '0.0.0.0' ? process.env.HOST : '127.0.0.1';
  const url = `http://${host}:${port}/`;
  waitForServer(`${url}api/settings`).then(() => openBrowser(url), () => { /* server did not come up; its own error is on the console */ });
}
