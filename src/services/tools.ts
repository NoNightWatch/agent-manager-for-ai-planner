import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { getConfig, getToolAuth } from '../config.js';
import { safeFetch } from '../lib/safe-fetch.js';
import { ToolSpecSchema, type ToolSpec } from '../types.js';

export type ToolContext = {
  runId: string;
  tokenOwner: string;
  signal?: AbortSignal;
  maxArtifactBytes?: number;
  getArtifactsBytes?: () => number;
  tryReserveArtifactsBytes?: (delta: number) => boolean;
  rollbackArtifactsBytes?: (delta: number) => void;
};
export type ToolCallResult = { ok: boolean; output: unknown; tokens_used: number };
export type ToolHandler = (input: any, ctx: ToolContext) => Promise<ToolCallResult>;

type ToolRegisterErrorCode = 'TOOL_NOT_ALLOWED' | 'TOOL_SPEC_INVALID';

export class ToolRegisterError extends Error {
  readonly retryable = false;
  readonly at = 'tools/register';

  constructor(readonly code: ToolRegisterErrorCode, message: string) {
    super(message);
  }
}

const allowedCharRegex = /^[0-9\s+\-*/().]+$/;

const tokenize = (expr: string): string[] => expr.match(/\d+(?:\.\d+)?|[()+\-*/]/g) ?? [];

const evaluateArithmetic = (expression: string): number => {
  const tokens = tokenize(expression);
  if (tokens.length === 0) throw new Error('empty expression');
  const output: string[] = [];
  const ops: string[] = [];
  const prec: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };

  for (const tk of tokens) {
    if (/^\d/.test(tk)) {
      output.push(tk);
      continue;
    }
    if (tk in prec) {
      while (ops.length && ops[ops.length - 1] in prec && prec[ops[ops.length - 1]] >= prec[tk]) {
        output.push(ops.pop() as string);
      }
      ops.push(tk);
      continue;
    }
    if (tk === '(') {
      ops.push(tk);
      continue;
    }
    if (tk === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') {
        output.push(ops.pop() as string);
      }
      if (ops.pop() !== '(') throw new Error('mismatched parentheses');
    }
  }

  while (ops.length) {
    const op = ops.pop() as string;
    if (op === '(' || op === ')') throw new Error('mismatched parentheses');
    output.push(op);
  }

  const stack: number[] = [];
  for (const tk of output) {
    if (/^\d/.test(tk)) {
      stack.push(Number(tk));
      continue;
    }
    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) throw new Error('bad expression');
    if (tk === '+') stack.push(a + b);
    if (tk === '-') stack.push(a - b);
    if (tk === '*') stack.push(a * b);
    if (tk === '/') stack.push(a / b);
  }

  if (stack.length !== 1 || Number.isNaN(stack[0])) throw new Error('invalid result');
  return stack[0];
};

