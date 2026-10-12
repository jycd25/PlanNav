// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_SETTINGS, type Settings } from '@ds/core';

vi.mock('../src/api.js', () => ({
  getSettings: vi.fn(), putSettings: vi.fn(), importIcs: vi.fn(), importUrl: vi.fn(), importAsBaseline: vi.fn(),
}));
import * as api from '../src/api.js';
import type { PublicAssistant } from '../src/api.js';
import { SettingsPanel } from '../src/panels/SettingsPanel.js';

const stored: Settings = { ...DEFAULT_SETTINGS, weekStartsOn: 1, memory: '- line one\n- line two' };
const claudeCode: PublicAssistant = { kind: 'claude-code', hasApiKey: false };

async function mount(over: Partial<Settings> = {}, assistant: PublicAssistant = claudeCode) {
  const settings = { ...stored, ...over };
  vi.mocked(api.getSettings).mockResolvedValue({ settings, assistant });
  vi.mocked(api.putSettings).mockResolvedValue({ ok: true });
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(<SettingsPanel onClose={onClose} onChanged={onChanged} />);
  await screen.findByRole('dialog', { name: 'Settings' });
  return { settings, onClose, onChanged };
}
const memoryBox = () => screen.getByLabelText('Memory') as HTMLTextAreaElement;
const saveMemory = () => screen.getByRole('button', { name: 'Save memory' }) as HTMLButtonElement;
const setMemory = (value: string) => fireEvent.change(memoryBox(), { target: { value } });

beforeEach(() => { for (const fn of [api.getSettings, api.putSettings, api.importIcs, api.importUrl, api.importAsBaseline]) vi.mocked(fn).mockReset(); });
afterEach(cleanup);

describe('SettingsPanel: the memory note', () => {
  it('shows the stored note in a 5-row textarea with the Save button disabled', async () => {
    await mount();
    expect(memoryBox().value).toBe('- line one\n- line two');
    expect(memoryBox().className).toBe('memory');
    expect(memoryBox().getAttribute('rows')).toBe('5');
    expect(memoryBox().placeholder).toBe('- When I start late, waive the breaks and end on time.');
    expect(saveMemory().disabled).toBe(true);
  });

  it('enables Save once the text differs, and disables it again when only surrounding whitespace differs', async () => {
    await mount();
    setMemory('- line one\n- line two\n- three');
    expect(saveMemory().disabled).toBe(false);
    setMemory('  - line one\n- line two  \n\n');
    expect(saveMemory().disabled).toBe(true);
    setMemory('- line one\n- line two');
    expect(saveMemory().disabled).toBe(true);
  });

  it('grows with the lines: rows is lines + 1, never under 5', async () => {
    await mount();
    setMemory('a');
    expect(memoryBox().getAttribute('rows')).toBe('5');
    setMemory('1\n2\n3\n4');
    expect(memoryBox().getAttribute('rows')).toBe('5');
    setMemory('1\n2\n3\n4\n5\n6');
    expect(memoryBox().getAttribute('rows')).toBe('7');
    setMemory('1\n2\n3\n4\n5\n6\n7\n8\n9\n10');
    expect(memoryBox().getAttribute('rows')).toBe('11');
  });

  it('saving PUTs the whole settings object with the trimmed note, then shows "Memory saved." and disables Save', async () => {
    const { settings, onChanged } = await mount();
    setMemory('  - new note\n\n');
    fireEvent.click(saveMemory());
    await screen.findByText('Memory saved.');
    expect(api.putSettings).toHaveBeenCalledTimes(1);
    expect(api.putSettings).toHaveBeenCalledWith({ settings: { ...settings, memory: '- new note' } });
    expect(memoryBox().value).toBe('- new note');
    expect(saveMemory().disabled).toBe(true);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('clearing the note saves an empty string and says "Memory cleared."', async () => {
    const { settings } = await mount();
    setMemory('   \n ');
    expect(saveMemory().disabled).toBe(false);
    fireEvent.click(saveMemory());
    await screen.findByText('Memory cleared.');
    expect(api.putSettings).toHaveBeenCalledWith({ settings: { ...settings, memory: '' } });
    expect(memoryBox().value).toBe('');
    expect(saveMemory().disabled).toBe(true);
  });

  it('a failed save shows the server\'s message and keeps the unsaved text so it can be retried', async () => {
    await mount();
    vi.mocked(api.putSettings).mockRejectedValueOnce(new Error('memory: at most 2000 characters'));
    setMemory('x'.repeat(10));
    fireEvent.click(saveMemory());
    await screen.findByText('memory: at most 2000 characters');
    expect(memoryBox().value).toBe('x'.repeat(10));
    expect(saveMemory().disabled).toBe(false);
  });

  it('a note saved by typing (user-event) reaches the API character for character', async () => {
    const user = userEvent.setup();
    const { settings } = await mount({ memory: '' });
    await user.type(memoryBox(), '- Keep lunch at noon.');
    await user.click(saveMemory());
    await screen.findByText('Memory saved.');
    expect(api.putSettings).toHaveBeenCalledWith({ settings: { ...settings, memory: '- Keep lunch at noon.' } });
  });
});

describe('SettingsPanel: week start', () => {
  it('changing the select saves at once, reports the day and refreshes the calendar', async () => {
    const { settings, onChanged } = await mount();
    const select = screen.getByDisplayValue('Monday') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '0' } });
    await screen.findByText('The week starts on Sunday.');
    expect(api.putSettings).toHaveBeenCalledTimes(1);
    expect(api.putSettings).toHaveBeenCalledWith({ settings: { ...settings, weekStartsOn: 0 } });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(select.value).toBe('0');
  });
  it('a stored week start other than Sunday or Monday is offered as a third option', async () => {
    await mount({ weekStartsOn: 3 });
    const select = screen.getByDisplayValue('Wednesday') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Sunday', 'Monday', 'Wednesday']);
  });
  it('a failed week-start save shows the error and leaves the select unchanged', async () => {
    await mount();
    vi.mocked(api.putSettings).mockRejectedValueOnce(new Error('offline'));
    fireEvent.change(screen.getByDisplayValue('Monday'), { target: { value: '0' } });
    await screen.findByText('offline');
    expect((screen.getByDisplayValue('Monday') as HTMLSelectElement).value).toBe('1');
  });
});

