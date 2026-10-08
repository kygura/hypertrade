// Lab operations shared by the HTTP routes, the analyst's tools and the MCP
// server, so all three answer the same question the same way.
import { z } from "zod";
import {
  LAB_BASES,
  LAB_GROUPS,
  LAB_TRANSFORMS,
  LabRuleSchema,
  LabSearchRequestSchema,
  type LabCatalogueEntry,
  type LabPulse,
  type LabRuleReport,
  type LabSearchRequest,
  type LabSearchResult,
} from "../../shared/lab.js";
import * as db from "../db.js";
import { loadDataset, type DatasetDeps } from "./dataset.js";
import { evaluateRule, liveCheck, runSearch } from "./search.js";
import { LAB_SOURCES, LAB_SYNC_COIN } from "./sources.js";

export const LabEvaluateRequestSchema = z
  .object({
    rule: LabRuleSchema,
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    costBps: z.number().min(0).max(100).optional(),
  })
  .strict();
export type LabEvaluateRequest = z.infer<typeof LabEvaluateRequestSchema>;

/** A saved report must carry resolved thresholds; the stats ride along as saved. */
export const LabSaveRequestSchema = z
  .object({
    report: z
      .object({
        rule: LabRuleSchema.refine((r) => r.conditions.every((c) => c.threshold !== undefined), {
          message: "saved rules need resolved thresholds (save a report from /lab/search or /lab/evaluate)",
        }),
        text: z.string().max(500),
      })
      .passthrough(),
    note: z.string().max(500).optional(),
    source: z.enum(["ui", "cli", "mcp"]).default("ui"),
  })
  .strict();

export interface LabFeatureInfo {
  id: string;
  label: string;
  group: string;
  units: string;
  source: string;
  description: string;
  lagDays: number;
  coverage: { from: string; to: string; rows: number } | null;
  syncError: string | null;
}

export interface LabServiceDeps {
  dataset: DatasetDeps | undefined;
  coverage: typeof db.seriesCoverage;
  candleCoverage: typeof db.candleCoverage;
  fundingCoverage: typeof db.fundingCoverage;
  syncState: typeof db.getSyncState;
  insertRun: typeof db.insertLabRun;
  listRules: typeof db.listLabRules;
  insertRule: typeof db.insertLabRule;
}

export const defaultServiceDeps: LabServiceDeps = {
  dataset: undefined,
  coverage: db.seriesCoverage,
  candleCoverage: db.candleCoverage,
  fundingCoverage: db.fundingCoverage,
  syncState: db.getSyncState,
  insertRun: db.insertLabRun,
  listRules: db.listLabRules,
  insertRule: db.insertLabRule,
};

const day = (d: Date) => d.toISOString().slice(0, 10);

export async function labFeatures(deps: LabServiceDeps = defaultServiceDeps): Promise<{
  bases: LabFeatureInfo[];
  transforms: typeof LAB_TRANSFORMS;
  groups: typeof LAB_GROUPS;
}> {
  const stored = LAB_BASES.filter((b) => !b.id.startsWith("px.") && !b.id.startsWith("fund."));
  const [cov, px, fund, states] = await Promise.all([
    deps.coverage(stored.map((b) => b.id)),
    deps.candleCoverage("BTC", "1d"),
    deps.fundingCoverage("BTC"),
    Promise.all(LAB_SOURCES.map((s) => deps.syncState(LAB_SYNC_COIN, s.key).catch(() => null))),
  ]);
  const covBy = new Map(cov.map((c) => [c.seriesId, c]));
  const errBy = new Map(LAB_SOURCES.map((s, i) => [s.key, states[i]?.error ?? null]));
  const bases = LAB_BASES.map((b): LabFeatureInfo => {
    let coverage: LabFeatureInfo["coverage"] = null;
    if (b.id === "px.BTC" && px) coverage = { from: day(px.min), to: day(px.max), rows: 0 };
    else if (b.id === "fund.BTC" && fund) coverage = { from: day(fund.min), to: day(fund.max), rows: 0 };
    else {
      const c = covBy.get(b.id);
      if (c) coverage = { from: day(c.min), to: day(c.max), rows: c.n };
    }
    return { ...b, coverage, syncError: errBy.get(b.id) ?? null };
  });
  return { bases, transforms: LAB_TRANSFORMS, groups: LAB_GROUPS };
}

