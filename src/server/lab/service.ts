import type { z, ZodTypeAny } from "zod";
import { ToolInputError, UpstreamError, type ToolContext } from "../mcp/types.js";
import {
  evaluateRule as evaluateRuleOn,
  featureSpecs,
  inZoneDays,
  livePerf,
  MAX_FEATURES,
  parseFeatureId,
  ruleFiresAt,
  ruleId,
  runSearch,
  SearchRefused,
  withVerdict,
} from "./engine/index.js";
import { allMetrics, getMetric, loadDataset as registryLoadDataset, PROVIDERS, type LoadConfig } from "./providers/registry.js";
import { defaultStore, type LabStore, type RunSummary, type StoredRun } from "./store.js";
import {
  RuleSchema,
  SearchConfigSchema,
  type CatalogueEntry,
  type CatalogueHealth,
  type Direction,
  type LabDataset,
  type LabProvider,
  type MarketPulse,
  type MetricCategory,
  type MetricDef,
  type PerfStats,
  type PulseAsset,
  type Rule,
  type RuleEvaluation,
  type SearchResult,
  type Sensitivity,
} from "./types.js";
import { mapLimit, msg } from "./util.js";

// Lab service (LAB.md "Tool contract"): one method per tool. A thin
// orchestration layer over the providers (data), the engine (all math) and
// the store (persistence). Transports call it through tools.ts.

export type LoadDatasetFn = (cfg: LoadConfig) => Promise<{ dataset: LabDataset; warnings: string[] }>;

export interface LabServiceDeps {
  store: LabStore;
  loadDataset: LoadDatasetFn;
  now: () => number;
  /** Metric catalogue used to validate ids; defaults to the registry. */
  providers: LabProvider[];
}

export const DEFAULT_WINDOWS = [7, 30, 90];
/** Slippage for live (post-save) performance. */
export const LIVE_SLIPPAGE_BPS = 10;
const LOAD_CONCURRENCY = 4;
const DECAY_MIN_LIVE_DAYS = 30;
const DECAY_HOLDOUT_SHARE = 0.25;
const OVERLAP_JACCARD = 0.6;
/** Kept back from a search deadline for the work after the last trial (refit, ranking, persisting). */
export const SEARCH_FINISH_MS = 5_000;

export type CatalogueFlag = "decayed" | "overlap";
export type CatalogueListEntry = CatalogueEntry & { live: PerfStats | null; flags: CatalogueFlag[] };

export interface EvaluateInput {
  rule: Rule;
  from?: string;
  to?: string;
  slippageBps?: number;
  includeEquity?: boolean;
  sensitivity?: boolean;
  windows?: number[];
  /** N for the deflated Sharpe (e.g. a run's effectiveTrials); default 1. */
  trials?: number;
}

export interface SaveInput {
  rule: Rule;
  name: string;
  note?: string;
  runId?: string;
  origin?: CatalogueEntry["origin"];
}

/** Zod parse at the trust boundary: the first issue becomes a ToolInputError naming its field path. */
export function parseInput<S extends ZodTypeAny>(schema: S, input: unknown, prefix?: string): z.output<S> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const issue = r.error.issues[0]!;
  const path = issue.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]] : issue.path;
  const field = [prefix, ...path].filter((x) => x !== undefined && x !== "").join(".") || undefined;
  const text = issue.code === "unrecognized_keys" ? "unknown argument" : issue.message;
  throw new ToolInputError(field ? `${field}: ${text}` : text, field);
}

/** An engine refusal is the caller's input to change: a 400, not a failure. */
function asInputError(err: unknown): unknown {
  return err instanceof SearchRefused ? new ToolInputError(err.message, err.field) : err;
}

/**
 * Fields a catalogue save takes from the search run that found the rule.
 * An explicit evaluation computes its own walk-forward too, but the run's is
 * what the rule was selected on, over the run's date range, and its deflated
 * Sharpe is deflated by the run's effectiveTrials. (The fresh evaluation is
 * also deflated by them when a run is given; without a run its N is 1, so it
 * is not deflated for any search — the asymmetry is deliberate: no run, no
 * known search to deflate for.)
 */
