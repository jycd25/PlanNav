// Tier B scoring: pure functions over a dialogue's tool-call trace (no assistant, no store), so they are unit-tested.

/** Tools that change the store. A call to one in a turn marked `mutating: false` is unrequested. */
export const MUTATING = new Set(['upsert_task', 'archive_task', 'plan_schedule', 'mark_block', 'mark_task', 'track_time', 'move_block', 'add_block', 'delete_block',
  'add_commitment', 'remove_commitment', 'add_recurring_commitment', 'remove_recurring_commitment', 'set_availability', 'update_settings',
  'set_work_style', 'import_calendar', 'import_as_baseline', 'save_baseline', 'apply_baseline', 'clear_schedule', 'shift_day', 'carve_out', 'carry_over']);

const questionCount = (s) => (s.match(/\?/g) ?? []).length;

/**
 * One turn against its script: correct when every `expect` tool was called, no `forbid` tool was, no error, no call at
 * all when `noCalls`, and at most `maxQuestions` question marks when set. Unrequested: mutating calls in a turn marked
 * `mutating: false`, plus a `plan_schedule` or `clear_schedule` call that was not expected.
 */
export function judgeTurn(turn, calls, text, error = null) {
  const expect = turn.expect ?? [];
  const forbid = turn.forbid ?? [];
  const correct = expect.every((t) => calls.includes(t)) && !forbid.some((t) => calls.includes(t)) && !error
    && !(turn.noCalls && calls.length > 0) && !(turn.maxQuestions !== undefined && questionCount(text) > turn.maxQuestions);
  let unrequested = turn.mutating === false ? calls.filter((c) => MUTATING.has(c)).length : 0;
  for (const c of ['plan_schedule', 'clear_schedule']) if (calls.includes(c) && !expect.includes(c)) unrequested += 1;
  return { correct, unrequested };
}

const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : 0; };
/** Nearest-rank percentile (p in 0..1). */
const percentile = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.max(0, Math.ceil(p * a.length) - 1)] : 0; };
const round1 = (x) => Math.round(x * 10) / 10;

/**
 * A turn's latency record from its `stats` event (ClaudeCodeProvider emits one per turn): seconds to the first token,
 * seconds in the API, model round trips, the overhead (wall minus API: process start, MCP, tool runs) and prompt-cache
 * tokens. A direct turn (answered without a model) carries only `direct: true`.
 */
export function turnStats(events, latency_s) {
  const s = events.find((e) => e.type === 'stats')?.stats;
  if (!s) return { direct: false };
  if (s.direct) return { direct: true };
  const out = { direct: false };
  if (s.ttftMs !== undefined) out.ttft_s = round1(s.ttftMs / 1000);
  if (s.durationApiMs !== undefined) { out.api_s = round1(s.durationApiMs / 1000); out.overhead_s = round1(latency_s - s.durationApiMs / 1000); }
  if (s.numTurns !== undefined) out.rounds = s.numTurns;
  if (s.cacheReadTokens !== undefined) out.cache_read = s.cacheReadTokens;
  if (s.cacheCreationTokens !== undefined) out.cache_create = s.cacheCreationTokens;
  return out;
}

/** The B line. `setup_turns`: user turns in the setup dialogue (`setup: true`) until the first mutating call, or null. */
export function aggregateDialogues(runs, caps = { words_med: 40, words_max: 60, questions_max: 1, latency_med_s: 20 }) {
  const turns = runs.flatMap((r) => r.turns);
  const setup = runs.find((r) => r.setup);
  const firstChange = setup?.turns.find((t) => t.calls.some((c) => MUTATING.has(c)));
  const out = {
    tool_acc: turns.length ? turns.filter((t) => t.correct).length / turns.length : 0,
    unrequested: turns.reduce((n, t) => n + t.unrequested, 0),
    words_med: median(turns.map((t) => t.words)),
    words_max: Math.max(0, ...turns.map((t) => t.words)),
    questions_max: Math.max(0, ...turns.map((t) => t.questions)),
    setup_turns: firstChange ? firstChange.index : null,
    latency_med_s: median(turns.map((t) => t.latency_s)),
    latency_p90_s: percentile(turns.map((t) => t.latency_s), 0.9),
    // Model metrics over the turns that reported them (a direct turn has none).
    ttft_med_s: median(turns.filter((t) => t.ttft_s !== undefined).map((t) => t.ttft_s)),
    rounds_med: median(turns.filter((t) => t.rounds !== undefined).map((t) => t.rounds)),
    overhead_med_s: median(turns.filter((t) => t.api_s !== undefined).map((t) => t.latency_s - t.api_s)),
    cache_create_med: median(turns.filter((t) => t.cache_create !== undefined).map((t) => t.cache_create)),
    direct: turns.filter((t) => t.direct).length,
    errors: turns.filter((t) => t.error).length,
  };
  out.crash = (out.words_med > caps.words_med ? 1 : 0) + (out.words_max > caps.words_max ? 1 : 0) + (out.questions_max > caps.questions_max ? 1 : 0) + (out.latency_med_s > caps.latency_med_s ? 1 : 0) + (out.errors > 0 ? 1 : 0);
  return out;
}
