import { getConfig } from '../config.js';
import { safeFetch } from '../lib/safe-fetch.js';
import type { ModelTier } from '../services/model-tier.js';
import type { LLMProvider, LLMRoundResult, LLMTaskContext } from './llm-provider.js';

// Tier → Anthropic model ID mapping.
// Override individual models via env vars:
//   ANTHROPIC_MODEL_CHEAP    (default: claude-haiku-4-5-20251001)
//   ANTHROPIC_MODEL_STANDARD (default: claude-sonnet-4-6)
//   ANTHROPIC_MODEL_PREMIUM  (default: claude-opus-4-6)
const tierToModel = (): Record<ModelTier, string> => ({
  cheap: process.env.ANTHROPIC_MODEL_CHEAP ?? 'claude-haiku-4-5-20251001',
  standard: process.env.ANTHROPIC_MODEL_STANDARD ?? 'claude-sonnet-4-6',
  premium: process.env.ANTHROPIC_MODEL_PREMIUM ?? 'claude-opus-4-6'
});

// Anthropic API types (minimal subset needed)
type AnthropicTextBlock = { type: 'text'; text: string };
type AnthropicToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type AnthropicToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string };
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

type AnthropicMessage =
  | { role: 'user'; content: string | Array<AnthropicToolResultBlock | AnthropicTextBlock> }
  | { role: 'assistant'; content: string | AnthropicContentBlock[] };

type AnthropicResponse = {
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | null;
  usage: { input_tokens: number; output_tokens: number };
};

// Maps run:task:attempt → last assistant tool_use blocks.
// Required because the engine appends tool-result messages but does NOT re-inject
// the preceding assistant tool_use blocks; we must reconstruct them for Anthropic.
const pendingToolUse = new Map<string, AnthropicToolUseBlock[]>();

const convKey = (ctx: LLMTaskContext): string =>
  `${ctx.runId}:${ctx.taskName}:${ctx.attempt}`;

// Build a proper Anthropic-format message array from the engine's flat message list.
const buildAnthropicMessages = (ctx: LLMTaskContext): AnthropicMessage[] => {
  const { messages } = ctx;
  const toolMessages = messages.filter((m) => m.role === 'tool');
  // Fold all conversational messages (user + assistant dependency context) into one user turn
  const userParts = messages
    .filter((m) => m.role !== 'system' && m.role !== 'tool')
    .map((m) => (m.role === 'assistant' ? `\n[Context from prior steps]\n${m.content}` : m.content));
  const userContent = userParts.join('\n').trim();

  if (toolMessages.length === 0) {
    // First round: simple user message
    return userContent ? [{ role: 'user', content: userContent }] : [];
  }

  // Subsequent round: reconstruct the full tool-call exchange that Anthropic expects.
  const prevToolUse = pendingToolUse.get(convKey(ctx)) ?? [];
  const result: AnthropicMessage[] = [];

  if (userContent) {
    result.push({ role: 'user', content: userContent });
  }
  // Re-inject the assistant message containing the tool_use blocks
  if (prevToolUse.length > 0) {
    result.push({ role: 'assistant', content: prevToolUse });
  }
  // User message with tool results
  result.push({
    role: 'user',
    content: toolMessages.map((m) => ({
      type: 'tool_result' as const,
      tool_use_id: m.tool_call_id ?? '',
      content: m.content
    }))
  });

  return result;
};

export class AnthropicLLMProvider implements LLMProvider {
  readonly id = 'anthropic';
  readonly supports_tools = true;
  readonly enabled = Boolean(getConfig().ANTHROPIC_API_KEY);
  readonly notes = this.enabled
    ? 'Anthropic Messages API (native). Requires api.anthropic.com in OUTBOUND_ALLOWLIST.'
    : 'Set ANTHROPIC_API_KEY and add api.anthropic.com to OUTBOUND_ALLOWLIST to enable.';

  async executeRound(ctx: LLMTaskContext): Promise<LLMRoundResult> {
    const cfg = getConfig();
    const apiKey = cfg.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw { code: 'PROVIDER_NOT_CONFIGURED', message: 'ANTHROPIC_API_KEY is not set', retryable: false, at: 'anthropic' };
    }

