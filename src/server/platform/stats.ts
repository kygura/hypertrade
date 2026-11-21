import { CI_MIN_CLUSTERS, type LedgerStats } from "../../shared/platform.js";
import { horizonMs } from "./outcomes.js";
import { SCORE_VERSION } from "./score.js";
import type { OutcomeRow } from "./store.js";

const DAY_MS = 86_400_000;

// Two-sided 95% t critical values, df 4..30; 1.96 above.
const T95 = [2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
const tCrit = (df: number) => (df > 30 ? 1.96 : T95[df - 4]);

/**
 * The one sample summary of every scorecard (ledger, extremes, radar). Values of one `bucket` are one cluster
 * (correlated, not independent): `mean` and the 95% t-interval run over cluster means, the interval null below
 * CI_MIN_CLUSTERS clusters. n and hitRate (x > 0, strictly) stay per value. Null for no values.
 */
export function clusterStats(xs: ReadonlyArray<{ x: number; bucket: number }>): { n: number; clusters: number; hitRate: number; mean: number; ci95: [number, number] | null } | null {
  if (!xs.length) return null;
  const cl = new Map<number, number[]>();
  for (const { x, bucket } of xs) cl.set(bucket, [...(cl.get(bucket) ?? []), x]);
  const ms = [...cl.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  const k = ms.length;
  const mean = ms.reduce((a, b) => a + b, 0) / k;
  let ci95: [number, number] | null = null;
  if (k >= CI_MIN_CLUSTERS) {
    const sd = Math.sqrt(ms.reduce((a, x) => a + (x - mean) ** 2, 0) / (k - 1));
    const h = (tCrit(k - 1) * sd) / Math.sqrt(k);
    ci95 = [mean - h, mean + h];
  }
  return { n: xs.length, clusters: k, hitRate: xs.filter((v) => v.x > 0).length / xs.length, mean, ci95 };
}

/** The signal-time cluster of a value: floor(atMs / max(1 day, horizon)). */
export const clusterBucket = (atMs: number, horizonMs: number) => Math.floor(atMs / Math.max(DAY_MS, horizonMs));

/** Groups by setupKind + horizon, plus regime and/or tier when asked. Rows with non-finite netReturn, or with no cost breakdown (hasCosts false), are skipped.
 * By regime, only rows scored under the current SCORE_VERSION count: the regime label changed meaning between versions (score.ts).
 * Outcomes of one signal-time bucket floor(createdAtMs / max(1 day, horizon)) are one cluster (clusterStats).
 * The fixed-horizon numbers (n, hitRate, meanNet, ci95) are hold-to-horizon, whatever the stop and target. `trade` is the
 * separate stat of the stop/target trades among the group's rows (they sit on the longest horizon), in R.
 * `ungraded` counts the group's rows that were given up on, never priced (OutcomeRow.ungraded): they are in no number,
 * and a group with only those has n 0 and null numbers. */
export function groupStats(rows: OutcomeRow[], by: { regime?: boolean; tier?: boolean } = {}): LedgerStats[] {
  const groups = new Map<string, { key: Pick<LedgerStats, "setupKind" | "horizon" | "regime" | "tier">; rows: OutcomeRow[] }>();
  for (const r of rows) {
    if ((!r.ungraded && !Number.isFinite(r.netReturn)) || r.hasCosts === false || (by.regime && r.scoreVersion !== SCORE_VERSION)) continue;
    const key = { setupKind: r.setupKind, horizon: r.horizon, regime: by.regime ? r.regime : null, tier: by.tier ? r.liquidityTier : null };
    const k = JSON.stringify(key);
    const g = groups.get(k) ?? { key, rows: [] };
    g.rows.push(r);
    groups.set(k, g);
  }
  return [...groups.values()].map(({ key, rows: all }) => {
    const bucket = (r: OutcomeRow) => clusterBucket(r.createdAtMs, horizonMs(r.horizon));
    const rs = all.filter((r) => !r.ungraded);
    const s = clusterStats(rs.map((r) => ({ x: r.netReturn, bucket: bucket(r) })));
    const ungraded = all.length - rs.length;
    const traded = rs.filter((r) => r.trade && Number.isFinite(r.trade.r) && Number.isFinite(r.trade.netReturn));
    const tr = clusterStats(traded.map((r) => ({ x: r.trade!.r, bucket: bucket(r) })));
    const count = (exit: string) => traded.filter((r) => r.trade!.exit === exit).length;
    const trade: LedgerStats["trade"] = tr && {
      n: tr.n, clusters: tr.clusters, hitRate: tr.hitRate, meanR: tr.mean, ci95: tr.ci95,
      meanNet: clusterStats(traded.map((r) => ({ x: r.trade!.netReturn, bucket: bucket(r) })))!.mean,
      stops: count("stop"), targets: count("target"), timeouts: count("horizon"), ambiguous: traded.filter((r) => r.trade!.ambiguous).length,
    };
    return { ...key, n: s?.n ?? 0, clusters: s?.clusters ?? 0, hitRate: s?.hitRate ?? null, meanNet: s?.mean ?? null, ci95: s?.ci95 ?? null, ungraded, trade };
  });
}

/** The ledger horizon a setup's record is quoted at (alert line, opportunity detail, research board). */
export const LEDGER_HORIZON = "24h";

/**
 * A setup kind's ledger record: the LEDGER_HORIZON group of groupStats over its outcomes scored under the current
 * SCORE_VERSION; null when it has none. One definition for every place that quotes it, so a setup shows one n.
 */
export function setupLedgerStats(setupKind: string, rows: readonly OutcomeRow[]): LedgerStats | null {
  return groupStats(rows.filter((r) => r.setupKind === setupKind && r.scoreVersion === SCORE_VERSION)).find((g) => g.horizon === LEDGER_HORIZON) ?? null;
}

/** A setup kind's stop/target trade record: the `trade` stat of its groupStats group that has one (the longest horizon), under the current SCORE_VERSION; null without any. */
export function setupTradeStats(setupKind: string, rows: readonly OutcomeRow[]): { horizon: string; trade: NonNullable<LedgerStats["trade"]> } | null {
  const g = groupStats(rows.filter((r) => r.setupKind === setupKind && r.scoreVersion === SCORE_VERSION))
    .filter((x) => x.trade).sort((x, y) => horizonMs(y.horizon) - horizonMs(x.horizon))[0];
  return g ? { horizon: g.horizon, trade: g.trade! } : null;
}

const pct = (x: number, d: number) => `${x < 0 ? "\u2212" : "+"}${Math.abs(x * 100).toFixed(d)}`;
const signedR = (x: number, d: number) => `${x < 0 ? "\u2212" : "+"}${Math.abs(x).toFixed(d)}`;

/**
 * Facts-only evidence line (FEATURES 5), naming what it quotes:
 * `ledger 24h hold (no stop/target): n 37 \u00b7 11 clusters \u00b7 +0.42% (\u22120.3\u2026+1.1) \u00b7 edge unvalidated`.
 * Null stats = empty ledger; the interval is omitted below 5 clusters; `· 3 ungraded` follows when horizons were given up on. With `trade` (setupTradeStats) a second line
 * quotes the trade as ticketed: `ledger stop/target (72h max): n 12 \u00b7 6 clusters \u00b7 +0.31R (\u22120.2\u2026+0.8) \u00b7 7 stop / 3 target / 2 time`.
 */
export function evidenceLine(s: LedgerStats | null, basis: string, horizon = "24h", trade: ReturnType<typeof setupTradeStats> = null): string {
  const parts = [`n ${s?.n ?? 0}`, `${s?.clusters ?? 0} clusters`];
  if (s?.meanNet != null) parts.push(`${pct(s.meanNet, 2)}%${s.ci95 ? ` (${pct(s.ci95[0], 1)}\u2026${pct(s.ci95[1], 1)})` : ""}`);
  if (s?.ungraded) parts.push(`${s.ungraded} ungraded`);
  const hold = `ledger ${horizon} hold (no stop/target): ${parts.join(" \u00b7 ")} \u00b7 edge ${basis}`;
  if (!trade) return hold;
  const t = trade.trade;
  const r = `${signedR(t.meanR, 2)}R${t.ci95 ? ` (${signedR(t.ci95[0], 1)}\u2026${signedR(t.ci95[1], 1)})` : ""}`;
  return `${hold}\nledger stop/target (${trade.horizon} max): n ${t.n} \u00b7 ${t.clusters} clusters \u00b7 ${r} \u00b7 ${t.stops} stop / ${t.targets} target / ${t.timeouts} time`;
}
