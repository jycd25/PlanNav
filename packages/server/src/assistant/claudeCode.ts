import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { Store } from '@ds/core';
import type { AssistantEvent, AssistantProvider, Emit, TurnStats } from './types.js';
import { buildStablePrompt, buildTurnContext } from './systemPrompt.js';
import { firstExisting, mcpEntryCandidates } from '../paths.js';

export type ParsedEvent =
  | { kind: 'text'; text: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'message_start' }
  | { kind: 'tool_call'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; content: string; isError: boolean }
  | { kind: 'result'; sessionId: string; isError: boolean; stats: CliStats };

/** The CLI's own numbers for a run, from its `result` event; a field it did not send (or sent as a non-number) is absent. */
export type CliStats = Omit<TurnStats, 'wallMs' | 'direct'>;

function cliStats(ev: any): CliStats {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const out: CliStats = {
    durationMs: num(ev.duration_ms), durationApiMs: num(ev.duration_api_ms), ttftMs: num(ev.ttft_ms), numTurns: num(ev.num_turns),
    inputTokens: num(ev.usage?.input_tokens), outputTokens: num(ev.usage?.output_tokens),
    cacheReadTokens: num(ev.usage?.cache_read_input_tokens), cacheCreationTokens: num(ev.usage?.cache_creation_input_tokens),
  };
  for (const k of Object.keys(out) as Array<keyof CliStats>) if (out[k] === undefined) delete out[k];
  return out;
}

/** The server log's line for one turn: "turn 7.9s api 5.1s ttft 2.1s rounds 2 cache_read 35k cache_create 16k". */
export function formatTurnLine(s: TurnStats): string {
  const sec = (ms: number | undefined) => (ms === undefined ? '-' : `${(ms / 1000).toFixed(1)}s`);
  const k = (n: number | undefined) => (n === undefined ? '-' : `${Math.round(n / 1000)}k`);
  if (s.direct) return `turn ${sec(s.wallMs)} direct`;
  return `turn ${sec(s.wallMs)} api ${sec(s.durationApiMs)} ttft ${sec(s.ttftMs)} rounds ${s.numTurns ?? '-'} cache_read ${k(s.cacheReadTokens)} cache_create ${k(s.cacheCreationTokens)}`;
}

const MCP_PREFIX = 'mcp__scheduler__';

export function parseStreamJsonLine(line: string): ParsedEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];
  let ev: any;
  try { ev = JSON.parse(trimmed); } catch { return []; }
  const out: ParsedEvent[] = [];
  if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    for (const b of ev.message.content) {
      if (b.type === 'text' && b.text) out.push({ kind: 'text', text: b.text });
      // Only the scheduler's MCP tools are surfaced; the CLI's own tools (ToolSearch and friends) stay internal.
      if (b.type === 'tool_use' && typeof b.name === 'string' && b.name.startsWith(MCP_PREFIX)) {
        out.push({ kind: 'tool_call', id: b.id, name: b.name.slice(MCP_PREFIX.length), input: b.input });
      }
    }
  } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
    for (const b of ev.message.content) {
      if (b.type !== 'tool_result') continue;
      const content = Array.isArray(b.content)
        ? b.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
        : String(b.content ?? '');
      out.push({ kind: 'tool_result', id: b.tool_use_id, content, isError: Boolean(b.is_error) });
    }
  } else if (ev.type === 'stream_event' && !ev.parent_tool_use_id) {
    // --include-partial-messages: the reply as it is written (a subagent's stream, with a parent, is not ours).
    const e = ev.event;
    if (e?.type === 'message_start') out.push({ kind: 'message_start' });
    else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') out.push({ kind: 'text_delta', text: e.delta.text });
  } else if (ev.type === 'result' && typeof ev.session_id === 'string') {
    out.push({ kind: 'result', sessionId: ev.session_id, isError: Boolean(ev.is_error), stats: cliStats(ev) });
  }
  return out;
}

/**
 * Translate a parsed CLI event into assistant events. `toolNames` remembers call ids so results can be named and unknown
 * ids dropped. `stream.streamed`: the current model message already arrived as deltas, so its complete text is dropped.
 */
export function toAssistantEvents(ev: ParsedEvent, toolNames: Map<string, string>, stream: { streamed: boolean } = { streamed: false }): AssistantEvent[] {
  switch (ev.kind) {
    case 'message_start':
      stream.streamed = false;
      return [];
    case 'text_delta':
      stream.streamed = true;
      return [{ type: 'text', delta: ev.text }];
    case 'text':
      return stream.streamed ? [] : [{ type: 'text', delta: ev.text }];
    case 'tool_call':
      toolNames.set(ev.id, ev.name);
      return [{ type: 'tool_call', id: ev.id, name: ev.name, input: ev.input }];
    case 'tool_result': {
      const name = toolNames.get(ev.id);
      if (!name) return [];
      let result: unknown = ev.content;
      try { result = JSON.parse(ev.content); } catch { /* keep text */ }
      return [{ type: 'tool_result', id: ev.id, name, result, isError: ev.isError }];
    }
    case 'result':
      return [];
  }
}

