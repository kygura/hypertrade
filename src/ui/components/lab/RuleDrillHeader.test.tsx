import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { PerfStats, RuleEvaluation } from "../../lib/lab";
import { RuleDrillHeader } from "./RuleDrillHeader";
import { WINDOW_TERMS } from "./WindowStatsTable";

const stats = (p: Partial<PerfStats>): PerfStats => ({ from: "2020-01-01", to: "2024-01-01", days: 900, totalReturn: 0.5, cagr: 0.1, sharpe: 1, maxDrawdown: -0.1, hitRate: 0.6, trades: 38, tradesPerYear: 5, exposure: 0.3, ...p });
const ev: RuleEvaluation = {
  id: "r1",
  rule: { asset: "BTC", direction: "long", horizonDays: 14, conditions: [{ feature: "ht:funding|z|90", op: "<", threshold: -1 }] },
  text: "",
  precision: 0.7,
  support: 100,
  inSample: stats({}),
  walkForward: stats({ sharpe: 1.4 }),
  holdout: stats({ sharpe: 0.6, trades: 9, days: 290 }),
  deflatedSharpe: 0.71,
  benchmark: { inSample: stats({}), holdout: null },
  firingNow: false,
  latest: { date: "2026-11-10", values: {} },
  verdict: { level: "candidate", reasons: ["deflated Sharpe 0.71 < 0.9", "stability not measured (no sensitivity grid)"] },
};

describe("rule drill header", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RuleDrillHeader ev={ev} metrics={[]} sensitivity={null} savedAt={null} onRemove={() => {}} dsrN={{ n: 150 }} current />
    </MemoryRouter>,
  );
  test("leads with the fact line: Sharpe, trades and days per window, then the bars passed and missed", () => {
    expect(html).toContain("Walk-forward Sharpe +1.40 on 38 trades over 900 days; holdout Sharpe +0.60 on 9 trades over 290 days. Passes holdout, walk-forward; misses deflated Sharpe (0.71 of 0.9); stability not measured.");
  });
  test("labels are plain words and the guide defines every verdict level with the save bar's numbers", () => {
    for (const label of ["WALK-FORWARD SHARPE", "DEFLATED SHARPE", "HIT RATE", "MAX DRAWDOWN", "STABILITY"]) expect(html).toContain(`>${label}<`);
    expect(html).not.toContain(">DSR<");
    for (const level of ["ROBUST", "CANDIDATE", "FRAGILE", "WEAK", "FAILS HOLDOUT"]) expect(html).toContain(`>${level}</dt>`);
    expect(html).toContain("the most recent 20% of the history, set aside before any search and never used to pick or rank a rule");
    expect(html).toContain("0.9 or more passes the save bar");
    // the badge's title carries the meaning before the server's reasons
    expect(html).toContain('title="CANDIDATE: passes holdout, walk-forward and stability, but the deflated Sharpe is below 0.9');
  });
  test("the stats table's guide covers every column and row label it prints", () => {
    const labels = WINDOW_TERMS.map(([k]) => k);
    for (const k of ["IN-SAMPLE", "WALK-FWD", "HOLDOUT", "LIVE", "SHARPE", "DEFLATED SHARPE", "MAX DRAWDOWN", "HIT RATE", "TRADES", "EXPOSURE"]) expect(labels).toContain(k);
  });
});
