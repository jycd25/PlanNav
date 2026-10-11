import type { Baseline, BaselineSlot, Block, Commitment, RecurringCommitment, Settings, SetupStatus, Task } from '@ds/core';

export type BlockView = Block & { taskName: string };
export interface RecurringOccurrence { recurringId: string; title: string; start: string; end: string }
export interface State {
  now: string; tasks: Task[]; blocks: BlockView[]; commitments: Commitment[];
  recurring: RecurringOccurrence[]; recurringRules: RecurringCommitment[]; settings: Settings; setup: SetupStatus;
}
export interface ImportResult { commitments: Commitment[]; skipped: number; notes: string[]; summary: string; removed: string[]; calendarName?: string }
export interface BaselineResponse { baseline: Baseline | null; versions: Array<{ version: number; savedAt: string }> }
export interface ApplyBaselineResult { created: BlockView[]; commitments: Commitment[]; replaced: number; skipped: Array<{ slot: BaselineSlot; reason: string }> }
export interface ImportBaselineResult { baseline: Baseline; tasks: { created: Task[]; matched: Task[]; revived: Task[] }; oneOffs: unknown[]; weeksSeen: number; summary: string }
export type AssistantEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; result: unknown; isError?: boolean }
  | { type: 'done' }
  | { type: 'error'; message: string }
  /** What the turn cost (wall clock, time to first token, model round trips); `direct` when no model was called. */
  | { type: 'stats'; stats: { wallMs: number; ttftMs?: number; numTurns?: number; direct?: boolean } };
export interface PublicAssistant { kind: 'anthropic' | 'claude-code'; model?: string; hasApiKey: boolean }
export interface SettingsResponse { settings: Settings; assistant: PublicAssistant }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'content-type': 'application/json' }, ...init });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try { message = ((await res.json()) as { error?: string }).error ?? message; } catch { /* ignore */ }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}
const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export const getState = (from: Date, to: Date) => request<State>(`/api/state?from=${from.toISOString()}&to=${to.toISOString()}`);
export const upsertTask = (input: Record<string, unknown>) => request<Task>('/api/tasks', json('POST', input));
export const archiveTask = (id: string) => request<{ ok: true }>(`/api/tasks/${id}`, json('DELETE'));
export const patchBlock = (id: string, patch: { status?: Block['status']; start?: string; end?: string; note?: string }) => request<BlockView>(`/api/blocks/${id}`, json('PATCH', patch));
export const trackBlock = (id: string, action: 'start' | 'pause' | 'finish' | 'set', minutes?: number) => request<{ block: BlockView; paused: BlockView[]; elapsedMinutes: number }>(`/api/blocks/${id}/track`, json('POST', minutes === undefined ? { action } : { action, minutes }));
export const deleteBlock = (id: string) => request<{ ok: true }>(`/api/blocks/${id}`, json('DELETE'));
export const createBlock = (input: { taskId: string; start: string; end: string }) => request<BlockView>('/api/blocks', json('POST', input));
export const addCommitment = (input: { title: string; start: string; end: string }) => request<Commitment>('/api/commitments', json('POST', input));
export const deleteCommitment = (id: string) => request<{ ok: true }>(`/api/commitments/${id}`, json('DELETE'));
export const planSchedule = (opts: { until?: string; horizon?: 'day' | 'week' }) => request<{ created: BlockView[]; summary: string }>('/api/plan', json('POST', opts));
export const getSettings = () => request<SettingsResponse>('/api/settings');
export const putSettings = (body: { settings?: Settings; assistant?: { kind: string; model?: string; apiKey?: string } }) => request<{ ok: true }>('/api/settings', json('PUT', body));
export const resetChat = () => request<{ ok: true }>('/api/chat/reset', json('POST'));
/** Start the assistant now so the first message does not wait for it (the chat opened, or a new chat began). */
export const warmChat = () => request<{ ok: true }>('/api/chat/warm', json('POST'));
export const addRecurring = (input: { title: string; days: number[]; start: string; end: string }) => request<RecurringCommitment>('/api/recurring', json('POST', input));
export const deleteRecurring = (id: string) => request<{ ok: true }>(`/api/recurring/${id}`, json('DELETE'));
export const importIcs = (ics: string) => request<ImportResult>('/api/import', json('POST', { ics }));
export const importUrl = (url: string) => request<ImportResult>('/api/import-url', json('POST', { url }));
/** Make the baseline week from a calendar's past events (an .ics text, or a feed URL) instead of importing commitments. */
export const importAsBaseline = (source: { ics: string } | { url: string }) =>
  request<ImportBaselineResult>('ics' in source ? '/api/import' : '/api/import-url', json('POST', { ...source, asBaseline: true }));
export const getBaseline = () => request<BaselineResponse>('/api/baseline');
export const saveBaseline = (slots: BaselineSlot[]) => request<BaselineResponse>('/api/baseline', json('PUT', { slots }));
export const revertBaseline = (version: number) => request<BaselineResponse>('/api/baseline/revert', json('POST', { version }));
/** Copy the baseline onto the week containing `weekOf` (a local YYYY-MM-DD; default this week). */
export const applyBaseline = (weekOf?: string) => request<ApplyBaselineResult>('/api/baseline/apply', json('POST', weekOf ? { weekOf } : {}));

export function parseSse(buffer: string): { events: unknown[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const events: unknown[] = [];
  for (const part of parts) {
    const data = part.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    if (!data) continue;
    try { events.push(JSON.parse(data)); } catch { /* skip malformed */ }
  }
  return { events, rest };
}

export async function* chat(message: string, signal?: AbortSignal): AsyncGenerator<AssistantEvent> {
  const res = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }), signal });
  if (!res.ok || !res.body) {
    let message = `chat failed: ${res.status}`;
    try { message = ((await res.json()) as { error?: string }).error ?? message; } catch { /* ignore */ }
    throw new Error(message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSse(buffer);
    buffer = rest;
    for (const e of events) yield e as AssistantEvent;
  }
}
