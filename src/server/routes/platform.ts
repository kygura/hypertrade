import { Hono } from "hono";
import { z } from "zod";
import {
  FeedQuerySchema, FeedRowSchema, LedgerStatsQuerySchema, LiqMapHistoryQuerySchema, LiqMapQuerySchema, RejectBodySchema, SnoozeBodySchema,
  type Costs, type LedgerEntry, type LedgerPayload, type Opportunity, type RiskVerdictSchema,
} from "../../shared/platform.js";
import type { Side } from "../../shared/intel.js";
import type { ResearchResult } from "../../shared/intel.js";
import { evaluateRisk, operatorRiskOrder } from "../desk/governor.js";
import { DeskService } from "../desk/service.js";
import type { OperatorOrder } from "../desk/types.js";
import { researchDailyLimit, researchDeps, runResearch, RESEARCH_PROMPT_VERSION, utcDayStart } from "../intel/research.js";
import { aggregate, coverage } from "../platform/liqmap.js";
import { getPlatformContext, type PlatformContext } from "../platform/context.js";
import { groupStats } from "../platform/stats.js";
import { defaultDeskService } from "./desk.js";
import { defaultIntelDeps } from "./intel/index.js";
import { body, failure, invalid } from "./intel/http.js";

// /api/platform (SPEC.md § Platform P2). Cookie auth; GETs also take the read bearer (READ_PATH in auth.ts).
// Every route answers 503 {error:"platform_offline"} while no PlatformContext is set (the worker loops are not running).
// Approval reaches the book only through the desk's governor: preview → submitOperatorOrder.

export type RiskVerdict = z.infer<typeof RiskVerdictSchema>;
/** What an opportunity asks the governor to size and place; sizing is the governor's, never ours. */
export interface Ticket { coin: string; side: Side; stopPx: number; targetPx: number | null }
export interface Placement { status: string; reasons: string[]; proposalId: string }

export interface RiskGate {
  /** Read-only: the portfolio before and the governor's verdict on adding the ticket. */
  assess(t: Ticket): Promise<{ before: RiskVerdict; after: RiskVerdict }>;
  /** Preview and submit on the desk's venue (paper or testnet). Records a blocked verdict instead of executing it. */
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
      const o = order(t, d.config.limits.maxRiskPct);
      const pv = await d.previewOperatorOrder(o);
      const rec = await d.submitOperatorOrder(o, { previewHash: pv.previewHash }, by);
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
const Z_NAME = /Z(\d+d)?$/;

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
      return c.json({ opportunities: rows.map((r) => FeedRowSchema.parse(r)), scanAgeSec: last ? seenAge(last.toISOString(), deps.now()) : null });
    })
    .get("/opportunities/:id", async (c) => {
      const { opp, res } = await load(c);
      if (!opp) return res;
      const store = c.var.ctx.store;
      const entries = await store.ledgerFor(opp.id);
      const features = created(entries)?.payload.features.features ?? {};
      const signals = Object.entries(features).map(([name, value]) => ({ name, value, z: Z_NAME.test(name) ? value : null }));
      const stats = groupStats(await store.outcomeRows({ setupKind: opp.setupKind })).sort((a, b) => b.n - a.n)[0] ?? null;
      const ticket = ticketOf(opp);
      let risk: { before: RiskVerdict; after: RiskVerdict } | null = null;
      if (ticket) risk = await deps.risk.assess(ticket).catch((err) => (console.error("[platform] risk preview failed", err), null));
      const rid = entries.filter((e): e is Extract<LedgerEntry, { kind: "research" }> => e.kind === "research").at(-1)?.payload.researchId;
      const research = rid ? await deps.research.get(rid, opp.coin).catch(() => null) : null;
      const size = risk?.after.sizing as { notionalUsd?: number } | undefined;
      return c.json({
        opportunity: opp,
        signals,
        bearCase: research && (research.status === "found" || research.status === "no_cause") ? research.explanation : null,
        stats,
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

      const placed = await deps.risk.place(ticket, OPERATOR).catch((err) => ({ status: "failed", reasons: [err instanceof Error ? err.message : String(err)], proposalId: "" }));
      if (placed.status !== "executed") {
        const reason = `placement ${placed.status}: ${placed.reasons.join("; ") || "no detail"}`.slice(0, 2000);
        await ctx.store.transitionOpportunity(opp.id, "approved", "rejected", "operator", decision(approved, entry, "reject", reason));
        return c.json({ error: placed.status === "blocked" ? "governor_blocked" : "placement_failed", reasons: placed.reasons }, placed.status === "blocked" ? 422 : 502);
      }
      const open = await ctx.store.transitionOpportunity(opp.id, "approved", "open", "system", undefined, placed.proposalId || undefined);
      return c.json({ opportunity: open ?? approved, proposalId: placed.proposalId });
    })
    .post("/opportunities/:id/reject", async (c) => {
      const { opp, res } = await load(c);
      if (!opp) return res;
      const b = RejectBodySchema.safeParse(await body(c));
      if (!b.success) return invalid(c, b.error, "reject body");
      const ctx = c.var.ctx;
      const entry = created(await ctx.store.ledgerFor(opp.id));
      const rejected = await ctx.store.transitionOpportunity(opp.id, opp.status, "rejected", "operator", decision(opp, entry, "reject", b.data.reason)).catch(() => null);
      return rejected ? c.json({ opportunity: rejected }) : c.json({ error: "illegal_transition", message: `${opp.status} → rejected is not allowed` }, 409);
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
        const { buckets } = aggregate(positions, { mark, bucketBps, rangePct: range });
        const tracked = positions.reduce((s, p) => s + p.positionValue, 0);
        return {
          coin, ts: now.toISOString(), mark, bucketBps, buckets,
          coverage: coverage(tracked, oiUsd ?? 0, new Set(positions.map((p) => p.address)).size, positions.map((p) => seenAge(p.updatedAt, now))),
        };
      });
      return out ? c.json(out) : c.json({ error: "no_mark", message: `no mark price for ${coin} yet` }, 503);
    })
    .get("/liqmap/history", async (c) => {
      const q = LiqMapHistoryQuerySchema.safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error, "query");
      const snaps = await c.var.ctx.store.liqmapHistory(q.data.coin, new Date(deps.now().getTime() - q.data.hours * 3_600_000).toISOString());
      return c.json({ coin: q.data.coin, bucketBps: snaps.at(-1)?.bucketBps ?? 25, snapshots: snaps.map(({ ts, mark, buckets }) => ({ ts, mark, buckets })) });
    })
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
