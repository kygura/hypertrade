import { Hono } from "hono";
import { z } from "zod";
import {
  FeedQuerySchema, FeedRowSchema, LedgerStatsQuerySchema, LiqBoardQuerySchema, NoveltyQuerySchema, LiqMapHistoryQuerySchema, LiqMapQuerySchema, RejectBodySchema, SECTORS, SnoozeBodySchema,
  type Costs, type LedgerEntry, type LedgerPayload, type LiqBoardResponse, type NearMissResponse, type Opportunity, type Position, type RiskVerdictSchema, type SectorsResponse,
} from "../../shared/platform.js";
import type { Side } from "../../shared/intel.js";
import type { ResearchResult } from "../../shared/intel.js";
import { evaluateRisk, operatorRiskOrder } from "../desk/governor.js";
import { DeskService } from "../desk/service.js";
import type { OperatorOrder } from "../desk/types.js";
import { researchDailyLimit, researchDeps, runResearch, RESEARCH_PROMPT_VERSION, utcDayStart } from "../intel/research.js";
import { aggregate, coverage } from "../platform/liqmap.js";
import { getPlatformContext, placedBy, placing, type PlatformContext } from "../platform/context.js";
import { Z_KEYS } from "../platform/score.js";
import { evidenceLine, groupStats } from "../platform/stats.js";
import { defaultDeskService } from "./desk.js";
import { defaultIntelDeps } from "./intel/index.js";
import { body, failure, invalid } from "./intel/http.js";

// /api/platform (SPEC.md § Platform P2). Cookie auth; GETs also take the read bearer (READ_PATH in auth.ts).
// Every route answers 503 {error:"platform_offline"} while no PlatformContext is set (the worker loops are not running).
// Approval reaches the book only through the desk's governor: placeOperatorOrder (preview + submit under one lock).
// After approval the idea ends open (filled) or failed (system); a lost transition stays approved for reconcile.ts.

export type RiskVerdict = z.infer<typeof RiskVerdictSchema>;
/** What an opportunity asks the governor to size and place; sizing is the governor's, never ours. */
export interface Ticket { coin: string; side: Side; stopPx: number; targetPx: number | null }
export interface Placement { status: string; reasons: string[]; proposalId: string }

export interface RiskGate {
  /** Read-only: the portfolio before and the governor's verdict on adding the ticket. */
  assess(t: Ticket): Promise<{ before: RiskVerdict; after: RiskVerdict }>;
  /** Preview and submit on the desk's venue (paper or testnet). Records a blocked verdict instead of executing it. Never throws after a fill. */
  place(t: Ticket, by: string): Promise<Placement>;
}

export interface PlatformDeps {
  context(): PlatformContext | null;
  risk: RiskGate;
  research: {
    /** "capped" at the daily manual budget; null while another run is in flight. */
    run(q: { question: string; asset: string }): Promise<ResearchResult | "capped" | null>;
    get(id: string, asset: string): Promise<ResearchResult | null>;
  };
  now(): Date;
}

const OPERATOR = "operator";
const MAX_MID_AGE_SEC = 30;
const CACHE_MS = 10_000;
/** Risk the ticket is sized at, percent of equity (the governor clips it to its own limit). */
const TICKET_RISK_PCT = 0.5;

const order = (t: Ticket, maxRiskPct: number): OperatorOrder => ({
  coin: t.coin, side: t.side, stop: t.stopPx, ...(t.targetPx != null ? { target: t.targetPx } : {}), riskPct: Math.max(0.05, Math.min(TICKET_RISK_PCT, maxRiskPct)), source: "copilot",
});

export function deskRisk(get: () => DeskService): RiskGate {
  return {
    async assess(t) {
      const d = get();
      const { ctxs, marks } = await d.marks();
      const account = await d.broker.account(marks, d.now());
      const ctx = {
        limits: d.config.limits, account, now: d.now(), killSwitch: (await d.killSwitch()).on,
        market: d.broker.market ? await d.broker.market(t.coin) : DeskService.findMarket(ctxs, t.coin),
      };
      const { order: r, warnings } = operatorRiskOrder(order(t, d.config.limits.maxRiskPct), ctx);
      const v = evaluateRisk(r, ctx);
      const gross = account.positions.reduce((a, p) => a + p.notionalUsd, 0);
      return {
        before: { approved: true, reasons: [], warnings: [], equityUsd: account.equityUsd, positions: account.positions.length, grossLeverage: account.equityUsd > 0 ? gross / account.equityUsd : null },
        after: { ...v, warnings: [...warnings, ...v.warnings] },
      };
    },
    async place(t, by) {
      const d = get();
      const rec = await d.placeOperatorOrder(order(t, d.config.limits.maxRiskPct), by);
      return { status: rec.status, reasons: rec.verdict.reasons, proposalId: rec.id };
    },
  };
}

