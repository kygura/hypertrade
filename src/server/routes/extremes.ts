import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { ExtremeCalibrationResultSchema, ExtremeVerdictSchema, type ExtremeRecord } from "../../shared/extremes.js";
import type { Opportunity } from "../../shared/platform.js";
import { requireCronToken } from "../auth.js";
import * as db from "../db.js";
import { createNotifier, type Alert } from "../desk/notify.js";
import { appliedThresholds, thresholdsOfRun } from "../extremes/calibrate.js";
import { DEFAULT_EXTREME_THRESHOLDS, EXTREME_LOOKBACK_MS, detectExtremes } from "../extremes/detect.js";
import { gradedExtremes } from "../extremes/grade.js";
import { runExtremesJob, type ExtremesJobDeps } from "../extremes/job.js";
import { openExtremeOpportunity } from "../extremes/opportunity.js";
import { clearsMinRr, convictionOfRr, extremesMinRr, priceExtreme, PRICING_LOOKBACK_MS, type ExtremePricing } from "../extremes/pricing.js";
import { createWaker } from "../extremes/wake.js";
import { bus } from "../platform/bus.js";
import { dbPlatformContext, getPlatformContext, MAX_MID_AGE_SEC, type PlatformContext } from "../platform/context.js";
import { extremesReadyTtlMin } from "../platform/opportunity.js";
import type { PlatformStore } from "../platform/store.js";
import { PgPlatformStore } from "../platform/store-pg.js";
import { capped, type LabLease } from "./cron.js";
import { body, failure, invalid } from "./intel/http.js";
import { fetchCandles } from "../../shared/hl-client.js";
import type { Candle } from "../../shared/types.js";

// Extremes (docs/EXTREMES.md):
//   POST /api/cron/extremes       every 15 min (db/cron/schedule.sql), cron token: the job (extremes/job.ts) under its own
//                                 lease (sync_state '_extremes'/'job'); 503 without a database, 200 {skipped} when leased.
//   GET  /api/extremes?days=7     stored events with delivery, verdict and grade (extremes/grade.ts), newest first, plus
//                                 a summary by stance and by kind (cookie, or the read bearer).
//   GET  /api/extremes/calibration  the thresholds the job applies (latest applied calibration, else the code defaults),
//                                 the code defaults and the last 10 calibration runs (extremes/calibrate.ts; same auth).
//   POST /api/extremes/verdict    the research session's answer (cookie or the LAB_API_TOKEN bearer, auth.ts). Parsed
//                                 with ExtremeVerdictSchema; 404 unknown key, 409 already answered. Every stance stamps
//                                 the live mark when fresh (verdictMark). `take` needs it (503 without, 422 when killPx is
//                                 on the wrong side), is priced on 1h candles (extremes/pricing.ts: stop, target, R:R,
//                                 conviction), becomes a ready platform opportunity (extremes/opportunity.ts; approved
//                                 only with the operator's cookie on /api/platform) and pushes once. A priced take under
//                                 EXTREMES_MIN_RR (default 2, at one decimal) opens nothing and the push says why; an
//                                 unpriced one (no candles, no template) opens as before, with no target.

/** Answer by now with what ran: the job is a few store reads, at most one wake (10 s timeout) and three pushes. */
const EXTREMES_HARD_STOP_MS = 120_000;
const EXTREMES_LEASE_MS = EXTREMES_HARD_STOP_MS + 60_000;

export interface CronExtremesDeps {
  hasDb: () => boolean;
  lease: LabLease;
  job: () => ExtremesJobDeps;
  hardStopMs?: number;
}

const extremesLease: LabLease = {
  acquire: (holder, ttlMs) => db.acquireLease("_extremes", "job", holder, ttlMs),
  release: (holder) => db.releaseLease("_extremes", "job", holder),
};

let pgStore: PgPlatformStore | null = null;
const store = () => (pgStore ??= new PgPlatformStore());

const defaultCronDeps = (): CronExtremesDeps => ({
  hasDb: () => !!db.databaseUrl(),
  lease: extremesLease,
  job: () => ({
    store: store(),
    detect: detectExtremes,
    thresholds: () => appliedThresholds(store()),
    lookbackMs: EXTREME_LOOKBACK_MS,
    wake: createWaker().wake,
    notifier: createNotifier(),
    appUrl: process.env.APP_URL ?? null,
    now: Date.now,
  }),
});