const isPathAllowed = (rawPath: string, baseDir: string): { ok: true; relativePath: string; fullPath: string } | { ok: false } => {
  if (!rawPath || isAbsolute(rawPath) || rawPath.includes('..') || rawPath.includes('\\')) {
    return { ok: false };
  }

  const normalized = normalize(rawPath).replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('..') || normalized.includes('\\')) {
    return { ok: false };
  }

  const fullPath = join(baseDir, normalized);
  const rel = relative(baseDir, fullPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false };
  }

  return { ok: true, relativePath: normalized, fullPath };
};

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();
  private readonly handlers = new Map<string, ToolHandler>();
  private version = 1;

  constructor() {
    this.registerBuiltins();
  }

  getVersion(): number {
    return this.version;
  }

  register(specs: ToolSpec[]): { tools_version: number; tools: ToolSpec[] } {
    specs.forEach((spec) => {
      const validated = ToolSpecSchema.parse(spec);
      this.validateSpecSize(validated);
      if (!this.isExternalToolAllowed(validated.name)) {
        throw new ToolRegisterError('TOOL_NOT_ALLOWED', `Tool ${validated.name} is not allowed by server policy`);
      }
      if (validated.callback_url && !this.isCallbackUrlAllowed(validated.callback_url)) {
        throw new ToolRegisterError('TOOL_NOT_ALLOWED', 'Tool callback_url is not allowed by server policy');
      }

      this.tools.set(validated.name, validated);
      if (validated.callback_url) {
        const url = validated.callback_url;
        this.handlers.set(validated.name, async (input, ctx) => {
          const env = getConfig();
          const toolTimeout = AbortSignal.timeout(validated.timeout_ms ?? 10_000);
          const signal = ctx.signal ? AbortSignal.any([ctx.signal, toolTimeout]) : toolTimeout;

          try {
                        const authHeader = validated.auth_ref ? getToolAuth(validated.auth_ref) : undefined;
            const body = JSON.stringify({ input, run_id: ctx.runId, token_owner: ctx.tokenOwner });
            if (Buffer.byteLength(body, 'utf8') > env.MAX_TOOL_CALLBACK_REQUEST_BYTES) {
              return { ok: false, output: { error: 'OUTBOUND_PAYLOAD_REJECTED', retryable: false }, tokens_used: 1 };
            }
            const res = getConfig().TOOL_CALLBACK_ALLOW_LOCAL_TEST
              ? await (async () => {
                  const native = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...(authHeader ? { Authorization: `Bearer ${authHeader}` } : {}) },
                    body,
                    redirect: 'error',
                    signal
                  });
                  return { status: native.status, headers: native.headers, bodyText: await native.text() };
                })()
              : await safeFetch(url, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...(authHeader ? { Authorization: `Bearer ${authHeader}` } : {}) },
                  body,
                  timeoutMs: validated.timeout_ms,
                  maxBytes: env.TOOL_CALLBACK_MAX_BYTES,
                  signal
                });
            if (res.status < 200 || res.status >= 300) return { ok: false, output: { error: `HTTP_${res.status}`, retryable: res.status >= 500 || res.status === 429 }, tokens_used: 0 };
            const contentType = res.headers.get('content-type') ?? '';
            if (!contentType.toLowerCase().includes('application/json')) {
              return { ok: false, output: { error: 'TOOL_HTTP_BAD_CONTENT_TYPE' }, tokens_used: 0 };
            }
            const output = JSON.parse(res.bodyText) as { tokens_used?: number };
            return { ok: true, output, tokens_used: output.tokens_used ?? 30 };
          } catch (error) {
            if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
              return { ok: false, output: { error: 'TOOL_TIMEOUT', retryable: true }, tokens_used: 1 };
            }
            return { ok: false, output: { error: error instanceof Error ? error.message : 'TOOL_HTTP_FAILED' }, tokens_used: 1 };
          }
        });
      } else if (!this.handlers.has(validated.name)) {
        this.handlers.set(validated.name, async (input) => ({ ok: true, output: input, tokens_used: 30 }));
      }
    });
    this.version += 1;
    return { tools_version: this.version, tools: this.list() };
  }

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  getSpec(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  isToolAllowed(name: string): boolean {
    return this.tools.has(name);
  }

  setHandler(name: string, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }

  async call(name: string, input: any, ctx: ToolContext): Promise<ToolCallResult> {
    const handler = this.handlers.get(name);
    const spec = this.tools.get(name);
    if (!handler || !spec) {
      throw new Error(`unknown tool: ${name}`);
    }

    const timeoutController = new AbortController();
    const compositeSignal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutController.signal]) : timeoutController.signal;

    try {
      const timeout = (async () => {
        await delay(spec.timeout_ms, undefined, { signal: timeoutController.signal });
        return { ok: false, output: { error: 'TOOL_TIMEOUT' }, tokens_used: 1 } as ToolCallResult;
      })();

      const call = handler(input, { ...ctx, signal: compositeSignal });
      return await Promise.race([call, timeout]);
    } finally {
      timeoutController.abort();
    }
  }

  private validateSpecSize(spec: ToolSpec): void {
    if (spec.name.length > 64) {
      throw new ToolRegisterError('TOOL_SPEC_INVALID', `Tool name too long: ${spec.name.length} > 64`);
    }
    if (spec.description.length > 512) {
      throw new ToolRegisterError('TOOL_SPEC_INVALID', `Tool description too long: ${spec.description.length} > 512`);
    }
    const schemaLength = JSON.stringify(spec.input_schema).length;
    if (schemaLength > 20_000) {
      throw new ToolRegisterError('TOOL_SPEC_INVALID', `Tool input_schema too large: ${schemaLength} > 20000`);
    }
    if (spec.timeout_ms < 1 || spec.timeout_ms > 120_000) {
      throw new ToolRegisterError('TOOL_SPEC_INVALID', 'Tool timeout_ms out of allowed range');
    }
  }

  private isExternalToolAllowed(name: string): boolean {
    const allowlist = getConfig().TOOL_ALLOWLIST
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    return allowlist.includes(name);
  }

  private isCallbackUrlAllowed(raw: string): boolean {
    try {
      const env = getConfig();
      const url = new URL(raw);
      if (url.username || url.password) return false;
      if (url.protocol !== 'https:' && !(env.ALLOW_INSECURE_HTTP_TOOLS && url.protocol === 'http:')) return false;
      if (getConfig().TOOL_CALLBACK_ALLOW_LOCAL_TEST) return true;
      return env.TOOL_CALLBACK_ALLOWLIST.trim().length > 0;
    } catch {
      return false;
    }
  }

  private registerBuiltins(): void {
    this.tools.set('file_store', {
      name: 'file_store',
      description: 'Store content under ./runs/artifacts for a run id',
      input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      timeout_ms: 1000,
      tags: ['builtin', 'io', 'safe']
    });

    this.tools.set('js_eval', {
      name: 'js_eval',
      description: 'Evaluate arithmetic-only expression and return numeric result',
      input_schema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
      timeout_ms: 500,
      tags: ['builtin', 'compute', 'safe']
    });

    this.handlers.set('file_store', async (input, ctx) => {
      const rawPath = String(input.path || 'out.txt');
      const content = String(input.content || '');
      const bytes = Buffer.byteLength(content);
      const baseDir = join(process.cwd(), 'runs', 'artifacts', ctx.runId);
      mkdirSync(baseDir, { recursive: true });

      const allowed = isPathAllowed(rawPath, baseDir);
      if (!allowed.ok) {
        return { ok: false, output: { error: 'PATH_NOT_ALLOWED', attempted_bytes: 0 }, tokens_used: 20 };
      }

      const reserved = ctx.tryReserveArtifactsBytes ? ctx.tryReserveArtifactsBytes(bytes) : true;
      if (!reserved) {
        return { ok: false, output: { error: 'ARTIFACT_LIMIT', attempted_bytes: 0 }, tokens_used: 20 };
      }

      try {
        mkdirSync(dirname(allowed.fullPath), { recursive: true });
        writeFileSync(allowed.fullPath, content, 'utf8');
      } catch (error) {
        ctx.rollbackArtifactsBytes?.(bytes);
        throw error;
      }

      return { ok: true, output: { path: allowed.relativePath, bytes }, tokens_used: 80 };
    });

    this.handlers.set('js_eval', async (input) => {
      const expression = String(input.expression || '0').trim();
      if (expression.length > 200 || !allowedCharRegex.test(expression)) {
        return { ok: false, output: { error: 'EXPRESSION_NOT_ALLOWED' }, tokens_used: 20 };
      }

      try {
        const result = evaluateArithmetic(expression);
        return { ok: true, output: result, tokens_used: 40 };
      } catch {
        return { ok: false, output: { error: 'EXPRESSION_NOT_ALLOWED' }, tokens_used: 20 };
      }
    });

    // ─── http_fetch ───────────────────────────────────────────────────────────
    this.tools.set('http_fetch', {
      name: 'http_fetch',
      description: 'Make an HTTP GET or POST request to an allowed URL and return the response status and body. The target host must appear in OUTBOUND_ALLOWLIST.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Target URL (https only unless ALLOW_INSECURE_HTTP is set)' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method (default: GET)' },
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional request headers. Authorization, Cookie, and x-api-key are blocked.' },
          body: { type: 'string', description: 'Request body for POST/PUT (max 32 KB)' },
          max_response_bytes: { type: 'number', description: 'Max response body bytes (default 32768, max 65536)' }
        },
        required: ['url']
      },
      timeout_ms: 15_000,
      tags: ['builtin', 'network', 'external']
    });

    this.handlers.set('http_fetch', async (input, ctx) => {
      const url = String(input.url ?? '');
      const method = String(input.method ?? 'GET').toUpperCase();
      const allowedMethods = new Set(['GET', 'POST', 'PUT', 'DELETE']);

      if (!allowedMethods.has(method)) {
        return { ok: false, output: { error: 'METHOD_NOT_ALLOWED', allowed: [...allowedMethods] }, tokens_used: 10 };
      }

      try { new URL(url); } catch {
        return { ok: false, output: { error: 'INVALID_URL' }, tokens_used: 10 };
      }

      // Block credentials/sensitive headers to prevent SSRF token theft
      const blocked = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-run-token']);
      const safeHeaders: Record<string, string> = {};
      const rawHeaders = input.headers as Record<string, unknown> | undefined;
      if (rawHeaders && typeof rawHeaders === 'object') {
        for (const [k, v] of Object.entries(rawHeaders)) {
          if (!blocked.has(k.toLowerCase())) safeHeaders[k] = String(v).slice(0, 512);
        }
      }

      const body = input.body ? String(input.body).slice(0, 32_768) : undefined;
      const maxBytes = Math.min(Number(input.max_response_bytes ?? 32_768), 65_536);

      try {
        const res = await safeFetch(url, { method, headers: safeHeaders, body, timeoutMs: 12_000, maxBytes, signal: ctx.signal });
        const ok = res.status >= 200 && res.status < 300;
        return {
          ok,
          output: { status: res.status, content_type: res.headers.get('content-type') ?? 'unknown', body: res.bodyText },
          tokens_used: Math.max(10, Math.ceil(res.bodyText.length / 4))
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('OUTBOUND') || msg.includes('SSRF')) {
          return { ok: false, output: { error: 'URL_NOT_ALLOWED', detail: msg }, tokens_used: 10 };
        }
        return { ok: false, output: { error: 'FETCH_FAILED', detail: msg }, tokens_used: 10 };
      }
    });

    // ─── datetime ─────────────────────────────────────────────────────────────
    this.tools.set('datetime', {
      name: 'datetime',
      description: 'Return the current UTC date and time. Accepts an optional format: "iso" (default), "unix" (epoch seconds), or "parts" (year/month/day/hour/minute/second object).',
      input_schema: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['iso', 'unix', 'parts'], description: 'Output format (default: iso)' }
        }
      },
      timeout_ms: 100,
      tags: ['builtin', 'time', 'safe']
    });

    this.handlers.set('datetime', async (input) => {
      const now = new Date();
      const fmt = String(input.format ?? 'iso');
      if (fmt === 'unix') {
        return { ok: true, output: { unix: Math.floor(now.getTime() / 1000) }, tokens_used: 10 };
      }
      if (fmt === 'parts') {
        return {
          ok: true,
          output: {
            year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate(),
            hour: now.getUTCHours(), minute: now.getUTCMinutes(), second: now.getUTCSeconds(),
            weekday: now.toUTCString().slice(0, 3), timezone: 'UTC'
          },
          tokens_used: 10
        };
      }
      // default: iso
      return {
        ok: true,
        output: { iso: now.toISOString(), unix: Math.floor(now.getTime() / 1000), display: now.toUTCString() },
        tokens_used: 10
      };
    });

    // ─── file_read ────────────────────────────────────────────────────────────
    this.tools.set('file_read', {
      name: 'file_read',
      description: 'Read the content of a file previously stored by file_store under ./runs/artifacts for the current run. Returns the file content as a UTF-8 string.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path within the run artifact directory (same path used with file_store)' }
        },
        required: ['path']
      },
      timeout_ms: 1000,
      tags: ['builtin', 'io', 'safe']
    });

    this.handlers.set('file_read', async (input, ctx) => {
      const rawPath = String(input.path || '');
      const baseDir = join(process.cwd(), 'runs', 'artifacts', ctx.runId);
      const allowed = isPathAllowed(rawPath, baseDir);
      if (!allowed.ok) {
        return { ok: false, output: { error: 'PATH_NOT_ALLOWED' }, tokens_used: 20 };
      }
      if (!existsSync(allowed.fullPath)) {
        return { ok: false, output: { error: 'FILE_NOT_FOUND', path: allowed.relativePath }, tokens_used: 20 };
      }
      try {
        const content = readFileSync(allowed.fullPath, 'utf8');
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > 65_536) {
          return { ok: false, output: { error: 'FILE_TOO_LARGE', bytes, max_bytes: 65_536 }, tokens_used: 20 };
        }
        return {
          ok: true,
          output: { path: allowed.relativePath, content, bytes },
          tokens_used: Math.max(20, Math.ceil(bytes / 4))
        };
      } catch {
        return { ok: false, output: { error: 'READ_FAILED' }, tokens_used: 20 };
      }
    });
  }
}