const SEARCH_FIELDS = ["walkForward", "walkForwardFolds", "deflatedSharpe"] as const;

/** A fresh evaluation, with the walk-forward fields of the search that found the rule when there is one; the verdict is recomputed on the result. */
function withSearchWalkForward(fresh: RuleEvaluation, fromSearch: RuleEvaluation | undefined): RuleEvaluation {
  if (!fromSearch) return fresh;
  const out: Record<string, unknown> = { ...fresh };
  for (const k of SEARCH_FIELDS) if (k in fromSearch) out[k] = (fromSearch as unknown as Record<string, unknown>)[k];
  return withVerdict(out as unknown as RuleEvaluation);
}

/** Search N for a run: its effectiveTrials, or the raw variant count for runs stored before it existed (stricter). */
function runTrials(result: SearchResult | null | undefined): number | undefined {
  return result ? (result.effectiveTrials ?? result.variantsScored) : undefined;
}

/** Entries and run results stored before verdicts existed get one computed on read. */
function ensureVerdict<T extends RuleEvaluation>(ev: T): T {
  return ev.verdict ? ev : withVerdict(ev);
}
function withEntryVerdict<T extends CatalogueEntry>(e: T): T {
  return e.saved.verdict ? e : { ...e, saved: withVerdict(e.saved) };
}

