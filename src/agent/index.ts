// Public surface of the embedded OpenRouter agent (docs/research/
// agent-protocol.md §4). The sidecar bridge imports from here only.
export {
  DEFAULT_BASE_URL,
  OpenRouterError,
  defaultModelId,
  listModels,
  modelOptionName,
  perMillion,
  usableModels,
  validateKey,
  type OpenRouterModel,
} from './models.js';
export {
  DEFAULT_SYSTEM_PROMPT,
  MAX_TOOL_ROUNDS,
  SYSTEM_RESOURCE_URI,
  createEmbeddedSession,
  type Effort,
  type EmbeddedMode,
  type EmbeddedSession,
  type EmbeddedSessionOptions,
} from './openrouter.js';