/** Runs a search on stored data. `persist` keeps it in lab_runs (the UI's run history). */
export async function labSearch(
  raw: LabSearchRequest,
  opts: { persist?: boolean; deps?: LabServiceDeps } = {},
): Promise<LabSearchResult & { runId: string | null }> {
  const deps = opts.deps ?? defaultServiceDeps;
  const req = LabSearchRequestSchema.parse(raw);
  const ds = await loadDataset(req.bases ?? LAB_BASES.map((b) => b.id), deps.dataset);
  const result = runSearch(ds, req);
  let runId: string | null = null;
  if (opts.persist) {
    // History is a convenience: a failed insert must not lose the answer.
    runId = await deps.insertRun(req, result).catch(() => null);
  }
  return { ...result, runId };
}

export async function labEvaluate(input: LabEvaluateRequest, deps: LabServiceDeps = defaultServiceDeps): Promise<LabRuleReport> {
  const ds = await loadDataset(input.rule.conditions.map((c) => c.feature.slice(0, c.feature.lastIndexOf("|"))), deps.dataset);
  return evaluateRule(ds, input.rule, { from: input.from, costBps: input.costBps });
}

export function pulseOf(entries: LabCatalogueEntry[]): LabPulse {
  const p: LabPulse = { long: { active: 0, total: 0 }, short: { active: 0, total: 0 }, lean: 0 };
  for (const e of entries) {
    const side = e.report.rule.direction === "short" ? p.short : p.long;
    side.total++;
    if (e.live?.firingNow) side.active++;
  }
  const total = p.long.total + p.short.total;
  p.lean = total ? (p.long.active - p.short.active) / total : 0;
  return p;
}

/** The saved catalogue, each rule re-checked on today's data, plus the pulse. */
export async function labCatalogue(deps: LabServiceDeps = defaultServiceDeps): Promise<{ entries: LabCatalogueEntry[]; pulse: LabPulse }> {
  const rows = await deps.listRules();
  if (rows.length === 0) return { entries: [], pulse: pulseOf([]) };
  const reports = rows.map((r) => r.report as LabRuleReport);
  const baseIds = [...new Set(reports.flatMap((r) => r.rule.conditions.map((c) => c.feature.slice(0, c.feature.lastIndexOf("|")))))];
  const ds = await loadDataset(baseIds, deps.dataset);
  const entries = rows.map((row, i): LabCatalogueEntry => {
    const report = reports[i]!;
    const base = { id: row.id, createdAt: row.createdAt.toISOString(), note: row.note, source: row.source, report };
    try {
      return { ...base, live: liveCheck(ds, report.rule, base.createdAt) };
    } catch (err) {
      return { ...base, live: null, error: err instanceof Error ? err.message : String(err) };
    }
  });
  return { entries, pulse: pulseOf(entries) };
}

/** The same rule (same rendered text) is already saved. */
export class LabDuplicateError extends Error {
  constructor(public readonly id: string) {
    super("rule already in the catalogue");
    this.name = "LabDuplicateError";
  }
}

export async function labSave(raw: unknown, deps: LabServiceDeps = defaultServiceDeps): Promise<{ id: string; createdAt: string }> {
  const req = LabSaveRequestSchema.parse(raw);
  // Saving twice would restart nothing and double-count the rule in the pulse.
  const existing = (await deps.listRules()).find((r) => (r.report as { text?: string }).text === req.report.text);
  if (existing) throw new LabDuplicateError(existing.id);
  const row = await deps.insertRule(req.report, req.source, req.note ?? null);
  return { id: row.id, createdAt: row.createdAt.toISOString() };
}

/** Report without the equity curve: what a model needs, at a fraction of the tokens. */
export function compactReport(r: LabRuleReport) {
  const s = (x: LabRuleReport["inSample"] | null) =>
    x && {
      window: `${x.from}..${x.to}`,
      sharpe: round(x.sharpe),
      cagrPct: round(x.cagrPct),
      maxDrawdownPct: round(x.maxDrawdownPct),
      exposure: round(x.exposure),
      trades: x.trades,
      winRate: x.winRate === null ? null : round(x.winRate),
      benchmarkSharpe: round(x.benchmark.sharpe),
    };
  return {
    text: r.text,
    rule: r.rule,
    inSample: s(r.inSample),
    walkForward: s(r.walkForward),
    outOfSample: s(r.outOfSample),
    deflatedSharpe: r.deflatedSharpe === null ? null : round(r.deflatedSharpe),
    stability: r.stability === null ? null : round(r.stability),
    firingNow: r.firingNow,
    asOf: r.asOf,
  };
}

const round = (v: number) => Math.round(v * 1000) / 1000;
