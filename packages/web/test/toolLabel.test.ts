import { describe, it, expect } from 'vitest';
import { toolLabel } from '../src/chat/toolLabel.js';

const part = (name: string, result: unknown, isError = false) => ({ type: 'tool' as const, id: '1', name, input: {}, result, isError, pending: false });

describe('toolLabel', () => {
  it('names the baseline-week tools in words, never by their raw names, and shows their summary', () => {
    const cases: Array<[string, string]> = [
      ['shift_day', 'Shifted the day'], ['carve_out', 'Carved out time'], ['carry_over', 'Carried over'],
      ['import_as_baseline', 'Imported baseline'], ['apply_baseline', 'Applied baseline'], ['save_baseline', 'Saved baseline'],
    ];
    for (const [name, label] of cases) {
      expect(toolLabel(part(name, {}))).toBe(label);
      expect(toolLabel(part(name, { summary: 'Did it.' }))).toBe(`${label}: Did it.`);
    }
  });

  it('a shift that asked first says so, and the memory tool shows the note', () => {
    expect(toolLabel(part('shift_day', { needsConfirmation: true, summary: 'Shifting 5 blocks by 20 min keeps your breaks (15:00-17:00) but ends the day at 19:00, past 18:00. Waive the breaks to end at 18:00, or keep them and end later?' }))).toMatch(/^Asked before shifting: Shifting 5 blocks/);
    expect(toolLabel(part('update_memory', { memory: '- When I start late,\n  waive the breaks.', summary: 'Memory updated.' }))).toBe('Updated memory: - When I start late, waive the breaks.');
    expect(toolLabel(part('update_memory', { memory: '', summary: 'Memory cleared.' }))).toBe('Updated memory: cleared');
  });

  it('a refusal ({ ok: false, note }) shows its note', () => {
    expect(toolLabel(part('plan_schedule', { ok: false, note: 'A baseline is set.' }))).toBe('Planned schedule: A baseline is set.');
  });

  it('keeps the existing labels and an error\'s message', () => {
    expect(toolLabel(part('plan_schedule', { summary: 'Planned 3 blocks.' }))).toBe('Planned schedule: Planned 3 blocks.');
    expect(toolLabel(part('carry_over', { error: 'Task not found: x' }, true))).toBe('Carried over: Task not found: x');
    expect(toolLabel(part('mystery_tool', {}))).toBe('mystery_tool');
  });
});
