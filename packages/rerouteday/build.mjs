// Bundles the server (with @ds/core) into dist/server.js and dist/mcp.js, and copies the built web UI to dist/web.
// Third-party packages stay external: they are this package's `dependencies`. Run after `pnpm -r build` has built
// @ds/core, @ds/server and @ds/web (the workspace devDependencies make pnpm order it so).
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const serverDist = join(here, '..', 'server', 'dist');
const webDist = join(here, '..', 'web', 'dist');
const out = join(here, 'dist');

for (const [what, p] of [['@ds/server', join(serverDist, 'index.js')], ['@ds/web', join(webDist, 'index.html')]]) {
  if (!existsSync(p)) {
    console.error(`rerouteday build: ${what} is not built (${p} missing). Run \`pnpm build\` from the repo root.`);
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: Object.keys(pkg.dependencies),
  logLevel: 'warning',
};
await build({ ...common, entryPoints: [join(serverDist, 'index.js')], outfile: join(out, 'server.js') });
await build({ ...common, entryPoints: [join(serverDist, 'mcp.js')], outfile: join(out, 'mcp.js') });
cpSync(webDist, join(out, 'web'), { recursive: true });
// npm shows the package README; the repo's is the source of truth, so it is copied here at build time (git-ignored).
cpSync(join(here, '..', '..', 'README.md'), join(here, 'README.md'));
console.log('rerouteday build: dist/server.js, dist/mcp.js, dist/web, README.md');
