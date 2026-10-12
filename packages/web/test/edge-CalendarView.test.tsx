// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { DEFAULT_SETTINGS, type Commitment, type Settings, type Task } from '@ds/core';

vi.mock('../src/api.js', () => ({
  patchBlock: vi.fn(), trackBlock: vi.fn(), deleteBlock: vi.fn(), createBlock: vi.fn(), addCommitment: vi.fn(),
  deleteCommitment: vi.fn(), addRecurring: vi.fn(), deleteRecurring: vi.fn(), putSettings: vi.fn(),
}));
import * as api from '../src/api.js';
import type { BlockView, RecurringOccurrence } from '../src/api.js';
import { CalendarView, type CalendarViewProps, type TemplateEditor } from '../src/calendar/CalendarView.js';

// The popover decides Finish/Actual from the real clock (new Date()), so the clock is pinned to Wed Oct 7 2026, 12:00 local.
const NOW = new Date(2026, 9, 7, 12);
beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); vi.stubGlobal('alert', vi.fn()); });
afterAll(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const day = new Date(2026, 9, 7);
const at = (h: number, m = 0, d = 7) => new Date(2026, 9, d, h, m);
const iso = (h: number, m = 0, d = 7) => at(h, m, d).toISOString();
const task: Task = { id: 't1', name: 'Leetcode', color: '#4f8cff', priority: 1, budgetMinutes: 60, budgetPeriod: 'week', archived: false, createdAt: '' };
const task2: Task = { ...task, id: 't2', name: 'Reading', color: '#34c759' };
const block = (over: Partial<BlockView> = {}): BlockView => ({ id: 'b1', taskId: 't1', taskName: 'Leetcode', start: iso(9), end: iso(10, 30), status: 'pending', createdAt: '', statusChangedAt: null, ...over });
const settings: Settings = { ...DEFAULT_SETTINGS, availability: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }] };

function mount(blocks: BlockView[], over: Partial<CalendarViewProps> = {}) {
  const onChanged = vi.fn();
  render(<CalendarView days={[day]} now={NOW} blocks={blocks} commitments={[]} recurring={[]} tasks={[task, task2]} settings={settings} onChanged={onChanged} {...over} />);
  return { onChanged };
}
const card = () => screen.getByTitle('Leetcode 09:00–10:30');
const openPopover = () => { fireEvent.click(card()); return document.querySelector('.popover') as HTMLElement; };
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const hasButton = (name: string) => screen.queryByRole('button', { name }) !== null;
const meta = () => document.querySelector('.popover .meta')!.textContent;
const actualInput = () => document.querySelector('.popover input[type="number"]') as HTMLInputElement;

beforeEach(() => {
  for (const fn of Object.values(api)) if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue({});
});
afterEach(cleanup);

