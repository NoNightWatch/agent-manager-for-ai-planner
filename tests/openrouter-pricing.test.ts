import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ── Mock safeFetch before importing the module under test ──────────────────
vi.mock('../src/lib/safe-fetch.js', () => ({
  safeFetch: vi.fn()
}));

import { safeFetch } from '../src/lib/safe-fetch.js';
import {
  refreshPricing,
  getBestModelForTier,
  getModelPrice,
  getPricingSnapshot
} from '../src/services/openrouter-pricing.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const mockFetch = safeFetch as ReturnType<typeof vi.fn>;

/** Builds a minimal OpenRouter /models response body with the given model list. */
const makeResponse = (models: Array<{
  id: string;
  name?: string;
  promptPerToken: number;
  completionPerToken: number;
  hasTopProvider?: boolean;
}>) =>
  JSON.stringify({
    data: models.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      pricing: {
        prompt: String(m.promptPerToken),
        completion: String(m.completionPerToken)
      },
      top_provider: m.hasTopProvider ? { context_length: 200000 } : null
    }))
  });

const ok = (body: string) =>
  Promise.resolve({ status: 200, headers: new Headers(), bodyText: body });

// Reset module-level cache between tests by re-importing via a fresh refresh.
beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tier classification ────────────────────────────────────────────────────

describe('tier classification', () => {
  it('classifies a model with promptPerToken < 0.000001 as cheap', async () => {
    mockFetch.mockReturnValue(
      ok(makeResponse([{ id: 'x/nano', promptPerToken: 0.0000005, completionPerToken: 0.000002 }]))
    );
    await refreshPricing();
    const snap = getPricingSnapshot();
    expect(snap.find((e) => e.id === 'x/nano')?.tier).toBe('cheap');
  });

  it('classifies a model with $1/1M prompt as standard', async () => {
    // $1/1M = 0.000001 per token (boundary: >= CHEAP_MAX, < STANDARD_MAX)
    mockFetch.mockReturnValue(
      ok(makeResponse([{ id: 'x/mid', promptPerToken: 0.000001, completionPerToken: 0.000004 }]))
    );
    await refreshPricing();
    const snap = getPricingSnapshot();
    expect(snap.find((e) => e.id === 'x/mid')?.tier).toBe('standard');
  });

  it('classifies a model with $3/1M prompt as standard', async () => {
    mockFetch.mockReturnValue(
      ok(makeResponse([{ id: 'x/standard', promptPerToken: 0.000003, completionPerToken: 0.000015 }]))
    );
    await refreshPricing();
    const snap = getPricingSnapshot();
    expect(snap.find((e) => e.id === 'x/standard')?.tier).toBe('standard');
  });

  it('classifies a model with $5/1M prompt as premium (boundary)', async () => {
    mockFetch.mockReturnValue(
      ok(makeResponse([{ id: 'x/big', promptPerToken: 0.000005, completionPerToken: 0.00002 }]))
    );
    await refreshPricing();
    const snap = getPricingSnapshot();
    expect(snap.find((e) => e.id === 'x/big')?.tier).toBe('premium');
  });

  it('classifies a model with $15/1M prompt as premium', async () => {
    mockFetch.mockReturnValue(
      ok(makeResponse([{ id: 'x/opus', promptPerToken: 0.000015, completionPerToken: 0.000075 }]))
    );
    await refreshPricing();
    const snap = getPricingSnapshot();
    expect(snap.find((e) => e.id === 'x/opus')?.tier).toBe('premium');
  });

  it('stores prompt_per_1m and completion_per_1m as $/1M values', async () => {
    mockFetch.mockReturnValue(
      ok(makeResponse([{ id: 'x/test', promptPerToken: 0.000003, completionPerToken: 0.000015 }]))
    );
    await refreshPricing();
    const entry = getPricingSnapshot().find((e) => e.id === 'x/test');
    expect(entry?.prompt_per_1m).toBeCloseTo(3.0);
    expect(entry?.completion_per_1m).toBeCloseTo(15.0);
  });
});

// ── Best model selection ───────────────────────────────────────────────────

