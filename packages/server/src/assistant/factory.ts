import type { SqliteStore } from '../db.js';
import type { AssistantConfig, AssistantManager, AssistantProvider, Emit } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { ClaudeCodeProvider } from './claudeCode.js';

const CONFIG_KEY = 'assistant';
const SESSION_KEY = 'claude_session';

export function createAssistantManager(store: SqliteStore, dbPath: string): AssistantManager {
  let config: AssistantConfig = store.getJson<AssistantConfig>(CONFIG_KEY) ?? { kind: 'claude-code' };
  let provider: AssistantProvider | null = null;

  const build = (): AssistantProvider => {
    if (config.kind === 'anthropic') return new AnthropicProvider(store, { apiKey: config.apiKey, model: config.model });
    return new ClaudeCodeProvider({
      dbPath, model: config.model, store,
      sessionStore: {
        get: () => store.getJson<string>(SESSION_KEY),
        set: (id) => (id ? store.setJson(SESSION_KEY, id) : store.deleteKey(SESSION_KEY)),
      },
    });
  };

  return {
    send: (text: string, emit: Emit, signal?: AbortSignal, note?: string) => (provider ??= build()).send(text, emit, signal, note),
    reset: () => { provider?.reset(); provider = null; },
    warm: () => (provider ??= build()).warm?.(),
    getConfig: () => config,
    setConfig: (c) => { config = c; store.setJson(CONFIG_KEY, c); provider?.reset(); provider = null; },
  };
}