export function defaultPlatformDeps(): PlatformDeps {
  return {
    context: getPlatformContext,
    risk: deskRisk(defaultDeskService),
    research: {
      async run(q) {
        const d = defaultIntelDeps();
        if ((await d.store.researchCountSince(utcDayStart(d.now()), "manual")) >= researchDailyLimit(d.env ?? process.env)) return "capped";
        return runResearch(researchDeps(d), { question: q.question, asset: q.asset, trigger: "manual" });
      },
      async get(id, asset) {
        return (await defaultIntelDeps().store.listResearch({ asset, limit: 50 })).find((r) => r.id === id) ?? null;
      },
    },
    now: () => new Date(),
  };
}

const IdSchema = z.string().uuid();
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const seenAge = (iso: string, now: Date) => Math.max(0, (now.getTime() - Date.parse(iso)) / 1000);
// score.ts keeps its Z_KEYS private; the name pattern stands in until it exports Z_FEATURE_KEYS.
/** z-feature → the raw input it standardises (features.ts); z-features without one show no value. */
const RAW_OF: Partial<Record<(typeof Z_KEYS)[number], string>> = { ret15mZ: "ret15mPct", oiChg1hZ: "oiChg1hPct", fundingZ24h: "fundingApr" };
const BOARD_BUCKET_BPS = 25;
const BOARD_RANGE = 0.2;

