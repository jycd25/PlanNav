// Opens a URL in the user's default browser without blocking the server process.
import { spawn } from 'node:child_process';

/** The platform's opener as [command, args]. Pure, so it can be tested. */
export function openerCommand(url, platform = process.platform) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
  return ['xdg-open', [url]];
}

/** True unless the user or environment asked not to open a browser. */
export function shouldOpen(argv, env = process.env) {
  if (argv.includes('--no-open')) return false;
  const flag = env.REROUTEDAY_OPEN ?? env.PLANNAV_OPEN; // the pre-rename variable is still honored
  if (flag === '0' || flag === 'false') return false;
  if (env.CI) return false;
  return true;
}

export function openBrowser(url) {
  const [cmd, args] = openerCommand(url);
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* no opener on this system: the URL is already printed */ });
    child.unref();
  } catch { /* same */ }
}

/** Resolves once the server answers on `url`, or rejects after `ms`. */
export async function waitForServer(url, ms = 15000) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.ok) return; last = new Error(`status ${r.status}`); } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw last ?? new Error('timed out');
}
