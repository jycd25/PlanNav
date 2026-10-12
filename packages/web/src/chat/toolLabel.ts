import type { Part } from './reducer.js';

const LABELS: Record<string, string> = {
  plan_schedule: 'Planned schedule', mark_task: 'Marked task', mark_block: 'Marked block', upsert_task: 'Saved task',
  archive_task: 'Archived task', add_commitment: 'Added commitment', remove_commitment: 'Removed commitment',
  get_schedule: 'Read schedule', list_tasks: 'Read tasks', get_now: 'Checked time', get_summary: 'Read summary',
  get_setup_status: 'Checked setup', set_availability: 'Set availability', add_recurring_commitment: 'Added weekly commitment',
  remove_recurring_commitment: 'Removed weekly commitment', update_settings: 'Updated settings', import_calendar: 'Imported calendar',
  shift_day: 'Shifted the day', carve_out: 'Carved out time', carry_over: 'Carried over',
  import_as_baseline: 'Imported baseline', apply_baseline: 'Applied baseline', save_baseline: 'Saved baseline',
  update_memory: 'Updated memory',
};

/** Tools whose result carries a one-sentence `summary` worth showing in the chat log. */
const WITH_SUMMARY = new Set(['plan_schedule', 'import_calendar', 'shift_day', 'carve_out', 'carry_over', 'import_as_baseline', 'apply_baseline', 'save_baseline']);

/** The chat log's line for a tool call: a short human label, plus what it did when the result says so. */
export function toolLabel(p: Extract<Part, { type: 'tool' }>): string {
  const base = LABELS[p.name] ?? p.name;
  const r = (p.result && typeof p.result === 'object' ? p.result : undefined) as Record<string, unknown> | undefined;
  if (p.isError) return `${base}: ${String(r && 'error' in r ? r.error : p.result)}`;
  if (r && r.ok === false && typeof r.note === 'string') return `${base}: ${r.note}`;
  if (p.name === 'shift_day' && r?.needsConfirmation && typeof r.summary === 'string') return `Asked before shifting: ${r.summary}`;
  if (p.name === 'update_memory' && r && typeof r.memory === 'string') return `${base}: ${r.memory ? r.memory.replace(/\s+/g, ' ').slice(0, 120) : 'cleared'}`;
  if (WITH_SUMMARY.has(p.name) && r && typeof r.summary === 'string') return `${base}: ${r.summary}`;
  if ((p.name === 'mark_task' || p.name === 'mark_block') && r && typeof r.taskName === 'string') return `${base}: ${r.taskName} → ${String(r.status)}`;
  if (p.name === 'upsert_task' && r && typeof r.name === 'string') return `${base}: ${r.name}`;
  if (p.name === 'add_commitment' && r && typeof r.title === 'string') return `${base}: ${r.title}`;
  if (p.name === 'add_recurring_commitment' && r && typeof r.title === 'string') return `${base}: ${r.title}`;
  if (p.name === 'set_availability' && Array.isArray(r?.availability)) return `${base}: ${(r!.availability as Array<{ start: string; end: string }>).map((w) => `${w.start}-${w.end}`).join(', ')}`;
  return base;
}
