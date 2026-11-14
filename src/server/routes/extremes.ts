import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { ExtremeVerdictSchema, type ExtremeRecord } from "../../shared/extremes.js";
import type { Opportunity } from "../../shared/platform.js";
import { requireCronToken } from "../auth.js";
import * as db from "../db.js";
import { createNotifier, type Alert } from "../desk/notify.js";
import { EXTREME_LOOKBACK_MS, detectExtremes } from "../extremes/detect.js";
import { gradedExtremes } from "../extremes/grade.js";
import { runExtremesJob, type ExtremesJobDeps } from "../extremes/job.js";
import { openExtremeOpportunity } from "../extremes/opportunity.js";
import { createWaker } from "../extremes/wake.js";
import { bus } from "../platform/bus.js";
import { dbPlatformContext, getPlatformContext, MAX_MID_AGE_SEC, type PlatformContext } from "../platform/context.js";
import { extremesReadyTtlMin } from "../platform/opportunity.js";
import type { PlatformStore } from "../platform/store.js";
import { PgPlatformStore } from "../platform/store-pg.js";
import type { LabLease } from "./cron.js";
import { body, failure, invalid } from "./intel/http.js";

// Extremes (docs/EXTREMES.md):
//   POST /api/cron/extremes       every 15 min (db/cron/schedule.sql), cron token: the job (extremes/job.ts) under its own
//                                 lease (sync_state '_extremes'/'job'); 503 without a database, 200 {skipped} when leased.
//   GET  /api/extremes?days=7     stored events with delivery, verdict and grade (extremes/grade.ts), newest first, plus
//                                 a summary by stance and by kind (cookie, or the read bearer).
//   POST /api/extremes/verdict    the research session's answer (cookie or the LAB_API_TOKEN bearer, auth.ts). Parsed
//                                 with ExtremeVerdictSchema; 404 unknown key, 409 already answered. Every stance stamps
//                                 the live mark when fresh (verdictMark). `take` needs it (503 without, 422 when killPx is
//                                 on the wrong side), becomes a ready platform opportunity (extremes/opportunity.ts;
//                                 approved only with the operator's cookie on /api/platform) and pushes once.

/** Answer by now with what ran: the job is a few store reads, at most one wake (10 s timeout) and three pushes. */
export const EXTREMES_HARD_STOP_MS = 120_000;
export const EXTREMES_LEASE_MS = EXTREMES_HARD_STOP_MS + 60_000;

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
    lookbackMs: EXTREME_LOOKBACK_MS,
    wake: createWaker().wake,
    notifier: createNotifier(),
    appUrl: process.env.APP_URL ?? null,
    now: Date.now,
  }),
});

/** One leased, hard-stopped job run. Never throws: 503 without a database, 200 `skipped` when leased, 500 on an error or hard stop. */
export async function runExtremesCron(deps: CronExtremesDeps): Promise<{ status: 200 | 500 | 503; body: Record<string, unknown> }> {
  if (!deps.hasDb()) return { status: 503, body: { ok: false, error: "no database: DATABASE_URL is not set" } };
  const holder = randomUUID();
  try {
    if (!(await deps.lease.acquire(holder, EXTREMES_LEASE_MS))) return { status: 200, body: { ok: true, skipped: "leased" } };
  } catch (err) {
    return { status: 500, body: { ok: false, error: `lease: ${err instanceof Error ? err.message : String(err)}` } };
  }
  const work = (async (): Promise<Record<string, unknown>> => {
    try {
      return { ok: true, ...(await runExtremesJob(deps.job())) };
    } finally {
      await deps.lease.release(holder).catch((err) => console.error("[extremes] lease release:", err));
    }
  })().catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  const hardStopMs = deps.hardStopMs ?? EXTREMES_HARD_STOP_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hardStop = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), hardStopMs)));
  const done = await Promise.race([work, hardStop]);
  clearTimeout(timer);
  if (done) return { status: done.ok ? 200 : 500, body: done };
  console.error(`[extremes] hard stop after ${Math.round(hardStopMs / 1000)}s`);
  return { status: 500, body: { ok: false, timedOut: true, error: `still running after ${Math.round(hardStopMs / 1000)}s` } };
}

export function cronExtremesRoutes(deps: () => CronExtremesDeps = defaultCronDeps) {
  return new Hono().post("/extremes", requireCronToken, async (c) => {
    const { status, body } = await runExtremesCron(deps());
    return c.json(body, status);
  });
}

// ---------------------------------------------------------------- read and verdict

export type ExtremesRouteStore = Pick<
  PlatformStore,
  "listExtremes" | "latestExtreme" | "setExtremeVerdict" | "setExtremeOpportunity" | "scanSnapshotsSince" | "listOpportunities" | "upsertOpportunity" | "transitionOpportunity"
>;

export interface ExtremesRouteDeps {
  store: () => ExtremesRouteStore | null;
  /** The live mark, or null when no fresh price is available. */
  mark: (coin: string) => Promise<number | null>;
  notifier: () => { send(a: Alert): Promise<string[]> };
  appUrl: () => string | null;
  now: () => Date;
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

export const defaultExtremesDeps = (): ExtremesRouteDeps => ({
  store: () => (db.databaseUrl() ? store() : null),
  mark: (coin) => {
    const ctx = getPlatformContext() ?? (dbCtx ??= dbPlatformContext(store()));
    return freshMid(ctx, coin, Date.now());
  },
  notifier: () => createNotifier(),
  appUrl: () => process.env.APP_URL ?? null,
  now: () => new Date(),
  publish: (opportunity, change) => bus.publish("opportunity", { opportunity, change }),
});

const ListQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(30).default(7) }).strict();
const DAY = 86_400_000;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)) || "unknown error";

/** The `take` push: one per verdict (the store writes a verdict once). Says where to approve when the take became an opportunity. */
export function takeAlert(r: ExtremeRecord, appUrl: string | null, mark: number, approvable: { ttlH: number } | null = null): Alert {
  const v = r.verdict!;
  const base = appUrl?.trim().replace(/\/+$/, "");
  const approve = approvable ? `\nApprove or reject on the coin page; expires in ${approvable.ttlH} h.` : "";
  return {
    level: "warn",
    title: `Take: ${v.direction} ${r.event.coin}`,
    body: `${r.event.line}\n${v.cause}\nKill ${v.killPx} (mark ${mark})${approve}`,
    ...(base ? { click: `${base}/coin/${encodeURIComponent(r.event.coin)}` } : {}),
  };
}

type OpportunityReport = { id: string; status: Opportunity["status"]; created: boolean };

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
      if (!take) return c.json({ record: saved, mark, pushed: [], opportunity: null, opportunityReason: null });

      // The take as an approvable opportunity. The verdict is already stored and the push goes out whatever happens here.
      let opened: Opportunity | null = null;
      let opportunity: OpportunityReport | null = null;
      let opportunityReason: string | null = null;
      try {
        const o = await openExtremeOpportunity(s, saved, nowMs, deps.publish);
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
      const pushed = await deps.notifier().send(takeAlert(saved, deps.appUrl(), mark!, approvable)).catch((err) => (console.error("[extremes] take push:", errText(err)), [] as string[]));
      return c.json({ record: saved, mark, pushed, opportunity, opportunityReason });
    });
}
