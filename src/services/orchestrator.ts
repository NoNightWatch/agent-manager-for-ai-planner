import pino from 'pino';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BudgetLevel, Plan, PlanOptions, Run } from '../types.js';
import { PlannerService } from './planner.js';
import { applyTierToPlan } from './model-tier.js';
import { ExecutionEngine } from './engine.js';
import { RunStore } from './run-store.js';
import { ToolRegistry } from './tools.js';
import { runId } from '../lib/utils.js';
import { PricingRegistry } from './pricing-registry.js';
import { PlanValidationError, validatePlan } from './plan-validator.js';
import { RateLimiter, RateLimitError } from './rate-limiter.js';
import { StrategyRegistry } from './planner-strategies.js';
import { appendRunEvent } from '../lib/events.js';
import { getConfig } from '../config.js';
import { createProviderRegistry } from '../providers/index.js';

export class EnqueuePlanInvalidError extends Error {
  readonly code = 'PLAN_INVALID';
  readonly retryable = false;
  readonly at = 'plan';

  constructor(readonly runId: string, message: string) {
    super(message);
  }
}

export class StrategyNotFoundError extends Error {
  readonly code = 'STRATEGY_NOT_FOUND';
  readonly retryable = false;
  readonly at = 'strategy_hint';

  constructor(message: string) {
    super(message);
  }
}

const resolvePackageJsonPath = (): string => {
  const base = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(base, '../../package.json'), join(base, '../../../package.json')];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {}
  }
  throw new Error('package.json not found');
};

const terminal = (status: Run['status']): boolean => status === 'succeeded' || status === 'failed';

export class OrchestratorService {
  private readonly planner = new PlannerService();
  private readonly strategies = new StrategyRegistry();
  private readonly tools = new ToolRegistry();
  private readonly pricing = new PricingRegistry();
  private readonly rateLimiter = new RateLimiter();
  private readonly providerRegistry = createProviderRegistry();
  private readonly engine = new ExecutionEngine(this.tools, this.providerRegistry);
  private readonly logger = pino({ name: 'orchestrator' });
  private readonly runControllers = new Map<string, AbortController>();

  constructor(
    private readonly store: RunStore,
    private readonly serviceVersion: string = JSON.parse(readFileSync(resolvePackageJsonPath(), 'utf8')).version as string
  ) {}

  getTools(): ToolRegistry {
    return this.tools;
  }

  createPlan(userRequest: string, budgetLevel: BudgetLevel = 'normal', tokenOwner = 'anonymous', strategyHint?: string, options?: PlanOptions): Plan {
    const strategyId = strategyHint ?? this.strategies.defaultStrategyId;
    const strategy = this.strategies.get(strategyId);
    if (!strategy) throw new StrategyNotFoundError(`Unknown strategy_hint: ${strategyId}`);
    const plan = strategy.createPlan(userRequest, budgetLevel, options);
    const policy = this.pricing.get(tokenOwner);
    const tiered = applyTierToPlan(plan, budgetLevel, policy.maxTierCap);
    validatePlan(tiered, this.tools);
    return tiered;
  }

  normalizeClientPlan(plan: Plan, budgetLevel: BudgetLevel, tokenOwner: string): Plan {
    const policy = this.pricing.get(tokenOwner);
    const tiered = applyTierToPlan(plan, budgetLevel, policy.maxTierCap);
    validatePlan(tiered, this.tools);
    return tiered;
  }

