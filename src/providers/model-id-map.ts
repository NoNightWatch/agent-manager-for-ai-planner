/**
 * Maps OpenRouter canonical model IDs (format: "provider/model-name") to the
 * native model identifiers expected by each vendor's API.
 *
 * Usage:
 *   import { toNativeModelId } from './model-id-map.js';
 *   const claudeId = toNativeModelId('anthropic/claude-3-5-sonnet-20241022', 'anthropic');
 *   // → 'claude-3-5-sonnet-20241022'
 *
 * Keep entries sorted by openrouter_id for easy scanning.
 * Only add entries where the native ID differs from stripping the "provider/" prefix,
 * OR where you need an explicit override.
 */

export type NativeProvider = 'anthropic' | 'openai' | 'openrouter';

export type ModelIdEntry = {
  /** OpenRouter canonical ID, e.g. "anthropic/claude-3-5-sonnet-20241022". */
  openrouter_id: string;
  /** Native Anthropic Messages API model ID, if applicable. */
  anthropic?: string;
  /** Native OpenAI Chat Completions API model ID, if applicable. */
  openai?: string;
  /**
   * Canonical OpenRouter model ID — always the same as openrouter_id.
   * Present for symmetry so callers can use the same lookup path for all providers.
   */
  openrouter?: string;
};

