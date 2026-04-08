import type { BudgetLevel, Plan, PlanOptions, TaskSpec } from '../types.js';
import { PlanSchema } from '../types.js';

const budgetByLevel: Record<BudgetLevel, Plan['budget']> = {
  cheap: { max_steps: 4, max_tool_calls: 2, max_latency_ms: 15_000, max_cost_estimate: 0.02, max_model_upgrades: 1 },
  normal: { max_steps: 8, max_tool_calls: 6, max_latency_ms: 35_000, max_cost_estimate: 0.08, max_model_upgrades: 2 },
  thorough: { max_steps: 12, max_tool_calls: 12, max_latency_ms: 60_000, max_cost_estimate: 0.2, max_model_upgrades: 4 }
};

const taskTimeoutByBudget: Record<BudgetLevel, number> = {
  cheap: 8_000,
  normal: 20_000,
  thorough: 45_000
};

// Broad compute / analytical vocabulary
const kCompute = /(calculate|compute|analy[sz]e|algorithm|derive|optimi[sz]e|process|transform|convert|simulate|predict|model|estimate)/i;
// Verification / correctness vocabulary
const kVerify = /(verify|validate|proof|test|assert|check|review|audit|inspect|confirm|ensure|certify)/i;
// External resource / IO vocabulary (also catches network and data verbs)
const kExternal = /(file|tool|api|web|search|database|js|script|store|fetch|request|download|upload|query|endpoint|http)/i;
// Multi-goal indicators: conjunctions, list syntax, enumeration, ordering words
const kMultiGoal = /( and | also |;|\n-| then | after that| finally| additionally| furthermore)/i;
// Code generation vocabulary
const kCode = /(code|function|implement|class|module|script|program|write|build|debug|refactor|develop|create a|\bapi\b)/i;
// Comparison / trade-off vocabulary → usually needs two parallel executor streams
const kComparison = /(compare|contrast|\bvs\b|\bversus\b|difference between|better than|pros and cons|trade.?off|which is (better|faster|cheaper))/i;
// Explicit sequential structure → multi-step = multi-agent
const kSequential = /(step.by.step|\bstep \d|\bphase \d|\bfirst[,. ]+then\b|\b1\.\s|\b2\.\s|\b3\.\s)/i;

// Per-role system prompts. Executors also have goal-type-specific variants for better task focus.
const systemPrompts = {
  triage: 'You are a triage agent. Analyze the request and produce a structured summary of goals, constraints, and required capabilities. Be concise.',
  planner: 'You are a planning agent. Using the triage summary, produce a concrete execution outline with clear sub-goals, expected output fields, and distinct streams for each executor.',
  verifier: 'You are a verification agent. Validate all executor results for correctness, completeness, and consistency with the original request. Return { "verified": true } if all criteria pass, otherwise { "verified": false, "issues": [...] }.',
  executor: {
    default: 'You are an executor agent. Solve the task efficiently and return structured JSON output.',
    answer: 'You are a knowledgeable assistant. Provide accurate, well-reasoned, concise answers in structured JSON.',
    code: 'You are a code generation expert. Write clean, well-structured, production-ready code. Include examples and explain key design decisions.',
    analysis: 'You are an analytical expert. Provide thorough, evidence-based analysis with clear conclusions and supporting reasoning in structured JSON.',
    tooling: 'You are a tool-execution expert. Use available tools effectively and systematically to accomplish the task. Report tool results clearly.'
  }
};

export class PlannerService {
  createPlan(userRequest: string, budgetLevel: BudgetLevel, options?: PlanOptions): Plan {
    const complexity = this.complexity(userRequest, options);
    const forceMulti = options?.must_verify === true || options?.risk_level === 'high';
    const mode = (forceMulti || complexity >= 3) ? 'multi' : 'single';
    const plan = mode === 'multi'
      ? this.multiPlan(userRequest, budgetLevel, complexity, options)
      : this.singlePlan(userRequest, budgetLevel, complexity, options);
    return PlanSchema.parse(plan);
  }

