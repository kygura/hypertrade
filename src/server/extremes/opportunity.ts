import { EXTREMES_SCORE_VERSION, isExtremesOpportunity, type ExtremeRecord } from "../../shared/extremes.js";
import { LIVE_STATUSES, type LedgerPayload, type LiquidityTier, type Opportunity, type OpportunityStatus } from "../../shared/platform.js";
import { computeFeatures, liquidityTiers } from "../platform/features.js";
import { snapshotStreams } from "../platform/replaySource.js";
import { clean } from "../platform/scanner.js";
import { dedupeKey, type OpportunityInput, type PlatformStore } from "../platform/store.js";
import { latestVolumes, RANK_WINDOW_MS } from "./job.js";

// A `take` verdict as a platform Opportunity (docs/EXTREMES.md § Approve): the coin page's SETUP block can then approve
// it through the desk governor like any ready setup. Only what is known goes in: kind and direction from the event and
// the verdict, stop = invalidation = killPx, no target, entry = the live mark stamped at verdict time, score = the
// event's severity under its own scoreVersion (EXTREMES_SCORE_VERSION), no costs (no book read here). It reaches
// `ready` by the shortest legal path new -> calculated -> ready (checkTransition), actor system. A live row on the same
// dedupe key (coin|direction|kind) is returned as it is: never a second one, and never refreshed.

const HOUR = 3_600_000;
const px = (n: number) => Number(n.toPrecision(6));
/** new -> calculated -> ready: OPPORTUNITY_TRANSITIONS' shortest path without a research step. */
const NEXT: Partial<Record<OpportunityStatus, OpportunityStatus>> = { new: "calculated", calculated: "ready" };

/** What the store knows about the coin at verdict time. */
export interface ExtremeMarket {
  tier: LiquidityTier | null;
  regime: string | null;
  dayNtlVlm: number | null;
  oiUsd: number | null;
}

/** The opportunity and its `created` ledger payload for a take (pure). Throws for a record that is not a take with a stamped mark. */
export function extremeOpportunityInput(r: ExtremeRecord, m: ExtremeMarket): { input: OpportunityInput; created: LedgerPayload<"created"> } {
  const v = r.verdict;
  if (v?.stance !== "take" || !v.direction || v.killPx == null || r.verdictMark == null) throw new Error("only a take with a stamped mark becomes an opportunity");
  const e = r.event;
  const kill = v.killPx;
  const cause = v.cause.length > 400 ? `${v.cause.slice(0, 399)}…` : v.cause;
  const input: OpportunityInput = {
    coin: e.coin, direction: v.direction, setupKind: e.kind, tradeType: "directional", score: e.severity, scoreVersion: EXTREMES_SCORE_VERSION,
    tags: ["extreme", e.kind, ...(m.tier == null ? ["tier:unknown"] : [])], liquidityTier: m.tier ?? 3, regime: m.regime ?? "unknown",
    invalidation: `${v.direction === "long" ? "Below" : "Above"} ${px(kill)} (kill). ${cause}`,
    entryPx: r.verdictMark, stopPx: kill, targetPx: null, invalidationPx: kill,
  };
  const created = clean({
    features: { features: e.facts, inputs: { mark: e.mark, verdictMark: r.verdictMark, killPx: kill, eventTs: e.ts, window: e.window, source: "extremes" } },
    market: { mark: r.verdictMark, dayNtlVlm: m.dayNtlVlm, oiUsd: m.oiUsd },
    score: e.severity, scoreVersion: EXTREMES_SCORE_VERSION,
  }) as LedgerPayload<"created">;
  return { input, created };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Liquidity tier over the latest stored 24 h volumes (the job's ranking, the scanner's liquidityTiers), the coin's
 * latest OI and volume, and the regime of its last 24 h of snapshots (features.ts, as the scanner labels it).
 * Null where the store holds nothing for the coin.
 */
export async function extremeMarket(store: Pick<PlatformStore, "scanSnapshotsSince">, coin: string, now: number): Promise<ExtremeMarket> {
  const vol = latestVolumes(await store.scanSnapshotsSince(new Date(now - RANK_WINDOW_MS).toISOString()));
  const tier = vol.has(coin) ? (liquidityTiers([...vol].map(([c, x]) => ({ coin: c, dayNtlVlm: x.dayNtlVlm })))[coin] ?? null) : null;
  const latest = vol.get(coin)?.inputs ?? {};
  const points = snapshotStreams(await store.scanSnapshotsSince(new Date(now - 24 * HOUR).toISOString(), [coin])).get(coin) ?? [];
  const regime = points.length ? computeFeatures(points, now).inputs.regime : null;
  return { tier, regime: typeof regime === "string" ? regime : null, dayNtlVlm: num(latest.dayNtlVlm), oiUsd: num(latest.oiUsd) };
}

export type ExtremeOpportunityStore = Pick<PlatformStore, "scanSnapshotsSince" | "listOpportunities" | "upsertOpportunity" | "transitionOpportunity">;

/**
 * Creates (or finds) the opportunity for a take and moves it to ready. `publish` sees every write (the always-on
 * server's bus; alerts.ts sends no Ready push for an extremes row). Returns the row and whether it was created here.
 */
export async function openExtremeOpportunity(
  store: ExtremeOpportunityStore,
  r: ExtremeRecord,
  now: number,
  publish: (o: Opportunity, change: "created" | "status") => void = () => {},
): Promise<{ opportunity: Opportunity; created: boolean }> {
  const v = r.verdict;
  if (v?.stance !== "take" || !v.direction) throw new Error("not a take");
  const key = dedupeKey({ coin: r.event.coin, direction: v.direction, setupKind: r.event.kind });
  const live = (await store.listOpportunities({ statuses: [...LIVE_STATUSES], limit: 500 })).find((o) => o.dedupeKey === key);
  if (live) return { opportunity: live, created: false };
  const { input, created } = extremeOpportunityInput(r, await extremeMarket(store, r.event.coin, now));
  const res = await store.upsertOpportunity(input, created);
  let cur = res.opportunity;
  if (res.created) publish(cur, "created");
  // Only an extremes row is walked to ready here (a row the upsert found under the key raced in; it is left as it is otherwise).
  for (let to = NEXT[cur.status]; to && isExtremesOpportunity(cur); to = NEXT[cur.status]) {
    const moved = await store.transitionOpportunity(cur.id, cur.status, to, "system");
    if (!moved) break;
    cur = moved;
    publish(cur, "status");
  }
  return { opportunity: cur, created: res.created };
}