describe('CalendarView popover: status and clock state', () => {
  it('a done block that was never started: Actual 0, no started/finished line, Reset offered, no clock buttons', () => {
    mount([block({ status: 'done' })]);
    openPopover();
    expect(document.querySelector('.popover h4')!.textContent).toBe('Leetcode');
    expect(meta()).toBe('09:00 – 10:30 · done');
    expect(actualInput().value).toBe('0');
    expect(['Done', 'Skip', 'Reset', 'Copy', 'Delete'].every(hasButton)).toBe(true);
    expect(['Start', 'Pause', 'Finish'].some(hasButton)).toBe(false);
    expect(button('Log').disabled).toBe(false);
  });

  it('a pending block of today, not started: Start and Finish, no Pause or Reset', () => {
    mount([block()]);
    openPopover();
    expect(meta()).toBe('09:00 – 10:30 · pending');
    expect(hasButton('Start')).toBe(true);
    expect(hasButton('Finish')).toBe(true);
    expect(hasButton('Pause')).toBe(false);
    expect(hasButton('Reset')).toBe(false);
  });

  it('a pending block of another day, not started: Start only (Finish needs today or a started block)', () => {
    mount([block({ start: iso(9, 0, 8), end: iso(10, 30, 8) })], { days: [new Date(2026, 9, 8)] });
    openPopover();
    expect(hasButton('Start')).toBe(true);
    expect(hasButton('Finish')).toBe(false);
    expect(hasButton('Reset')).toBe(false);
  });

  it('a running block: Pause and Finish and Reset, no Start; Actual counts the running stretch; the card shows the live badge', () => {
    mount([block({ trackedMinutes: 10, startedAt: iso(11, 20), runningSince: iso(11, 30) })]);
    expect(card().className).toBe('card pending  running');
    expect(card().querySelector('.badge')!.textContent).toBe('● 40 min');
    openPopover();
    expect(meta()).toBe('09:00 – 10:30 · pending · started 11:20');
    expect(hasButton('Start')).toBe(false);
    expect(hasButton('Pause')).toBe(true);
    expect(hasButton('Finish')).toBe(true);
    expect(hasButton('Reset')).toBe(true);
    expect(actualInput().value).toBe('40');
  });

  it('a paused block: Start again, Finish, Reset; Actual is the tracked minutes', () => {
    mount([block({ trackedMinutes: 20, startedAt: iso(9, 5), runningSince: null })]);
    openPopover();
    expect(hasButton('Start')).toBe(true);
    expect(hasButton('Pause')).toBe(false);
    expect(hasButton('Finish')).toBe(true);
    expect(hasButton('Reset')).toBe(true);
    expect(actualInput().value).toBe('20');
    expect(meta()).toBe('09:00 – 10:30 · pending · started 09:05');
  });

  it('a started block on another day may be finished', () => {
    mount([block({ start: iso(9, 0, 8), end: iso(10, 30, 8), trackedMinutes: 5, startedAt: iso(11) })], { days: [new Date(2026, 9, 8)] });
    openPopover();
    expect(hasButton('Finish')).toBe(true);
  });

  it('a finished block shows both actual times in order', () => {
    mount([block({ status: 'done', startedAt: iso(9, 5), finishedAt: iso(10), trackedMinutes: 55 })]);
    openPopover();
    expect(meta()).toBe('09:00 – 10:30 · done · started 09:05 · finished 10:00');
    expect(actualInput().value).toBe('55');
    expect(hasButton('Finish')).toBe(false);
  });

  it('a skipped and a missed block offer Reset and no clock buttons', () => {
    mount([block({ status: 'skipped' })]);
    openPopover();
    expect(meta()).toBe('09:00 – 10:30 · skipped');
    expect(hasButton('Reset')).toBe(true);
    expect(['Start', 'Pause', 'Finish'].some(hasButton)).toBe(false);
    cleanup();
    mount([block({ status: 'missed' })]);
    openPopover();
    expect(meta()).toBe('09:00 – 10:30 · missed');
    expect(hasButton('Reset')).toBe(true);
  });
});

describe('CalendarView popover: actions', () => {
  it('Start, Pause and Finish call the tracker with the block id and keep the popover open', async () => {
    const { onChanged } = mount([block({ runningSince: null })]);
    openPopover();
    fireEvent.click(button('Start'));
    await waitFor(() => expect(api.trackBlock).toHaveBeenCalledWith('b1', 'start', undefined));
    fireEvent.click(button('Finish'));
    await waitFor(() => expect(api.trackBlock).toHaveBeenCalledWith('b1', 'finish', undefined));
    expect(document.querySelector('.popover')).not.toBeNull();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    cleanup();
    mount([block({ runningSince: iso(11, 30) })]);
    openPopover();
    fireEvent.click(button('Pause'));
    await waitFor(() => expect(api.trackBlock).toHaveBeenCalledWith('b1', 'pause', undefined));
  });

  it('Done, Skip and Reset patch the status and close the popover; Delete deletes', async () => {
    mount([block({ status: 'done' })]);
    openPopover();
    fireEvent.click(button('Skip'));
    expect(document.querySelector('.popover')).toBeNull();
    await waitFor(() => expect(api.patchBlock).toHaveBeenCalledWith('b1', { status: 'skipped' }));
    openPopover();
    fireEvent.click(button('Reset'));
    await waitFor(() => expect(api.patchBlock).toHaveBeenCalledWith('b1', { status: 'pending' }));
    openPopover();
    fireEvent.click(button('Done'));
    await waitFor(() => expect(api.patchBlock).toHaveBeenCalledWith('b1', { status: 'done' }));
    openPopover();
    fireEvent.click(button('Delete'));
    await waitFor(() => expect(api.deleteBlock).toHaveBeenCalledWith('b1'));
    expect(document.querySelector('.popover')).toBeNull();
  });

  it('a failed patch alerts the message and still refreshes', async () => {
    vi.mocked(api.patchBlock).mockRejectedValue(new Error('Block not found'));
    const { onChanged } = mount([block()]);
    openPopover();
    fireEvent.click(button('Done'));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Block not found'));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('clicking the calendar body closes the popover', () => {
    mount([block()]);
    openPopover();
    fireEvent.click(document.querySelector('.cal-body')!);
    expect(document.querySelector('.popover')).toBeNull();
  });
});

