import { createHash } from "node:crypto";
import { z } from "zod";
import type { Claim } from "../../shared/claims.js";
import { fetchPerpMetaAndCtxs } from "../../shared/hl-client.js";
import type {
  Alert,
  Brief,
  BriefSurface,
  Catalyst,
  DiffItem,
  IngestHealth,
  IntelEvent,
  LlmTrace,
  PositionsResponse,
  Review,
  SnapshotMetric,
  SnapshotRow,
} from "../../shared/intel.js";
import type { AssetCtx } from "../../shared/types.js";
import * as db from "../db.js";
import type { AccountState } from "../desk/types.js";
import type { Notifier } from "../desk/notify.js";
import { claimsJsonSchema, validateClaims } from "./claims.js";
import { buildDiffItems, rankDiffs, type AssetDiffInput, type Bar } from "./diff.js";
import { completeStructured, intelProviderFactory, type LlmDeps } from "./llm.js";
import { hasSamples, WINDOW_MS, type Point } from "./normalize.js";
import { sendIntel } from "./notify.js";
import { loadExposure, watchedAssets } from "./positions.js";
import { snapshotRow } from "./snapshot.js";
import { PgIntelStore, type IntelStore } from "./store.js";

// Terminal brief (SPEC.md § Intel I0.14). Code diffs held ∪ watched assets
// against a baseline, ranks by materiality and merges batched alerts and the
// next 24 h of catalysts; the strong tier only narrates what cleared, in
// claim-tagged lines. Silent (nothing cleared, no batched alert) → no LLM
// call. A failed narration still stores the brief, with lines [] and the
// error in the trace, so the ranked table shows without prose.
//   ui:   baseline = snapshot nearest the last review (6 h fallback); logs a review
//   cron: baseline = the previous cron brief (6 h fallback); never logs a review

const HOUR_MS = 3_600_000;
export const FALLBACK_BASELINE_MS = 6 * HOUR_MS;
const CATALYST_AHEAD_MS = 24 * HOUR_MS;
/** A stored snapshot this fresh lends its book depth/spread to the live row (books are only fetched by collect). */
const BOOK_FRESH_MS = 30 * 60_000;
const ATR_LOOKBACK_MS = 48 * HOUR_MS;
export const BRIEF_PROMPT_VERSION = "terminal-brief-v1";
const MAX_LINES = 5;

export interface Thresholds {
  minZ: number;
  topK: number;
  pushMateriality: number;
}

export interface TerminalDeps {
  store: IntelStore;
  /** Unified positions. `marks` (from the live ctxs) spares a second metaAndAssetCtxs fetch. */
  exposure(marks?: Record<string, number>): Promise<PositionsResponse>;
  watched(): Promise<string[]>;
  /** Live asset contexts: the brief's "current". */
  ctxs(): Promise<AssetCtx[]>;
  /** Cold-start and ATR inputs, ascending. */
  candles1h(coin: string, from: Date, to: Date): Promise<Array<Bar & { t: number }>>;
  observations(seriesId: string, from: Date, to: Date): Promise<Point[]>;
  funding(coin: string, from: Date, to: Date): Promise<Array<{ t: number; rate: number; premium: number }>>;
  /** Last run per collector_runs `intel:<source>`. */
  ingestHealth(): Promise<IngestHealth[]>;
  llm: LlmDeps;
  thresholds: Thresholds;
  now(): Date;
  /** Runs after a brief with items is stored (thesis recheck). Best-effort: a failure never fails the brief. */
  onBrief?(brief: Brief): Promise<void>;
}

export interface BriefOptions {
  surface: BriefSurface;
  /** ui surface only: what opened it (Telegram deep link or the page). */
  via?: Review["via"];
  signal?: AbortSignal;
}