/** Path and launcher for the MCP server, from dist when built, else from source via tsx. */
export function mcpServerCommand(): { command: string; args: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const js = firstExisting(mcpEntryCandidates(here));
  if (js) return { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', js] };
  const ts = join(here, '..', 'mcp.ts');
  return { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', '--import', 'tsx', ts] };
}

export interface SessionStore { get(): string | undefined; set(id: string | undefined): void }

/** Upper bound on assistant turns (tool round trips) per message, so a confused model stops instead of looping. */
export const MAX_TURNS = 25;

/** `text` for a one-shot run; without it the CLI stays up and takes messages as stream-json lines on stdin. */
export function buildClaudeArgs(o: { text?: string; systemPrompt: string; mcpConfig: string; model?: string; session?: string; extraArgs?: string[] }): string[] {
  const args = [
    ...(o.extraArgs ?? []),
    ...(o.text === undefined ? ['-p', '--input-format', 'stream-json'] : ['-p', o.text]),
    '--output-format', 'stream-json',
    '--verbose',
    // The reply streams to the chat as it is written, not when the message is complete.
    '--include-partial-messages',
    '--strict-mcp-config',
    '--mcp-config', o.mcpConfig,
    '--allowedTools', 'mcp__scheduler',
    '--permission-mode', 'dontAsk',
    '--restricted',
    // No built-in tools at all: --restricted still left 23 (Task, Read, Write, Edit, Grep, WebSearch, Skill, Cron…),
    // about 40k tokens of schemas in every request; the assistant needs only the scheduler's MCP tools.
    '--tools', '',
    '--max-turns', String(MAX_TURNS),
    // The system prompt is constant now (the live Context rides in each message), but a resumed session must still take
    // the prompt it is given, not replay the one it was started with (an older version of the app, a one-shot run).
    '--system-prompt-snapshot', 'off',
    '--system-prompt', o.systemPrompt,
  ];
  if (o.model) args.push('--model', o.model);
  if (o.session) args.push('--resume', o.session);
  return args;
}

/**
 * The CLI's environment. ENABLE_TOOL_SEARCH=false: by default the CLI defers MCP tools behind its own ToolSearch, so
 * every tool turn cost an extra model round trip ("select:mcp__scheduler__mark_task", then the tool, then the reply).
 * With it off the scheduler's tool schemas are in the request from the start.
 */
export function claudeEnv(dbPath: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, PLANNAV_DB_PATH: dbPath, ENABLE_TOOL_SEARCH: 'false' };
}

export interface ClaudeCodeConfig {
  dbPath: string;
  model?: string;
  store: Store;
  sessionStore: SessionStore;
  /** Executable to run (default "claude"); tests point this at a stand-in. */
  claudeBin?: string;
  /** Arguments placed before the CLI flags, e.g. a script path when claudeBin is node. */
  claudeArgs?: string[];
  /** Where the one line per turn goes (default: stderr). */
  log?: (line: string) => void;
  /** A turn with no result after this long stops the process (default 180 s). */
  turnTimeoutMs?: number;
  /** An idle process is stopped after this long (default 15 min); the next turn resumes the session in a new one. */
  idleMs?: number;
}

/** The user's message as the CLI gets it: the live Context first (the system prompt is fixed at launch), then their words. */
export function wrapMessage(context: string, text: string): string {
  return `<context>\n${context}\n</context>\n\n${text}`;
}

class CliRunFailed extends Error {
  constructor(message: string, public readonly resumed: boolean, public readonly emitted = false) { super(message); }
}

/** How much of the CLI's stderr is kept for an error message (its tail). */
const STDERR_KEPT = 4000;

/** `onStopped`: the process was stopped on purpose (a reset, a settings change, another chat's process) during the turn. */
type TurnHandler = { onEvent: (ev: ParsedEvent) => void; onExit: (code: number | null, stderrTail: string) => void; onStopped: () => void };

/**
 * One long-lived `claude -p --input-format stream-json` process: started once per chat (process start, authentication
 * and the CLI's context build are paid once), fed one user message per turn on stdin. Its handles are released while
 * idle so a host process can exit; the CLI then sees stdin close and exits too.
 */
class CliProcess {
  readonly child: ChildProcess;
  exited = false;
  answered = false;
  private apiSoFar = 0;
  private stderr = '';
  private handler: TurnHandler | null = null;
  private idle: NodeJS.Timeout | null = null;

  constructor(bin: string, args: string[], env: NodeJS.ProcessEnv, readonly stable: string, readonly resumed: boolean, private idleMs: number) {
    this.child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr!.on('data', (d) => { this.stderr = (this.stderr + String(d)).slice(-STDERR_KEPT); });
    this.child.stdin!.on('error', () => { /* the exit handler reports it */ });
    createInterface({ input: this.child.stdout! }).on('line', (line) => { for (const ev of parseStreamJsonLine(line)) this.handler?.onEvent(ev); });
    const exited = (code: number | null) => {
      if (this.exited) return;
      this.exited = true;
      this.handler?.onExit(code, this.stderr.trim().split('\n').slice(-5).join('\n'));
    };
    this.child.on('exit', exited);
    this.child.on('error', () => exited(null));
    this.release();
  }

  /** The cumulative API time the CLI reports, turned into this turn's. */
  apiDelta(cumulative: number | undefined): number | undefined {
    if (cumulative === undefined) return undefined;
    const d = cumulative - this.apiSoFar;
    this.apiSoFar = cumulative;
    return d;
  }

  begin(message: string, handler: TurnHandler) {
    if (this.idle) clearTimeout(this.idle);
    this.handler = handler;
    for (const h of [this.child, this.child.stdin, this.child.stdout, this.child.stderr] as Array<{ ref?: () => void } | null>) h?.ref?.();
    this.child.stdin!.write(JSON.stringify({ type: 'user', message: { role: 'user', content: message } }) + '\n');
  }

  end() {
    this.handler = null;
    this.release();
  }

  private release() {
    for (const h of [this.child, this.child.stdin, this.child.stdout, this.child.stderr] as Array<{ unref?: () => void } | null>) h?.unref?.();
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), this.idleMs);
    this.idle.unref();
  }

  /** Stop the process; a turn in progress is told at once (it would otherwise wait for its timeout). */
  stop() {
    if (this.idle) clearTimeout(this.idle);
    const handler = this.handler;
    this.handler = null;
    if (!this.exited) this.child.kill();
    this.exited = true;
    handler?.onStopped();
  }
}