describe('CalendarView popover: logging actual minutes', () => {
  it('Log sends the typed minutes, rounded; Enter in the field logs too', async () => {
    mount([block({ status: 'done' })]);
    openPopover();
    fireEvent.change(actualInput(), { target: { value: '45' } });
    fireEvent.click(button('Log'));
    await waitFor(() => expect(api.trackBlock).toHaveBeenCalledWith('b1', 'set', 45));
    fireEvent.change(actualInput(), { target: { value: '30.6' } });
    fireEvent.keyDown(actualInput(), { key: 'Enter' });
    await waitFor(() => expect(api.trackBlock).toHaveBeenCalledWith('b1', 'set', 31));
    expect(api.trackBlock).toHaveBeenCalledTimes(2);
  });

  it('rejects non-numbers, negatives, more than a day, and an empty field', () => {
    mount([block({ status: 'done' })]);
    openPopover();
    fireEvent.change(actualInput(), { target: { value: 'abc' } });
    expect(actualInput().value).toBe(''); // a number field drops the letters
    expect(button('Log').disabled).toBe(true);
    fireEvent.keyDown(actualInput(), { key: 'Enter' });
    fireEvent.change(actualInput(), { target: { value: '-5' } });
    expect(button('Log').disabled).toBe(true);
    fireEvent.change(actualInput(), { target: { value: '1441' } });
    expect(button('Log').disabled).toBe(true);
    fireEvent.change(actualInput(), { target: { value: '1440' } });
    expect(button('Log').disabled).toBe(false);
    fireEvent.change(actualInput(), { target: { value: '0' } });
    expect(button('Log').disabled).toBe(false);
    expect(api.trackBlock).not.toHaveBeenCalled();
  });
});

describe('CalendarView popover: the note', () => {
  it('Save note appears only when the trimmed text changed, saves through patchBlock and keeps the popover open', async () => {
    const { onChanged } = mount([block()]);
    openPopover();
    const note = screen.getByLabelText('Note') as HTMLTextAreaElement;
    expect(note.placeholder).toBe('Note for the assistant: how it went, what to change…');
    expect(note.maxLength).toBe(2000);
    expect(hasButton('Save note')).toBe(false);
    fireEvent.change(note, { target: { value: '   ' } });
    expect(hasButton('Save note')).toBe(false);
    fireEvent.change(note, { target: { value: 'did it, not focused' } });
    fireEvent.click(button('Save note'));
    await waitFor(() => expect(api.patchBlock).toHaveBeenCalledWith('b1', { note: 'did it, not focused' }));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.popover')).not.toBeNull();
  });

  it('an existing note is prefilled, the card carries the pencil, and Cmd/Ctrl+Enter saves', async () => {
    mount([block({ note: 'shared slot' })]);
    expect(screen.getByTitle('Has a note').textContent).toBe('✎');
    openPopover();
    const note = screen.getByLabelText('Note') as HTMLTextAreaElement;
    expect(note.value).toBe('shared slot');
    fireEvent.change(note, { target: { value: 'shared slot ' } });
    expect(hasButton('Save note')).toBe(false); // trailing space only
    fireEvent.keyDown(note, { key: 'Enter', metaKey: true });
    expect(api.patchBlock).not.toHaveBeenCalled();
    fireEvent.change(note, { target: { value: 'shared slot; Reading got done' } });
    fireEvent.keyDown(note, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(api.patchBlock).toHaveBeenCalledWith('b1', { note: 'shared slot; Reading got done' }));
    fireEvent.keyDown(note, { key: 'Enter' });
    expect(api.patchBlock).toHaveBeenCalledTimes(1); // plain Enter is a newline, not a save
  });
});