export function createPlatformRoutes(deps: PlatformDeps) {
  const cache = new Map<string, { at: number; value: unknown }>();
  const cached = async <T>(key: string, make: () => Promise<T>): Promise<T> => {
    const now = deps.now().getTime();
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return hit.value as T;
    const value = await make();
    cache.set(key, { at: now, value });
    return value;
  };

  /** Mark and OI from the live mid and the latest scan snapshot of the coin. */
  const marketFor = async (ctx: PlatformContext, coin: string, now: Date) => {
    const snap = (await ctx.store.scanSnapshotsSince(new Date(now.getTime() - 3_600_000).toISOString())).filter((s) => s.coin === coin).at(-1);
    return { mark: ctx.mid(coin) ?? num(snap?.inputs.mark), oiUsd: num(snap?.inputs.oiUsd) };
  };

  /** liqmap.coverage owns the ratio (P0.8); this only gathers its inputs. */
  const coverageOf = (positions: Position[], oiUsd: number | null, now: Date) =>
    coverage(positions.reduce((s, p) => s + p.positionValue, 0), oiUsd ?? null, new Set(positions.map((p) => p.address)).size, positions.map((p) => seenAge(p.updatedAt, now)));

  const ticketOf = (o: Opportunity): Ticket | null => (o.stopPx == null ? null : { coin: o.coin, side: o.direction, stopPx: o.stopPx, targetPx: o.targetPx });
  const created = (entries: Awaited<ReturnType<PlatformContext["store"]["ledgerFor"]>>) => entries.find((e) => e.kind === "created");
  /** What the operator saw when deciding (P0.12). */
  const seenOf = (o: Opportunity, e: ReturnType<typeof created>): LedgerPayload<"decision">["seen"] => ({
    score: o.score, scoreVersion: o.scoreVersion, features: e?.payload.features ?? { features: {}, inputs: {} },
    stopPx: o.stopPx, targetPx: o.targetPx, invalidationPx: o.invalidationPx, regime: o.regime, liquidityTier: o.liquidityTier, costs: o.costs as Costs | null,
  });
  const decision = (o: Opportunity, e: ReturnType<typeof created>, d: "approve" | "reject", reason: string | null): LedgerPayload<"decision"> => ({ decision: d, reason, operator: OPERATOR, seen: seenOf(o, e) });

  const app = new Hono<{ Variables: { ctx: PlatformContext } }>()
    .onError((err, c) => failure(c, err, "platform", "platform error"))
    .use("*", async (c, next) => {
      const ctx = deps.context();
      if (!ctx) return c.json({ error: "platform_offline" }, 503);
      c.set("ctx", ctx);
      await next();
    });

  /** The opportunity named by :id, or the 400/404 response. */
  const load = async (c: { req: { param(n: string): string }; var: { ctx: PlatformContext }; json: (b: unknown, s: 400 | 404) => Response }) => {
    const id = IdSchema.safeParse(c.req.param("id"));
    if (!id.success) return { res: c.json({ error: "invalid id", field: "id" }, 400) };
    const opp = await c.var.ctx.store.getOpportunity(id.data);
    return opp ? { opp } : { res: c.json({ error: "opportunity not found" }, 404) };
  };

  return app
    .get("/opportunities", async (c) => {
      const q = FeedQuerySchema.safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error, "query");
      const ctx = c.var.ctx;
      const rows = await ctx.store.listOpportunities({ statuses: q.data.status, tier: q.data.tier, limit: q.data.limit });
      const last = ctx.lastScanAt();
      return c.json({
        opportunities: rows.map((r) => FeedRowSchema.parse(r)),
        scanAgeSec: last ? seenAge(last.toISOString(), deps.now()) : null,
        readyTtlMin: Number(process.env.PLATFORM_READY_TTL_MIN) || 60,
      });
    })
    .get("/opportunities/:id", async (c) => {
      const { opp, res } = await load(c);
      if (!opp) return res;
      const store = c.var.ctx.store;
      const entries = await store.ledgerFor(opp.id);
      const fv = created(entries)?.payload.features ?? { features: {}, inputs: {} };
      const signals = Object.entries(fv.features).map(([name, value]) => {
        if (!(Z_KEYS as readonly string[]).includes(name)) return { name, value, z: null };
        const raw = RAW_OF[name as (typeof Z_KEYS)[number]];
        return { name, value: raw ? num(fv.inputs[raw]) : null, z: value };
      });
      const groups = groupStats(await store.outcomeRows({ setupKind: opp.setupKind }));
      const stats = [...groups].sort((a, b) => b.n - a.n)[0] ?? null;
      const ticket = ticketOf(opp);
      let risk: { before: RiskVerdict; after: RiskVerdict } | null = null;
      if (ticket) risk = await deps.risk.assess(ticket).catch((err) => (console.error("[platform] risk preview failed", err), null));
      const rid = entries.filter((e): e is Extract<LedgerEntry, { kind: "research" }> => e.kind === "research").at(-1)?.payload.researchId;
      const research = rid ? await deps.research.get(rid, opp.coin).catch(() => null) : null;
      const size = risk?.after.sizing;
      return c.json({
        opportunity: opp,
        signals,
        bearCase: research && (research.status === "found" || research.status === "no_cause") ? research.explanation : null,
        stats,
        evidence: evidenceLine(groups.find((g) => g.horizon === "24h") ?? null, opp.edgeBasis),
        risk,
        ticket: { side: opp.direction, entryPx: opp.entryPx, stopPx: opp.stopPx, targetPx: opp.targetPx, sizeUsd: size?.notionalUsd && size.notionalUsd > 0 ? size.notionalUsd : null, sizeSource: "governor" as const },
      });
    })
    .post("/opportunities/:id/approve", async (c) => {
      const { opp, res } = await load(c);
      if (!opp) return res;
      const ctx = c.var.ctx;
      if (opp.status !== "ready") return c.json({ error: "illegal_transition", message: `${opp.status} → approved is not allowed` }, 409);
      // P0.15 freshness gate: nothing reaches the governor on a stale feed.
      const now = deps.now();
      const age = ctx.midAge(opp.coin, now.getTime());
      const scan = ctx.lastScanAt();
      const stale =
        age == null ? `no live mid for ${opp.coin}`
        : age > MAX_MID_AGE_SEC ? `${opp.coin} mid is ${Math.round(age)} s old (limit ${MAX_MID_AGE_SEC} s)`
        : !scan || now.getTime() - scan.getTime() > 2 * ctx.scanIntervalSec * 1000 ? "the last scan is older than twice the scan interval"
        : null;
      if (stale) return c.json({ error: "stale_feed", message: stale }, 409);

      const ticket = ticketOf(opp);
      if (!ticket) return c.json({ error: "governor_blocked", reasons: ["opportunity has no stop level"] }, 422);
      const { after } = await deps.risk.assess(ticket);
      if (!after.approved) return c.json({ error: "governor_blocked", reasons: after.reasons }, 422);

      const entry = created(await ctx.store.ledgerFor(opp.id));
      // Illegal or raced transitions throw or return null: 409, nothing placed.
      const approved = await ctx.store.transitionOpportunity(opp.id, "ready", "approved", "operator", decision(opp, entry, "approve", null)).catch(() => null);
      if (!approved) return c.json({ error: "illegal_transition", message: "opportunity is no longer ready" }, 409);

      // placeOperatorOrder never throws after a fill, so a throw here means nothing was placed.
      // The opportunity id rides on the desk proposal (decidedBy), so reconcile.ts can find it without a ref.
      // In flight until the projection has moved, so reconcile never races this request.
      placing.add(opp.id);
      try {
        const placed = await deps.risk.place(ticket, placedBy(opp.id)).catch((err) => ({ status: "failed", reasons: [err instanceof Error ? err.message : String(err)], proposalId: "" }));
        const ref = placed.proposalId || null;
        if (placed.status !== "executed") {
          const reason = `placement ${placed.status}: ${placed.reasons.join("; ") || "no detail"}`.slice(0, 2000);
          const failed = await ctx.store.transitionOpportunity(opp.id, "approved", "failed", "system", undefined, { ref, reason }).catch((err) => (console.error("[platform] approved → failed not recorded", opp.id, err), null));
          if (!failed) console.error("[platform] approved → failed lost; reconcile will settle", opp.id);
          return c.json({ error: placed.status === "blocked" ? "governor_blocked" : "placement_failed", reasons: placed.reasons }, placed.status === "blocked" ? 422 : 502);
        }
        const open = await ctx.store.transitionOpportunity(opp.id, "approved", "open", "system", undefined, { ref }).catch((err) => (console.error("[platform] approved → open failed", opp.id, err), null));
        if (!open) {
          // The fill happened; the row stays approved and reconcile.ts moves it to open from the desk proposal.
          console.error("[platform] approved → open lost after a fill; reconcile will settle", opp.id, ref);
          return c.json({ error: "transition_lost", proposalId: ref }, 500);
        }
        return c.json({ opportunity: open, proposalId: placed.proposalId });
      } finally {
        placing.delete(opp.id);
      }
    })
    .post("/opportunities/:id/reject", async (c) => {
      const { opp, res } = await load(c);
      if (!opp) return res;
      const b = RejectBodySchema.safeParse(await body(c));
      if (!b.success) return invalid(c, b.error, "reject body");
      const ctx = c.var.ctx;
      const illegal = () => c.json({ error: "illegal_transition", message: `${opp.status} → rejected is not allowed` }, 409);
      if (opp.status !== "ready") return illegal();
      const entry = created(await ctx.store.ledgerFor(opp.id));
      const rejected = await ctx.store.transitionOpportunity(opp.id, "ready", "rejected", "operator", decision(opp, entry, "reject", b.data.reason)).catch(() => null);
      return rejected ? c.json({ opportunity: rejected }) : illegal();
    })
    .post("/opportunities/:id/snooze", async (c) => {
      const { opp, res } = await load(c);
      if (!opp) return res;
      const b = SnoozeBodySchema.safeParse(await body(c));
      if (!b.success) return invalid(c, b.error, "snooze body");
      const snoozed = await c.var.ctx.store.snoozeOpportunity(opp.id, new Date(deps.now().getTime() + b.data.minutes * 60_000).toISOString());
      return snoozed ? c.json({ opportunity: snoozed }) : c.json({ error: "opportunity not found" }, 404);
    })
    .post("/opportunities/:id/research", async (c) => {
      const { opp, res } = await load(c);
      if (!opp) return res;
      const store = c.var.ctx.store;
      const r = await deps.research.run({ asset: opp.coin, question: `What public information argues against a ${opp.direction} in ${opp.coin} right now (${opp.setupKind} setup)? Invalidation: ${opp.invalidation}` });
      if (r === "capped") return c.json({ error: "daily research limit reached" }, 429);
      if (!r) return c.json({ error: "a research run is already in flight" }, 409);
      let current = opp;
      if (r.status === "found" || r.status === "no_cause") {
        if (r.model) {
          await store.appendLedger({
            opportunityId: opp.id, kind: "research",
            payload: { researchId: r.id, model: r.model, promptVersion: RESEARCH_PROMPT_VERSION, sources: [...new Set(r.evidence.flatMap((e) => (e.url ? [e.url] : [])))] },
          });
        }
        // new → investigating is the only legal entry (P0.11); any other status keeps its place.
        if (opp.status === "new") current = (await store.transitionOpportunity(opp.id, "new", "investigating", "system").catch(() => null)) ?? opp;
      }
      return c.json({ opportunity: current, research: r });
    })
    .get("/liqmap", async (c) => {
      const q = LiqMapQuerySchema.safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error, "query");
      const { coin, range, bucketBps } = q.data;
      const ctx = c.var.ctx;
      const out = await cached(`liqmap|${coin}|${range}|${bucketBps}`, async () => {
        const now = deps.now();
        const { mark, oiUsd } = await marketFor(ctx, coin, now);
        if (mark == null || !(mark > 0)) return null;
        const positions = await ctx.store.listPositions(coin);
        const { buckets, nearestClusters } = aggregate(positions, { mark, bucketBps, rangePct: range });
        return { coin, ts: now.toISOString(), mark, bucketBps, buckets, nearestClusters, coverage: coverageOf(positions, oiUsd, now) };
      });
      return out ? c.json(out) : c.json({ error: "no_mark", message: `no mark price for ${coin} yet` }, 503);
    })
    .get("/liqmap/board", async (c) => {
      const q = LiqBoardQuerySchema.safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error, "query");
      const limit = q.data.limit ?? (Number(process.env.PLATFORM_LIQMAP_COINS) || 30);
      const ctx = c.var.ctx;
      return c.json(await cached(`board|${limit}`, async (): Promise<LiqBoardResponse> => {
        const now = deps.now();
        // Latest scan inputs per coin (mark, OI); before the first snapshot, the coins the crawler holds positions in.
        const snaps = new Map<string, Record<string, unknown>>();
        for (const s of await ctx.store.scanSnapshotsSince(new Date(now.getTime() - 3_600_000).toISOString())) snaps.set(s.coin, s.inputs);
        const byCoin = new Map<string, Position[]>();
        for (const p of await ctx.store.listPositions()) byCoin.set(p.coin, [...(byCoin.get(p.coin) ?? []), p]);
        const oi = (coin: string) => num(snaps.get(coin)?.oiUsd);
        const tracked = (coin: string) => (byCoin.get(coin) ?? []).reduce((a, p) => a + p.positionValue, 0);
        const coins = snaps.size
          ? [...snaps.keys()].sort((a, b) => (oi(b) ?? 0) - (oi(a) ?? 0))
          : [...byCoin.keys()].sort((a, b) => tracked(b) - tracked(a));
        const rows: LiqBoardResponse["rows"] = [];
        for (const coin of coins.slice(0, limit)) {
          const mark = ctx.mid(coin) ?? num(snaps.get(coin)?.mark);
          if (mark == null || !(mark > 0)) continue;
          const positions = byCoin.get(coin) ?? [];
          const { nearestClusters } = aggregate(positions, { mark, bucketBps: BOARD_BUCKET_BPS, rangePct: BOARD_RANGE });
          rows.push({ coin, mark, nearestLong: nearestClusters.long, nearestShort: nearestClusters.short, coverage: coverageOf(positions, oi(coin), now) });
        }
        const near = (r: LiqBoardResponse["rows"][number]) => Math.min(r.nearestLong?.distancePct ?? Infinity, r.nearestShort?.distancePct ?? Infinity);
        rows.sort((a, b) => near(a) - near(b) || a.coin.localeCompare(b.coin));
        return { rows, asOf: now.toISOString() };
      }));
    })
    .get("/liqmap/history", async (c) => {
      const q = LiqMapHistoryQuerySchema.safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error, "query");
      const snaps = await c.var.ctx.store.liqmapHistory(q.data.coin, new Date(deps.now().getTime() - q.data.hours * 3_600_000).toISOString());
      return c.json({ coin: q.data.coin, bucketBps: snaps.at(-1)?.bucketBps ?? 25, snapshots: snaps.map(({ ts, mark, buckets }) => ({ ts, mark, buckets })) });
    })
    .get("/novelty", async (c) => {
      const q = NoveltyQuerySchema.safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error, "query");
      const entries = await c.var.ctx.store.listNovelty(new Date(deps.now().getTime() - q.data.days * 86_400_000).toISOString().slice(0, 10));
      return c.json({ entries: entries.filter((e) => !q.data.coin || e.coin === q.data.coin).reverse() });
    })
    .get("/near-miss", (c) => { const all = c.var.ctx.nearMisses(); return c.json({ top: all[0] ?? null, all } satisfies NearMissResponse); })
    .get("/sectors", async (c) => c.json({ vocabulary: [...SECTORS], tags: await c.var.ctx.store.listSectors() } satisfies SectorsResponse))
    .get("/ledger/stats", async (c) => {
      const q = LedgerStatsQuerySchema.safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error, "query");
      const rows = await c.var.ctx.store.outcomeRows(q.data);
      return c.json({ stats: groupStats(rows, { regime: q.data.regime !== undefined, tier: q.data.tier !== undefined }) });
    })
    .get("/ledger/:id", async (c) => {
      const { opp, res } = await load(c);
      if (!opp) return res;
      return c.json({ opportunityId: opp.id, entries: await c.var.ctx.store.ledgerFor(opp.id) });
    });
}