  private complexity(input: string, options?: PlanOptions): number {
    let score = 0;
    // Length heuristic: longer requests carry more sub-goals
    if (input.length > 240) score += 1;
    if (input.length > 600) score += 1; // very long → very complex
    // Semantic keyword groups
    if (kMultiGoal.test(input)) score += 1;
    if (kCompute.test(input)) score += 1;
    if (kVerify.test(input)) score += 1;
    if (kExternal.test(input) || kCode.test(input)) score += 1;
    if (kComparison.test(input)) score += 1;  // comparison → parallel executors needed
    if (kSequential.test(input)) score += 1;  // explicit steps → multi-agent flow
    // PlanOptions signals
    if (options?.goal_type === 'analysis') score += 1;
    if (options?.goal_type === 'code') score += 1;
    if (options?.risk_level === 'high') score += 1;
    return score;
  }

  // Determine which tools to allow based on goal type and preference.
  private resolveTools(userRequest: string, options?: PlanOptions): string[] {
    if (options?.tool_preference === 'avoid') return [];
    const tools: string[] = ['js_eval'];

    const needsFile =
      kExternal.test(userRequest) ||
      options?.goal_type === 'tooling' ||
      options?.goal_type === 'code' ||
      options?.tool_preference === 'prefer';
    if (needsFile) {
      tools.push('file_store');
      tools.push('file_read'); // file_read complements file_store for multi-task pipelines
    }

    // http_fetch: allow when the task is tooling-oriented or the request implies web/API access.
    const needsHttp =
      options?.goal_type === 'tooling' ||
      options?.tool_preference === 'prefer' ||
      /\b(fetch|http[s]?|api|web|url|request|endpoint|download|upload|curl|rest)\b/i.test(userRequest);
    if (needsHttp) tools.push('http_fetch');

    // datetime: allow for tooling goals or when the request mentions time/date context.
    const needsTime =
      options?.goal_type === 'tooling' ||
      /\b(date|time|today|now|current|timestamp|when|schedule|calendar|deadline)\b/i.test(userRequest);
    if (needsTime) tools.push('datetime');

    return tools;
  }

  // Executor reasoning_level drives model tier selection in model-tier.ts:
  //   low → cheap (gpt-lite), medium → standard (gpt-standard), high → premium (gpt-premium, if budget allows)
  private resolveExecutorReasoning(complexity: number, options?: PlanOptions): 'low' | 'medium' | 'high' {
    if (options?.risk_level === 'high' || options?.goal_type === 'analysis') return 'high';
    if (options?.goal_type === 'code' || complexity >= 3) return 'medium';
    if (complexity >= 2) return 'medium';
    return 'low';
  }

  private executorSystemPrompt(options?: PlanOptions): string {
    const key = options?.goal_type ?? 'default';
    return (systemPrompts.executor as Record<string, string>)[key] ?? systemPrompts.executor.default;
  }

  // Scale output token budget by goal type and complexity so code/analysis tasks
  // have enough room to produce complete responses without being truncated.
  private resolveOutputTokens(baseTokens: number, options?: PlanOptions): number {
    if (options?.goal_type === 'code') return Math.max(baseTokens, 1200);
    if (options?.goal_type === 'analysis') return Math.max(baseTokens, 800);
    if (options?.goal_type === 'tooling') return Math.max(baseTokens, 600);
    return baseTokens;
  }

  private applyBudgetOverrides(budget: Plan['budget'], options?: PlanOptions): Plan['budget'] {
    let b = { ...budget };
    if (options?.max_cost_override !== undefined) b = { ...b, max_cost_estimate: options.max_cost_override };
    if (options?.latency_hint_ms !== undefined) b = { ...b, max_latency_ms: Math.min(b.max_latency_ms, options.latency_hint_ms) };
    return b;
  }

  private singlePlan(userRequest: string, budgetLevel: BudgetLevel, complexity: number, options?: PlanOptions): Plan {
    const tools = this.resolveTools(userRequest, options);
    const reasoning_level = this.resolveExecutorReasoning(complexity, options);
    const maxOutputTokens = this.resolveOutputTokens(500, options);
    // model field is overwritten by applyTierToPlan in orchestrator; set a sensible placeholder.
    const tasks: TaskSpec[] = [{
      name: 'single_executor',
      agent: 'executor',
      input: userRequest,
      depends_on: [],
      tools_allowed: tools,
      model: 'gpt-lite',
      reasoning_level,
      max_output_tokens: maxOutputTokens,
      timeout_ms: taskTimeoutByBudget[budgetLevel],
      system_prompt: this.executorSystemPrompt(options)
    }];

    const budget = this.applyBudgetOverrides(budgetByLevel[budgetLevel], options);
    const goalNote = options?.goal_type ? ` Goal: ${options.goal_type}.` : '';
    return {
      mode: 'single',
      rationale: `Low complexity (${complexity}) request selected single executor flow.${goalNote}`,
      budget,
      invariants: ['Never exceed budget hard limits', 'Must produce digest for output'],
      success_criteria: ['Output contract validates', 'No budget violation'],
      tasks,
      output_contract: { type: 'json', schema: { type: 'object' } }
    };
  }

