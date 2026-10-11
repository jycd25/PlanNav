/**
 * Direct actions: the chat's starter phrases and the intent table's exact phrases that map to one tool with no free
 * argument are answered by running that tool, with its `summary` as the reply, and no model call. Only an exact match
 * after normalising (case, curly quotes, spaces, trailing punctuation) qualifies: "I'm starting now, but skip Reading"
 * is a different request and goes to the model. The chat route also skips them right after a reply that ended with a
 * question: the user is probably answering it.
 */
export interface DirectAction { tool: string; input: Record<string, unknown> }

export function normalizePhrase(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?\s]+$/, '');
}

const SHIFT: DirectAction = { tool: 'shift_day', input: {} };
const PHRASES = new Map<string, DirectAction>([
  ["i'm starting now", SHIFT], ['im starting now', SHIFT], ['i am starting now', SHIFT],
  // Not "let's go": it is as often a yes to the model's last question ("…OK?") as a start of the day; the model routes it.
  ['start my day', SHIFT], ["i'm late, start now", SHIFT],
  ['apply my baseline to this week', { tool: 'apply_baseline', input: { week_of: 'this week' } }],
  ['apply my baseline to next week', { tool: 'apply_baseline', input: { week_of: 'next week' } }],
  ['apply my baseline', { tool: 'apply_baseline', input: { week_of: 'next week' } }],
  ['set up next week', { tool: 'apply_baseline', input: { week_of: 'next week' } }],
  ["what's on today", { tool: 'get_schedule', input: {} }], ['whats on today', { tool: 'get_schedule', input: {} }],
  ['how am i doing', { tool: 'get_summary', input: {} }],
]);

export function matchDirect(text: string): DirectAction | null {
  const hit = PHRASES.get(normalizePhrase(text));
  return hit ? { tool: hit.tool, input: { ...hit.input } } : null;
}

/** The reply for a direct action: the tool's own summary sentence. */
export function directReply(result: unknown): string | null {
  const r = result as { summary?: unknown } | null;
  return r && typeof r.summary === 'string' && r.summary.trim() ? r.summary : null;
}
