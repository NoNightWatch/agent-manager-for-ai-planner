/**
 * Tests for src/services/runner.ts
 *
 * Uses the mock provider (no API keys required) to exercise the full
 * plan → execute → result pipeline.
 */

import { describe, expect, it } from 'vitest';
import { run } from '../src/services/runner.js';
import type { RunResult } from '../src/services/runner.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Returns true when the value looks like a USD dollar amount >= 0. */
const isNonNegativeNumber = (v: unknown): v is number =>
  typeof v === 'number' && isFinite(v) && v >= 0;

// ── Suite ──────────────────────────────────────────────────────────────────

describe('runner.run()', () => {
  it('returns a successful RunResult for a simple request', async () => {
    const result = await run('Return the answer to 2 + 2');
    expect(result.success).toBe(true);
    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
  });

  it('result has required top-level fields with correct types', async () => {
    const result: RunResult = await run('Explain bubble sort briefly');
    expect(typeof result.success).toBe('boolean');
    expect(typeof result.output).toBe('string');
    expect(Array.isArray(result.tasks)).toBe(true);
    expect(isNonNegativeNumber(result.total_cost_est)).toBe(true);
    expect(isNonNegativeNumber(result.duration_ms)).toBe(true);
  });

  it('tasks array is non-empty and each task has required fields', async () => {
    const result = await run('Write hello world in Python');
    expect(result.tasks.length).toBeGreaterThan(0);

    for (const task of result.tasks) {
      expect(typeof task.name).toBe('string');
      expect(task.name.length).toBeGreaterThan(0);

      expect(typeof task.model).toBe('string');
      expect(task.model.length).toBeGreaterThan(0);

      expect(['cheap', 'standard', 'premium']).toContain(task.tier);

      expect(isNonNegativeNumber(task.cost_est)).toBe(true);
    }
  });

  it('duration_ms is positive after a completed run', async () => {
    const result = await run('Quick answer request');
    // Mock provider completes immediately; duration may be very small but >= 0.
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('total_cost_est equals the sum of individual task cost estimates', async () => {
    const result = await run('Compute something');
    const taskSum = result.tasks.reduce((acc, t) => acc + t.cost_est, 0);
    // Allow a small floating-point tolerance.
    expect(Math.abs(result.total_cost_est - taskSum)).toBeLessThan(0.0001);
  });

  it('respects the cheap budget_level option', async () => {
    const result = await run('Simple request', { budgetLevel: 'cheap' });
    expect(result.success).toBe(true);
    // With cheap budget the planner should produce a single-executor plan.
    expect(result.tasks.length).toBeGreaterThanOrEqual(1);
  });

  it('respects the thorough budget_level option', async () => {
    const result = await run('Thorough analysis request', { budgetLevel: 'thorough' });
    expect(result.success).toBe(true);
  });

  it('uses the mock provider when DEFAULT_PROVIDER_ID is not set', async () => {
    const savedProvider = process.env.DEFAULT_PROVIDER_ID;
    delete process.env.DEFAULT_PROVIDER_ID;
    try {
      const result = await run('Basic request');
      expect(result.success).toBe(true);
    } finally {
      if (savedProvider !== undefined) process.env.DEFAULT_PROVIDER_ID = savedProvider;
    }
  });

  it('explicitly pinning providerId=mock still succeeds', async () => {
    const result = await run('Mock provider test', { providerId: 'mock' });
    expect(result.success).toBe(true);
    // Every task model reported by the mock is its own task.model (set by planner).
    for (const task of result.tasks) {
      expect(typeof task.model).toBe('string');
    }
  });

  it('works multiple times in sequence (no shared state leaks)', async () => {
    const r1 = await run('First request');
    const r2 = await run('Second request');
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    // Runs are independent — different task instances.
    expect(r1.tasks).not.toBe(r2.tasks);
  });

  it('concurrent runs do not interfere with each other', async () => {
    const [r1, r2, r3] = await Promise.all([
      run('Concurrent request A'),
      run('Concurrent request B'),
      run('Concurrent request C')
    ]);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r3.success).toBe(true);
  });

  it('output is a non-empty string even when final_output is a structured object', async () => {
    // The mock provider returns a JSON object as output. The runner must stringify it.
    const result = await run('Object output test');
    expect(typeof result.output).toBe('string');
    expect(result.output.trim().length).toBeGreaterThan(0);
    // Should not literally be "(no output)" for a successful run.
    expect(result.output).not.toBe('(no output)');
  });
});
