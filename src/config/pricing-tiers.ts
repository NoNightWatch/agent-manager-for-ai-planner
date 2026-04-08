/**
 * Configuration for OpenRouter-based model tier selection.
 *
 * Thresholds, fallback model names, and refresh settings are kept here so they
 * can be tuned without touching the pricing logic in openrouter-pricing.ts.
 *
 * Network note:
 *   The pricing module fetches https://openrouter.ai/api/v1/models at startup.
 *   'openrouter.ai' is already included in the OUTBOUND_ALLOWLIST default value
 *   (see src/config.ts), so no extra configuration is needed for pricing to work.
 *   If you override OUTBOUND_ALLOWLIST in your environment, make sure to include
 *   'openrouter.ai' to keep automatic pricing refreshes enabled.
 */

/** Hostname required for live OpenRouter pricing. Listed here for easy reference. */
export const OPENROUTER_HOST = 'openrouter.ai';

/** Price thresholds in USD per 1 million prompt tokens. */
export const TIER_THRESHOLDS = {
  /** Models below this price are classified as 'cheap'. */
  CHEAP_MAX_PER_1M: 1.0,
  /** Models below this price (and at or above CHEAP_MAX) are classified as 'standard'. */
  STANDARD_MAX_PER_1M: 5.0,
  // Models priced at or above STANDARD_MAX are classified as 'premium'.
} as const;

/** Interval between automatic pricing refreshes from OpenRouter (milliseconds). */
export const PRICING_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Maximum size of the OpenRouter models response body (bytes). */
export const OPENROUTER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB

/** Timeout for the OpenRouter pricing request (milliseconds). */
export const OPENROUTER_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Fallback model names returned when OpenRouter pricing is unavailable.
 * These are the same placeholder names that existing providers (openai, anthropic,
 * gateway) are already configured to interpret, so backward compatibility is preserved.
 */
export const FALLBACK_MODEL_BY_TIER = {
  cheap: 'gpt-lite',
  standard: 'gpt-standard',
  premium: 'gpt-premium',
} as const;
