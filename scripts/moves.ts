// Prints the moves table once (docs/SPEC.md § Moves): each coin's move over the window split into BTC beta, ETH-ex-BTC
// beta, sector-ex-majors beta and a residual, with the residual z, R², positioning and the checklists.
//   bun run moves [--window 4h|24h|72h] [--top N]
// Live Hyperliquid 1h candles (and settled funding, as there is no scanner here); news, Elfa and the sector stage when
// DATABASE_URL is set. No scanner or crawler in this process, so the flow and liquidation layers are unavailable.
// About 60 HL weight per coin under the process's weight guard: 40 coins take two to three minutes.
import { fetchCandles, fetchFundingPage } from "../src/shared/hl-client";
import { MoveWindowSchema, type MoveRow, type MovesResponse } from "../src/shared/moves";
import { releaseConnection } from "../src/server/db";
import { MOVES_TOP } from "../src/server/moves/constants";
import { createMovesService, defaultMovesDeps } from "../src/server/moves/service";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const f = (x: number | null | undefined, d = 2, sign = true) => (x == null ? "—" : `${sign && x > 0 ? "+" : ""}${x.toFixed(d)}`);

export function formatMoves(r: MovesResponse): string {
  const out = [`moves · window ${r.window} · state ${r.state}${r.reason ? ` · ${r.reason}` : ""} · asOf ${r.asOf ?? "—"} · ${r.universe.coins} coins`];
  for (const [k, v] of Object.entries(r.layers)) if (v.state !== "ok") out.push(`  layer ${k}: ${v.state} · ${v.reason}`);
  if (r.universe.dropped.length) out.push(`  dropped: ${r.universe.dropped.map((d) => `${d.coin} (${d.reason})`).join(", ")}`);
  if (r.factors.length) out.push(`  factors (log %): ${r.factors.map((x) => `${x.label} ${f(x.pct)}`).join(" · ")}`);
  out.push("", ["coin".padEnd(10), "total%", "btc%", "eth%", "sect%", "resid%", "z", "R²", "n", "fundAPR%", "crowd L/S", "enter", "fade"].map((h, i) => (i ? h.padStart(9) : h)).join(" "));
  const z = (row: MoveRow) => Math.abs(row.attribution?.residualZ ?? 0);
  for (const row of [...r.rows].sort((a, b) => z(b) - z(a))) {
    const a = row.attribution;
    const [enter, fade] = row.setups;
    out.push([
      row.coin.padEnd(10),
      ...(a ? [f(a.totalPct), f(a.btcPct), f(a.ethPct), f(a.sectorPct), f(a.residualPct), f(a.residualZ, 1), f(a.r2, 2, false), String(a.estimation.n)] : ["—", "—", "—", "—", "—", "—", "—", "—"]).map((s) => s.padStart(9)),
      f(row.positioning.fundingAprPct, 1).padStart(9),
      `${row.positioning.longMet}/${row.positioning.of} ${row.positioning.shortMet}/${row.positioning.of}`.padStart(9),
      (enter ? `${enter.met}/${enter.of}` : "—").padStart(9),
      (fade ? `${fade.met}/${fade.of}` : "—").padStart(9),
      ...(a ? [] : [`  ${row.attributionReason}`]),
    ].join(" "));
  }
  return out.join("\n");
}

async function main() {
  const window = MoveWindowSchema.parse(arg("--window") ?? "24h");
  const top = arg("--top");
  if (top !== undefined && !/^[1-9]\d*$/.test(top)) throw new Error("--top needs a positive integer");
  const t0 = Date.now();
  const svc = createMovesService({
    ...defaultMovesDeps({ log: (m) => console.error(`[moves] ${m}`) }),
    // A standalone process: the guard's whole budget (no scanner shares it here).
    candles: (coin, s, e) => fetchCandles(coin, "1h", s, e),
    funding: (coin, s, e) => fetchFundingPage(coin, s, e),
    serverless: false,
    top: top ? Number(top) : MOVES_TOP,
    waitMs: 30 * 60_000,
  });
  console.log(formatMoves(await svc.universe(window)));
  console.error(`[moves] done in ${Math.round((Date.now() - t0) / 1000)} s`);
}

if (import.meta.main) {
  try {
    await main();
  } finally {
    await releaseConnection();
  }
}
