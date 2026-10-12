import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

/** REROUTEDAY_DB_PATH, else ~/.rerouteday/data.sqlite. The pre-rename names (PLANNAV_DB_PATH and ~/.plannav, before
 *  them DS_DB_PATH and ~/.dynamic-scheduler) are still honored when set or present, so an existing database keeps being used. */
export function defaultDbPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir(), exists: (p: string) => boolean = existsSync): string {
  if (env.REROUTEDAY_DB_PATH) return env.REROUTEDAY_DB_PATH;
  if (env.PLANNAV_DB_PATH) return env.PLANNAV_DB_PATH;
  if (env.DS_DB_PATH) return env.DS_DB_PATH;
  const dir = join(home, '.rerouteday');
  if (!exists(join(dir, 'data.sqlite'))) {
    for (const legacy of [join(home, '.plannav', 'data.sqlite'), join(home, '.dynamic-scheduler', 'data.sqlite')]) if (exists(legacy)) return legacy;
  }
  mkdirSync(dir, { recursive: true });
  return join(dir, 'data.sqlite');
}

/** Where the built web UI may live, relative to the directory of the running module: beside it (the bundled
 *  `rerouteday` package puts it at dist/web), else the monorepo layout (packages/server/dist → packages/web/dist). */
export function webDistCandidates(here: string): string[] {
  return [join(here, 'web'), join(here, '..', '..', 'web', 'dist')];
}

/** Where the built MCP entry may live: beside the running module (bundled: dist/mcp.js next to dist/server.js),
 *  else one level up (monorepo: server/dist/assistant → server/dist/mcp.js). */
export function mcpEntryCandidates(here: string): string[] {
  return [join(here, 'mcp.js'), join(here, '..', 'mcp.js')];
}

export function firstExisting(paths: string[], exists: (p: string) => boolean = existsSync): string | undefined {
  return paths.find(exists);
}
