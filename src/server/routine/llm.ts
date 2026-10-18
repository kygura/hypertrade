import type { ZodType } from "zod";
import { completeStructured, type LlmCacheStore, type LlmTrace, usageCost } from "../intel/llm.js";
import { isProviderId, parseEffort, resolveChosenProvider, type AnalystEnv, type Effort, type LLMProvider, type ProviderId, type ToolSpec } from "../llm/provider.js";

// The routine's model access: the app's own completeStructured (emit tool,
// zod as the authority, one retry) over a provider chain from ROUTINE_LLM,
// tried in order on failure (docs/fallback-routine.md § Provider chain). No
// database: the cache is in memory and doubles as the per-run spend meter.

// Claude first; Kimi takes over when the Anthropic call fails (no credits, no key, outage).
export const DEFAULT_CHAIN = "anthropic:claude-opus-5-5@high,moonshot:kimi-k3@high,moonshot:kimi-k2.6";
export const DEFAULT_MAX_USD = 1;
/** Large structured answers from thinking models take minutes, not the intel default of 60 s. */
export const ROUTINE_DEADLINE_MS = 300_000;

export interface ChainEntry {
  provider: ProviderId;
  model: string;
  effort?: Effort;
  raw: string;
}

/** `provider:model[@effort]`, comma-separated. Bad entries are reported, not fatal. */
export function parseChain(spec: string | undefined): { entries: ChainEntry[]; errors: string[] } {
  const entries: ChainEntry[] = [];
  const errors: string[] = [];
  for (const raw of (spec?.trim() || DEFAULT_CHAIN).split(",").map((s) => s.trim()).filter(Boolean)) {
    const colon = raw.indexOf(":");
    const provider = colon > 0 ? raw.slice(0, colon).trim().toLowerCase() : "";
    let model = colon > 0 ? raw.slice(colon + 1).trim() : "";
    let effort: Effort | undefined;
    const at = model.lastIndexOf("@");
    if (at > 0) {
      const e = model.slice(at + 1).trim().toLowerCase();
      if (parseEffort(e) !== e) {
        errors.push(`${raw}: unknown effort "${e}"`);
        continue;
      }
      effort = e as Effort;
      model = model.slice(0, at).trim();
    }
    if (!isProviderId(provider) || !model) {
      errors.push(`${raw}: expected provider:model[@effort] with a known provider`);
      continue;
    }
    entries.push({ provider, model, effort, raw });
  }
  return { entries, errors };
}

export type ProviderFactory = (entry: ChainEntry) => LLMProvider | null;

export const envProviderFactory =
  (env: AnalystEnv): ProviderFactory =>
  (e) =>
    resolveChosenProvider(env, { provider: e.provider, model: e.model, effort: e.effort });

/** In-memory LlmCacheStore: no reuse across runs; usage rows feed the spend cap. */
export class MemoryLlmCache implements LlmCacheStore {
  private rows = new Map<string, unknown>();
  readonly usage: unknown[] = [];
  async cacheGet(key: string, v: string) {
    return this.rows.get(`${key}|${v}`) ?? null;
  }
  async cachePut(key: string, v: string, output: unknown, usage: unknown, model?: string) {
    this.rows.set(`${key}|${v}`, output);
    this.usage.push({ ...(usage as object), model });
  }
  async callsSince() {
    return this.usage.length;
  }
  async usageSince() {
    return this.usage;
  }
  spentUsd() {
    return this.usage.reduce<number>((s, u) => s + usageCost(u), 0);
  }
}

export interface ChainAttempt {
  entry: string;
  ok: boolean;
  error?: string;
  model: string | null;
  ms: number;
  usage: LlmTrace["usage"];
}

export interface ChainDeps {
  entries: ChainEntry[];
  makeProvider: ProviderFactory;
  cache: MemoryLlmCache;
  maxUsd: number;
  now(): Date;
  deadlineMs?: number;
}

export type ChainResult<T> = { ok: true; value: T; model: string; attempts: ChainAttempt[] } | { ok: false; error: string; attempts: ChainAttempt[] };

/**
 * Tries each chain entry in order until one returns a valid object. A
 * missing key, an HTTP error or invalid output after the retry moves to the
 * next entry; reaching the spend cap stops the chain.
 */
export async function callChain<T>(
  deps: ChainDeps,
  args: { system: string; user: string; schema: ZodType<T>; jsonSchema: ToolSpec["input_schema"]; promptVersion: string },
): Promise<ChainResult<T>> {
  const attempts: ChainAttempt[] = [];
  for (const entry of deps.entries) {
    const provider = deps.makeProvider(entry);
    if (!provider) {
      attempts.push({ entry: entry.raw, ok: false, error: "no API key for this provider", model: null, ms: 0, usage: { input_tokens: 0, output_tokens: 0 } });
      continue;
    }
    const res = await completeStructured({
      tier: "strong",
      ...args,
      deadlineMs: deps.deadlineMs ?? ROUTINE_DEADLINE_MS,
      deps: { makeProvider: () => provider, cache: deps.cache, now: deps.now, dailyCap: 50, dailyUsd: deps.maxUsd },
    });
    attempts.push({ entry: entry.raw, ok: res.ok, error: res.ok ? undefined : res.error, model: res.trace.model, ms: res.trace.ms, usage: res.trace.usage });
    if (res.ok) return { ok: true, value: res.value, model: provider.model, attempts };
    if (res.error.startsWith("LLM cap reached")) return { ok: false, error: `spend cap: ${res.error}`, attempts };
  }
  const last = attempts.at(-1);
  return { ok: false, error: last ? `every provider failed (last: ${last.entry}: ${last.error})` : "no provider in ROUTINE_LLM", attempts };
}

/** True when at least one chain entry has a key, i.e. the run can call a model at all. */
export function anyProviderConfigured(entries: ChainEntry[], make: ProviderFactory): boolean {
  return entries.some((e) => make(e) !== null);
}