describe('getBestModelForTier – model selection', () => {
  it('returns the only cheap model in that tier', async () => {
    mockFetch.mockReturnValue(
      ok(makeResponse([
        { id: 'x/cheap-only', promptPerToken: 0.0000005, completionPerToken: 0.000002 }
      ]))
    );
    await refreshPricing();
    expect(getBestModelForTier('cheap')).toBe('x/cheap-only');
  });

  it('prefers a top_provider model over a cheaper non-top model', async () => {
    mockFetch.mockReturnValue(
      ok(makeResponse([
        // Non-top, slightly cheaper
        { id: 'x/budget', promptPerToken: 0.0000003, completionPerToken: 0.000001, hasTopProvider: false },
        // Top provider, slightly more expensive
        { id: 'x/top', promptPerToken: 0.0000005, completionPerToken: 0.000002, hasTopProvider: true }
      ]))
    );
    await refreshPricing();
    expect(getBestModelForTier('cheap')).toBe('x/top');
  });

  it('selects the cheapest model when multiple top_provider models exist in same tier', async () => {
    mockFetch.mockReturnValue(
      ok(makeResponse([
        { id: 'x/top-pricey', promptPerToken: 0.0000008, completionPerToken: 0.000003, hasTopProvider: true },
        { id: 'x/top-cheap',  promptPerToken: 0.0000005, completionPerToken: 0.000002, hasTopProvider: true }
      ]))
    );
    await refreshPricing();
    expect(getBestModelForTier('cheap')).toBe('x/top-cheap');
  });

  it('returns the correct model for each tier from a mixed list', async () => {
    mockFetch.mockReturnValue(
      ok(makeResponse([
        { id: 'x/nano',    promptPerToken: 0.0000002, completionPerToken: 0.000001, hasTopProvider: true },
        { id: 'x/mid',     promptPerToken: 0.000002,  completionPerToken: 0.000008, hasTopProvider: true },
        { id: 'x/premium', promptPerToken: 0.000010,  completionPerToken: 0.000050, hasTopProvider: true }
      ]))
    );
    await refreshPricing();
    expect(getBestModelForTier('cheap')).toBe('x/nano');
    expect(getBestModelForTier('standard')).toBe('x/mid');
    expect(getBestModelForTier('premium')).toBe('x/premium');
  });
});

// ── getModelPrice ──────────────────────────────────────────────────────────

describe('getModelPrice', () => {
  it('returns price for a known model', async () => {
    mockFetch.mockReturnValue(
      ok(makeResponse([{ id: 'x/known', promptPerToken: 0.000003, completionPerToken: 0.000015 }]))
    );
    await refreshPricing();
    const price = getModelPrice('x/known');
    expect(price).not.toBeNull();
    expect(price!.prompt).toBeCloseTo(3.0);
    expect(price!.completion).toBeCloseTo(15.0);
  });

  it('returns null for an unknown model', async () => {
    mockFetch.mockReturnValue(ok(makeResponse([])));
    await refreshPricing();
    // getPricingSnapshot would return [] but cache is set → no fallback needed
    expect(getModelPrice('not/here')).toBeNull();
  });
});

// ── Fallback scenarios ─────────────────────────────────────────────────────

