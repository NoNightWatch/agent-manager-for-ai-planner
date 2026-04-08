import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '../types.js';
import { digestOf } from '../lib/utils.js';
import { getConfig } from '../config.js';

// Persisted lookup index so owner/idempotency data survives restarts.
type PersistIndex = {
  ownerByRunId: Record<string, string>;
  runsByOwner: Record<string, string[]>;
  idempotency: Record<string, string>; // `${owner}:${key}` → runId
};

const RUN_TTL_MS = getConfig().RUN_TTL_MS;
const RUN_TTL_TERMINAL_MS = getConfig().RUN_TTL_TERMINAL_MS;
const maxRunsInMemory = (): number => getConfig().MAX_RUNS_IN_MEMORY;

type WaitOptions = { timeoutMs: number; signal?: AbortSignal };
type RunListItem = { id: string; created_at: number; status: Run['status']; plan_digest: string; summary: string; owner: string };

type RunListOptions = {
  owner?: string;
  status?: Run['status'];
  limit: number;
  cursor?: string;
};

export class RunStore {
  private readonly runs = new Map<string, Run>();
  private readonly byIdempotency = new Map<string, string>();
  private readonly idempotencyByRunId = new Map<string, string>();
  private readonly ownerByRunId = new Map<string, string>();
  private readonly runsByOwner = new Map<string, string[]>();
  private readonly emitter = new EventEmitter();
  private readonly cleanupTimer: NodeJS.Timeout;
  private cleanupCount = 0;

  constructor(private readonly persist = false) {
    if (persist) {
      mkdirSync(join(process.cwd(), 'runs'), { recursive: true });
      this.loadIndex();
    }
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref();
    // Flush index periodically so it stays in sync without a write on every event
    if (persist) {
      this.indexFlushTimer = setInterval(() => this.flushIndex(), 30_000);
      this.indexFlushTimer.unref();
    }
  }

  private readonly indexFlushTimer?: NodeJS.Timeout;

  set(run: Run, owner?: string): void {
    const existing = this.runs.get(run.id);
    const mergedLogs = existing ? this.mergeLogs(existing.logs, run.logs) : run.logs;
    const merged: Run = { ...run, logs: mergedLogs, logs_base: existing?.logs_base ?? run.logs_base };
    this.runs.set(run.id, merged);
    const runOwner = owner ?? this.ownerByRunId.get(run.id);
    if (runOwner) {
      this.ownerByRunId.set(run.id, runOwner);
      const list = this.runsByOwner.get(runOwner) ?? [];
      if (!list.includes(run.id)) {
        list.push(run.id);
        this.runsByOwner.set(runOwner, list);
      }
    }

    this.persistRun(merged);
    this.enforceCapacity();
    // Flush index on first-time ownership registration so it survives an immediate crash
    if (!existing && runOwner) this.flushIndex();
    if (merged.status === 'succeeded' || merged.status === 'failed') {
      this.flushIndex();
      this.emitter.emit(`done:${merged.id}`, merged);
      this.emitter.removeAllListeners(`done:${merged.id}`);
    }
  }

  patchRun(id: string, patch: Partial<Run>): Run | undefined {
    const current = this.runs.get(id);
    if (!current) return undefined;
    const next: Run = { ...current, ...patch, logs: current.logs, logs_base: current.logs_base };
    this.runs.set(id, next);
    this.persistRun(next);
    return next;
  }

  appendEvent(id: string, event: Run['logs'][number]): Run | undefined {
    const current = this.runs.get(id);
    if (!current) return undefined;
    const nextLogs = [...current.logs, event];
    const next: Run = { ...current, logs: nextLogs };
    this.runs.set(id, next);
    this.persistRun(next);
    return next;
  }

  get(id: string): Run | undefined {
    const inMem = this.runs.get(id);
    if (inMem) return inMem;
    if (!this.persist) return undefined;
    const path = join(process.cwd(), 'runs', `${id}.json`);
    if (!existsSync(path)) return undefined;
    const run = JSON.parse(readFileSync(path, 'utf8')) as Run;
    this.runs.set(id, run);
    return run;
  }

