import type { BudgetLevel, Plan, PlanOptions } from '../types.js';
import { PlannerService } from './planner.js';

const baseTimeoutByBudget = (budget: BudgetLevel): number => ({ cheap: 8_000, normal: 20_000, thorough: 45_000 })[budget];

export interface PlannerStrategy {
  id: string;
  description: string;
  createPlan(userRequest: string, budgetLevel: BudgetLevel, options?: PlanOptions): Plan;
}

// Default strategy: balances quality and cost by request complexity.
// Delegates fully to the enhanced PlannerService so that PlanOptions (goal_type, risk_level,
// must_verify, tool_preference, latency_hint_ms, max_cost_override) are all applied.
class HeuristicStrategy implements PlannerStrategy {
  id = 'heuristic_v1';
  description = 'Default heuristic strategy balancing quality and cost by request complexity.';
  private readonly planner = new PlannerService();

  createPlan(userRequest: string, budgetLevel: BudgetLevel, options?: PlanOptions): Plan {
    // Pass options through so the planner applies goal_type, risk_level, must_verify, etc.
    let plan = this.planner.createPlan(userRequest, budgetLevel, options);

    // Safety net: strip tools if caller explicitly opts out (planner may have already done this).
    if (options?.tool_preference === 'avoid') {
      plan = { ...plan, tasks: plan.tasks.map((t) => ({ ...t, tools_allowed: [] })) };
    }

    // Safety net: ensure a verifier exists when must_verify is set. The enhanced planner forces
    // multi-mode when must_verify=true, but guard against edge cases from client-supplied plans.
    if (options?.must_verify && !plan.tasks.some((t) => t.agent === 'verifier')) {
      const executor = plan.tasks[0];
      plan = {
        ...plan,
        mode: 'multi',
        tasks: [
          { ...executor, name: 'single_executor', depends_on: [] },
          {
            name: 'verifier',
            agent: 'verifier',
            input: 'Validate single executor result against original criteria.',
            depends_on: ['single_executor'],
            tools_allowed: [],
            model: executor.model,
            reasoning_level: 'high',
            max_output_tokens: 220,
            timeout_ms: Math.min(executor.timeout_ms ?? 20_000, baseTimeoutByBudget(budgetLevel)),
            system_prompt:
              'You are a verification agent. Validate results for correctness, completeness, and quality. Return { "verified": true } if all criteria pass.'
          }
        ]
      };
    }

    return plan;
  }
}

// Conservative strategy: minimal tokens and tools, prefers single mode.
class SafeMinimalV2Strategy implements PlannerStrategy {
  id = 'safe_minimal_v2';
  description = 'Safety-first strategy: prefers single mode, reduced token budgets, and avoids tools unless explicitly preferred.';
  private readonly planner = new PlannerService();

  createPlan(userRequest: string, budgetLevel: BudgetLevel, options?: PlanOptions): Plan {
    const highComplexity = userRequest.length > 420 || /(parallel|verify|analyze|complex|multi)/i.test(userRequest);
    const mustMulti = Boolean(options?.must_verify || highComplexity);

    if (!mustMulti) {
      return {
        mode: 'single',
        rationale: 'safe_minimal_v2 selected single execution path.',
        budget: this.planner.createPlan(userRequest, budgetLevel, options).budget,
        invariants: ['Stay under strict budget bounds'],
        success_criteria: ['Produce valid output'],
        tasks: [
          {
            name: 'single_executor',
            agent: 'executor',
            input: userRequest,
            depends_on: [],
            tools_allowed: options?.tool_preference === 'prefer' ? ['js_eval'] : [],
            model: 'gpt-lite',
            reasoning_level: 'low',
            max_output_tokens: 180,
            timeout_ms: baseTimeoutByBudget(budgetLevel),
            system_prompt: 'You are an executor agent. Solve the task concisely and return structured JSON output.'
          }
        ],
        output_contract: { type: 'json', schema: { type: 'object' } }
      };
    }

    // For multi-mode, delegate to the enhanced planner (passes options for budget overrides,
    // system prompts, etc.) then cap output tokens to enforce the conservative budget.
    const base = this.planner.createPlan(userRequest, budgetLevel, options);
    const toolsAllowed = options?.tool_preference === 'prefer' ? ['js_eval'] : [];

    return {
      ...base,
      mode: 'multi',
      tasks: base.tasks.map((task) => {
        if (task.agent === 'executor') {
          return { ...task, tools_allowed: toolsAllowed, max_output_tokens: Math.min(task.max_output_tokens, 220) };
        }
        return { ...task, max_output_tokens: Math.min(task.max_output_tokens, 220) };
      })
    };
  }
}

// Code-focused strategy: optimised for code generation and implementation tasks.
// Sets goal_type='code' to activate code-specific system prompts, model tier selection,
// and tool access (file_store enabled by default). Always adds a verifier pass.
class CodeFocusedV1Strategy implements PlannerStrategy {
  id = 'code_focused_v1';
  description = 'Optimised for code generation: activates code-specific system prompts, file_store tool, standard/premium models, and always verifies output.';
  private readonly planner = new PlannerService();

  createPlan(userRequest: string, budgetLevel: BudgetLevel, options?: PlanOptions): Plan {
    const codeOptions: PlanOptions = {
      ...options,
      goal_type: 'code',
      // Default to prefer tools (file_store) unless caller explicitly avoids
      tool_preference: options?.tool_preference === 'avoid' ? 'avoid' : 'prefer',
      // Always verify generated code for correctness
      must_verify: true
    };
    return this.planner.createPlan(userRequest, budgetLevel, codeOptions);
  }
}

// Analysis-focused strategy: optimised for deep analytical tasks.
// Sets goal_type='analysis' and risk_level='high' so executors use premium models,
// always runs in multi-agent mode with verification.
class AnalysisFocusedV1Strategy implements PlannerStrategy {
  id = 'analysis_focused_v1';
  description = 'Optimised for deep analysis: uses premium models for executors, forces multi-agent mode, and always verifies analytical conclusions.';
  private readonly planner = new PlannerService();

  createPlan(userRequest: string, budgetLevel: BudgetLevel, options?: PlanOptions): Plan {
    const analysisOptions: PlanOptions = {
      ...options,
      goal_type: 'analysis',
      risk_level: 'high',
      must_verify: true,
      // Analysis tasks rarely need file I/O unless caller prefers tools
      tool_preference: options?.tool_preference ?? 'avoid'
    };
    return this.planner.createPlan(userRequest, budgetLevel, analysisOptions);
  }
}

export class StrategyRegistry {
  private readonly strategies = new Map<string, PlannerStrategy>();
  readonly defaultStrategyId = 'heuristic_v1';

  constructor() {
    this.register(new HeuristicStrategy());
    this.register(new SafeMinimalV2Strategy());
    this.register(new CodeFocusedV1Strategy());
    this.register(new AnalysisFocusedV1Strategy());
  }

  register(strategy: PlannerStrategy): void {
    this.strategies.set(strategy.id, strategy);
  }

  get(id: string): PlannerStrategy | undefined {
    return this.strategies.get(id);
  }

  list(): Array<{ id: string; description: string }> {
    return [...this.strategies.values()].map((s) => ({ id: s.id, description: s.description }));
  }
}
