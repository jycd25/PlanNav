import { describe, it, expect } from 'vitest';
import { toolLabel } from '../src/chat/toolLabel.js';

const part = (name: string, result?: unknown, isError = false, pending = false) => ({ type: 'tool' as const, id: '1', name, input: {}, result, isError, pending });

const EVERY_TOOL: Array<[string, string]> = [
  ['plan_schedule', 'Planned schedule'], ['mark_task', 'Marked task'], ['mark_block', 'Marked block'], ['upsert_task', 'Saved task'],
  ['archive_task', 'Archived task'], ['add_commitment', 'Added commitment'], ['remove_commitment', 'Removed commitment'],
  ['get_schedule', 'Read schedule'], ['list_tasks', 'Read tasks'], ['get_now', 'Checked time'], ['get_summary', 'Read summary'],
  ['get_setup_status', 'Checked setup'], ['set_availability', 'Set availability'], ['add_recurring_commitment', 'Added weekly commitment'],
  ['remove_recurring_commitment', 'Removed weekly commitment'], ['update_settings', 'Updated settings'], ['import_calendar', 'Imported calendar'],
  ['shift_day', 'Shifted the day'], ['carve_out', 'Carved out time'], ['carry_over', 'Carried over'],
  ['import_as_baseline', 'Imported baseline'], ['apply_baseline', 'Applied baseline'], ['save_baseline', 'Saved baseline'],
  ['update_memory', 'Updated memory'],
];

describe('toolLabel: every tool', () => {
  it('a pending call (no result yet) shows the bare label', () => {
    for (const [name, label] of EVERY_TOOL) expect(toolLabel(part(name, undefined, false, true))).toBe(label);
  });
  it('a result that carries nothing it understands (empty object, null, number, string) shows the bare label', () => {
    for (const [name, label] of EVERY_TOOL) {
      expect(toolLabel(part(name, {}))).toBe(label);
      expect(toolLabel(part(name, null))).toBe(label);
      expect(toolLabel(part(name, 42))).toBe(label);
      expect(toolLabel(part(name, 'done'))).toBe(label);
    }
  });
  it('an error shows the result\'s error field, or the raw result when there is none', () => {
    for (const [name, label] of EVERY_TOOL) {
      expect(toolLabel(part(name, { error: 'Task not found: x' }, true))).toBe(`${label}: Task not found: x`);
      expect(toolLabel(part(name, 'plain failure', true))).toBe(`${label}: plain failure`);
    }
  });
  it('a refusal ({ ok: false, note }) shows the note for every tool, and beats any summary', () => {
    for (const [name, label] of EVERY_TOOL) {
      expect(toolLabel(part(name, { ok: false, note: 'No baseline yet.', summary: 'ignored' }))).toBe(`${label}: No baseline yet.`);
    }
  });
  it('a summary is shown only for the tools whose summary is worth a line', () => {
    const withSummary = new Set(['plan_schedule', 'import_calendar', 'shift_day', 'carve_out', 'carry_over', 'import_as_baseline', 'apply_baseline', 'save_baseline']);
    for (const [name, label] of EVERY_TOOL) {
      expect(toolLabel(part(name, { summary: 'Did it.' }))).toBe(withSummary.has(name) ? `${label}: Did it.` : label);
    }
  });
});

describe('toolLabel: errors and refusals in odd shapes', () => {
  it('an error with an object result that has no error field stringifies the object', () => {
    expect(toolLabel(part('get_now', { message: 'x' }, true))).toBe('Checked time: [object Object]');
  });
  it('an error with no result at all says undefined', () => {
    expect(toolLabel(part('get_now', undefined, true))).toBe('Checked time: undefined');
  });
  it('an error whose error field is not a string is still stringified', () => {
    expect(toolLabel(part('get_now', { error: 404 }, true))).toBe('Checked time: 404');
    expect(toolLabel(part('get_now', { error: null }, true))).toBe('Checked time: null');
  });
  it('the error wins over a refusal note and a needsConfirmation summary', () => {
    expect(toolLabel(part('shift_day', { ok: false, note: 'n', error: 'e', needsConfirmation: true, summary: 's' }, true))).toBe('Shifted the day: e');
  });
  it('ok: false without a string note is not a refusal', () => {
    expect(toolLabel(part('plan_schedule', { ok: false }))).toBe('Planned schedule');
    expect(toolLabel(part('plan_schedule', { ok: false, note: 7 }))).toBe('Planned schedule');
    expect(toolLabel(part('plan_schedule', { ok: false, summary: 'Planned.' }))).toBe('Planned schedule: Planned.');
  });
  it('ok: true with a note is not a refusal; the summary still shows', () => {
    expect(toolLabel(part('carve_out', { ok: true, note: 'n', summary: 'Carved 14:00–15:00.' }))).toBe('Carved out time: Carved 14:00–15:00.');
  });
  it('an unknown tool shows its raw name, with the error or note when there is one', () => {
    expect(toolLabel(part('mystery'))).toBe('mystery');
    expect(toolLabel(part('mystery', { error: 'boom' }, true))).toBe('mystery: boom');
    expect(toolLabel(part('mystery', { ok: false, note: 'nope' }))).toBe('mystery: nope');
    expect(toolLabel(part('mystery', { summary: 'ignored' }))).toBe('mystery');
  });
});

