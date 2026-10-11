/**
 * What one user turn cost: the wall clock the server measured, and what the CLI's `result` event reports (the model's
 * time, the time to the first token, model round trips and prompt-cache usage). `direct`: answered without a model.
 */
export interface TurnStats {
  wallMs: number;
  durationMs?: number;
  durationApiMs?: number;
  ttftMs?: number;
  numTurns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  direct?: boolean;
}

export type AssistantEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; result: unknown; isError?: boolean }
  | { type: 'done'; sessionId?: string }
  | { type: 'error'; message: string }
  | { type: 'stats'; stats: TurnStats };

export type Emit = (e: AssistantEvent) => void;

export interface AssistantProvider {
  /** `note`: app-written lines for this turn (what was done directly since the model last replied), kept apart from the user's words. */
  send(text: string, emit: Emit, signal?: AbortSignal, note?: string): Promise<void>;
  reset(): void;
  /** Get ready for a first message (start what is slow to start), if the backend has anything to start. */
  warm?(): void;
}

export type AssistantConfig =
  | { kind: 'anthropic'; apiKey: string; model: string }
  | { kind: 'claude-code'; model?: string };

export interface AssistantManager {
  send(text: string, emit: Emit, signal?: AbortSignal, note?: string): Promise<void>;
  reset(): void;
  warm(): void;
  getConfig(): AssistantConfig;
  setConfig(c: AssistantConfig): void;
}
