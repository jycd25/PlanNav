/**
 * Prefilled prompts above the chat box, like a support agent's starter bubbles: a click puts the sentence in the input,
 * ready to edit or send. Each one is a phrase the system prompt's intent table routes to exactly one tool, and the set
 * follows the state the user is in (no baseline yet, a week without it, a day laid out).
 */
export interface SuggestionContext {
  ready: boolean;        // a baseline with a task slot exists
  weekApplied: boolean;  // this week holds blocks copied from the baseline
  tasks: string[];       // active task names, in priority order
  todayBlocks: Array<{ taskName: string; start: string; end: string; status: 'pending' | 'done' | 'skipped' | 'missed' }>;
  now: Date;
}

const MAX = 5;
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export function suggestions(c: SuggestionContext): string[] {
  const out: string[] = [];
  if (!c.ready) {
    out.push("Let's set up my schedule.");
    if (c.tasks.length) out.push('Suggest a schedule from my tasks');
    out.push('Add a task Reading, 30 min a day, priority 3');
    out.push('Use my imported calendar as my baseline');
  } else if (!c.weekApplied) {
    out.push('Apply my baseline to this week', 'Apply my baseline to next week', "What's on today?");
  } else {
    const t = c.now.getTime();
    out.push("I'm starting now");
    const nextHour = new Date(c.now); nextHour.setMinutes(0, 0, 0); nextHour.setHours(nextHour.getHours() + 1);
    out.push(`Busy until ${hhmm(nextHour)}`);
    // The latest block that ended unmarked, or missed: the one "I didn't finish" most likely means.
    const over = c.todayBlocks.filter((b) => new Date(b.end).getTime() <= t && (b.status === 'pending' || b.status === 'missed')).sort((a, b) => b.end.localeCompare(a.end))[0];
    if (over) out.push(`I didn't finish ${over.taskName}`);
    const current = c.todayBlocks.find((b) => b.status === 'pending' && new Date(b.start).getTime() <= t && t < new Date(b.end).getTime());
    if (current) out.push(`Note on ${current.taskName}: not focused`);
    out.push("What's on today?", 'How am I doing?');
  }
  return [...new Set(out)].slice(0, MAX);
}