describe('SettingsPanel: assistant backend', () => {
  it('the Claude Code backend shows only the alias field; switching to the API key shows the password and model fields', async () => {
    await mount();
    expect(screen.queryByPlaceholderText('sk-ant-…')).toBeNull();
    expect(screen.getByText('Model (optional alias: sonnet, opus)')).not.toBeNull();
    expect(screen.getByPlaceholderText('default')).not.toBeNull();
    fireEvent.change(screen.getByDisplayValue('Claude Code subscription (claude -p)'), { target: { value: 'anthropic' } });
    const key = screen.getByPlaceholderText('sk-ant-…') as HTMLInputElement;
    expect(key.type).toBe('password');
    expect(key.autocomplete).toBe('off');
    expect(screen.getByPlaceholderText('claude-opus-5-5')).not.toBeNull();
    expect(screen.queryByPlaceholderText('default')).toBeNull();
    expect(screen.queryByText('(saved; leave blank to keep)')).toBeNull();
  });

  it('saving the API-key backend sends the key and the default model, clears the field and marks the key as saved', async () => {
    const { onChanged } = await mount();
    fireEvent.change(screen.getByDisplayValue('Claude Code subscription (claude -p)'), { target: { value: 'anthropic' } });
    fireEvent.change(screen.getByPlaceholderText('sk-ant-…'), { target: { value: 'sk-ant-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save assistant' }));
    await screen.findByText('Saved.');
    expect(api.putSettings).toHaveBeenCalledWith({ assistant: { kind: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-secret' } });
    expect((screen.getByPlaceholderText('sk-ant-…') as HTMLInputElement).value).toBe('');
    expect(screen.getByText('(saved; leave blank to keep)')).not.toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('with a key already stored, saving without typing one keeps it (no apiKey in the request)', async () => {
    await mount({}, { kind: 'anthropic', model: 'claude-sonnet-4-5', hasApiKey: true });
    expect(screen.getByText('(saved; leave blank to keep)')).not.toBeNull();
    expect((screen.getByPlaceholderText('claude-opus-5-5') as HTMLInputElement).value).toBe('claude-sonnet-4-5');
    fireEvent.click(screen.getByRole('button', { name: 'Save assistant' }));
    await screen.findByText('Saved.');
    expect(api.putSettings).toHaveBeenCalledWith({ assistant: { kind: 'anthropic', model: 'claude-sonnet-4-5' } });
  });

  it('the Claude Code backend sends no model when the alias is blank and the alias when set', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Save assistant' }));
    await screen.findByText('Saved.');
    expect(api.putSettings).toHaveBeenLastCalledWith({ assistant: { kind: 'claude-code' } });
    fireEvent.change(screen.getByPlaceholderText('default'), { target: { value: 'sonnet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save assistant' }));
    await waitFor(() => expect(api.putSettings).toHaveBeenCalledTimes(2));
    expect(api.putSettings).toHaveBeenLastCalledWith({ assistant: { kind: 'claude-code', model: 'sonnet' } });
  });

  it('a failed assistant save shows the message', async () => {
    await mount();
    vi.mocked(api.putSettings).mockRejectedValueOnce(new Error('claude not found on PATH'));
    fireEvent.click(screen.getByRole('button', { name: 'Save assistant' }));
    await screen.findByText('claude not found on PATH');
  });
});

describe('SettingsPanel: loading, closing, import and export', () => {
  it('shows "Loading…" until the settings arrive', async () => {
    vi.mocked(api.getSettings).mockReturnValue(new Promise(() => { /* never */ }));
    render(<SettingsPanel onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByText('Loading…')).not.toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // Regression (fixed 2026-10-12): SettingsPanel.tsx:30 stores the load error in `status`, but line 33 returns the "Loading…" sheet whenever
  // `settings` is null, and that sheet never renders `status`. Expected: the error text ("Error: 500 Internal Server Error")
  // is shown. Actual: "Loading…" stays on screen for ever and the error is invisible.
  it('a failed settings load shows the error instead of "Loading…"', async () => {
    vi.mocked(api.getSettings).mockRejectedValue(new Error('500 Internal Server Error'));
    render(<SettingsPanel onClose={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByText('Error: 500 Internal Server Error');
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('Close and the scrim both call onClose', async () => {
    const { onClose } = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(document.querySelector('.scrim')!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Fetch is disabled until a URL is typed; a plain import adds busy time and reports summary and notes', async () => {
    const { onChanged } = await mount();
    const fetchBtn = screen.getByRole('button', { name: 'Fetch' }) as HTMLButtonElement;
    expect(fetchBtn.disabled).toBe(true);
    const url = screen.getByPlaceholderText('https://calendar.google.com/calendar/ical/…/basic.ics') as HTMLInputElement;
    fireEvent.change(url, { target: { value: '   ' } });
    expect(fetchBtn.disabled).toBe(true);
    fireEvent.change(url, { target: { value: 'https://cal/basic.ics' } });
    expect(fetchBtn.disabled).toBe(false);
    vi.mocked(api.importUrl).mockResolvedValue({ commitments: [], skipped: 2, notes: ['2 all-day events skipped.'], summary: 'Imported 3 events.', removed: [] });
    fireEvent.click(fetchBtn);
    await screen.findByText('Imported 3 events. 2 all-day events skipped.');
    expect(api.importUrl).toHaveBeenCalledWith('https://cal/basic.ics');
    expect(api.importAsBaseline).not.toHaveBeenCalled();
    expect(url.value).toBe('');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('with "Use as my baseline" checked the URL goes to importAsBaseline and the hint changes', async () => {
    await mount();
    expect(screen.getByText('Adds the upcoming events as busy time.')).not.toBeNull();
    fireEvent.click(screen.getByLabelText('Use as my baseline'));
    expect(screen.getByText(/Makes the baseline week from the last 60 days/)).not.toBeNull();
    fireEvent.change(screen.getByPlaceholderText('https://calendar.google.com/calendar/ical/…/basic.ics'), { target: { value: 'https://cal/basic.ics' } });
    vi.mocked(api.importAsBaseline).mockResolvedValue({ summary: 'Baseline v2 saved: 12 slots, 4 tasks.' } as never);
    fireEvent.click(screen.getByRole('button', { name: 'Fetch' }));
    await screen.findByText('Baseline v2 saved: 12 slots, 4 tasks.');
    expect(api.importAsBaseline).toHaveBeenCalledWith({ url: 'https://cal/basic.ics' });
    expect(api.importUrl).not.toHaveBeenCalled();
  });

  it('an import failure shows its message and keeps the URL', async () => {
    await mount();
    const url = screen.getByPlaceholderText('https://calendar.google.com/calendar/ical/…/basic.ics') as HTMLInputElement;
    fireEvent.change(url, { target: { value: 'https://cal/basic.ics' } });
    vi.mocked(api.importUrl).mockRejectedValue(new Error('Could not fetch the calendar (404).'));
    fireEvent.click(screen.getByRole('button', { name: 'Fetch' }));
    await screen.findByText('Could not fetch the calendar (404).');
    expect(url.value).toBe('https://cal/basic.ics');
  });

  it('the export links point at the API with the right download names', async () => {
    await mount();
    const ics = screen.getByText('Download .ics') as HTMLAnchorElement;
    const json = screen.getByText('Download JSON') as HTMLAnchorElement;
    expect(ics.getAttribute('href')).toBe('/api/export.ics');
    expect(ics.hasAttribute('download')).toBe(true);
    expect(json.getAttribute('href')).toBe('/api/export.json');
    expect(json.getAttribute('download')).toBe('rerouteday.json');
  });
});