describe('CalendarView: copy and paste', () => {
  const col = () => document.querySelector('.col') as HTMLElement;

  it('Copy then ⌘V at the pointer creates a block of the copied length at the hovered slot', async () => {
    mount([block()]);
    openPopover();
    fireEvent.click(button('Copy'));
    expect(document.querySelector('.popover')).toBeNull();
    fireEvent.pointerMove(col(), { clientY: 14 * 48 + 10 }); // 14:12 → slot 14:00
    fireEvent.keyDown(window, { key: 'v', metaKey: true });
    await waitFor(() => expect(api.createBlock).toHaveBeenCalledWith({ taskId: 't1', start: iso(14), end: iso(15, 30) }));
  });

  it('a paste in the last slots of the day is pulled back to end at midnight', async () => {
    mount([block()]);
    openPopover();
    fireEvent.click(button('Copy'));
    fireEvent.pointerMove(col(), { clientY: 23.5 * 48 });
    fireEvent.keyDown(window, { key: 'v', ctrlKey: true });
    await waitFor(() => expect(api.createBlock).toHaveBeenCalledWith({ taskId: 't1', start: iso(22, 30), end: iso(0, 0, 8) }));
  });

  it('⌘V with nothing copied, or after the pointer left the grid, or while typing in a field, creates nothing', () => {
    mount([block()]);
    fireEvent.pointerMove(col(), { clientY: 480 });
    fireEvent.keyDown(window, { key: 'v', metaKey: true });
    openPopover();
    fireEvent.click(button('Copy'));
    fireEvent.pointerMove(col(), { clientY: 480 });
    fireEvent.pointerLeave(col());
    fireEvent.keyDown(window, { key: 'v', metaKey: true });
    fireEvent.pointerMove(col(), { clientY: 480 });
    openPopover();
    fireEvent.keyDown(screen.getByLabelText('Note'), { key: 'v', metaKey: true });
    fireEvent.keyDown(window, { key: 'v' }); // no modifier
    expect(api.createBlock).not.toHaveBeenCalled();
  });

  it('⌘C with the popover open copies the block and closes the popover', async () => {
    mount([block()]);
    openPopover();
    fireEvent.keyDown(window, { key: 'c', metaKey: true });
    expect(document.querySelector('.popover')).toBeNull();
    fireEvent.pointerMove(col(), { clientY: 16 * 48 });
    fireEvent.keyDown(window, { key: 'v', metaKey: true });
    await waitFor(() => expect(api.createBlock).toHaveBeenCalledWith({ taskId: 't1', start: iso(16), end: iso(17, 30) }));
  });

  it('the right-click create form offers Paste once something is copied and pastes from it', async () => {
    mount([block()]);
    openPopover();
    fireEvent.click(button('Copy'));
    fireEvent.contextMenu(col(), { clientX: 40, clientY: 11 * 48 + 5 });
    const form = document.querySelector('.popover.create') as HTMLElement;
    expect(form.querySelector('h4')!.textContent).toBe('Wednesday 11:00 – 11:30');
    expect([...form.querySelectorAll('.choices label')].map((l) => l.textContent)).toEqual([
      'Busy once', 'Busy every Wednesday', 'Available every Wednesday', 'Task block', 'Paste “Leetcode” (1 h 30 min)',
    ]);
    fireEvent.click(screen.getByLabelText('Paste “Leetcode” (1 h 30 min)'));
    fireEvent.click(button('Add'));
    await waitFor(() => expect(api.createBlock).toHaveBeenCalledWith({ taskId: 't1', start: iso(11), end: iso(12, 30) }));
    expect(document.querySelector('.popover.create')).toBeNull();
  });
});

