#!/usr/bin/env node
// Minimal stand-in for `claude -p --output-format stream-json`, one-shot (-p <text>) or long-lived (--input-format stream-json).
// With --resume stale it behaves like a CLI whose session is gone: no result event, exit 1.
// FAKE_RECORD: a file to append one JSON line per message ({ pid, args, content }).
// In a message: FAIL_STREAM exits without a result when long-lived, HANG never answers, ERROR_RESULT answers with is_error.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const flag = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
if (flag('--resume') === 'stale') {
  process.stderr.write('No conversation found with session ID: stale\n');
  process.exit(1);
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let n = 0;
function answer(content, stream) {
  n += 1;
  if (process.env.FAKE_RECORD) appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ pid: process.pid, args, content }) + '\n');
  if (stream && content.includes('FAIL_STREAM')) process.exit(2);
  if (content.includes('HANG')) return;
  out({ type: 'system', subtype: 'init' });
  const reply = `echo: ${content.split('\n\n').pop()}`;
  // With --include-partial-messages the real CLI streams the text, then sends the complete message too.
  if (args.includes('--include-partial-messages')) {
    out({ type: 'stream_event', event: { type: 'message_start', message: {} }, parent_tool_use_id: null });
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } }, parent_tool_use_id: null });
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
  // duration_api_ms is cumulative over a long-lived process, as the real CLI reports it.
  out({ type: 'result', session_id: 'fresh-session', is_error: content.includes('ERROR_RESULT'), duration_ms: 900, duration_api_ms: 700 * n, ttft_ms: 400, num_turns: 1, usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 30000, cache_creation_input_tokens: 2000 } });
}

if (flag('--input-format') === 'stream-json') {
  // FAKE_RECORD_SPAWN: also record the start of a long-lived process (content "<spawn>").
  if (process.env.FAKE_RECORD && process.env.FAKE_RECORD_SPAWN) appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ pid: process.pid, args, content: '<spawn>' }) + '\n');
  createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    answer(typeof m.message.content === 'string' ? m.message.content : m.message.content.map((b) => b.text).join(''), true);
  }).on('close', () => process.exit(0));
} else if (process.env.FAKE_ONESHOT_STDERR) {
  // FAKE_ONESHOT_STDERR: a one-shot run that writes this many bytes of stderr on one line and exits 3 without a result.
  process.stderr.write('e'.repeat(Number(process.env.FAKE_ONESHOT_STDERR)), () => process.exit(3));
} else {
  answer(args[args.indexOf('-p') + 1], false);
  // FAKE_LINGER_MS: stay alive after the result, as the real CLI does while it shuts down (MCP servers, telemetry).
  if (process.env.FAKE_LINGER_MS) setTimeout(() => process.exit(0), Number(process.env.FAKE_LINGER_MS));
}
