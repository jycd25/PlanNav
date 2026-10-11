// Tier B: drive the real assistant (claude -p through the server's provider) with scripted user turns and score the tool-call trace.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_SETTINGS, importIcs, normalizeSettings, runTool } from '@ds/core';
import { SqliteStore } from '@ds/server/dist/db.js';
import { createAssistantManager } from '@ds/server/dist/assistant/factory.js';
import { seedStore } from './replay.mjs';
import { judgeTurn, turnStats } from './dialogueScore.mjs';

export { MUTATING, aggregateDialogues, judgeTurn, turnStats } from './dialogueScore.mjs';

const wordCount = (s) => s.trim() ? s.trim().split(/\s+/).length : 0;
const questionCount = (s) => (s.match(/\?/g) ?? []).length;

export async function runDialogue(dialogue, { model = 'sonnet', file } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bench-'));
  const dbPath = join(dir, 'bench.sqlite');
  const store = new SqliteStore(dbPath);
  const now = new Date();
  try {
    const seed = dialogue.seed ?? {};
    seedStore(store, { ...seed, settings: seed.settings ?? {} }, now);
    if (!seed.settings) store.saveSettings(normalizeSettings(DEFAULT_SETTINGS));
    if (seed.ics) importIcs(store, readFileSync(join(dirname(file), seed.ics), 'utf8'), now);
    if (seed.plan) await runTool(store, 'plan_schedule', seed.plan === true ? {} : seed.plan, { now: () => now });
    const assistant = createAssistantManager(store, dbPath);
    assistant.setConfig({ kind: 'claude-code', model });
    const turns = [];
    for (const [i, turn] of (dialogue.turns ?? []).entries()) {
      const events = [];
      const t0 = performance.now();
      let error = null;
      try { await assistant.send(turn.user, (e) => events.push(e)); } catch (e) { error = e instanceof Error ? e.message : String(e); }
      const latency_s = (performance.now() - t0) / 1000;
      const calls = events.filter((e) => e.type === 'tool_call').map((e) => e.name);
      const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
      const { correct, unrequested } = judgeTurn(turn, calls, text, error);
      turns.push({ index: i + 1, user: turn.user, calls, words: wordCount(text), questions: questionCount(text), correct, unrequested, latency_s, ...turnStats(events, latency_s), error, text: text.slice(0, 200) });
    }
    return { name: dialogue.name, setup: Boolean(dialogue.setup), turns };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
