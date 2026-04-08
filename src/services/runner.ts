/**
 * High-level runner — the simplest way to execute a task programmatically.
 *
 * Usage:
 *   import { run } from './services/runner.js';
 *   const result = await run('Write a bubble sort in Python');
 *   console.log(result.output);
 *
 * Works out of the box without any API keys — defaults to the mock provider so
 * you can try the full orchestration flow locally. Set ANTHROPIC_API_KEY or
 * OPENAI_API_KEY (and the matching provider in DEFAULT_PROVIDER_ID) to get real
 * model responses.
 */

import { OrchestratorService } from './orchestrator.js';
import { RunStore } from './run-store.js';
import type { BudgetLevel, PlanOptions, Run } from '../types.js';

// ── Public types ───────────────────────────────────────────────────────────

export type TaskSummary = {
  /** Task name as assigned by the planner (e.g. "triage", "executor", "verifier"). */
  name: string;
  /** Model ID actually used for this task (OpenRouter or provider-native format). */
  model: string;
  /** Cost tier assigned: 'cheap' | 'standard' | 'premium'. */
  tier: string;
  /** Estimated cost in USD for this task. */
  cost_est: number;
};

export type RunResult = {
  /** True when the run completed with status "succeeded". */
  success: boolean;
  /** Human-readable final output from the last executor task. */
  output: string;
  /** Per-task summary including model, tier, and estimated cost. */
  tasks: TaskSummary[];
  /** Sum of all committed task costs in USD. */
  total_cost_est: number;
  /** Wall-clock execution time in milliseconds. */
  duration_ms: number;
};

export type RunnerOptions = {
  /** Budget level controlling step/tool/cost limits. Default: 'normal'. */
  budgetLevel?: BudgetLevel;
  /** Override the planner strategy. Default: 'heuristic_v1'. */
  strategyHint?: string;
  /** Fine-grained plan options (goal_type, risk_level, must_verify, …). */
  planOptions?: PlanOptions;
  /**
   * Maximum time to wait for the run to complete, in milliseconds.
   * Default: 30 000 ms. Increase for complex/thorough runs.
   */
  timeoutMs?: number;
  /** Pin to a specific LLM provider ID (e.g. 'anthropic', 'openai', 'mock'). */
  providerId?: string;
};

// ── Helpers ────────────────────────────────────────────────────────────────

const outputToString = (value: unknown): string => {
  if (value === undefined || value === null) return '(no output)';
  if (typeof value === 'string') return value;
  // Pretty-print objects so the CLI and callers get readable text.
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const extractTasks = (completedRun: Run): TaskSummary[] =>
  completedRun.plan.tasks.map((task) => {
    const result = completedRun.results_by_task[task.name];
    return {
      name: task.name,
      model: result?.meta?.model ?? task.model,
      tier: result?.meta?.tier ?? 'cheap',
      cost_est: result?.meta?.cost_est ?? 0
    };
  });

// ── Main API ───────────────────────────────────────────────────────────────

/**
 * Execute a user request end-to-end and return a structured result.
 *
 * Internally creates a private RunStore + OrchestratorService so every call is
 * fully isolated — no shared state between invocations.
 */
export const run = async (userRequest: string, options: RunnerOptions = {}): Promise<RunResult> => {
  const store = new RunStore();
  const orchestrator = new OrchestratorService(store);
  const timeoutMs = options.timeoutMs ?? 30_000;

  const enqueued = orchestrator.enqueueRun({
    userRequest,
    budgetLevel: options.budgetLevel,
    strategyHint: options.strategyHint,
    planOptions: options.planOptions,
    providerId: options.providerId,
    tokenOwner: 'runner'
  });

  const runId = enqueued.run_id;
  if (!runId) {
    // dry_run or unexpected path — should not happen in normal usage
    throw new Error('enqueueRun did not return a run_id');
  }

  const completedRun = await orchestrator.waitForCompletion(runId, timeoutMs);

  const success = completedRun.status === 'succeeded';
  const output = success
    ? outputToString(completedRun.final_output)
    : (completedRun.error?.message ?? 'Run failed with unknown error');

  return {
    success,
    output,
    tasks: extractTasks(completedRun),
    total_cost_est: completedRun.metrics.cost_estimate_committed,
    duration_ms: completedRun.metrics.total_ms
  };
};