  enqueueRun(params: {
    userRequest?: string;
    plan?: Plan;
    idempotencyKey?: string;
    budgetLevel?: BudgetLevel;
    strategyHint?: string;
    planOptions?: PlanOptions;
    maxConcurrency?: number;
    dryRun?: boolean;
    providerId?: string;
    tokenOwner: string;
  }): { run_id?: string; status?: string; ok?: boolean; dry_run?: boolean; normalized_plan?: Plan; estimated_cost?: number; estimated_latency_ms?: number; task_count?: number } {
    const budget = params.budgetLevel ?? 'normal';
    if (params.idempotencyKey) {
      const existing = this.store.getByIdempotency(params.tokenOwner, params.idempotencyKey);
      if (existing) {
        const run = this.store.get(existing);
        if (run) return { run_id: run.id, status: run.status };
      }
    }

    const id = runId();

    let plan: Plan;
    try {
      plan = params.plan
        ? this.normalizeClientPlan(params.plan, budget, params.tokenOwner)
        : this.createPlan(params.userRequest ?? '', budget, params.tokenOwner, params.strategyHint, params.planOptions);
    } catch (error) {
      if (error instanceof PlanValidationError) {
        this.recordFailedRun(id, this.planner.createPlan('invalid_plan', budget), { code: 'PLAN_INVALID', message: error.message, retryable: false, at: 'plan' }, 'plan_invalid');
        throw new EnqueuePlanInvalidError(id, error.message);
      }
      throw error;
    }

    if (params.dryRun) {
      return {
        ok: true,
        dry_run: true,
        normalized_plan: plan,
        estimated_cost: plan.budget.max_cost_estimate,
        estimated_latency_ms: plan.budget.max_latency_ms,
        task_count: plan.tasks.length
      };
    }

    this.rateLimiter.checkAndConsume(params.tokenOwner);

    const queued: Run = {
      id,
      created_at: Date.now(),
      status: 'queued',
      plan,
      results_by_task: {},
      progress: { total_tasks: plan.tasks.length, completed_tasks: 0, running_tasks: 0, queued_tasks: plan.tasks.length },
      logs_base: 0,
      logs: [],
      metrics: {
        total_ms: 0,
        tasks_ms: {},
        tool_calls: 0,
        retries: 0,
        fallback: false,
        model_upgrades: 0,
        cost_estimate: 0,
        cost_estimate_committed: 0,
        cost_estimate_failed: 0,
        artifacts_bytes: 0,
        events_truncated: false,
        steps_executed_total: 0
      }
    };
    this.store.set({ ...queued, token_owner: params.tokenOwner }, params.tokenOwner);
    if (params.idempotencyKey) {
      this.store.putIdempotency(params.tokenOwner, params.idempotencyKey, id);
    }

    const controller = new AbortController();
    this.runControllers.set(id, controller);

    setImmediate(async () => {
      const latest = this.store.get(id);
      if (!latest) {
        this.rateLimiter.release(params.tokenOwner);
        this.runControllers.delete(id);
        return;
      }

      if (controller.signal.aborted || terminal(latest.status)) {
        this.rateLimiter.release(params.tokenOwner);
        this.runControllers.delete(id);
        return;
      }

      const started: Run = { ...latest, status: 'running' };
      this.store.set(started);
      const policy = this.pricing.get(params.tokenOwner);
      try {
        const run = await this.engine.executeRun(started, {
          maxConcurrency: params.maxConcurrency,
          tokenOwner: params.tokenOwner,
          pricing: policy,
          signal: controller.signal,
          providerId: params.providerId
        });
        this.store.set({ ...run, token_owner: params.tokenOwner }, params.tokenOwner);
        this.logger.info({ run_id: id, status: run.status }, 'run completed');
      } catch (error) {
        const failed: Run = {
          ...started,
          status: 'failed',
          error: { code: 'INTERNAL', message: error instanceof Error ? error.message : 'unknown', retryable: false, at: 'run' }
        };
        this.store.set({ ...failed, token_owner: params.tokenOwner }, params.tokenOwner);
        this.logger.error({ run_id: id, err: failed.error }, 'run crashed');
      } finally {
        this.runControllers.delete(id);
        this.rateLimiter.release(params.tokenOwner);
      }
    });

    return { run_id: id, status: 'queued' };
  }

  cancelRun(id: string): Run | undefined {
    const run = this.store.get(id);
    if (!run) return undefined;

    if (run.status === 'queued' || run.status === 'running') {
      this.runControllers.get(id)?.abort();
      const seq = run.logs_base + run.logs.length + 1;
      this.store.appendEvent(id, { seq, ts: Date.now(), type: 'run_cancel_requested', run_id: id, data: {} });
      return this.store.get(id);
    }

    return run;
  }

  async waitForCompletion(runId: string, timeoutMs: number, signal?: AbortSignal): Promise<Run> {
    return this.store.waitForCompletion(runId, { timeoutMs, signal });
  }

  getRun(id: string): Run | undefined {
    return this.store.get(id);
  }

  injectTaskResult(id: string, taskName: string, payload: unknown, meta?: unknown): Run | undefined {
    const run = this.store.get(id);
    if (!run) return undefined;
    if (run.status !== 'running' && run.status !== 'queued') return run;
    if (run.results_by_task[taskName]) return run;
    const injected = { ...(run.injected_tasks ?? {}), [taskName]: { payload, meta } };
    const updated: Run = { ...run, injected_tasks: injected };
    appendRunEvent(updated, 'task_injected', { task: taskName });
    this.store.set(updated, run.token_owner);
    return updated;
  }

