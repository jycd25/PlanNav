import type { AssistantEvent } from '../api.js';

export type Part =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; input: unknown; result?: unknown; isError?: boolean; pending: boolean };
export interface Message { role: 'user' | 'assistant'; parts: Part[] }

export function applyEvent(messages: Message[], e: AssistantEvent): Message[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return messages;
  const parts = [...last.parts];
  const tail = parts[parts.length - 1];
  switch (e.type) {
    case 'text':
      if (tail && tail.type === 'text') parts[parts.length - 1] = { type: 'text', text: tail.text + e.delta };
      else parts.push({ type: 'text', text: e.delta });
      break;
    case 'tool_call':
      parts.push({ type: 'tool', id: e.id, name: e.name, input: e.input, pending: true });
      break;
    case 'tool_result': {
      const i = parts.findIndex((p) => p.type === 'tool' && p.id === e.id);
      const filled: Part = { type: 'tool', id: e.id, name: e.name, input: i >= 0 ? (parts[i] as Extract<Part, { type: 'tool' }>).input : undefined, result: e.result, isError: Boolean(e.isError), pending: false };
      if (i >= 0) parts[i] = filled; else parts.push(filled);
      break;
    }
    case 'error':
      parts.push({ type: 'text', text: `Error: ${e.message}` });
      break;
    case 'done':
    case 'stats':
      break;
  }
  return [...messages.slice(0, -1), { ...last, parts }];
}

/**
 * The hint under the assistant's message while its reply is on its way: "Thinking…" before anything arrives, "Working…"
 * after a finished tool row while the reply is being written; nothing once text streams (or a tool row is pending).
 */
export function pendingHint(m: Message, busy: boolean): string | null {
  if (!busy || m.role !== 'assistant') return null;
  const last = m.parts[m.parts.length - 1];
  if (!last) return 'Thinking…';
  return last.type === 'tool' && !last.pending ? 'Working…' : null;
}