describe('CalendarView: creating from empty space', () => {
  const col = () => document.querySelector('.col') as HTMLElement;

  it('right-click opens the form at the slot under the pointer; "Task block" adds a block of the minimum length for the chosen task', async () => {
    mount([]);
    fireEvent.contextMenu(col(), { clientX: 40, clientY: 10 * 48 + 20 }); // 10:25 → slot 10:15
    expect(document.querySelector('.popover.create h4')!.textContent).toBe('Wednesday 10:15 – 10:45');
    fireEvent.click(screen.getByLabelText('Task block'));
    const select = document.querySelector('.popover.create select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Leetcode', 'Reading']);
    fireEvent.change(select, { target: { value: 't2' } });
    fireEvent.click(button('Add'));
    await waitFor(() => expect(api.createBlock).toHaveBeenCalledWith({ taskId: 't2', start: iso(10, 15), end: iso(10, 45) }));
  });

  it('"Busy once" with an empty title is saved as "Busy"; Enter in the title field submits', async () => {
    mount([]);
    fireEvent.contextMenu(col(), { clientX: 40, clientY: 13 * 48 });
    const title = screen.getByPlaceholderText('Title (e.g. Standup)') as HTMLInputElement;
    fireEvent.keyDown(title, { key: 'Enter' });
    await waitFor(() => expect(api.addCommitment).toHaveBeenCalledWith({ title: 'Busy', start: iso(13), end: iso(13, 30) }));
  });

  it('"Busy every Wednesday" sends a weekly rule in HH:MM; "Available every Wednesday" appends a window to the settings', async () => {
    mount([]);
    fireEvent.contextMenu(col(), { clientX: 40, clientY: 8 * 48 });
    fireEvent.click(screen.getByLabelText('Busy every Wednesday'));
    fireEvent.change(screen.getByPlaceholderText('Title (e.g. Standup)'), { target: { value: ' Standup ' } });
    fireEvent.click(button('Add'));
    await waitFor(() => expect(api.addRecurring).toHaveBeenCalledWith({ title: 'Standup', days: [3], start: '08:00', end: '08:30' }));
    fireEvent.contextMenu(col(), { clientX: 40, clientY: 19 * 48 });
    fireEvent.click(screen.getByLabelText('Available every Wednesday'));
    fireEvent.click(button('Add'));
    await waitFor(() => expect(api.putSettings).toHaveBeenCalledWith({ settings: { ...settings, availability: [...settings.availability, { days: [3], start: '19:00', end: '19:30' }] } }));
  });

  it('with no tasks the Task block choice explains and Add is disabled; Cancel closes', () => {
    mount([], { tasks: [] });
    fireEvent.contextMenu(col(), { clientX: 40, clientY: 10 * 48 });
    fireEvent.click(screen.getByLabelText('Task block'));
    expect(screen.getByText('No tasks yet. Add one in Tasks or ask the assistant.')).not.toBeNull();
    expect(button('Add').disabled).toBe(true);
    fireEvent.click(button('Cancel'));
    expect(document.querySelector('.popover.create')).toBeNull();
  });
});

describe('CalendarView: commitments, recurring rules and shading', () => {
  it('a commitment opens its own popover and Delete removes it', async () => {
    const commitments: Commitment[] = [{ id: 'c1', title: 'Dentist', start: iso(14), end: iso(15) }];
    const { onChanged } = mount([], { commitments });
    const c = screen.getByTitle('Dentist 14:00–15:00');
    expect(c.className).toBe('card commitment  ');
    expect(c.querySelector('.resize')).toBeNull();
    fireEvent.click(c);
    expect(document.querySelector('.popover h4')!.textContent).toBe('Dentist');
    expect(document.querySelector('.popover .meta')!.textContent).toBe('Commitment');
    fireEvent.click(button('Delete'));
    await waitFor(() => expect(api.deleteCommitment).toHaveBeenCalledWith('c1'));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.popover')).toBeNull();
  });

  it('a recurring occurrence says "Every week" and removes the rule, not the occurrence', async () => {
    const recurring: RecurringOccurrence[] = [{ recurringId: 'r1', title: 'Standup', start: iso(9, 30), end: iso(9, 45) }];
    mount([], { recurring });
    fireEvent.click(screen.getByTitle('Standup 09:30–09:45'));
    expect(document.querySelector('.popover .meta')!.textContent).toBe('Every week');
    fireEvent.click(button('Remove weekly rule'));
    await waitFor(() => expect(api.deleteRecurring).toHaveBeenCalledWith('r1'));
    expect(api.deleteCommitment).not.toHaveBeenCalled();
  });

  it('off-hours are shaded outside the availability windows; no window shades the whole day', () => {
    mount([]);
    const off = [...document.querySelectorAll('.offhours')].map((e) => [(e as HTMLElement).style.top, (e as HTMLElement).style.height]);
    expect(off).toEqual([['0px', '432px'], ['864px', '288px']]);
    cleanup();
    mount([], { settings: DEFAULT_SETTINGS });
    expect([...document.querySelectorAll('.offhours')].map((e) => (e as HTMLElement).style.height)).toEqual(['1152px']);
  });

  it('today\'s column carries the now line at the current minute and the header marks the day', () => {
    mount([]);
    expect((document.querySelector('.col.today .nowline') as HTMLElement).style.top).toBe('576px');
    expect(document.querySelector('.cal-head .day.today')!.textContent).toBe('Wed7');
    cleanup();
    mount([], { days: [new Date(2026, 9, 8)] });
    expect(document.querySelector('.nowline')).toBeNull();
    expect(document.querySelector('.day.today')).toBeNull();
  });

  it('overlapping blocks are drawn side by side', () => {
    mount([block(), block({ id: 'b2', taskId: 't2', taskName: 'Reading', start: iso(9, 30), end: iso(11) })]);
    expect(card().style.width).toBe('calc(50% - 4px)');
    expect(screen.getByTitle('Reading 09:30–11:00').style.left).toBe('calc(50% + 2px)');
  });
});