  getRunEvents(id: string, after: number): { base: number; next: number; events: Run['logs']; truncated: boolean } | undefined {
    const run = this.store.get(id);
    if (!run) return undefined;
    const base = run.logs_base;
    const requested = Math.max(0, after);
    const truncated = requested < base;
    const events = run.logs.filter((event) => event.seq > requested);
    const next = events.length > 0 ? events[events.length - 1].seq : requested;
    return { base, next, events, truncated };
  }

  getCapabilities(includeDisabledProviders = false) {
    const cfg = getConfig();
    const defaultProviderId = cfg.DEFAULT_PROVIDER_ID || cfg.PROVIDER || (cfg.GATEWAY_URL ? 'gateway' : 'mock');
    return {
      version: this.serviceVersion,
      agent_roles: 'open: any string is accepted',
      reasoning_levels: ['low', 'medium', 'high'],
      budget_levels: ['cheap', 'normal', 'thorough'],
      llm_providers: {
        default_provider_id: defaultProviderId,
        providers: this.providerRegistry.list(includeDisabledProviders, defaultProviderId).map((p) => ({
          id: p.id,
          enabled: p.enabled,
          default: p.default,
          notes: p.notes
        })),
        env: {
          provider_env: 'LLM_PROVIDER',
          gateway_url_env: 'GATEWAY_URL',
          gateway_step_path_env: 'GATEWAY_STEP_PATH',
          gateway_api_key_env: 'GATEWAY_API_KEY',
          gateway_timeout_env: 'GATEWAY_TIMEOUT_MS'
        }
      },
      providers: this.providerRegistry.list(includeDisabledProviders, defaultProviderId),
      default_provider_id: defaultProviderId,
      strategies: { default_strategy: this.strategies.defaultStrategyId, available: this.strategies.list() },
      defaults: { max_concurrency_default: 8, budget_level_default: 'normal' },
      rate_limits: {
        tokenOwner_max_running_env: 'TOKENOWNER_MAX_RUNNING',
        tokenOwner_max_per_minute_env: 'TOKENOWNER_MAX_PER_MINUTE',
        tokenOwner_max_running: cfg.TOKENOWNER_MAX_RUNNING,
        tokenOwner_max_per_minute: cfg.TOKENOWNER_MAX_PER_MINUTE
      },
      tool_registration: {
        enabled: ((cfg.ENABLE_TOOL_REGISTER ?? cfg.ENABLE_TOOL_REGISTRATION) === '1'),
        tool_allowlist: cfg.TOOL_ALLOWLIST,
        tools_version: this.tools.getVersion(),
        available_tools: this.tools.list().map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
          tags: t.tags
        }))
      },
      endpoints: {
        openapi_url: '/openapi.json',
        events_url_template: '/v1/run/{id}/events?after={n}',
        stream_url_template: '/v1/run/{id}/stream?after={n}',
        replay_url_template: '/v1/run/{id}/replay',
        report_url_template: '/v1/run/{id}/report',
        cancel_url_template: '/v1/run/{id}/cancel'
      },
      // ── AI guidance ──────────────────────────────────────────────────────────
      // Structured hints to help AI callers pick the right options at call time.
      ai_guidance: {
        quick_start: 'POST /v1/run/sync with { user_request: "...", options: { budget_level: "normal" } } to get a synchronous result.',
        strategy_selection: {
          heuristic_v1: 'Default. Use for general requests — routes single vs multi-agent automatically based on complexity.',
          safe_minimal_v2: 'Use when low latency / token cost is critical, or the request is clearly simple.',
          code_focused_v1: 'Use when the primary goal is to write or review code. Activates file_store, verifier, and code-optimised system prompts.',
          analysis_focused_v1: 'Use for research or analytical tasks requiring thorough reasoning. Forces premium models and a verifier pass.'
        },
        budget_level_guide: {
          cheap: 'Max ~4 steps, 2 tool calls, $0.02, 15 s. Use for simple lookups or single-turn answers.',
          normal: 'Max ~8 steps, 6 tool calls, $0.08, 35 s. Good default for most tasks.',
          thorough: 'Max ~12 steps, 12 tool calls, $0.20, 60 s. Use for complex multi-step tasks where quality matters most.'
        },
        goal_type_guide: {
          answer: 'Factual Q&A or explanations. Executor uses knowledge-focused prompt, no tools by default.',
          code: 'Code generation or review. Enables file_store tool and code-expert executor prompt.',
          analysis: 'Deep analysis or research. Enables premium model tier and analytical executor prompt.',
          tooling: 'Tasks that require calling external APIs or manipulating files. Enables http_fetch, file_store, file_read tools.'
        },
        model_tier_mapping: {
          description: 'Internal tier names mapped to real models per provider. Budget level caps the maximum tier.',
          tiers: {
            cheap: { internal_name: 'gpt-lite', anthropic: process.env.ANTHROPIC_MODEL_CHEAP ?? 'claude-haiku-4-5-20251001', openai: process.env.OPENAI_MODEL_CHEAP ?? 'gpt-4o-mini' },
            standard: { internal_name: 'gpt-standard', anthropic: process.env.ANTHROPIC_MODEL_STANDARD ?? 'claude-sonnet-4-6', openai: process.env.OPENAI_MODEL_STANDARD ?? 'gpt-4o' },
            premium: { internal_name: 'gpt-premium', anthropic: process.env.ANTHROPIC_MODEL_PREMIUM ?? 'claude-opus-4-6', openai: process.env.OPENAI_MODEL_PREMIUM ?? 'o1-preview' }
          },
          agent_defaults: {
            triage: 'cheap (fast summarisation, no boost)',
            planner: 'standard (structured planning)',
            executor: 'cheap/standard/premium — scales with reasoning_level field',
            verifier: 'premium (critical correctness checking)'
          }
        },
        plan_options_reference: {
          budget_level: '"cheap" | "normal" | "thorough" — controls step/tool/cost/latency limits',
          strategy_hint: 'Override plan strategy. See strategy_selection above.',
          goal_type: '"answer" | "code" | "analysis" | "tooling" — shapes system prompts and tool selection',
          risk_level: '"low" | "medium" | "high" — high forces premium executor + verifier',
          must_verify: 'true → always run a verifier agent even for single-mode plans',
          tool_preference: '"avoid" | "allow" | "prefer" — controls whether executor tasks get tools',
          max_cost_override: 'Override max_cost_estimate budget cap (number, USD)',
          latency_hint_ms: 'Soft upper bound on latency (number, ms)',
          provider_id: 'Pin to a specific LLM provider ID',
          dry_run: 'true → return the normalised plan without executing it',
          max_concurrency: 'Max parallel tasks (default 8)'
        },
        builtin_tools: {
          js_eval: 'Evaluate arithmetic expressions (safe, sandboxed). Always available.',
          file_store: 'Write content to run artifact directory. Available for code/tooling goals.',
          file_read: 'Read files written by file_store in the same run. Complements file_store.',
          http_fetch: 'HTTP GET/POST to URLs in OUTBOUND_ALLOWLIST. Available for tooling goals.',
          datetime: 'Return current UTC time as iso/unix/parts. Available when request mentions time/date.'
        }
      }
    };
  }


  listRuns(params: { owner?: string; status?: Run['status']; limit: number; cursor?: string }): { runs: Array<{ id: string; created_at: number; status: Run['status']; plan_digest: string; summary: string; owner: string }>; next_cursor?: string } {
    return this.store.listRuns(params);
  }

  logRateLimited(owner: string, message: string): void {
    this.logger.warn({ owner, code: 'RATE_LIMIT', message }, 'run rejected by rate limiter');
  }

  isRateLimitError(error: unknown): error is RateLimitError {
    return error instanceof RateLimitError;
  }

  private recordFailedRun(id: string, plan: Plan, error: Run['error'], eventType: string): void {
    const run: Run = {
      id,
      created_at: Date.now(),
      status: 'failed',
      plan,
      results_by_task: {},
      progress: { total_tasks: 0, completed_tasks: 0, running_tasks: 0, queued_tasks: 0 },
      logs_base: 0,
      logs: [],
      metrics: {
        total_ms: 0,
        tasks_ms: {},
        tool_calls: 0,
        retries: 0,
        fallback: false,
        model_upgrades: 0,
        cost_estimate: 0,
        cost_estimate_committed: 0,
        cost_estimate_failed: 0,
        artifacts_bytes: 0,
        events_truncated: false,
        steps_executed_total: 0
      },
      error: error ?? undefined
    };
    appendRunEvent(run, eventType, { message: error?.message });
    this.store.set(run);
  }
}
