/**
 * OpenRouter pricing cache.
 *
 * Fetches https://openrouter.ai/api/v1/models (no API key required), classifies
 * each model into a tier based on its prompt price, and picks the best model per
 * tier (top_provider first, then lowest price).
 *
 * Call initPricing() once at server startup to begin automatic hourly refreshes.
 * getBestModelForTier() falls back to placeholder names from pricing-tiers.ts when
 * no live data is available, keeping backward compatibility with existing providers.
 */

import { safeFetch } from '../lib/safe-fetch.js';
import type { ModelPricingEntry } from '../types.js';
import type { ModelTier } from './model-tier.js';
import {
  TIER_THRESHOLDS,
  PRICING_REFRESH_INTERVAL_MS,
  OPENROUTER_MAX_RESPONSE_BYTES,
  OPENROUTER_REQUEST_TIMEOUT_MS,
  FALLBACK_MODEL_BY_TIER
} from '../config/pricing-tiers.js';

// ── Types ──────────────────────────────────────────────────────────────────

/** Raw shape of a single model object returned by the OpenRouter /models endpoint. */
type OpenRouterModelRaw = {
  id?: unknown;
  name?: unknown;
  pricing?: {
    prompt?: unknown;
    completion?: unknown;
  };
  top_provider?: unknown;
};

type OpenRouterResponse = {
  data?: unknown[];
};

// ── State ──────────────────────────────────────────────────────────────────

let cache: ModelPricingEntry[] | null = null;
let lastRefreshAt = 0;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
// Coalesces concurrent refresh calls into a single in-flight promise.
let refreshInFlight: Promise<void> | null = null;

// ── Internal helpers ───────────────────────────────────────────────────────

const toFloat = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = parseFloat(value);
    return isNaN(n) ? 0 : n;
  }
  return 0;
};

const classifyTier = (promptPer1m: number): ModelTier => {
  if (promptPer1m < TIER_THRESHOLDS.CHEAP_MAX_PER_1M) return 'cheap';
  if (promptPer1m < TIER_THRESHOLDS.STANDARD_MAX_PER_1M) return 'standard';
  return 'premium';
};

/**
 * Parses the raw OpenRouter API response into our internal ModelPricingEntry list.
 * Silently drops entries with missing/invalid required fields.
 */
const parseEntries = (raw: unknown): ModelPricingEntry[] => {
  const resp = raw as OpenRouterResponse;
  if (!resp?.data || !Array.isArray(resp.data)) return [];

  const entries: ModelPricingEntry[] = [];

  for (const item of resp.data) {
    const model = item as OpenRouterModelRaw;
    if (!model || typeof model.id !== 'string' || !model.id) continue;

    // Pricing values from OpenRouter are USD per token; multiply by 1e6 to get $/1M.
    const promptPerToken = toFloat(model.pricing?.prompt);
    const completionPerToken = toFloat(model.pricing?.completion);

    // Skip free/zero-price models and models with no pricing data.
    if (promptPerToken <= 0) continue;

    const promptPer1m = promptPerToken * 1_000_000;
    const completionPer1m = completionPerToken * 1_000_000;

    entries.push({
      id: model.id,
      name: typeof model.name === 'string' ? model.name : model.id,
      tier: classifyTier(promptPer1m),
      prompt_per_1m: promptPer1m,
      completion_per_1m: completionPer1m,
      // top_provider is non-null for models served directly by their primary vendor.
      is_top_provider: model.top_provider !== null && model.top_provider !== undefined
    });
  }

  return entries;
};

/**
 * Picks the single best model from a list of same-tier candidates.
 * Priority: top_provider first → lowest prompt price.
 */
const pickBest = (candidates: ModelPricingEntry[]): ModelPricingEntry | undefined => {
  if (candidates.length === 0) return undefined;
  return candidates.slice().sort((a, b) => {
    // top_provider models rank above non-top.
    if (a.is_top_provider !== b.is_top_provider) return a.is_top_provider ? -1 : 1;
    // Within the same top_provider bucket, prefer lower price.
    return a.prompt_per_1m - b.prompt_per_1m;
  })[0];
};

