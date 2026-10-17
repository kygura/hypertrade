import type { LedgerStats } from "../../shared/platform.js";
import type { OutcomeRow } from "./store.js";

// Two-sided 95% t critical values, df 4..30; 1.96 above.
const T95 = [2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
const tCrit = (df: number) => (df > 30 ? 1.96 : T95[df - 4]);

/** Groups by setupKind + horizon, plus regime and/or tier when asked. Rows with non-finite netReturn, or with no cost breakdown (hasCosts false), are skipped. */
export function groupStats(rows: OutcomeRow[], by: { regime?: boolean; tier?: boolean } = {}): LedgerStats[] {
  const groups = new Map<string, { key: Pick<LedgerStats, "setupKind" | "horizon" | "regime" | "tier">; xs: number[] }>();
  for (const r of rows) {
    if (!Number.isFinite(r.netReturn) || r.hasCosts === false) continue;
    const key = { setupKind: r.setupKind, horizon: r.horizon, regime: by.regime ? r.regime : null, tier: by.tier ? r.liquidityTier : null };
    const k = JSON.stringify(key);
    const g = groups.get(k) ?? { key, xs: [] };
    g.xs.push(r.netReturn);
    groups.set(k, g);
  }
  return [...groups.values()].map(({ key, xs }) => {
    const n = xs.length;
    const meanNet = xs.reduce((a, b) => a + b, 0) / n;
    let ci95: LedgerStats["ci95"] = null;
    if (n >= 5) {
      const sd = Math.sqrt(xs.reduce((a, x) => a + (x - meanNet) ** 2, 0) / (n - 1));
      const h = (tCrit(n - 1) * sd) / Math.sqrt(n);
      ci95 = [meanNet - h, meanNet + h];
    }
    return { ...key, n, hitRate: xs.filter((x) => x > 0).length / n, meanNet, ci95 };
  });
}