function envNum(env: Record<string, string | undefined>, key: string, def: number, min: number, max: number): number {
  const n = Number(env[key]);
  return env[key]?.trim() && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

/** INTEL_MIN_Z (2.0), INTEL_TOP_K (5), INTEL_PUSH_MATERIALITY (0.35). */
export function loadThresholds(env: Record<string, string | undefined> = process.env): Thresholds {
  return {
    minZ: envNum(env, "INTEL_MIN_Z", 2, 0, 10),
    topK: Math.round(envNum(env, "INTEL_TOP_K", 5, 1, 20)),
    pushMateriality: envNum(env, "INTEL_PUSH_MATERIALITY", 0.35, 0, 10),
  };
}

export function toCatalyst(e: IntelEvent, focus: Set<string>): Catalyst {
  return {
    eventId: e.id,
    title: e.title,
    type: e.type,
    assets: e.assets,
    scheduledAt: e.scheduledAt!,
    origin: e.origin,
    catalyst: e.catalyst,
    tag: e.tag,
    sources: e.sources,
    exposed: e.assets.filter((a) => focus.has(a)),
  };
}

async function baselineFor(deps: TerminalDeps, surface: BriefSurface, now: Date): Promise<Date> {
  const prev = surface === "ui" ? (await deps.store.lastReview())?.ts : (await deps.store.latestBrief("cron"))?.createdAt;
  return prev ? new Date(prev) : new Date(now.getTime() - FALLBACK_BASELINE_MS);
}

const points = (rows: SnapshotRow[], pick: (r: SnapshotRow) => number | null): Point[] =>
  rows.flatMap((r) => {
    const v = pick(r);
    return v == null ? [] : [{ t: Date.parse(r.ts), v }];
  });

/** One asset's diff input, or null without a baseline snapshot. Loader failures only drop the cold start / ATR. */
async function assetInput(
  deps: TerminalDeps,
  ctx: AssetCtx,
  positions: PositionsResponse["positions"],
  baselineTs: Date,
  now: Date,
): Promise<AssetDiffInput | null> {
  const asset = ctx.name;
  const from = new Date(now.getTime() - WINDOW_MS);
  const [baseline, history] = await Promise.all([deps.store.nearestSnapshot(asset, baselineTs), deps.store.snapshotRange(asset, from, now)]);
  if (!baseline) return null;
  const last = history.at(-1);
  const book = last && now.getTime() - Date.parse(last.ts) <= BOOK_FRESH_MS ? last : null;
  const live = snapshotRow(ctx, now);
  if (!live) return null;
  const current: SnapshotRow = book
    ? { ...live, depthBid1: book.depthBid1, depthAsk1: book.depthAsk1, depthBid2: book.depthBid2, depthAsk2: book.depthAsk2, spreadBps: book.spreadBps }
    : live;

  const t = now.getTime();
  const cold = (m: SnapshotMetric, pick: (r: SnapshotRow) => number | null) => !hasSamples(m, points(history, pick), t);
  const needPrice = cold("price", (r) => r.price);
  const needOi = cold("oi_usd", (r) => r.oiUsd);
  const needFunding = cold("funding", (r) => r.funding) || cold("premium", (r) => r.premium);
  const hasStop = positions.some((p) => p.stopPx != null);
  const safe = <T>(p: Promise<T>, empty: T) => p.catch(() => empty);

  const [candles, oi, funding] = await Promise.all([
    needPrice || hasStop ? safe(deps.candles1h(asset, needPrice ? from : new Date(t - ATR_LOOKBACK_MS), now), []) : Promise.resolve([]),
    needOi ? safe(deps.observations(`hl.oi.${asset}`, from, now), []) : Promise.resolve([]),
    needFunding ? safe(deps.funding(asset, from, now), []) : Promise.resolve([]),
  ]);
  const coldStart: AssetDiffInput["coldStart"] = {};
  if (needPrice && candles.length) coldStart.price = candles.map((c) => ({ t: c.t, v: c.c }));
  if (needOi && oi.length) coldStart.oi_usd = oi;
  if (needFunding) {
    if (funding.length) {
      coldStart.funding = funding.map((f) => ({ t: f.t, v: f.rate }));
      coldStart.premium = funding.map((f) => ({ t: f.t, v: f.premium }));
    } else {
      const [fo, po] = await Promise.all([
        safe(deps.observations(`hl.funding.${asset}`, from, now), []),
        safe(deps.observations(`hl.premium.${asset}`, from, now), []),
      ]);
      if (fo.length) coldStart.funding = fo;
      if (po.length) coldStart.premium = po;
    }
  }
  return { asset, current, baseline, history, coldStart, candles1h: candles, positions };
}

const NarrationSchema = z.object({ lines: z.array(z.unknown()).min(1).max(8) });
const narrationJsonSchema = {
  type: "object" as const,
  properties: { lines: { ...claimsJsonSchema, minItems: 1, maxItems: MAX_LINES } },
  required: ["lines"],
  additionalProperties: false,
};

const SYSTEM = `You narrate, for one trader, what changed in the market since they last looked. Code has already measured and ranked the changes; you only explain them.

Write 3 to 5 short lines, most important first. Each line is one object:
- A fact read from the data: {"tag": "observed", "text", "source": {"label", "url"}, "ts"}. For a snapshot change use source {"label": "snapshot", "url": "/markets/<COIN>"} and that change's ts. For an alert or catalyst, restate it with its own first source and its createdAt / scheduledAt as ts.
- Anything interpretive (why it matters, what it could mean for the position): {"tag": "hypothesis", "text"}.

Rules: use only the numbers given and do not invent any. Name the position side for held assets ("Long SOL: ..."). Never predict direction, never give price targets, never tell the trader to buy, sell, close or size anything.`;

const sig = (n: number) => Number(n.toPrecision(6));
const r2 = (n: number) => Math.round(n * 100) / 100;

function narrationInput(since: Date, now: Date, items: DiffItem[], alerts: Alert[], catalysts: Catalyst[], exposure: PositionsResponse): string {
  const assets = new Set([...items.map((i) => i.asset), ...alerts.map((a) => a.asset), ...catalysts.flatMap((c) => c.exposed)]);
  return JSON.stringify({
    since: since.toISOString(),
    now: now.toISOString(),
    positions: exposure.positions
      .filter((p) => assets.has(p.asset))
      .map((p) => ({ asset: p.asset, side: p.side, notionalUsd: Math.round(p.notionalUsd), stopPx: p.stopPx, source: p.source })),
    changes: items.map((i) => ({
      asset: i.asset,
      metric: i.metric,
      held: i.held,
      from: sig(i.from),
      to: sig(i.to),
      delta: r2(i.delta),
      deltaUnit: i.deltaUnit,
      z: r2(i.z),
      materiality: r2(i.materiality),
      ...(i.stopDistPct != null ? { stopDistPct: r2(i.stopDistPct) } : {}),
      ...(i.stopDistAtr != null ? { stopDistAtr: r2(i.stopDistAtr) } : {}),
      ts: i.ts,
    })),
    alerts: alerts.map((a) => ({ asset: a.asset, title: a.title, line: a.line.text, sources: a.sources, createdAt: a.createdAt })),
    catalysts: catalysts.map((c) => ({ title: c.title, scheduledAt: c.scheduledAt, exposed: c.exposed, sources: c.sources })),
  });
}

async function narrate(
  deps: TerminalDeps,
  input: string,
  signal?: AbortSignal,
): Promise<{ lines: Claim[]; trace: LlmTrace }> {
  const r = await completeStructured({
    tier: "strong",
    system: SYSTEM,
    user: input,
    schema: NarrationSchema,
    jsonSchema: narrationJsonSchema,
    promptVersion: BRIEF_PROMPT_VERSION,
    cacheKey: `brief:${createHash("sha256").update(input).digest("hex")}`,
    signal,
    deps: deps.llm,
  });
  if (!r.ok) return { lines: [], trace: { ...r.trace, error: r.error } };
  const { claims, dropped } = validateClaims(r.value.lines);
  return { lines: claims.slice(0, MAX_LINES), trace: { ...r.trace, cached: r.cached, dropped } };
}

export async function buildBrief(deps: TerminalDeps, o: BriefOptions): Promise<Brief> {
  const now = deps.now();
  const since = await baselineFor(deps, o.surface, now);
  const ctxs = await deps.ctxs();
  const marks = Object.fromEntries(ctxs.map((c) => [c.name, c.markPx]));
  const empty: PositionsResponse = { positions: [], sources: [], totalNotionalUsd: 0 };
  const [exposure, watched, ingest] = await Promise.all([
    deps.exposure(marks).catch(() => empty),
    deps.watched().catch(() => [] as string[]),
    deps.ingestHealth().catch(() => [] as IngestHealth[]),
  ]);
  const focus = new Set([...exposure.positions.map((p) => p.asset), ...watched]);
  const byName = new Map(ctxs.filter((c) => !c.isDelisted).map((c) => [c.name, c]));

  const inputs = await Promise.all(
    [...focus].flatMap((asset) => {
      const ctx = byName.get(asset);
      return ctx ? [assetInput(deps, ctx, exposure.positions.filter((p) => p.asset === asset), since, now)] : [];
    }),
  );
  const { items: all, diffed } = buildDiffItems(
    inputs.filter((i): i is AssetDiffInput => i != null),
    exposure.totalNotionalUsd,
  );
  const items = rankDiffs(all, deps.thresholds);

  const [batched, scheduled] = await Promise.all([
    deps.store.listAlerts({ since, route: "batch", limit: 100 }),
    deps.store.listCatalysts(now, new Date(now.getTime() + CATALYST_AHEAD_MS)),
  ]);
  const alerts = batched.filter((a) => focus.has(a.asset));
  const catalysts = scheduled.map((e) => toCatalyst(e, focus)).filter((c) => c.exposed.length > 0);
  const silent = items.length === 0 && alerts.length === 0;

  const narration = silent ? null : await narrate(deps, narrationInput(since, now, items, alerts, catalysts, exposure), o.signal);
  const brief = await deps.store.insertBrief({
    surface: o.surface,
    since: since.toISOString(),
    items,
    alerts,
    catalysts,
    lines: narration?.lines ?? [],
    silent,
    threshold: { minZ: deps.thresholds.minZ, pushMateriality: deps.thresholds.pushMateriality },
    ingest,
    diffedCount: diffed,
    ...(narration ? { trace: narration.trace } : {}),
  });
  if (o.surface === "ui") await deps.store.logReview({ via: o.via ?? "ui", briefId: brief.id });
  if (deps.onBrief && brief.items.length) {
    try {
      await deps.onBrief(brief);
    } catch (e) {
      console.warn("[intel] brief hook failed:", e instanceof Error ? e.message : e);
    }
  }
  return brief;
}

const fmt = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

/** Code-written fallback line for a diff item, used in Telegram when narration failed. */
export function itemLine(i: DiffItem): string {
  const unit = i.deltaUnit === "pct" ? "%" : i.deltaUnit === "bps" ? " bps" : "";
  return `${i.held ? "held" : "watched"} ${i.asset} ${i.metric} ${fmt(i.delta)}${unit} (z ${fmt(i.z)})`;
}

export interface IntelBriefRun {
  ok: boolean;
  briefId?: string;
  silent?: boolean;
  items?: number;
  alerts?: number;
  /** Channels the Telegram/Discord/webhook message reached. */
  sent?: string[];
  narrationError?: string;
  error?: string;
}

/**
 * Cron brief (POST /api/cron/intel/brief): builds the cron-surface brief and,
 * when anything cleared, pushes "N things changed that touch your positions"
 * with the top lines and a /?review=1 link. Never marks reviewed. Never throws.
 */
export async function runIntelBrief(
  deps: TerminalDeps & { notifier: Notifier; appUrl?: string },
  o: { budgetMs: number; signal?: AbortSignal },
): Promise<IntelBriefRun> {
  const budget = AbortSignal.timeout(o.budgetMs);
  const signal = o.signal ? AbortSignal.any([o.signal, budget]) : budget;
  try {
    const brief = await buildBrief(deps, { surface: "cron", signal });
    const base = { ok: true, briefId: brief.id, silent: brief.silent, items: brief.items.length, alerts: brief.alerts.length };
    const narrationError = brief.trace?.error ? { narrationError: brief.trace.error } : {};
    if (brief.silent) return { ...base, sent: [], ...narrationError };
    const n = brief.items.length + brief.alerts.length;
    const lines: Array<Claim | string> = brief.lines.length ? brief.lines : [...brief.items.map(itemLine), ...brief.alerts.map((a) => a.line)];
    const link = deps.appUrl ? `${deps.appUrl.replace(/\/+$/, "")}/?review=1` : undefined;
    const title = n === 1 ? "1 thing changed that touches your positions" : `${n} things changed that touch your positions`;
    const sent = await sendIntel(deps.notifier, { title, lines, link });
    return { ...base, sent, ...narrationError };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Latest run per `intel:<source>` collector. */
export async function loadIngestHealth(): Promise<IngestHealth[]> {
  const rows = await db.sql()<{ collector: string; started_at: Date; ok: boolean; error: string | null }[]>`
    select distinct on (collector) collector, started_at, ok, error from collector_runs
    where collector like 'intel:%' order by collector, started_at desc
  `;
  return rows.map((r) => ({
    source: r.collector.slice("intel:".length),
    ok: r.ok,
    lastRunAt: new Date(r.started_at).toISOString(),
    ...(r.error ? { error: r.error } : {}),
  }));
}

/**
 * Production wiring. `deskAccount` is DeskService.account (injected so Intel
 * never constructs the Desk); `ctxs` lets the caller share a cached
 * metaAndAssetCtxs (routes/hl.ts getCtxs), else each call fetches.
 */
export function defaultTerminalDeps(
  o: { env?: Record<string, string | undefined>; deskAccount?: () => Promise<AccountState>; watchAddress?: string; ctxs?: () => Promise<AssetCtx[]> } = {},
): TerminalDeps {
  const env = o.env ?? process.env;
  const store = new PgIntelStore();
  const ctxs = o.ctxs ?? (async () => (await fetchPerpMetaAndCtxs()).ctxs);
  return {
    store,
    exposure: (marks) =>
      loadExposure({
        store,
        marks: async (assets) => {
          const m = marks ?? Object.fromEntries((await ctxs()).map((c) => [c.name, c.markPx]));
          return Object.fromEntries(assets.flatMap((a) => (m[a] != null ? [[a, m[a]!]] : [])));
        },
        watchAddress: o.watchAddress,
        deskAccount: o.deskAccount,
      }),
    watched: () => watchedAssets(store, env),
    ctxs,
    candles1h: async (coin, from, to) =>
      (await db.getCandlesBetween(coin, "1h", from, to)).map((c) => ({ t: new Date(c.ts).getTime(), h: c.h, l: c.l, c: c.c })),
    observations: async (id, from, to) => (await db.seriesRange(id, from, to)).map((p) => ({ t: new Date(p.ts).getTime(), v: p.value })),
    funding: async (coin, from, to) => (await db.getFunding(coin, from, to)).map((f) => ({ t: new Date(f.ts).getTime(), rate: f.rate, premium: f.premium })),
    ingestHealth: loadIngestHealth,
    llm: { makeProvider: intelProviderFactory(env), cache: store, now: () => new Date(), dailyCap: Math.round(envNum(env, "INTEL_LLM_DAILY_CAP", 200, 0, 100_000)) },
    thresholds: loadThresholds(env),
    now: () => new Date(),
  };
}