describe('toolLabel: shift_day and needsConfirmation', () => {
  it('needsConfirmation with a summary changes the label to a question asked', () => {
    expect(toolLabel(part('shift_day', { needsConfirmation: true, summary: 'Waive the breaks?' }))).toBe('Asked before shifting: Waive the breaks?');
  });
  it('needsConfirmation without a string summary falls back to the plain label', () => {
    expect(toolLabel(part('shift_day', { needsConfirmation: true }))).toBe('Shifted the day');
    expect(toolLabel(part('shift_day', { needsConfirmation: true, summary: 3 }))).toBe('Shifted the day');
  });
  it('needsConfirmation false, or a falsy value, is an ordinary shift', () => {
    expect(toolLabel(part('shift_day', { needsConfirmation: false, summary: 'Shifted 3 blocks.' }))).toBe('Shifted the day: Shifted 3 blocks.');
    expect(toolLabel(part('shift_day', { needsConfirmation: 0, summary: 'Shifted 3 blocks.' }))).toBe('Shifted the day: Shifted 3 blocks.');
  });
  it('needsConfirmation on any other tool is ignored', () => {
    expect(toolLabel(part('carve_out', { needsConfirmation: true, summary: 'Carved.' }))).toBe('Carved out time: Carved.');
    expect(toolLabel(part('mark_task', { needsConfirmation: true, taskName: 'A', status: 'done' }))).toBe('Marked task: A → done');
  });
  it('a refusal note beats needsConfirmation', () => {
    expect(toolLabel(part('shift_day', { ok: false, note: 'Nothing left today.', needsConfirmation: true, summary: 's' }))).toBe('Shifted the day: Nothing left today.');
  });
});

describe('toolLabel: update_memory', () => {
  it('collapses whitespace and cuts the note at 120 characters', () => {
    const long = 'x'.repeat(200);
    expect(toolLabel(part('update_memory', { memory: long }))).toBe(`Updated memory: ${'x'.repeat(120)}`);
    expect(toolLabel(part('update_memory', { memory: '  - a\n\n\t- b  ' }))).toBe('Updated memory:  - a - b ');
  });
  it('an empty note says cleared; a missing or non-string note shows the bare label', () => {
    expect(toolLabel(part('update_memory', { memory: '' }))).toBe('Updated memory: cleared');
    expect(toolLabel(part('update_memory', { summary: 'Memory updated.' }))).toBe('Updated memory');
    expect(toolLabel(part('update_memory', { memory: null }))).toBe('Updated memory');
  });
  it('a whitespace-only note is not "cleared": it collapses to one space', () => {
    expect(toolLabel(part('update_memory', { memory: '   ' }))).toBe('Updated memory:  ');
  });
  it('an error on update_memory shows the error, not the note', () => {
    expect(toolLabel(part('update_memory', { error: 'too long', memory: 'x' }, true))).toBe('Updated memory: too long');
  });
});

describe('toolLabel: per-tool result fields', () => {
  it('mark_task and mark_block show "task → status", with a missing status printed as undefined', () => {
    expect(toolLabel(part('mark_task', { taskName: 'Leetcode', status: 'done' }))).toBe('Marked task: Leetcode → done');
    expect(toolLabel(part('mark_block', { taskName: 'Reading', status: 'skipped' }))).toBe('Marked block: Reading → skipped');
    expect(toolLabel(part('mark_block', { taskName: 'Reading' }))).toBe('Marked block: Reading → undefined');
    expect(toolLabel(part('mark_task', { status: 'done' }))).toBe('Marked task');
  });
  it('upsert_task shows the name, add_commitment and add_recurring_commitment the title; only when strings', () => {
    expect(toolLabel(part('upsert_task', { name: 'Reading' }))).toBe('Saved task: Reading');
    expect(toolLabel(part('upsert_task', { name: 7 }))).toBe('Saved task');
    expect(toolLabel(part('add_commitment', { title: 'Dentist' }))).toBe('Added commitment: Dentist');
    expect(toolLabel(part('add_recurring_commitment', { title: 'Standup' }))).toBe('Added weekly commitment: Standup');
    expect(toolLabel(part('remove_commitment', { title: 'Dentist' }))).toBe('Removed commitment');
  });
  it('set_availability lists the windows; an empty list leaves a trailing colon and space', () => {
    expect(toolLabel(part('set_availability', { availability: [{ start: '09:00', end: '18:00' }, { start: '20:00', end: '22:00' }] }))).toBe('Set availability: 09:00-18:00, 20:00-22:00');
    expect(toolLabel(part('set_availability', { availability: [] }))).toBe('Set availability: ');
    expect(toolLabel(part('set_availability', { availability: 'all' }))).toBe('Set availability');
  });
  it('a result that is an array is an object but has none of the fields: bare label', () => {
    expect(toolLabel(part('list_tasks', [{ name: 'a' }]))).toBe('Read tasks');
  });
});