// ── Core fetch ─────────────────────────────────────────────────────────────

const doRefresh = async (): Promise<void> => {
  let bodyText: string;
  try {
    const result = await safeFetch('https://openrouter.ai/api/v1/models', {
      method: 'GET',
      timeoutMs: OPENROUTER_REQUEST_TIMEOUT_MS,
      maxBytes: OPENROUTER_MAX_RESPONSE_BYTES
    });
    if (result.status !== 200) {
      // Non-200 is not worth crashing for; we keep the existing cache (or fallback).
      console.warn(`[openrouter-pricing] refresh got HTTP ${result.status}, keeping previous cache`);
      return;
    }
    bodyText = result.bodyText;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[openrouter-pricing] refresh failed: ${msg}, keeping previous cache`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    console.warn('[openrouter-pricing] response is not valid JSON, keeping previous cache');
    return;
  }

  const entries = parseEntries(parsed);
  if (entries.length === 0) {
    console.warn('[openrouter-pricing] parsed 0 entries from response, keeping previous cache');
    return;
  }

  cache = entries;
  lastRefreshAt = Date.now();
  console.info(`[openrouter-pricing] refreshed: ${entries.length} models cached`);
};

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Triggers an immediate pricing refresh from OpenRouter.
 * Multiple concurrent calls are coalesced into a single in-flight request.
 */
export const refreshPricing = (): Promise<void> => {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
};

/**
 * Returns the OpenRouter model ID of the best model for the given tier,
 * or the fallback placeholder name if no live pricing data is available.
 *
 * Fallback values ('gpt-lite', 'gpt-standard', 'gpt-premium') are the same
 * placeholder names that existing providers already know how to handle.
 */
export const getBestModelForTier = (tier: ModelTier): string => {
  if (!cache) return FALLBACK_MODEL_BY_TIER[tier];
  const candidates = cache.filter((e) => e.tier === tier);
  const best = pickBest(candidates);
  return best ? best.id : FALLBACK_MODEL_BY_TIER[tier];
};

/**
 * Returns the cached prompt/completion prices ($/1M tokens) for a model ID,
 * or null if the model is not in the current cache.
 */
export const getModelPrice = (modelId: string): { prompt: number; completion: number } | null => {
  if (!cache) return null;
  const entry = cache.find((e) => e.id === modelId);
  if (!entry) return null;
  return { prompt: entry.prompt_per_1m, completion: entry.completion_per_1m };
};

/**
 * Returns a copy of the current in-memory pricing snapshot.
 * Returns an empty array when no live data has been fetched yet.
 */
export const getPricingSnapshot = (): ModelPricingEntry[] => (cache ? cache.slice() : []);

/** Milliseconds since the last successful refresh (0 if never refreshed). */
export const getLastRefreshAge = (): number => (lastRefreshAt > 0 ? Date.now() - lastRefreshAt : 0);

/**
 * Starts automatic hourly pricing refreshes and performs an immediate initial fetch.
 * Safe to call multiple times — subsequent calls are no-ops.
 *
 * Should be called once at server startup (e.g. from server.ts).
 */
export const initPricing = (): void => {
  if (refreshTimer !== null) return; // already started

  // Kick off an immediate first fetch without blocking startup.
  void refreshPricing();

  refreshTimer = setInterval(() => {
    void refreshPricing();
  }, PRICING_REFRESH_INTERVAL_MS);

  // Do not keep the Node process alive solely for this timer.
  refreshTimer.unref();
};

// Auto-init in non-test environments so that simply importing this module in
// production wires up the background refresh without requiring a separate call.
if (process.env.NODE_ENV !== 'test') {
  initPricing();
}
