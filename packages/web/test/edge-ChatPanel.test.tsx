// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SetupStatus } from '@ds/core';

vi.mock('../src/api.js', () => ({ chat: vi.fn(), warmChat: vi.fn(), resetChat: vi.fn(), importIcs: vi.fn(), importAsBaseline: vi.fn() }));
import * as api from '../src/api.js';
import type { AssistantEvent } from '../src/api.js';
import { ChatPanel } from '../src/chat/ChatPanel.js';
import type { SuggestionContext } from '../src/chat/suggestions.js';

// jsdom has no Element.prototype.scrollTo; the chat log scrolls to its bottom after every message.
beforeAll(() => { Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo; });

/** A hand-driven assistant stream: push events, close, or fail; aborting the signal fails it like a real fetch would. */
function fakeStream() {
  const queue: AssistantEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let failure: unknown = null;
  const poke = () => { wake?.(); wake = null; };
  async function* gen(): AsyncGenerator<AssistantEvent> {
    while (true) {
      if (queue.length) { yield queue.shift()!; continue; }
      if (failure) throw failure;
      if (closed) return;
      await new Promise<void>((r) => { wake = r; });
    }
  }
  return {
    gen,
    push: (e: AssistantEvent) => act(async () => { queue.push(e); poke(); await Promise.resolve(); }),
    close: () => act(async () => { closed = true; poke(); await Promise.resolve(); }),
    fail: (err: unknown) => act(async () => { failure = err; poke(); await Promise.resolve(); }),
  };
}

const ready: SetupStatus = { ready: true, hasAvailability: true, hasTasks: true, recurringCount: 0, commitmentCount: 0, missing: [], next_step: null };
const notReady: SetupStatus = { ...ready, ready: false, hasTasks: false, missing: ['baseline'], next_step: 'No baseline yet.' };
const context: Omit<SuggestionContext, 'ready'> = { weekApplied: true, tasks: ['Leetcode'], todayBlocks: [], now: new Date(2026, 9, 7, 10, 20) };

let stream: ReturnType<typeof fakeStream>;
let captured: { message: string; signal?: AbortSignal } | null;
function mount(setup: SetupStatus | null = ready, ctx: typeof context | null = context) {
  const onChanged = vi.fn();
  render(<ChatPanel onChanged={onChanged} setup={setup} context={ctx} />);
  return { onChanged, box: () => screen.getByPlaceholderText(/Message the scheduler|Replying/) as HTMLTextAreaElement, send: () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement };
}