    const model = tierToModel()[ctx.tier];
    const systemContent = ctx.messages.find((m) => m.role === 'system')?.content;
    const anthropicMessages = buildAnthropicMessages(ctx);

    if (anthropicMessages.length === 0) {
      throw { code: 'PROVIDER_BAD_REQUEST', message: 'No user content in message list', retryable: false, at: 'anthropic' };
    }

    const requestBody: Record<string, unknown> = {
      model,
      max_tokens: ctx.task.max_output_tokens,
      messages: anthropicMessages,
      ...(systemContent ? { system: systemContent } : {}),
      ...(ctx.tools.length > 0
        ? {
            tools: ctx.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.input_schema
            }))
          }
        : {})
    };

    const bodyStr = JSON.stringify(requestBody);
    if (Buffer.byteLength(bodyStr, 'utf8') > cfg.MAX_PROVIDER_REQUEST_BYTES) {
      throw { code: 'OUTBOUND_PAYLOAD_REJECTED', message: 'Request body exceeds MAX_PROVIDER_REQUEST_BYTES', retryable: false, at: 'anthropic' };
    }

    const started = Date.now();
    let fetchResult: { status: number; headers: Headers; bodyText: string };
    try {
      fetchResult = await safeFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: bodyStr,
        timeoutMs: cfg.GATEWAY_TIMEOUT_MS,
        maxBytes: 512 * 1024,
        signal: ctx.signal
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw {
        code: msg.includes('OUTBOUND') ? 'OUTBOUND_HOST_NOT_ALLOWED' : 'PROVIDER_NETWORK_ERROR',
        message: msg,
        retryable: !msg.includes('OUTBOUND'),
        at: 'anthropic'
      };
    }

    const { status, bodyText } = fetchResult;
    if (status === 429) throw { code: 'RATE_LIMIT', message: 'Anthropic rate limit exceeded', retryable: true, at: 'anthropic' };
    if (status === 401 || status === 403) throw { code: 'AUTH_INVALID_TOKEN', message: 'Anthropic API key rejected', retryable: false, at: 'anthropic' };
    if (status >= 500) throw { code: 'PROVIDER_SERVER_ERROR', message: `Anthropic HTTP ${status}`, retryable: true, at: 'anthropic' };
    if (status >= 400) throw { code: 'PROVIDER_BAD_REQUEST', message: `Anthropic HTTP ${status}: ${bodyText.slice(0, 200)}`, retryable: false, at: 'anthropic' };

    let response: AnthropicResponse;
    try {
      response = JSON.parse(bodyText) as AnthropicResponse;
    } catch {
      throw { code: 'PROVIDER_PARSE_ERROR', message: 'Anthropic response is not valid JSON', retryable: true, at: 'anthropic' };
    }

    const providerLatencyMs = Date.now() - started;
    const usage = { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens };
    const key = convKey(ctx);

    // Tool-use response: store blocks for the next round reconstruction
    const toolUseBlocks = response.content.filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use');
    if (toolUseBlocks.length > 0) {
      pendingToolUse.set(key, toolUseBlocks);
      return {
        tool_calls: toolUseBlocks.map((b) => ({ call_id: b.id, name: b.name, arguments: b.input })),
        usage,
        model: response.model,
        provider_latency_ms: providerLatencyMs
      };
    }

    // Final response: clean up stored state
    pendingToolUse.delete(key);
    const textBlock = response.content.find((b): b is AnthropicTextBlock => b.type === 'text');
    const outputText = textBlock?.text ?? '';

    // Parse JSON from bare response or from ```json ... ``` code fences
    let outputJson: Record<string, unknown> | undefined;
    try {
      const trimmed = outputText.trim();
      const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
      outputJson = JSON.parse(stripped.trim()) as Record<string, unknown>;
    } catch {
      outputJson = undefined;
    }

    return {
      output_text: outputText,
      output_json: outputJson,
      usage,
      model: response.model,
      provider_latency_ms: providerLatencyMs
    };
  }
}