  async waitForCompletion(runId: string, opts: WaitOptions): Promise<Run> {
    const existing = this.get(runId);
    if (existing && (existing.status === 'succeeded' || existing.status === 'failed')) {
      return existing;
    }

    return new Promise<Run>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject({ code: 'RUN_SYNC_TIMEOUT', message: 'Synchronous run timeout exceeded', retryable: true, suggested_action: 'retry', at: 'run/sync' });
      }, opts.timeoutMs);

      const onDone = (run: Run) => {
        cleanup();
        resolve(run);
      };

      const onAbort = () => {
        cleanup();
        reject({ code: 'RUN_SYNC_ABORTED', message: 'Synchronous run wait aborted', retryable: true, suggested_action: 'retry', at: 'run/sync' });
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.emitter.off(`done:${runId}`, onDone);
        opts.signal?.removeEventListener('abort', onAbort);
      };

      this.emitter.on(`done:${runId}`, onDone);
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  putIdempotency(owner: string, key: string, runId: string): void {
    const composite = `${owner}:${key}`;
    this.byIdempotency.set(composite, runId);
    this.idempotencyByRunId.set(runId, composite);
  }

  getByIdempotency(owner: string, key: string): string | undefined {
    return this.byIdempotency.get(`${owner}:${key}`);
  }

  listRuns(options: RunListOptions): { runs: RunListItem[]; next_cursor?: string } {
    const owner = options.owner ?? 'anonymous';
    const ids = [...(this.runsByOwner.get(owner) ?? [])]
      .map((id) => this.get(id))  // use get() to lazy-load from disk after restart
      .filter((run): run is Run => Boolean(run))
      .sort((a, b) => (b.created_at - a.created_at) || b.id.localeCompare(a.id));

    const cursor = options.cursor ? this.decodeCursor(options.cursor) : undefined;
    const filtered = ids.filter((run) => {
      if (options.status && run.status !== options.status) return false;
      if (!cursor) return true;
      return run.created_at < cursor.createdAt || (run.created_at === cursor.createdAt && run.id < cursor.id);
    });

    const page = filtered.slice(0, options.limit);
    const runs = page.map((run) => ({
      id: run.id,
      created_at: run.created_at,
      status: run.status,
      plan_digest: digestOf(run.plan),
      summary: run.plan.rationale,
      owner
    }));

    const last = page[page.length - 1];
    return {
      runs,
      next_cursor: filtered.length > options.limit && last ? this.encodeCursor(last.created_at, last.id) : undefined
    };
  }

  getCleanupCount(): number {
    return this.cleanupCount;
  }

  private cleanup(): void {
    this.cleanupCount += 1;
    const now = Date.now();
    for (const [id, run] of this.runs) {
      const age = now - run.created_at;
      const isTerminal = run.status === 'succeeded' || run.status === 'failed';
      const ttl = isTerminal ? RUN_TTL_TERMINAL_MS : RUN_TTL_MS;
      if (age > ttl) {
        this.runs.delete(id);
        const owner = this.ownerByRunId.get(id);
        if (owner) {
          const list = (this.runsByOwner.get(owner) ?? []).filter((rid) => rid !== id);
          if (list.length > 0) this.runsByOwner.set(owner, list);
          else this.runsByOwner.delete(owner);
          this.ownerByRunId.delete(id);
        }

        const ikey = this.idempotencyByRunId.get(id);
        if (ikey) {
          this.byIdempotency.delete(ikey);
          this.idempotencyByRunId.delete(id);
        }
      }
    }
  }

  private enforceCapacity(): void {
    const limit = maxRunsInMemory();
    if (this.runs.size <= limit) return;
    const ordered = [...this.runs.values()].sort((a, b) => a.created_at - b.created_at);
    const evictCount = this.runs.size - limit;
    for (const run of ordered.slice(0, evictCount)) {
      this.runs.delete(run.id);
      const owner = this.ownerByRunId.get(run.id);
      if (owner) {
        const list = (this.runsByOwner.get(owner) ?? []).filter((rid) => rid !== run.id);
        if (list.length > 0) this.runsByOwner.set(owner, list);
        else this.runsByOwner.delete(owner);
        this.ownerByRunId.delete(run.id);
      }
      const ikey = this.idempotencyByRunId.get(run.id);
      if (ikey) {
        this.byIdempotency.delete(ikey);
        this.idempotencyByRunId.delete(run.id);
      }
    }
  }

  private encodeCursor(createdAt: number, id: string): string {
    return Buffer.from(`${createdAt}:${id}`, 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string): { createdAt: number; id: string } | undefined {
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const [createdAtRaw, ...idParts] = decoded.split(':');
      const createdAt = Number(createdAtRaw);
      if (!Number.isFinite(createdAt) || idParts.length === 0) return undefined;
      return { createdAt, id: idParts.join(':') };
    } catch {
      return undefined;
    }
  }

  // Atomic write: write to .tmp then rename so readers never see a partial file.
  // On POSIX this is a single fsync-safe rename; on Windows it is best-effort.
  private persistRun(run: Run): void {
    if (!this.persist) return;
    const runsDir = join(process.cwd(), 'runs');
    const target = join(runsDir, `${run.id}.json`);
    const tmp = `${target}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(run, null, 2), 'utf8');
      renameSync(tmp, target);
    } catch {
      // best-effort: fall back to direct write on rename failure (Windows locked-file edge case)
      try { writeFileSync(target, JSON.stringify(run, null, 2), 'utf8'); } catch { /* ignore */ }
    }
  }

  // Persist the owner/idempotency index so lookups survive restarts.
  private flushIndex(): void {
    if (!this.persist) return;
    const idx: PersistIndex = {
      ownerByRunId: Object.fromEntries(this.ownerByRunId),
      runsByOwner: Object.fromEntries(this.runsByOwner),
      idempotency: Object.fromEntries(this.byIdempotency)
    };
    const indexPath = join(process.cwd(), 'runs', 'index.json');
    const tmp = `${indexPath}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(idx, null, 2), 'utf8');
      renameSync(tmp, indexPath);
    } catch { /* best-effort */ }
  }

  // Reload the persisted index on startup so owner/idempotency data is recovered.
  private loadIndex(): void {
    const indexPath = join(process.cwd(), 'runs', 'index.json');
    if (!existsSync(indexPath)) return;
    try {
      const idx = JSON.parse(readFileSync(indexPath, 'utf8')) as PersistIndex;
      for (const [runId, owner] of Object.entries(idx.ownerByRunId ?? {})) this.ownerByRunId.set(runId, owner);
      for (const [owner, ids] of Object.entries(idx.runsByOwner ?? {})) this.runsByOwner.set(owner, ids);
      for (const [key, runId] of Object.entries(idx.idempotency ?? {})) this.byIdempotency.set(key, runId);
    } catch { /* corrupted index: start fresh */ }
  }

  private mergeLogs(a: Run['logs'], b: Run['logs']): Run['logs'] {
    if (a.length === 0) return b;
    if (b.length === 0) return a;
    const seen = new Set<string>();
    const merged: Run['logs'] = [];
    for (const item of [...a, ...b]) {
      const key = JSON.stringify([item.seq, item.ts, item.type, item.run_id, item.task_name, item.data]);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    return merged.sort((x, y) => (x.seq - y.seq) || (x.ts - y.ts));
  }
}
