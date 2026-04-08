import type { LLMProvider, LLMRoundResult, LLMTaskContext } from './llm-provider.js';
import { getConfig } from '../config.js';
import { safeFetch } from '../lib/safe-fetch.js';
import type { ModelTier } from '../services/model-tier.js';

// Tier → OpenAI model ID mapping.
// Override individual models via env vars:
//   OPENAI_MODEL_CHEAP    (default: gpt-4o-mini)
//   OPENAI_MODEL_STANDARD (default: gpt-4o)
//   OPENAI_MODEL_PREMIUM  (default: o1-preview)
const tierToModel = (): Record<ModelTier, string> => ({
  cheap: process.env.OPENAI_MODEL_CHEAP ?? 'gpt-4o-mini',
  standard: process.env.OPENAI_MODEL_STANDARD ?? 'gpt-4o',
  premium: process.env.OPENAI_MODEL_PREMIUM ?? 'o1-preview'
});

// Map internal tier placeholder names back to a tier so we can resolve the real OpenAI model.
const tierFromTaskModel = (model: string): ModelTier => {
  if (model === 'gpt-premium') return 'premium';
  if (model === 'gpt-standard') return 'standard';
  return 'cheap';
};

const parseJson = (value: string | undefined): Record<string, unknown> => {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

export class OpenAILLMProvider implements LLMProvider {
  readonly id = 'openai';
  readonly supports_tools = true;
  readonly enabled = Boolean(getConfig().OPENAI_API_KEY);
  readonly notes = this.enabled
    ? 'OpenAI Chat Completions API (native). Requires api.openai.com in OUTBOUND_ALLOWLIST.'
    : 'Set OPENAI_API_KEY and add api.openai.com to OUTBOUND_ALLOWLIST to enable.';

  async executeRound(args: LLMTaskContext): Promise<LLMRoundResult> {
    const cfg = getConfig();
    if (!cfg.OPENAI_API_KEY) {
      throw { code: 'PROVIDER_NOT_CONFIGURED', message: 'OPENAI_API_KEY is not set', retryable: false, at: 'openai' };
    }

    const tier = tierFromTaskModel(args.task.model);
    const model = tierToModel()[tier];
    const started = Date.now();

    const bodyStr = JSON.stringify({
      model,
      messages: args.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.role === 'tool' ? { tool_call_id: message.tool_call_id } : {}),
        ...(message.name ? { name: message.name } : {})
      })),
      ...(args.tools.length > 0
        ? {
            tools: args.tools.map((tool) => ({
              type: 'function',
              function: { name: tool.name, description: tool.description, parameters: tool.input_schema }
            }))
          }
        : {}),
      max_tokens: args.task.max_output_tokens,
      temperature: 0
    });

    if (Buffer.byteLength(bodyStr, 'utf8') > cfg.MAX_PROVIDER_REQUEST_BYTES) {
      throw { code: 'OUTBOUND_PAYLOAD_REJECTED', message: 'Request body exceeds MAX_PROVIDER_REQUEST_BYTES', retryable: false, at: 'openai' };
    }

    let fetchResult: { status: number; headers: Headers; bodyText: string };
    try {
      fetchResult = await safeFetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.OPENAI_API_KEY}`
        },
        body: bodyStr,
        timeoutMs: cfg.GATEWAY_TIMEOUT_MS,
        maxBytes: 512 * 1024,
        signal: args.signal
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw {
        code: msg.includes('OUTBOUND') ? 'OUTBOUND_HOST_NOT_ALLOWED' : 'PROVIDER_NETWORK_ERROR',
        message: msg,
        retryable: !msg.includes('OUTBOUND'),
        at: 'openai'
      };
    }

    const { status, bodyText } = fetchResult;
    if (status === 429) throw { code: 'RATE_LIMIT', message: 'OpenAI rate limit exceeded', retryable: true, at: 'openai' };
    if (status === 401 || status === 403) throw { code: 'AUTH_INVALID_TOKEN', message: 'OpenAI API key rejected', retryable: false, at: 'openai' };
    if (status >= 500) throw { code: 'PROVIDER_SERVER_ERROR', message: `OpenAI HTTP ${status}`, retryable: true, at: 'openai' };
    if (status >= 400) throw { code: 'PROVIDER_BAD_REQUEST', message: `OpenAI HTTP ${status}: ${bodyText.slice(0, 200)}`, retryable: false, at: 'openai' };

    let payload: {
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
    };
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw { code: 'PROVIDER_PARSE_ERROR', message: 'OpenAI response is not valid JSON', retryable: true, at: 'openai' };
    }

    const message = payload.choices?.[0]?.message;
    const toolCalls = (message?.tool_calls ?? [])
      .map((call) => ({
        call_id: call.id ?? `${args.task.name}-tool-call`,
        name: call.function?.name ?? '',
        arguments: parseJson(call.function?.arguments)
      }))
      .filter((call) => call.name.length > 0);

    return {
      output_text: message?.content ?? undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        input_tokens: payload.usage?.prompt_tokens,
        output_tokens: payload.usage?.completion_tokens
      },
      provider_latency_ms: Date.now() - started,
      model: payload.model ?? model
    };
  }
}