/** One leased, hard-stopped job run. Never throws: 503 without a database, 200 `skipped` when leased, 500 on an error or hard stop. */
export async function runLeasedJob(o: { tag: string; hasDb: () => boolean; lease: LabLease; leaseMs: number; hardStopMs: number; job: () => Promise<Record<string, unknown>> }): Promise<{ status: 200 | 500 | 503; body: Record<string, unknown> }> {
  if (!o.hasDb()) return { status: 503, body: { ok: false, error: "no database: DATABASE_URL is not set" } };
  const holder = randomUUID();
  try {
    if (!(await o.lease.acquire(holder, o.leaseMs))) return { status: 200, body: { ok: true, skipped: "leased" } };
  } catch (err) {
    return { status: 500, body: { ok: false, error: `lease: ${err instanceof Error ? err.message : String(err)}` } };
  }
  const work = (async (): Promise<Record<string, unknown>> => {
    try {
      return { ok: true, ...(await o.job()) };
    } finally {
      await o.lease.release(holder).catch((err) => console.error(`[${o.tag}] lease release:`, err));
    }
  })().catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  const done = await capped<Record<string, unknown> | null>(work, o.hardStopMs, null);
  if (done) return { status: done.ok ? 200 : 500, body: done };
  console.error(`[${o.tag}] hard stop after ${Math.round(o.hardStopMs / 1000)}s`);
  return { status: 500, body: { ok: false, timedOut: true, error: `still running after ${Math.round(o.hardStopMs / 1000)}s` } };
}

export const runExtremesCron = (deps: CronExtremesDeps) =>
  runLeasedJob({ tag: "extremes", hasDb: deps.hasDb, lease: deps.lease, leaseMs: EXTREMES_LEASE_MS, hardStopMs: deps.hardStopMs ?? EXTREMES_HARD_STOP_MS, job: async () => ({ ...(await runExtremesJob(deps.job())) }) });

export function cronExtremesRoutes(deps: () => CronExtremesDeps = defaultCronDeps) {
  return new Hono().post("/extremes", requireCronToken, async (c) => {
    const { status, body } = await runExtremesCron(deps());
    return c.json(body, status);
  });
}

// ---------------------------------------------------------------- read and verdict

type ExtremesRouteStore = Pick<
  PlatformStore,
  | "listExtremes" | "latestExtreme" | "setExtremeVerdict" | "setExtremeOpportunity" | "scanSnapshotsSince" | "listOpportunities" | "upsertOpportunity" | "transitionOpportunity"
  | "latestAppliedExtremeCalibration" | "listExtremeCalibrations"
>;

export interface ExtremesRouteDeps {
  store: () => ExtremesRouteStore | null;
  /** The live mark, or null when no fresh price is available. */
  mark: (coin: string) => Promise<number | null>;
  notifier: () => { send(a: Alert): Promise<string[]> };
  appUrl: () => string | null;
  now: () => Date;
  /** 1h candles for pricing a take, current bar last (default: Hyperliquid's, the last 80 h). Absent: takes open unpriced. */
  candles?: (coin: string, now: number) => Promise<Candle[]>;
  /** Every write of a take's opportunity (default: the process bus, which only the always-on server subscribes to). */
  publish?: (o: Opportunity, change: "created" | "status") => void;
  env?: Record<string, string | undefined>;
}

let dbCtx: PlatformContext | null = null;
/** The mark the approval freshness gate reads: the worker's WS mid, or Hyperliquid's allMids fetched on demand (context.ts). Null past MAX_MID_AGE_SEC. */
export async function freshMid(ctx: PlatformContext, coin: string, now: number): Promise<number | null> {
  await ctx.refreshMids?.(now);
  const age = ctx.midAge(coin, now);
  const mid = ctx.mid(coin);
  return age != null && age <= MAX_MID_AGE_SEC && mid != null && mid > 0 ? mid : null;
}

