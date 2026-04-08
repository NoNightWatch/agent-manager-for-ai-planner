import type { BudgetLevel, Plan, TaskSpec } from '../types.js';
import { getBestModelForTier } from './openrouter-pricing.js';

export type ModelTier = 'cheap' | 'standard' | 'premium';
export type TierPriceTable = Record<ModelTier, number>;

const TierOrder: ModelTier[] = ['cheap', 'standard', 'premium'];

// Base tier per agent role. Unknown/custom agent roles default to 'standard'.
const baseAgentTier: Partial<Record<string, ModelTier>> = {
  triage: 'cheap',
  planner: 'standard',
  executor: 'cheap',
  verifier: 'premium'
};

const budgetCap: Record<BudgetLevel, ModelTier> = {
  cheap: 'standard',
  normal: 'premium',
  thorough: 'premium'
};

// Executor tasks scale with reasoning complexity: low→cheap, medium→standard, high→premium.
// Other agent roles have fixed tiers appropriate to their role and are not boosted.
const executorReasoningBoost: Record<'low' | 'medium' | 'high', number> = {
  low: 0,
  medium: 1,
  high: 2
};

// Hardcoded fallback names used when OpenRouter pricing is unavailable.
// These match the placeholder names that existing providers (openai, anthropic,
// gateway) are already configured to interpret.
const modelNameByTier: Record<ModelTier, string> = {
  cheap: 'gpt-lite',
  standard: 'gpt-standard',
  premium: 'gpt-premium'
};

export const defaultTierPricePerToken: TierPriceTable = {
  cheap: 0.000001,
  standard: 0.000003,
  premium: 0.000008
};

export const capTier = (desired: ModelTier, cap: ModelTier): ModelTier => (TierOrder.indexOf(desired) <= TierOrder.indexOf(cap) ? desired : cap);

export const initialTierForTask = (task: TaskSpec, budgetLevel: BudgetLevel, ownerCap: ModelTier): ModelTier => {
  const baseTier = baseAgentTier[task.agent] ?? 'standard';
  const baseIdx = TierOrder.indexOf(baseTier);
  // Only executor tasks scale with reasoning complexity; other roles have fixed tiers.
  const boost = task.agent === 'executor' ? (executorReasoningBoost[task.reasoning_level] ?? 0) : 0;
  const boostedIdx = Math.min(baseIdx + boost, TierOrder.length - 1);
  const desired = TierOrder[boostedIdx] as ModelTier;
  return capTier(desired, capTier(budgetCap[budgetLevel], ownerCap));
};

export const upgradeTier = (tier: ModelTier, cap: ModelTier): ModelTier | null => {
  const i = TierOrder.indexOf(tier);
  if (i === TierOrder.length - 1) return null;
  const next = TierOrder[i + 1];
  return TierOrder.indexOf(next) <= TierOrder.indexOf(cap) ? next : null;
};

export const downgradeTier = (tier: ModelTier): ModelTier | null => {
  const i = TierOrder.indexOf(tier);
  if (i === 0) return null;
  return TierOrder[i - 1];
};

/**
 * Returns the model name for the given tier.
 *
 * Delegates to the OpenRouter pricing cache (getBestModelForTier) so that live
 * pricing data drives model selection. Falls back to hardcoded placeholder names
 * (modelNameByTier) when no pricing data is available, preserving full backward
 * compatibility with existing providers.
 */
export const modelName = (tier: ModelTier): string => {
  try {
    return getBestModelForTier(tier);
  } catch {
    return modelNameByTier[tier];
  }
};

export const estimateCost = (tokens: number, tier: ModelTier, pricing: TierPriceTable): number => Number((tokens * pricing[tier]).toFixed(6));

export const inferTokens = (input: string, outputHint = 100): number => Math.max(32, Math.ceil(input.length / 4) + outputHint);

export const applyTierToPlan = (plan: Plan, budgetLevel: BudgetLevel, ownerCap: ModelTier): Plan => ({
  ...plan,
  tasks: plan.tasks.map((task) => {
    const tier = initialTierForTask(task, budgetLevel, ownerCap);
    return { ...task, model: modelName(tier) };
  })
});
