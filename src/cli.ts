#!/usr/bin/env node
/**
 * Command-line interface for the AI agent orchestrator.
 *
 * Usage:
 *   npx tsx src/cli.ts "<your task>"
 *   npx tsx src/cli.ts "Write a bubble sort in Python"
 *   npx tsx src/cli.ts "Analyse the pros and cons of microservices" --budget thorough
 *
 * Flags (all optional):
 *   --budget   cheap | normal | thorough   (default: normal)
 *   --provider mock | openai | anthropic   (default: env DEFAULT_PROVIDER_ID or mock)
 *   --timeout  milliseconds                (default: 30000)
 *
 * Exit code: 0 on success, 1 on failure.
 */

import { run } from './services/runner.js';
import type { BudgetLevel } from './types.js';

// ── Argument parsing ───────────────────────────────────────────────────────

const args = process.argv.slice(2);

const flagIndex = (flag: string): number => args.findIndex((a) => a === flag);
const flagValue = (flag: string): string | undefined => {
  const idx = flagIndex(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
};

// First positional argument that is not a flag or flag value is the user request.
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { i++; continue; } // skip flag + value
  positional.push(args[i]);
}

const userRequest = positional[0];

if (!userRequest) {
  console.error('Error: missing task description.');
  console.error('');
  console.error('Usage:  npx tsx src/cli.ts "<your task>"');
  console.error('        npx tsx src/cli.ts "Write a bubble sort" --budget normal');
  process.exit(1);
}

const budgetRaw = flagValue('--budget') ?? 'normal';
const validBudgets: BudgetLevel[] = ['cheap', 'normal', 'thorough'];
if (!validBudgets.includes(budgetRaw as BudgetLevel)) {
  console.error(`Error: --budget must be one of: ${validBudgets.join(', ')}`);
  process.exit(1);
}
const budget = budgetRaw as BudgetLevel;

const providerFlag = flagValue('--provider');
const timeoutFlag = flagValue('--timeout');
const timeoutMs = timeoutFlag ? parseInt(timeoutFlag, 10) : 30_000;

// ── Formatting helpers ─────────────────────────────────────────────────────

const DIVIDER = '─'.repeat(45);

const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length);

const formatCost = (usd: number): string => `$${usd.toFixed(4)}`;

const formatDuration = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

// ── Run ────────────────────────────────────────────────────────────────────

let result: Awaited<ReturnType<typeof run>>;

try {
  result = await run(userRequest, {
    budgetLevel: budget,
    providerId: providerFlag,
    timeoutMs
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`✗ Fatal error: ${msg}`);
  process.exit(1);
}

// ── Output ─────────────────────────────────────────────────────────────────

const check = result.success ? '✓' : '✗';
const taskNames = result.tasks.map((t) => t.name).join(' + ');
console.log(`${check} Plan: ${result.tasks.length} task${result.tasks.length !== 1 ? 's' : ''} (${taskNames})`);

for (const task of result.tasks) {
  const icon = result.success ? '✓' : '✗';
  const name   = pad(task.name, 12);
  const model  = pad(task.model, 32);
  const tier   = pad(`[${task.tier}]`, 12);
  const cost   = formatCost(task.cost_est);
  console.log(`  ${icon} ${name} → ${model} ${tier} ${cost}`);
}

console.log(DIVIDER);

if (result.success) {
  console.log(`Result:\n${result.output}`);
} else {
  console.log(`Error: ${result.output}`);
}

console.log('');
console.log(`Total: ${formatCost(result.total_cost_est)} | ${formatDuration(result.duration_ms)}`);

process.exit(result.success ? 0 : 1);