const defaultExtremesDeps = (): ExtremesRouteDeps => ({
  store: () => (db.databaseUrl() ? store() : null),
  mark: (coin) => {
    const ctx = getPlatformContext() ?? (dbCtx ??= dbPlatformContext(store()));
    return freshMid(ctx, coin, Date.now());
  },
  notifier: () => createNotifier(),
  appUrl: () => process.env.APP_URL ?? null,
  now: () => new Date(),
  candles: (coin, now) => fetchCandles(coin, "1h", now - PRICING_LOOKBACK_MS, now),
  publish: (opportunity, change) => bus.publish("opportunity", { opportunity, change }),
});

const ListQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(30).default(7) }).strict();
const DAY = 86_400_000;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)) || "unknown error";

/** The pricing line of a take's push: the levels and R:R, or why there is no target or no opportunity. */
function pricingLine(v: NonNullable<ExtremeRecord["verdict"]>, p: ExtremePricing | null, floor: number, refused: boolean): string {
  if (!p) return "";
  if (!p.priced) return `\nNo target: ${p.reason}.`;
  const levels = `Stop ${p.stop}, target ${p.target} (${p.setup}), R:R ${p.rr}:1`;
  if (refused) return `\n${levels}: under the ${floor}:1 floor, so no opportunity was opened.`;
  const conviction = v.confidence ?? convictionOfRr(p.rr);
  return `\n${levels}, ${conviction} conviction${v.leverage != null ? `, ${v.leverage}x` : ""}.`;
}

/** The `take` push: one per verdict (the store writes a verdict once). Says where to approve when the take became an opportunity. */
function takeAlert(r: ExtremeRecord, appUrl: string | null, mark: number, approvable: { ttlH: number } | null = null, priced = ""): Alert {
  const v = r.verdict!;
  const base = appUrl?.trim().replace(/\/+$/, "");
  const approve = approvable ? `\nApprove or reject on the coin page; expires in ${approvable.ttlH} h.` : "";
  return {
    level: "warn",
    title: `Take: ${v.direction} ${r.event.coin}`,
    body: `${r.event.line}\n${v.cause}\nKill ${v.killPx} (mark ${mark})${priced}${approve}`,
    ...(base ? { click: `${base}/coin/${encodeURIComponent(r.event.coin)}` } : {}),
  };
}

type OpportunityReport = { id: string; status: Opportunity["status"]; created: boolean };
type PricingReport = { priced: true; setup: string; stop: number; target: number; rr: number; minRr: number } | { priced: false; reason: string };