export function createLabService(partial: Partial<LabServiceDeps> = {}) {
  const deps: LabServiceDeps = {
    store: partial.store ?? defaultStore(),
    loadDataset: partial.loadDataset ?? ((cfg) => registryLoadDataset(cfg)),
    now: partial.now ?? Date.now,
    providers: partial.providers ?? PROVIDERS,
  };
  const known = (id: string) => !!getMetric(id, deps.providers);

  /** Metric ids a rule's features read; ToolInputError on a bad feature id or unknown metric. */
  function ruleMetrics(rule: Rule, field = "rule"): string[] {
    const out = new Set<string>();
    rule.conditions.forEach((c, i) => {
      const at = `${field}.conditions.${i}.feature`;
      let metric: string;
      try {
        metric = parseFeatureId(c.feature).metric;
      } catch (err) {
        throw new ToolInputError(msg(err), at);
      }
      if (!known(metric)) throw new ToolInputError(`unknown metric ${metric} (lab_list_metrics lists them)`, at);
      out.add(metric);
    });
    if (rule.price && !known(rule.price)) throw new ToolInputError(`unknown price metric ${rule.price}`, `${field}.price`);
    return [...out];
  }

  /**
   * Full-history datasets for catalogue entries, one load per (asset, price)
   * with the union of their metrics. Entries that cannot be served are left
   * out with a warning; nothing throws.
   */
  async function loadEntries(entries: CatalogueEntry[], warnings: string[]): Promise<Map<string, LabDataset>> {
    const groups = new Map<string, { asset: string; price?: string; metrics: Set<string>; entries: Array<{ e: CatalogueEntry; metrics: string[] }> }>();
    for (const e of entries) {
      let metrics: string[];
      try {
        metrics = ruleMetrics(e.rule);
      } catch (err) {
        warnings.push(`${e.name} (${e.id}): ${msg(err)}`);
        continue;
      }
      const key = `${e.rule.asset.toUpperCase()}|${e.rule.price ?? ""}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { asset: e.rule.asset, price: e.rule.price, metrics: new Set(), entries: [] }));
      for (const m of metrics) g.metrics.add(m);
      g.entries.push({ e, metrics });
    }
    const out = new Map<string, LabDataset>();
    await mapLimit([...groups.values()], LOAD_CONCURRENCY, async (g) => {
      let loaded: Awaited<ReturnType<LoadDatasetFn>>;
      try {
        loaded = await deps.loadDataset({ asset: g.asset, metrics: [...g.metrics], price: g.price });
      } catch (err) {
        for (const { e } of g.entries) warnings.push(`${e.name} (${e.id}): ${msg(err)}`);
        return;
      }
      for (const { e, metrics } of g.entries) {
        const missing = metrics.filter((m) => !loaded.dataset.metrics[m]);
        if (!missing.length) out.set(e.id, loaded.dataset);
        else {
          const why = missing.map((m) => loaded.warnings.find((w) => w.startsWith(`${m}:`)) ?? `${m}: no data`);
          warnings.push(`${e.name} (${e.id}): ${why.join("; ")}`);
        }
      }
    });
    return out;
  }

  /** Live stats, decay, overlap and gaps over a set of entries (LAB.md §9). */
  async function analyse(entries: CatalogueEntry[]): Promise<CatalogueHealth> {
    const warnings: string[] = [];
    const data = await loadEntries(entries, warnings);
    const live: Record<string, PerfStats | null> = {};
    const zones = new Map<string, Map<number, boolean>>();
    for (const e of entries) {
      live[e.id] = null;
      const ds = data.get(e.id);
      if (!ds) continue;
      try {
        live[e.id] = livePerf(e.rule, ds, { slippageBps: LIVE_SLIPPAGE_BPS, from: e.savedAt });
        const z = inZoneDays(e.rule, ds);
        zones.set(e.id, new Map(ds.t.map((t, i) => [t, z[i]!])));
      } catch (err) {
        warnings.push(`${e.name} (${e.id}): ${msg(err)}`);
      }
    }
    if (warnings.length) console.warn(`[lab] catalogue: ${warnings.join(" | ")}`);

    const decayed: CatalogueHealth["decayed"] = [];
    for (const e of entries) {
      const l = live[e.id];
      const holdoutSharpe = e.saved.holdout?.sharpe ?? null;
      if (l && l.days >= DECAY_MIN_LIVE_DAYS && l.sharpe < Math.max(0, DECAY_HOLDOUT_SHARE * (holdoutSharpe ?? 0))) {
        decayed.push({ id: e.id, name: e.name, liveDays: l.days, liveSharpe: l.sharpe, holdoutSharpe });
      }
    }

    const overlaps: CatalogueHealth["overlaps"] = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i]!;
        const b = entries[j]!;
        const za = zones.get(a.id);
        const zb = zones.get(b.id);
        // Opposite sides on the same days are a contradiction, not a duplicate.
        if (!za || !zb || a.rule.asset.toUpperCase() !== b.rule.asset.toUpperCase() || a.rule.direction !== b.rule.direction) continue;
        let inter = 0;
        let union = 0;
        for (const [t, x] of za) {
          const y = zb.get(t);
          if (y === undefined) continue; // shared calendar only
          if (x && y) inter++;
          if (x || y) union++;
        }
        if (union && inter / union >= OVERLAP_JACCARD) overlaps.push({ a: a.id, b: b.id, jaccard: Math.round((inter / union) * 1000) / 1000 });
      }
    }

    const gaps: CatalogueHealth["gaps"] = [];
    const assets = [...new Map(entries.map((e) => [e.rule.asset.toUpperCase(), e.rule.asset])).values()].sort();
    for (const asset of assets) {
      for (const direction of ["long", "short"] as const) {
        if (!entries.some((e) => e.rule.asset.toUpperCase() === asset.toUpperCase() && e.rule.direction === direction)) gaps.push({ asset, direction });
      }
    }
    return { decayed, overlaps, gaps, live };
  }

  async function evaluate(input: EvaluateInput): Promise<RuleEvaluation> {
    const rule = parseInput(RuleSchema, input.rule, "rule");
    const metrics = ruleMetrics(rule);
    // Full history up to `to`: rolling features need warm-up before `from`.
    const { dataset, warnings } = await deps.loadDataset({ asset: rule.asset, metrics, price: rule.price, to: input.to });
    const missing = metrics.filter((m) => !dataset.metrics[m]);
    if (missing.length) throw new UpstreamError(`no data for ${missing.join(", ")} on ${rule.asset}${warnings.length ? ` (${warnings.join("; ")})` : ""}`);
    try {
      return evaluateRuleOn(rule, dataset, {
        slippageBps: input.slippageBps ?? 10,
        includeEquity: input.includeEquity ?? false,
        from: input.from,
        to: input.to,
        windows: input.sensitivity ? (input.windows ?? DEFAULT_WINDOWS) : undefined,
        trials: input.trials,
      });
    } catch (err) {
      throw asInputError(err);
    }
  }

  return {
    deps,

    listProviders() {
      return { providers: deps.providers.map((p) => ({ id: p.id, name: p.name, notes: p.notes, metrics: p.metrics().length })) };
    },

    listMetrics(filter: { provider?: string; category?: MetricCategory; asset?: string } = {}): { metrics: MetricDef[] } {
      return { metrics: allMetrics(filter, deps.providers) };
    },

    async search(input: unknown, ctx: Pick<ToolContext, "source" | "deadlineMs">): Promise<{ runId: string | null; result: SearchResult }> {
      const config = parseInput(SearchConfigSchema, input);
      config.metrics.forEach((m, i) => {
        if (!known(m)) throw new ToolInputError(`unknown metric ${m} (lab_list_metrics lists them)`, `metrics.${i}`);
      });
      if (config.price && !known(config.price)) throw new ToolInputError(`unknown price metric ${config.price}`, "price");
      // Refuse before fetching anything (the engine re-checks after dropping empty metrics).
      const features = featureSpecs(config.metrics, config.transforms, config.windows).length;
      if (features > MAX_FEATURES) {
        throw new ToolInputError(`${features} features (metrics × transforms × windows) exceed the cap of ${MAX_FEATURES}: use fewer metrics, transforms or windows`, "metrics");
      }

      const started = deps.now();
      let result: SearchResult;
      try {
        const loaded = await deps.loadDataset({
          asset: config.asset,
          metrics: config.metrics,
          price: config.price,
          from: config.from,
          to: config.to,
          ...(ctx.deadlineMs != null && { deadline: true }),
        });
        // The deadline covers the whole call: data loading spends part of it,
        // and the refit after the last trial needs the rest.
        const deadlineMs = ctx.deadlineMs == null ? undefined : Math.max(1, ctx.deadlineMs - (deps.now() - started) - SEARCH_FINISH_MS);
        result = runSearch(config, loaded.dataset, { deadlineMs });
        result.warnings = [...loaded.warnings, ...result.warnings];
      } catch (err) {
        // Refusals and bad input are answered, not recorded as failed runs.
        if (err instanceof SearchRefused || err instanceof ToolInputError) throw asInputError(err);
        await deps.store
          .saveRun({ source: ctx.source, config, status: "error", error: msg(err), result: null, durationMs: deps.now() - started })
          .catch((e) => console.warn(`[lab] failed run not saved: ${msg(e)}`));
        throw err;
      }
      let runId: string | null = null;
      try {
        runId = (await deps.store.saveRun({ source: ctx.source, config, status: "ok", error: null, result, durationMs: deps.now() - started })).id;
      } catch (err) {
        result.warnings.push(`run not saved: ${msg(err)}`);
      }
      return { runId, result };
    },

    async getRun(id: string): Promise<StoredRun> {
      const run = await deps.store.getRun(id);
      if (!run) throw new ToolInputError(`no run with id ${id} (lab_list_runs lists them)`, "id");
      return run.result && run.result.rules.some((r) => !r.verdict) ? { ...run, result: { ...run.result, rules: run.result.rules.map(ensureVerdict) } } : run;
    },

    async listRuns(limit = 20): Promise<{ runs: RunSummary[] }> {
      return { runs: await deps.store.listRuns(limit) };
    },

    evaluateRule: evaluate,

    async sensitivity(input: { rule: Rule; windows?: number[]; slippageBps?: number }): Promise<Sensitivity> {
      const ev = await evaluate({ rule: input.rule, slippageBps: input.slippageBps, sensitivity: true, windows: input.windows });
      return ev.sensitivity!;
    },

    async catalogueList(input: { asset?: string; direction?: Direction; live?: boolean } = {}): Promise<{ entries: CatalogueListEntry[] }> {
      const all = (await deps.store.listCatalogue()).map(withEntryVerdict);
      const sameAsset = (e: CatalogueEntry) => !input.asset || e.rule.asset.toUpperCase() === input.asset.toUpperCase();
      const listed = all.filter((e) => sameAsset(e) && (!input.direction || e.rule.direction === input.direction));
      if (input.live === false || !listed.length) return { entries: listed.map((e) => ({ ...e, live: null, flags: [] })) };
      // Flags compare against every rule on the listed assets, not only the listed direction.
      const assets = new Set(listed.map((e) => e.rule.asset.toUpperCase()));
      const health = await analyse(all.filter((e) => assets.has(e.rule.asset.toUpperCase())));
      const decayed = new Set(health.decayed.map((d) => d.id));
      const overlapping = new Set(health.overlaps.flatMap((o) => [o.a, o.b]));
      return {
        entries: listed.map((e) => ({
          ...e,
          live: health.live[e.id] ?? null,
          flags: [...(decayed.has(e.id) ? (["decayed"] as const) : []), ...(overlapping.has(e.id) ? (["overlap"] as const) : [])],
        })),
      };
    },

    async catalogueSave(input: SaveInput): Promise<CatalogueEntry> {
      const rule = parseInput(RuleSchema, input.rule, "rule");
      const run = input.runId ? await deps.store.getRun(input.runId) : null;
      if (input.runId && !run) throw new ToolInputError(`unknown run ${input.runId} (lab_list_runs lists them)`, "runId");
      const id = ruleId(rule);
      // The store keeps an existing entry's evaluation, so only a new rule is evaluated.
      const existing = await deps.store.getCatalogueEntry(id);
      const saved =
        existing?.saved ?? withSearchWalkForward(await evaluate({ rule, sensitivity: true, trials: runTrials(run?.result) }), run?.result?.rules.find((r) => r.id === id));
      return withEntryVerdict(await deps.store.saveCatalogueEntry({
        id,
        name: input.name,
        note: input.note ?? null,
        origin: input.origin ?? "user",
        runId: input.runId ?? null,
        rule,
        saved,
      }));
    },

    async catalogueRemove(id: string): Promise<{ removed: boolean }> {
      return { removed: await deps.store.archiveCatalogueEntry(id) };
    },

    async catalogueHealth(): Promise<CatalogueHealth> {
      return analyse(await deps.store.listCatalogue());
    },

    async marketPulse(input: { asset?: string } = {}): Promise<MarketPulse> {
      const entries = (await deps.store.listCatalogue()).filter((e) => !input.asset || e.rule.asset.toUpperCase() === input.asset.toUpperCase());
      const warnings: string[] = [];
      const data = await loadEntries(entries, warnings);
      const byAsset = new Map<string, PulseAsset>();
      for (const e of entries) {
        const ds = data.get(e.id);
        if (!ds) continue;
        let firing: boolean;
        try {
          firing = ruleFiresAt(e.rule, ds).firing;
        } catch (err) {
          warnings.push(`${e.name} (${e.id}): ${msg(err)}`);
          continue;
        }
        const key = e.rule.asset.toUpperCase();
        let p = byAsset.get(key);
        if (!p) byAsset.set(key, (p = { asset: e.rule.asset, longActive: 0, longTotal: 0, shortActive: 0, shortTotal: 0, lean: 0, rules: [] }));
        if (e.rule.direction === "long") {
          p.longTotal++;
          if (firing) p.longActive++;
        } else {
          p.shortTotal++;
          if (firing) p.shortActive++;
        }
        p.rules.push({ id: e.id, name: e.name, direction: e.rule.direction, firing, text: e.saved.text });
      }
      const assets = [...byAsset.values()].sort((a, b) => a.asset.localeCompare(b.asset));
      for (const p of assets) {
        const total = p.longTotal + p.shortTotal;
        p.lean = total ? (p.longActive - p.shortActive) / total : 0;
      }
      return { asOf: new Date(deps.now()).toISOString(), assets, warnings };
    },
  };
}

export type LabService = ReturnType<typeof createLabService>;