const MODEL_ID_MAP: ModelIdEntry[] = [
  // ── Anthropic ──────────────────────────────────────────────────────────────
  {
    openrouter_id: 'anthropic/claude-3-5-haiku',
    anthropic: 'claude-haiku-4-5-20251001',
  },
  {
    openrouter_id: 'anthropic/claude-3-5-haiku-20241022',
    anthropic: 'claude-haiku-4-5-20251001',
  },
  {
    openrouter_id: 'anthropic/claude-3-5-sonnet',
    anthropic: 'claude-sonnet-4-6',
  },
  {
    openrouter_id: 'anthropic/claude-3-5-sonnet-20241022',
    anthropic: 'claude-sonnet-4-6',
  },
  {
    openrouter_id: 'anthropic/claude-3-haiku',
    anthropic: 'claude-haiku-4-5-20251001',
  },
  {
    openrouter_id: 'anthropic/claude-3-haiku-20240307',
    anthropic: 'claude-haiku-4-5-20251001',
  },
  {
    openrouter_id: 'anthropic/claude-3-opus',
    anthropic: 'claude-opus-4-6',
  },
  {
    openrouter_id: 'anthropic/claude-3-opus-20240229',
    anthropic: 'claude-opus-4-6',
  },
  {
    openrouter_id: 'anthropic/claude-opus-4',
    anthropic: 'claude-opus-4-6',
  },
  {
    openrouter_id: 'anthropic/claude-sonnet-4',
    anthropic: 'claude-sonnet-4-6',
  },
  {
    openrouter_id: 'anthropic/claude-haiku-3-5',
    anthropic: 'claude-haiku-4-5-20251001',
  },

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  { openrouter_id: 'openai/gpt-3.5-turbo',        openai: 'gpt-3.5-turbo' },
  { openrouter_id: 'openai/gpt-3.5-turbo-0125',   openai: 'gpt-3.5-turbo-0125' },
  { openrouter_id: 'openai/gpt-4o',               openai: 'gpt-4o' },
  { openrouter_id: 'openai/gpt-4o-mini',          openai: 'gpt-4o-mini' },
  { openrouter_id: 'openai/gpt-4-turbo',          openai: 'gpt-4-turbo' },
  { openrouter_id: 'openai/gpt-4-turbo-preview',  openai: 'gpt-4-turbo-preview' },
  { openrouter_id: 'openai/o1',                   openai: 'o1' },
  { openrouter_id: 'openai/o1-mini',              openai: 'o1-mini' },
  { openrouter_id: 'openai/o1-preview',           openai: 'o1-preview' },
  { openrouter_id: 'openai/o3-mini',              openai: 'o3-mini' },

  // ── Mistral ────────────────────────────────────────────────────────────────
  // Mistral models are accessed via the Mistral API natively; strip prefix for the native ID.
  { openrouter_id: 'mistralai/mistral-7b-instruct',          openrouter: 'mistralai/mistral-7b-instruct' },
  { openrouter_id: 'mistralai/mistral-7b-instruct:free',     openrouter: 'mistralai/mistral-7b-instruct:free' },
  { openrouter_id: 'mistralai/mistral-small',                openrouter: 'mistralai/mistral-small' },
  { openrouter_id: 'mistralai/mistral-small-2409',           openrouter: 'mistralai/mistral-small-2409' },
  { openrouter_id: 'mistralai/mistral-medium',               openrouter: 'mistralai/mistral-medium' },
  { openrouter_id: 'mistralai/mistral-large',                openrouter: 'mistralai/mistral-large' },
  { openrouter_id: 'mistralai/mistral-large-2411',           openrouter: 'mistralai/mistral-large-2411' },
  { openrouter_id: 'mistralai/mixtral-8x7b-instruct',        openrouter: 'mistralai/mixtral-8x7b-instruct' },
  { openrouter_id: 'mistralai/mixtral-8x22b-instruct',       openrouter: 'mistralai/mixtral-8x22b-instruct' },

  // ── Meta Llama ────────────────────────────────────────────────────────────
  { openrouter_id: 'meta-llama/llama-3.1-8b-instruct',       openrouter: 'meta-llama/llama-3.1-8b-instruct' },
  { openrouter_id: 'meta-llama/llama-3.1-8b-instruct:free',  openrouter: 'meta-llama/llama-3.1-8b-instruct:free' },
  { openrouter_id: 'meta-llama/llama-3.1-70b-instruct',      openrouter: 'meta-llama/llama-3.1-70b-instruct' },
  { openrouter_id: 'meta-llama/llama-3.1-405b-instruct',     openrouter: 'meta-llama/llama-3.1-405b-instruct' },
  { openrouter_id: 'meta-llama/llama-3.2-1b-instruct',       openrouter: 'meta-llama/llama-3.2-1b-instruct' },
  { openrouter_id: 'meta-llama/llama-3.2-3b-instruct',       openrouter: 'meta-llama/llama-3.2-3b-instruct' },
  { openrouter_id: 'meta-llama/llama-3.2-11b-vision-instruct', openrouter: 'meta-llama/llama-3.2-11b-vision-instruct' },
  { openrouter_id: 'meta-llama/llama-3.3-70b-instruct',      openrouter: 'meta-llama/llama-3.3-70b-instruct' },

  // ── Google ────────────────────────────────────────────────────────────────
  { openrouter_id: 'google/gemini-flash-1.5',                openrouter: 'google/gemini-flash-1.5' },
  { openrouter_id: 'google/gemini-flash-1.5-8b',             openrouter: 'google/gemini-flash-1.5-8b' },
  { openrouter_id: 'google/gemini-flash-1.5-8b:free',        openrouter: 'google/gemini-flash-1.5-8b:free' },
  { openrouter_id: 'google/gemini-pro-1.5',                  openrouter: 'google/gemini-pro-1.5' },
  { openrouter_id: 'google/gemini-2.0-flash-001',            openrouter: 'google/gemini-2.0-flash-001' },
  { openrouter_id: 'google/gemini-2.0-flash-lite-001',       openrouter: 'google/gemini-2.0-flash-lite-001' },
  { openrouter_id: 'google/gemma-2-9b-it',                   openrouter: 'google/gemma-2-9b-it' },
  { openrouter_id: 'google/gemma-2-9b-it:free',              openrouter: 'google/gemma-2-9b-it:free' },

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  { openrouter_id: 'deepseek/deepseek-chat',                 openrouter: 'deepseek/deepseek-chat' },
  { openrouter_id: 'deepseek/deepseek-r1',                   openrouter: 'deepseek/deepseek-r1' },
  { openrouter_id: 'deepseek/deepseek-r1:free',              openrouter: 'deepseek/deepseek-r1:free' },
];

/**
 * Converts an OpenRouter model ID to the native model ID for a given provider.
 *
 * - For 'anthropic' / 'openai': returns the vendor-native ID (e.g. "claude-sonnet-4-6").
 * - For 'openrouter': returns the full OpenRouter canonical ID unchanged.
 * - Falls back to stripping the "provider/" prefix for unknown entries.
 * - Returns the original string unchanged if it contains no "/" (already native format).
 */
export const toNativeModelId = (openrouterId: string, provider: NativeProvider): string => {
  if (provider === 'openrouter') return openrouterId;

  const entry = MODEL_ID_MAP.find((e) => e.openrouter_id === openrouterId);
  if (entry) {
    const native = entry[provider];
    if (native) return native;
  }
  // Best-effort: strip the "provider/" prefix
  const slashIdx = openrouterId.indexOf('/');
  return slashIdx >= 0 ? openrouterId.slice(slashIdx + 1) : openrouterId;
};

/**
 * Returns the OpenRouter entry for an ID, or undefined if not in the map.
 * Useful for providers that want to check before attempting a conversion.
 */
export const getModelEntry = (openrouterId: string): ModelIdEntry | undefined =>
  MODEL_ID_MAP.find((e) => e.openrouter_id === openrouterId);