describe('CalendarView: template mode (the Baseline tab)', () => {
  const template = (): TemplateEditor => ({ move: vi.fn(), addTask: vi.fn(), addBusy: vi.fn(), remove: vi.fn(), setTask: vi.fn() });

  it('the popover is a task picker: changing it calls setTask and closes; Delete calls remove; no statuses or clock', () => {
    const t = template();
    mount([block({ id: 'slot:0' })], { template: t });
    expect(document.querySelector('.cal')!.className).toBe('cal template');
    expect(document.querySelector('.cal-head .day')!.textContent).toBe('Wednesday');
    openPopover();
    expect(document.querySelector('.popover h4')!.textContent).toBe('Wednesday 09:00 – 10:30');
    expect(['Start', 'Finish', 'Done', 'Skip', 'Log'].some(hasButton)).toBe(false);
    const select = screen.getByLabelText('Task') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['t1', 't2']);
    fireEvent.change(select, { target: { value: 't2' } });
    expect(t.setTask).toHaveBeenCalledWith('slot:0', 't2');
    expect(document.querySelector('.popover')).toBeNull();
    openPopover();
    fireEvent.click(button('Delete'));
    expect(t.remove).toHaveBeenCalledWith('slot:0');
    expect(api.deleteBlock).not.toHaveBeenCalled();
  });

  it('a slot whose task is gone is listed under its stored name so the picker still shows it', () => {
    mount([block({ id: 'slot:1', taskId: 'gone', taskName: 'Unknown task' })], { template: template() });
    fireEvent.click(screen.getByTitle('Unknown task 09:00–10:30'));
    const select = screen.getByLabelText('Task') as HTMLSelectElement;
    expect(select.value).toBe('gone');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Unknown task', 'Leetcode', 'Reading']);
  });

  it('paste and create go to the editor, never to the server, and the form offers only slots', async () => {
    const t = template();
    mount([block({ id: 'slot:0' })], { template: t });
    openPopover();
    fireEvent.click(button('Copy'));
    fireEvent.pointerMove(document.querySelector('.col')!, { clientY: 15 * 48 });
    fireEvent.keyDown(window, { key: 'v', metaKey: true });
    expect(t.addTask).toHaveBeenCalledWith('t1', at(15), at(16, 30));
    fireEvent.contextMenu(document.querySelector('.col')!, { clientX: 10, clientY: 7 * 48 });
    expect([...document.querySelectorAll('.popover.create .choices label')].map((l) => l.textContent)).toEqual(['Task slot…', 'Busy slot…', 'Paste “Leetcode” (1 h 30 min)']);
    fireEvent.click(screen.getByLabelText('Busy slot…'));
    fireEvent.change(screen.getByPlaceholderText('Title (e.g. Standup)'), { target: { value: 'Lunch' } });
    fireEvent.click(button('Add'));
    expect(t.addBusy).toHaveBeenCalledWith('Lunch', at(7), at(7, 30));
    expect(api.createBlock).not.toHaveBeenCalled();
    expect(api.addCommitment).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.offhours')).toHaveLength(0);
  });
});
