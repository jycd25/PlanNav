import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { tools, runTool, type Store, type ToolContext } from '@ds/core';
import type { AssistantProvider, Emit } from './types.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { fetchText } from '../fetchText.js';

/** Wrap the core tools for the SDK tool runner. Results are emitted with the SDK's tool_use id so the UI can pair them with calls. */
export function buildSdkTools(store: Store, emit: Emit, ctx: ToolContext) {
  let fallbackCounter = 0;
  return tools.map((t) =>
    betaZodTool({
      name: t.name,
      description: t.description,
      inputSchema: t.schema,
      run: async (input, context) => {
        const id = context?.toolUse?.id ?? `${t.name}-${fallbackCounter++}`;
        try {
          const result = await runTool(store, t.name, input, ctx);
          emit({ type: 'tool_result', id, name: t.name, result });
          return JSON.stringify(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          emit({ type: 'tool_result', id, name: t.name, result: { error: message }, isError: true });
          return JSON.stringify({ error: message });
        }
      },
    }),
  );
}

export class AnthropicProvider implements AssistantProvider {
  private messages: Anthropic.Beta.BetaMessageParam[] = [];
  private useFallbacks = true;

  constructor(private store: Store, private cfg: { apiKey: string; model: string }) {}

  reset() { this.messages = []; }

  async send(text: string, emit: Emit, signal?: AbortSignal, note?: string): Promise<void> {
    const client = new Anthropic({ apiKey: this.cfg.apiKey });
    const ctx = { now: () => new Date(), fetchText };
    const sdkTools = buildSdkTools(this.store, emit, ctx);

    // The Context is in the system prompt here, rebuilt each turn; the note rides with the message so the history keeps it.
    const content = note ? `[${note}]\n\n${text}` : text;
    const history: Anthropic.Beta.BetaMessageParam[] = [...this.messages, { role: 'user', content }];
    const run = async (withFallbacks: boolean) => {
      const runner = client.beta.messages.toolRunner({
        model: this.cfg.model,
        max_tokens: 16000,
        system: buildSystemPrompt(this.store, ctx.now()),
        tools: sdkTools,
        messages: history,
        stream: true,
        max_iterations: 20,
        ...(withFallbacks ? { betas: ['server-side-fallback-2026-07-01' as Anthropic.AnthropicBeta], fallbacks: 'default' as const } : {}),
      }, { signal });
      for await (const stream of runner) {
        stream.on('text', (delta) => emit({ type: 'text', delta }));
        const msg = await stream.finalMessage();
        for (const block of msg.content) {
          if (block.type === 'tool_use') emit({ type: 'tool_call', id: block.id, name: block.name, input: block.input });
        }
        if (msg.stop_reason === 'refusal') emit({ type: 'error', message: 'The model declined this request.' });
      }
      this.messages = [...runner.params.messages];
    };

    try {
      await run(this.useFallbacks);
    } catch (err) {
      // An account or platform that rejects the fallback beta: retry once without it and remember.
      if (this.useFallbacks && err instanceof Anthropic.BadRequestError && /fallback|beta/i.test(err.message)) {
        this.useFallbacks = false;
        await run(false);
        return;
      }
      throw err;
    }
  }
}