/** The app runs one chat at a time: at most one long-lived CLI per host process, so idle ones never pile up. */
let liveProcess: CliProcess | null = null;

export class ClaudeCodeProvider implements AssistantProvider {
  private proc: CliProcess | null = null;

  constructor(private cfg: ClaudeCodeConfig) {}

  reset() {
    this.stopProcess();
    this.cfg.sessionStore.set(undefined);
  }

  private stopProcess() {
    this.proc?.stop();
    this.proc = null;
  }

  async send(text: string, emit: Emit, signal?: AbortSignal, note?: string): Promise<void> {
    const t0 = performance.now();
    // The app's note goes inside the <context> block (app-written), with no angle bracket that could close it.
    const context = buildTurnContext(this.cfg.store, new Date());
    const message = wrapMessage(note ? `${context.trimEnd()}\n\n${note.replace(/</g, '‹').replace(/>/g, '›')}` : context, text);
    let cli: CliStats;
    try {
      cli = await this.turn(message, emit, signal);
    } catch (err) {
      // Retried only when the failed attempt showed nothing, so no tool can have run twice.
      if (!(err instanceof CliRunFailed) || err.emitted || signal?.aborted) throw err;
      // A stored session the CLI no longer knows (upgrade, cleared ~/.claude, copied database): start fresh once.
      if (err.resumed) {
        this.cfg.sessionStore.set(undefined);
        cli = await this.turn(message, emit, signal);
      } else {
        // The long-lived process died before answering: answer this turn with a one-shot run.
        cli = await this.runOnce(message, emit, signal, this.cfg.sessionStore.get());
      }
    }
    const stats: TurnStats = { wallMs: performance.now() - t0, ...cli };
    (this.cfg.log ?? ((l: string) => console.error(`[assistant] ${l}`)))(formatTurnLine(stats));
    emit({ type: 'stats', stats });
  }

  private mcpConfig(): string {
    const mcp = mcpServerCommand();
    return JSON.stringify({ mcpServers: { scheduler: { command: mcp.command, args: mcp.args, env: { PLANNAV_DB_PATH: this.cfg.dbPath } } } });
  }

  /** Start the long-lived CLI now (the chat opened), so the first message does not wait for process start. */
  warm() {
    this.ensureProcess();
  }

