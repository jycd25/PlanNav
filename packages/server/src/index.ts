import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteStore } from './db.js';
import { defaultDbPath, firstExisting, webDistCandidates } from './paths.js';
import { createApp } from './app.js';
import { createAssistantManager } from './assistant/factory.js';
import { fetchText } from './fetchText.js';

const dbPath = defaultDbPath();
const store = new SqliteStore(dbPath);
const assistant = createAssistantManager(store, dbPath);
const app = createApp({ store, assistant, fetchText });

const here = dirname(fileURLToPath(import.meta.url));
const webDist = firstExisting(webDistCandidates(here));
if (webDist) {
  const root = relative(process.cwd(), webDist) || '.';
  app.use('/*', serveStatic({ root }));
  app.get('*', serveStatic({ root, path: 'index.html' }));
} else {
  app.get('/', (c) => c.text('Web UI not built. Run `pnpm --filter @ds/web dev` for development, or `pnpm start` for production.'));
}

const port = Number(process.env.PORT ?? 4820);
// Local-only by default: the API has no authentication. Set HOST=0.0.0.0 to expose it deliberately.
const hostname = process.env.HOST ?? '127.0.0.1';
serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`PlanNav server on http://${hostname === '0.0.0.0' ? 'localhost' : hostname}:${port} (db: ${dbPath}, assistant: ${assistant.getConfig().kind})`);
});