export function extremesRoutes(deps: ExtremesRouteDeps = defaultExtremesDeps()) {
  return new Hono()
    .onError((err, c) => failure(c, err, "extremes", "extremes error"))
    .get("/", async (c) => {
      const q = ListQuerySchema.safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error, "query");
      const s = deps.store();
      if (!s) return c.json({ error: "unavailable", reason: "needs a database (DATABASE_URL unset)" }, 503);
      const now = deps.now().getTime();
      const since = new Date(now - q.data.days * DAY).toISOString();
      return c.json({ since, ...(await gradedExtremes(s, await s.listExtremes({ since, limit: 500 }), now)) });
    })
    .get("/calibration", async (c) => {
      const s = deps.store();
      if (!s) return c.json({ error: "unavailable", reason: "needs a database (DATABASE_URL unset)" }, 503);
      const applied = thresholdsOfRun(await s.latestAppliedExtremeCalibration());
      // Stored rows are parsed on the way out; one that does not parse shows result null.
      const runs = (await s.listExtremeCalibrations(10)).map((r) => {
        const result = ExtremeCalibrationResultSchema.safeParse(r.result);
        return { id: r.id, ranAt: r.ranAt, from: r.from, to: r.to, coins: r.coins.length, applied: r.applied, result: result.success ? result.data : null };
      });
      return c.json({ applied: { source: applied.source, thresholds: applied.thresholds }, defaults: DEFAULT_EXTREME_THRESHOLDS, runs });
    })
    .post("/verdict", async (c) => {
      const v = ExtremeVerdictSchema.safeParse(await body(c));
      if (!v.success) return invalid(c, v.error, "verdict");
      const s = deps.store();
      if (!s) return c.json({ error: "unavailable", reason: "needs a database (DATABASE_URL unset)" }, 503);
      const rec = await s.latestExtreme(v.data.key);
      if (!rec) return c.json({ error: "unknown key", field: "key" }, 404);
      if (rec.verdict) return c.json({ error: "already answered", verdictAt: rec.verdictAt }, 409);
      const take = v.data.stance === "take";
      // Every stance stamps the live mark when one is fresh (grading starts there); only a take needs one.
      const mark = await deps.mark(rec.event.coin).catch((err) => (console.error("[extremes] mark:", errText(err)), null));
      if (take) {
        if (mark == null) return c.json({ error: "unavailable", reason: `no fresh mark for ${rec.event.coin}` }, 503);
        const wrongSide = v.data.direction === "long" ? v.data.killPx! >= mark : v.data.killPx! <= mark;
        if (wrongSide) {
          return c.json({ error: `killPx ${v.data.killPx} is on the wrong side of the mark ${mark} for a ${v.data.direction}`, field: "killPx", mark }, 422);
        }
      }
      const nowMs = deps.now().getTime();
      let saved = await s.setExtremeVerdict(rec.event.key, rec.event.ts, v.data, new Date(nowMs).toISOString(), mark);
      if (!saved) return c.json({ error: "already answered" }, 409);
      if (!take) return c.json({ record: saved, mark, pushed: [], opportunity: null, opportunityReason: null, pricing: null });

      // Code prices the take on 1h candles; a failed read leaves it unpriced (it still opens, with no target).
      let pricing: ExtremePricing | null = null;
      if (deps.candles) {
        const bars = await deps.candles(rec.event.coin, nowMs).catch((err) => (console.error("[extremes] candles:", errText(err)), null));
        pricing = bars
          ? priceExtreme({ kind: rec.event.kind, fadeSide: rec.event.side, direction: v.data.direction!, entry: mark!, killPx: v.data.killPx!, bars })
          : { priced: false, reason: "candles unavailable" };
      }
      const minRr = extremesMinRr(deps.env);
      const refused = pricing?.priced === true && !clearsMinRr(pricing.rr, minRr);
      const pricingReport: PricingReport | null = !pricing
        ? null
        : pricing.priced
          ? { priced: true, setup: pricing.setup, stop: pricing.stop, target: pricing.target, rr: pricing.rr, minRr }
          : { priced: false, reason: pricing.reason };

      // The take as an approvable opportunity. The verdict is already stored and the push goes out whatever happens here.
      let opened: Opportunity | null = null;
      let opportunity: OpportunityReport | null = null;
      let opportunityReason: string | null = null;
      if (refused) opportunityReason = `R:R ${pricing!.priced ? pricing!.rr : "?"} is under the ${minRr} floor (EXTREMES_MIN_RR)`;
      else try {
        const o = await openExtremeOpportunity(s, saved, nowMs, deps.publish, pricing);
        opened = o.opportunity;
        opportunity = { id: o.opportunity.id, status: o.opportunity.status, created: o.created };
        if (o.opportunity.status !== "ready") opportunityReason = `opportunity is ${o.opportunity.status}, not ready`;
      } catch (err) {
        opportunityReason = `opportunity not created: ${errText(err)}`;
        console.error("[extremes] take opportunity:", errText(err));
      }
      if (opened) {
        const linked = await s.setExtremeOpportunity(rec.event.key, rec.event.ts, opened.id).catch((err) => (console.error("[extremes] opportunity link:", errText(err)), null));
        if (linked) saved = linked;
        else opportunityReason ??= "opportunity created but not linked to the record";
      }
      // Hours left before it expires (a row that was already ready has used part of its TTL).
      const left = opened?.status === "ready" ? (extremesReadyTtlMin(deps.env) - Math.max(0, nowMs - Date.parse(opened.statusChangedAt)) / 60_000) / 60 : null;
      const approvable = left != null ? { ttlH: Number(Math.max(0, left).toFixed(1)) } : null;
      const line = pricingLine(v.data, pricing, minRr, refused);
      const pushed = await deps.notifier().send(takeAlert(saved, deps.appUrl(), mark!, approvable, line)).catch((err) => (console.error("[extremes] take push:", errText(err)), [] as string[]));
      return c.json({ record: saved, mark, pushed, opportunity, opportunityReason, pricing: pricingReport });
    });
}