beforeEach(() => {
  stream = fakeStream();
  captured = null;
  vi.mocked(api.chat).mockReset().mockImplementation((message, signal) => {
    captured = { message, signal };
    signal?.addEventListener('abort', () => { void stream.fail(new DOMException('The operation was aborted.', 'AbortError')); });
    return stream.gen();
  });
  vi.mocked(api.warmChat).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(api.resetChat).mockReset().mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe('ChatPanel: typing and sending', () => {
  it('Enter sends the trimmed text once, clears the box, and shows the user line', async () => {
    const user = userEvent.setup();
    const { box } = mount();
    await user.type(box(), '  hello there  {Enter}');
    expect(api.chat).toHaveBeenCalledTimes(1);
    expect(captured!.message).toBe('hello there');
    expect(captured!.signal).toBeInstanceOf(AbortSignal);
    expect(box().value).toBe('');
    expect(document.querySelector('.msg.user')!.textContent).toBe('hello there');
    expect(document.querySelector('.msg.assistant .hint')!.textContent).toBe('Thinking…');
    await stream.close();
  });

  it('Shift+Enter inserts a newline and sends nothing', async () => {
    const user = userEvent.setup();
    const { box } = mount();
    await user.type(box(), 'a{Shift>}{Enter}{/Shift}b');
    expect(box().value).toBe('a\nb');
    expect(api.chat).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.msg')).toHaveLength(0);
  });

  it('Send is disabled on an empty or whitespace box and Enter on whitespace sends nothing', async () => {
    const user = userEvent.setup();
    const { box, send } = mount();
    expect(send().disabled).toBe(true);
    await user.type(box(), '   ');
    expect(send().disabled).toBe(true);
    await user.keyboard('{Enter}');
    expect(api.chat).not.toHaveBeenCalled();
    await user.type(box(), 'x');
    expect(send().disabled).toBe(false);
  });

  it('the Send button sends what is in the box', async () => {
    const { box, send } = mount();
    fireEvent.change(box(), { target: { value: 'apply my baseline' } });
    fireEvent.click(send());
    expect(captured!.message).toBe('apply my baseline');
    await stream.close();
  });

  it('shows the keyboard hint', () => {
    mount();
    expect(screen.getByText('Enter to send, Shift+Enter for a new line.')).not.toBeNull();
  });
});

describe('ChatPanel: starter bubbles', () => {
  it('without a baseline the setup chips are shown and a click prefills the box without sending', () => {
    const { box } = mount(notReady, { ...context, weekApplied: false, tasks: [] });
    const chips = screen.getByLabelText('Suggested messages');
    expect([...chips.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      "Let's set up my schedule.", 'Add a task Reading, 30 min a day, priority 3', 'Use my imported calendar as my baseline',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Add a task Reading, 30 min a day, priority 3' }));
    expect(box().value).toBe('Add a task Reading, 30 min a day, priority 3');
    expect(api.chat).not.toHaveBeenCalled();
  });

  it('with the week laid out the day chips follow the clock', () => {
    mount(ready, { ...context, todayBlocks: [{ taskName: 'Leetcode', start: new Date(2026, 9, 7, 9).toISOString(), end: new Date(2026, 9, 7, 10).toISOString(), status: 'pending' }] });
    expect([...screen.getByLabelText('Suggested messages').querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      "I'm starting now", 'Busy until 11:00', "I didn't finish Leetcode", "What's on today?", 'How am I doing?',
    ]);
  });

  it('no chips without a setup status or a context', () => {
    mount(null, context);
    expect(screen.queryByLabelText('Suggested messages')).toBeNull();
    cleanup();
    mount(ready, null);
    expect(screen.queryByLabelText('Suggested messages')).toBeNull();
  });

  it('the setup card appears only before the first message and its button asks the set-up question', async () => {
    mount(notReady, { ...context, weekApplied: false, tasks: [] });
    expect(screen.getByText('Let’s set up your week')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ask the assistant' }));
    expect(captured!.message).toBe("Let's set up my schedule.");
    expect(screen.queryByText('Let’s set up your week')).toBeNull();
    await stream.close();
  });

  it('a ready setup with no messages shows the one-line hint instead of the card', () => {
    mount();
    expect(screen.getByText('Pick a starter below or type your own: the assistant changes the calendar only through its tools and says what it did.')).not.toBeNull();
    expect(screen.queryByText('Let’s set up your week')).toBeNull();
  });
});

describe('ChatPanel: a streamed reply', () => {
  it('renders tool rows with their labels, pending then finished, and markdown text; onChanged fires on results and done', async () => {
    const { box, send, onChanged } = mount();
    fireEvent.change(box(), { target: { value: 'mark leetcode done' } });
    fireEvent.click(send());
    await stream.push({ type: 'tool_call', id: 't1', name: 'mark_task', input: { name: 'Leetcode' } });
    let row = document.querySelector('.msg.assistant .tool')!;
    expect(row.className).toBe('tool pending');
    expect(row.querySelector('.label')!.textContent).toBe('Marked task');
    expect(row.getAttribute('title')).toBe('{"name":"Leetcode"}');
    expect(document.querySelector('.msg.assistant .hint')).toBeNull();
    await stream.push({ type: 'tool_result', id: 't1', name: 'mark_task', result: { taskName: 'Leetcode', status: 'done' } });
    row = document.querySelector('.msg.assistant .tool')!;
    expect(row.className).toBe('tool');
    expect(row.querySelector('.label')!.textContent).toBe('Marked task: Leetcode → done');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.msg.assistant .hint')!.textContent).toBe('Working…');
    await stream.push({ type: 'text', delta: 'Done **now**.' });
    expect(document.querySelector('.msg.assistant .md')!.innerHTML).toBe('<p>Done <strong>now</strong>.</p>');
    expect(document.querySelector('.msg.assistant .hint')).toBeNull();
    await stream.push({ type: 'done' });
    await stream.close();
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('a shift that asked first is labelled "Asked before shifting: …"', async () => {
    const { box, send } = mount();
    fireEvent.change(box(), { target: { value: "I'm late" } });
    fireEvent.click(send());
    await stream.push({ type: 'tool_call', id: 's', name: 'shift_day', input: {} });
    await stream.push({ type: 'tool_result', id: 's', name: 'shift_day', result: { needsConfirmation: true, summary: 'Waive the breaks to end at 18:00, or keep them and end later?' } });
    expect(document.querySelector('.tool .label')!.textContent).toBe('Asked before shifting: Waive the breaks to end at 18:00, or keep them and end later?');
    await stream.close();
  });

  it('an errored tool row is marked and shows the error', async () => {
    const { box, send } = mount();
    fireEvent.change(box(), { target: { value: 'carry over x' } });
    fireEvent.click(send());
    await stream.push({ type: 'tool_call', id: 'c', name: 'carry_over', input: {} });
    await stream.push({ type: 'tool_result', id: 'c', name: 'carry_over', result: { error: 'Task not found: x' }, isError: true });
    const row = document.querySelector('.tool')!;
    expect(row.className).toBe('tool error');
    expect(row.querySelector('.label')!.textContent).toBe('Carried over: Task not found: x');
    await stream.close();
  });

  it('while the reply is in flight Send is disabled, the placeholder changes, chips hide and Enter does not send again', async () => {
    const user = userEvent.setup();
    const { box, send } = mount();
    await user.type(box(), 'first{Enter}');
    expect(send().disabled).toBe(true);
    expect(box().placeholder).toBe('Replying… you can type the next message');
    expect(screen.queryByLabelText('Suggested messages')).toBeNull();
    await user.type(box(), 'second{Enter}');
    expect(api.chat).toHaveBeenCalledTimes(1);
    expect(box().value).toBe('second');
    expect(send().disabled).toBe(true);
    await stream.push({ type: 'text', delta: 'ok' });
    await stream.close();
    await waitFor(() => expect(send().disabled).toBe(false));
    expect(box().placeholder).toBe('Message the scheduler…');
    expect(screen.getByLabelText('Suggested messages')).not.toBeNull();
    expect(box().value).toBe('second');
  });

  it('a stream failure becomes an "Error: …" line and the box is usable again', async () => {
    const { box, send } = mount();
    fireEvent.change(box(), { target: { value: 'hi' } });
    fireEvent.click(send());
    await stream.fail(new Error('chat failed: 503'));
    await waitFor(() => expect(document.querySelector('.msg.assistant .md')!.innerHTML).toBe('<p>Error: chat failed: 503</p>'));
    fireEvent.change(box(), { target: { value: 'again' } });
    expect(send().disabled).toBe(false);
  });

  it('the user line is plain text, never markdown', async () => {
    const { box, send } = mount();
    fireEvent.change(box(), { target: { value: '**not bold** <b>x</b>' } });
    fireEvent.click(send());
    const userLine = document.querySelector('.msg.user span')!;
    expect(userLine.textContent).toBe('**not bold** <b>x</b>');
    expect(userLine.querySelector('b')).toBeNull();
    await stream.close();
  });
});

describe('ChatPanel: new chat and warm-up', () => {
  it('warms the assistant on mount and swallows a failure to do so', async () => {
    vi.mocked(api.warmChat).mockRejectedValue(new Error('offline'));
    mount();
    await waitFor(() => expect(api.warmChat).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Send' })).not.toBeNull();
  });

  it('"New chat" aborts the reply in flight, resets and re-warms the server, and empties the log', async () => {
    const { box, send } = mount();
    fireEvent.change(box(), { target: { value: 'hello' } });
    fireEvent.click(send());
    await stream.push({ type: 'text', delta: 'partial' });
    expect(document.querySelectorAll('.msg')).toHaveLength(2);
    const signal = captured!.signal!;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New chat' })); });
    await waitFor(() => expect(document.querySelectorAll('.msg')).toHaveLength(0));
    expect(signal.aborted).toBe(true);
    expect(api.resetChat).toHaveBeenCalledTimes(1);
    expect(api.warmChat).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(send().disabled).toBe(true)); // not busy any more, and the box is empty
    fireEvent.change(box(), { target: { value: 'x' } });
    expect(send().disabled).toBe(false);
  });

  it('"New chat" with nothing in flight still resets and warms, and keeps working when the reset fails', async () => {
    vi.mocked(api.resetChat).mockRejectedValue(new Error('nope'));
    mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New chat' })); });
    expect(api.resetChat).toHaveBeenCalledTimes(1);
    expect(api.warmChat).toHaveBeenCalledTimes(1); // the mount warm-up only: the failed reset skips the second
    expect(document.querySelectorAll('.msg')).toHaveLength(0);
  });
});