  private multiPlan(userRequest: string, budgetLevel: BudgetLevel, complexity: number, options?: PlanOptions): Plan {
    const tools = this.resolveTools(userRequest, options);
    const timeout = taskTimeoutByBudget[budgetLevel];
    const executorReasoning = this.resolveExecutorReasoning(complexity, options);
    // executor_b handles edge-cases and risks, so it runs at higher reasoning when complexity demands it
    const executorBReasoning: 'low' | 'medium' | 'high' = complexity > 3 || options?.risk_level === 'high' ? 'high' : executorReasoning;
    const budget = this.applyBudgetOverrides(budgetByLevel[budgetLevel], options);
    const goalNote = options?.goal_type ? ` Goal: ${options.goal_type}.` : '';
    const execTokens = this.resolveOutputTokens(500, options);
    // Trim the request for inline embedding (keeps prompts readable without exploding token counts)
    const briefRequest = userRequest.length > 300 ? `${userRequest.slice(0, 300)}…` : userRequest;

    const tasks: TaskSpec[] = [
      {
        name: 'triage',
        agent: 'triage',
        input: userRequest,
        depends_on: [],
        tools_allowed: [],
        model: 'gpt-lite',
        reasoning_level: 'low',
        max_output_tokens: 300,
        timeout_ms: timeout,
        system_prompt: systemPrompts.triage
      },
      {
        name: 'planner',
        agent: 'planner',
        input: 'Using the triage summary above, produce a concrete execution outline: list each sub-goal, expected output fields, and assign them to executor_a (primary path) and executor_b (alternative/risk path).',
        depends_on: ['triage'],
        tools_allowed: [],
        model: 'gpt-standard',
        reasoning_level: 'medium',
        max_output_tokens: 400,
        timeout_ms: timeout,
        system_prompt: systemPrompts.planner
      },
      {
        name: 'executor_a',
        agent: 'executor',
        // Explicitly tell executor_a to read the planner context injected above it
        input: `[Stream A — primary solution] Follow the planner outline above. Implement the direct solution path for: ${briefRequest}. Return complete structured JSON output.`,
        depends_on: ['planner'],
        parallel_group: 'execute',
        tools_allowed: tools,
        model: 'gpt-lite',
        reasoning_level: executorReasoning,
        max_output_tokens: execTokens,
        timeout_ms: timeout,
        system_prompt: this.executorSystemPrompt(options)
      },
      {
        name: 'executor_b',
        agent: 'executor',
        // executor_b explores alternatives and catches risks not covered by executor_a
        input: `[Stream B — alternative & risk] Follow the planner outline above. Provide an alternative approach and identify edge-cases or risks for: ${briefRequest}. Return complete structured JSON output.`,
        depends_on: ['planner'],
        parallel_group: 'execute',
        tools_allowed: tools,
        model: 'gpt-lite',
        reasoning_level: executorBReasoning,
        max_output_tokens: execTokens,
        timeout_ms: timeout,
        system_prompt: this.executorSystemPrompt(options)
      },
      {
        name: 'verifier',
        agent: 'verifier',
        input: `Review executor_a and executor_b results above against the original request: "${briefRequest}". Return exactly { "verified": true } if both results are correct, complete, and consistent with the request — or { "verified": false, "issues": ["<specific problem>", ...] } if anything is missing or incorrect.`,
        depends_on: ['executor_a', 'executor_b'],
        tools_allowed: [],
        model: 'gpt-premium',
        reasoning_level: 'high',
        max_output_tokens: 350,
        timeout_ms: timeout,
        system_prompt: systemPrompts.verifier
      }
    ];

    return {
      mode: 'multi',
      rationale: `Complexity score ${complexity} triggered multi-agent route.${goalNote}`,
      budget,
      invariants: ['Planner must run after triage', 'Verifier must run after all executors', 'Budget constraints are hard limits'],
      success_criteria: ['Verifier passes', 'Output contract validates'],
      tasks,
      output_contract: { type: 'json', schema: { type: 'object', properties: { summary: { type: 'string' } } } }
    };
  }
}
