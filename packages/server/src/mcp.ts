import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { tools, runTool } from '@ds/core';
import { SqliteStore } from './db.js';
import { defaultDbPath } from './paths.js';
import { fetchText } from './fetchText.js';

const store = new SqliteStore(defaultDbPath());
const server = new McpServer({ name: 'scheduler', version: '0.1.0' });
const ctx = { now: () => new Date(), fetchText };

for (const t of tools) {
  server.registerTool(t.name, { description: t.description, inputSchema: t.schema }, async (input: unknown) => {
    try {
      const result = await runTool(store, t.name, input, ctx);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  });
}

await server.connect(new StdioServerTransport());