  /**
   * The long-lived process, started (or restarted, resuming the session) when there is none or it has exited. The
   * prompt check is a safety net: buildStablePrompt() is constant, so a running process never has a stale one today.
   */
  private ensureProcess(): CliProcess {
    const stable = buildStablePrompt();
    if (this.proc && (this.proc.exited || this.proc.stable !== stable)) this.stopProcess();
    if (!this.proc) {
      const session = this.cfg.sessionStore.get();
      const args = buildClaudeArgs({ systemPrompt: stable, mcpConfig: this.mcpConfig(), model: this.cfg.model, session, extraArgs: this.cfg.claudeArgs });
      if (liveProcess && !liveProcess.exited) liveProcess.stop();
      this.proc = liveProcess = new CliProcess(this.cfg.claudeBin ?? 'claude', args, claudeEnv(this.cfg.dbPath), stable, Boolean(session), this.cfg.idleMs ?? 15 * 60_000);
    }
    return this.proc;
  }

  /** One turn on the long-lived process. */
  private turn(message: string, emit: Emit, signal: AbortSignal | undefined): Promise<CliStats> {
    const proc = this.ensureProcess();
    const resumed = proc.resumed && !proc.answered;
    const toolNames = new Map<string, string>();
    const streamState = { streamed: false };
    return new Promise<CliStats>((resolve, reject) => {
      let emitted = false;
      let settled = false;
      // Declared before `finish`, which clears it: a signal already aborted settles the turn before the timer is set.
      let timer: NodeJS.Timeout | undefined;
      const finish = (err: Error | null, stats?: CliStats) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        proc.end();
        if (err) {
          // A failed turn leaves the process in an unknown state: the next turn starts a new one (resuming the session).
          if (this.proc === proc) this.stopProcess();
          reject(err);
        } else resolve(stats!);
      };
      const onAbort = () => finish(new Error('The reply was stopped.'));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort);
      timer = setTimeout(() => finish(new CliRunFailed('claude did not answer in time. Try again, or start a new chat.', false, true)), this.cfg.turnTimeoutMs ?? 180_000);
      proc.begin(message, {
        onEvent: (ev) => {
          if (ev.kind === 'result') {
            this.cfg.sessionStore.set(ev.sessionId);
            if (ev.isError) return finish(new CliRunFailed('claude reported an error. If this keeps happening, start a new chat.', resumed, emitted));
            proc.answered = true;
            return finish(null, { ...ev.stats, durationApiMs: proc.apiDelta(ev.stats.durationApiMs) });
          }
          for (const out of toAssistantEvents(ev, toolNames, streamState)) { emitted = true; emit(out); }
        },
        onExit: (code, tail) => finish(new CliRunFailed(`claude exited with code ${code}${tail ? `: ${tail}` : ''}. If this keeps happening, start a new chat.`, resumed, emitted)),
        // Not a CliRunFailed: a stopped turn is not retried.
        onStopped: () => finish(new Error('The reply was stopped.')),
      });
    });
  }

  /** The one-shot path: a process for this message alone (the fallback when the long-lived one fails). */
  private async runOnce(message: string, emit: Emit, signal: AbortSignal | undefined, session: string | undefined): Promise<CliStats> {
    const args = buildClaudeArgs({ text: message, systemPrompt: buildStablePrompt(), mcpConfig: this.mcpConfig(), model: this.cfg.model, session, extraArgs: this.cfg.claudeArgs });
    const resumed = Boolean(session);
    const toolNames = new Map<string, string>();
    const streamState = { streamed: false };
    let stats: CliStats = {};
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.cfg.claudeBin ?? 'claude', args, { env: claudeEnv(this.cfg.dbPath), stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      let gotResult = false;
      let resultIsError = false;
      let emitted = false;
      child.stderr.on('data', (d) => { stderr = (stderr + String(d)).slice(-STDERR_KEPT); });
      signal?.addEventListener('abort', () => child.kill());
      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        for (const ev of parseStreamJsonLine(line)) {
          if (ev.kind === 'result') {
            gotResult = true;
            resultIsError = ev.isError;
            stats = ev.stats;
            this.cfg.sessionStore.set(ev.sessionId);
          }
          for (const out of toAssistantEvents(ev, toolNames, streamState)) { emitted = true; emit(out); }
          // The reply is complete at a successful result: answer now. The CLI would take another 0.6 to 0.8 s to shut
          // down (MCP servers, telemetry), once nearly five minutes; the session is already on disk, so --resume works.
          if (ev.kind === 'result' && !ev.isError) { resolve(); child.kill(); }
        }
      });
      child.on('error', (err) => reject(new Error(`Could not start claude CLI: ${err.message}`)));
      child.on('close', (code) => {
        if (gotResult && !resultIsError) return resolve();
        const tail = stderr.trim().split('\n').slice(-5).join('\n');
        if (gotResult && resultIsError) return reject(new CliRunFailed(`claude reported an error${tail ? `: ${tail}` : ''}`, resumed, emitted));
        reject(new CliRunFailed(`claude exited with code ${code}${tail ? `: ${tail}` : ''}. If this keeps happening, start a new chat.`, resumed, emitted));
      });
    });
    return stats;
  }
}
