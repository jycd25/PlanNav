#!/usr/bin/env node
// Starts the PlanNav server with the built web UI. Re-executes node with the SQLite experimental warning silenced,
// which a shebang line cannot do portably.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`plannav — local-first calendar with a scheduling assistant

Usage:
  plannav                 start the server and UI on http://127.0.0.1:4820

Environment:
  PORT              port to listen on (default 4820)
  HOST              bind address (default 127.0.0.1; set 0.0.0.0 to expose on the network)
  PLANNAV_DB_PATH   SQLite file (default ~/.plannav/data.sqlite)

Pick the assistant backend in Settings: the Claude Code CLI (\`claude\` on your PATH) or an Anthropic API key.`);
  process.exit(0);
}
if (args.includes('--version') || args.includes('-v')) {
  console.log(JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version);
  process.exit(0);
}

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(here, '..', 'dist', 'server.js'), ...args], { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