describe('fallback behaviour', () => {
  it('returns placeholder names before any refresh has been performed', () => {
    // Module just loaded, no refresh done yet → cache is null
    // We need a fresh module instance; since vitest shares module state, we instead
    // verify that getBestModelForTier() returns a non-empty string (placeholder).
    // (A full isolation test requires --isolateModules or separate workers.)
    // Here we confirm the returned value is a non-empty string.
    const result = getBestModelForTier('cheap');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('keeps the previous cache when safeFetch throws a network error', async () => {
    // Seed the cache with a valid response.
    mockFetch.mockReturnValueOnce(
      ok(makeResponse([
        { id: 'x/stable-cheap', promptPerToken: 0.0000005, completionPerToken: 0.000002 }
      ]))
    );
    await refreshPricing();
    expect(getBestModelForTier('cheap')).toBe('x/stable-cheap');

    // Simulate a network failure on the next refresh.
    mockFetch.mockRejectedValueOnce(new Error('PROVIDER_NETWORK_ERROR'));
    await refreshPricing();

    // Should still return the previously cached model.
    expect(getBestModelForTier('cheap')).toBe('x/stable-cheap');
  });

  it('keeps the previous cache when the API returns a non-200 status', async () => {
    mockFetch.mockReturnValueOnce(
      ok(makeResponse([{ id: 'x/prev', promptPerToken: 0.0000005, completionPerToken: 0.000002 }]))
    );
    await refreshPricing();

    mockFetch.mockReturnValueOnce(
      Promise.resolve({ status: 503, headers: new Headers(), bodyText: 'Service Unavailable' })
    );
    await refreshPricing();

    expect(getBestModelForTier('cheap')).toBe('x/prev');
  });

  it('keeps the previous cache when the API returns invalid JSON', async () => {
    mockFetch.mockReturnValueOnce(
      ok(makeResponse([{ id: 'x/prev2', promptPerToken: 0.0000005, completionPerToken: 0.000002 }]))
    );
    await refreshPricing();

    mockFetch.mockReturnValueOnce(
      Promise.resolve({ status: 200, headers: new Headers(), bodyText: 'not json{{' })
    );
    await refreshPricing();

    expect(getBestModelForTier('cheap')).toBe('x/prev2');
  });

  it('keeps the previous cache when a 200 response with no valid entries is received', async () => {
    // Seed the cache with a known model first.
    mockFetch.mockReturnValueOnce(
      ok(makeResponse([{ id: 'x/seed', promptPerToken: 0.0000005, completionPerToken: 0.000002 }]))
    );
    await refreshPricing();
    expect(getBestModelForTier('cheap')).toBe('x/seed');

    // Now send a 200 with an empty data array — parseEntries returns [] so cache is NOT replaced.
    mockFetch.mockReturnValueOnce(
      Promise.resolve({ status: 200, headers: new Headers(), bodyText: JSON.stringify({ data: [] }) })
    );
    await refreshPricing();

    // The previously cached model must still be returned.
    expect(getBestModelForTier('cheap')).toBe('x/seed');
  });

  it('skips models with zero/missing prompt price', async () => {
    mockFetch.mockReturnValue(
      ok(
        JSON.stringify({
          data: [
            // Missing pricing entirely
            { id: 'x/no-price', name: 'No Price' },
            // Zero prompt price (free model)
            { id: 'x/free', name: 'Free', pricing: { prompt: '0', completion: '0' } },
            // Valid model
            { id: 'x/valid', name: 'Valid', pricing: { prompt: '0.000001', completion: '0.000004' }, top_provider: {} }
          ]
        })
      )
    );
    await refreshPricing();
    const snap = getPricingSnapshot();
    expect(snap.find((e) => e.id === 'x/no-price')).toBeUndefined();
    expect(snap.find((e) => e.id === 'x/free')).toBeUndefined();
    expect(snap.find((e) => e.id === 'x/valid')).toBeDefined();
  });
});

// ── getPricingSnapshot ─────────────────────────────────────────────────────

describe('getPricingSnapshot', () => {
  it('returns all cached entries after a successful refresh', async () => {
    mockFetch.mockReturnValue(
      ok(makeResponse([
        { id: 'a/one', promptPerToken: 0.0000002, completionPerToken: 0.000001 },
        { id: 'b/two', promptPerToken: 0.000003,  completionPerToken: 0.000012 }
      ]))
    );
    await refreshPricing();
    const snap = getPricingSnapshot();
    expect(snap.length).toBe(2);
    expect(snap.map((e) => e.id).sort()).toEqual(['a/one', 'b/two']);
  });

  it('returns a copy so callers cannot mutate the internal cache', async () => {
    mockFetch.mockReturnValue(
      ok(makeResponse([{ id: 'x/immutable', promptPerToken: 0.000001, completionPerToken: 0.000004 }]))
    );
    await refreshPricing();
    const snap = getPricingSnapshot();
    snap.push({ id: 'injected', name: 'injected', tier: 'cheap', prompt_per_1m: 0, completion_per_1m: 0, is_top_provider: false });
    expect(getPricingSnapshot().find((e) => e.id === 'injected')).toBeUndefined();
  });
});
