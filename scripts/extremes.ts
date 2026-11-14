// Extremes detector from the command line (src/server/extremes). Keyless, no database needed.
//   bun run extremes [--top 30]                  scan now: detectExtremes at the last closed 15-min bar, top N coins by 24 h volume
//   bun run extremes show <COIN>                 that coin's readings for all three detectors, with each threshold
//   bun run extremes replay [--top 30] [--days N] [--events] [--source candles|snapshots]
//   bun run extremes score [--days 30]           stored events graded from scan_snapshots (needs DATABASE_URL): the
//                                                GET /api/extremes summary by stance and by kind
// candles (default): HL 15-min candles (the latest 5000, about 52 days) + hourly funding through the setup replay's loader
// (platform/replaySource.ts, memoised HL fetchers under the weight guard, about 3 coins a minute). Candles carry no OI,
// so oi_flush and crowded_asymmetry are not evaluable on them. snapshots: stored scan_snapshots (needs DATABASE_URL).
import { HL_MAX_CANDLES } from "../src/shared/hl-client";
import { fundingAprPct } from "../src/shared/signalMath";
import { databaseUrl, releaseConnection } from "../src/server/db";
import {
  BTC_COIN, DEFAULT_EXTREME_THRESHOLDS, detectExtremes, EXTREME_LOOKBACK_MS, EXTREME_MIN_HISTORY_MS, readExtremes,
} from "../src/server/extremes/detect";
import { gradedExtremes, type ExtremeSummaryRow } from "../src/server/extremes/grade";
import { replayExtremes, type ReturnStats } from "../src/server/extremes/replay";
import type { RingPoint } from "../src/server/platform/features";
import { candleStream, defaultCandleDeps, GRID_MS, SNAPSHOT_GRADE_TOLERANCE_MS, snapshotStreams } from "../src/server/platform/replaySource";
import { scanRetentionDays } from "../src/server/platform/store";
import { PgPlatformStore } from "../src/server/platform/store-pg";
import { selectUniverse } from "../src/server/platform/universe";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const log = (m: string) => console.error(`[extremes] ${m}`);
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const posInt = (name: string, dflt: number) => {
  const v = arg(name);
  if (v === undefined) return dflt;
  if (!/^[1-9]\d*$/.test(v)) throw new Error(`${name} needs a positive integer`);
  return Number(v);
};

/** Candle streams ending at the last closed 15-min boundary, BTC always included (the residual leg reads it). */
async function candleStreams(o: { top?: number; coins?: string[]; spanMs: number }): Promise<{ end: number; streams: Map<string, RingPoint[]> }> {
  const d = defaultCandleDeps({ log });
  const end = Math.floor(d.now() / GRID_MS) * GRID_MS;
  const start = end - Math.min(o.spanMs, HL_MAX_CANDLES * GRID_MS);
  const coins = o.coins ?? selectUniverse(await d.universe(), { top: o.top }).map((c) => c.coin);
  if (!coins.includes(BTC_COIN)) coins.unshift(BTC_COIN);
  const streams = new Map<string, RingPoint[]>();
  for (const [i, coin] of coins.entries()) {
    try {
      const [cs, fs] = [await d.candles(coin, start, end - 1), await d.funding(coin, start - HOUR, end)];
      const pts = candleStream(cs.filter((c) => c.t + GRID_MS <= end), fs);
      if (pts.length) streams.set(coin, pts);
      log(`${i + 1}/${coins.length} ${coin}: ${cs.length} candles, ${fs.length} funding`);
    } catch (err) {
      log(`${i + 1}/${coins.length} ${coin}: dropped (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { end, streams };
}

const pct = (x: number | null, d = 2) => (x == null ? "-" : `${x < 0 ? "-" : "+"}${Math.abs(x * 100).toFixed(d)}%`);
const num = (x: number | null, d = 2) => (x == null ? "-" : x.toFixed(d));
const cell = (s: ReturnStats) => (s.n ? `n${s.n} hit ${Math.round(s.hitRate! * 100)}% med ${pct(s.median)} mean ${pct(s.mean)}` : "n0");

async function scan(top: number) {
  const { end, streams } = await candleStreams({ top, spanMs: EXTREME_LOOKBACK_MS + DAY });
  const btc = streams.get(BTC_COIN) ?? null;
  const events = [...streams].flatMap(([coin, points]) => detectExtremes({ coin, points, btc: coin === BTC_COIN ? null : btc, now: end }));
  console.log(`extremes at ${new Date(end).toISOString()} · ${streams.size} coins · candles (oi_flush, crowded_asymmetry not evaluable: no OI)`);
  if (!events.length) console.log("none");
  for (const e of events.sort((a, b) => b.severity - a.severity)) console.log(`${e.kind.padEnd(18)} ${e.side.padEnd(5)} ${e.line}`);
}

async function show(coin: string) {
  const { end, streams } = await candleStreams({ coins: coin === BTC_COIN ? [BTC_COIN] : [BTC_COIN, coin], spanMs: EXTREME_LOOKBACK_MS + DAY });
  const points = streams.get(coin);
  if (!points) throw new Error(`no candles for ${coin}`);
  const r = readExtremes({ coin, points, btc: coin === BTC_COIN ? null : (streams.get(BTC_COIN) ?? null), now: end });
  const th = DEFAULT_EXTREME_THRESHOLDS;
  console.log(`${coin} at ${new Date(end).toISOString()} · mark ${r.mark ?? "-"} · funding ${r.funding == null ? "-" : `${fundingAprPct(r.funding).toFixed(1)}% apr`}`);
  if (!r.evaluable) return console.log(`not evaluable: needs ${EXTREME_MIN_HISTORY_MS / DAY} days of history and a mark at now`);
  const cut = (x: number, need: number, d = 1) => `${x.toFixed(d)}/${need}`;
  const zc = (z: number | null, need: number) => (z == null ? "-" : cut(Math.abs(z), need));
  console.log(`\nprice_dislocation (each: reading/threshold; |move|, |z| own, ${coin === BTC_COIN ? "BTC: no residual leg" : "same-sign |z| vs BTC"})`);
  for (const p of r.price) {
    const w = p.window;
    console.log(`  ${w.padEnd(4)} move ${pct(p.ret).padStart(8)} (|move| ${cut(Math.abs(p.ret) * 100, th.price.minMove[w] * 100, 1)}%)  z ${zc(p.z, th.price.z[w])}  vs BTC ${zc(p.zResid, th.price.zResid[w])}  beta ${num(p.beta)}  ${p.fires ? "FIRES" : ""}`);
  }
  console.log(`\noi_flush (each: reading/threshold; OI contracts drop, -z, |price z|)`);
  if (!r.oi.length) console.log("  not evaluable: no OI on this source");
  for (const o of r.oi) {
    const w = o.window;
    console.log(`  ${w.padEnd(4)} OI ${pct(o.oiChg).padStart(8)} (drop ${cut(-o.oiChg * 100, th.oiFlush.minDrop[w] * 100, 1)}%)  -z ${o.z == null ? "-" : cut(-o.z, th.oiFlush.z[w])}  price ${pct(o.ret)} |z| ${zc(o.zPrice, th.oiFlush.zPrice)}  ${o.fires ? "FIRES" : ""}`);
  }
  const c = r.crowded;
  const t = th.crowded;
  console.log(`\ncrowded_asymmetry (needs funding pctile >= ${t.pctile} or <= ${(1 - t.pctile).toFixed(2)}, |z| >= ${t.zFunding}, |apr| >= ${t.minAprPct}%, OI pctile >= ${t.oiPctile}, 24h z with the crowd <= ${t.maxFollowZ})`);
  if (!c) console.log("  not evaluable: no OI on this source");
  else console.log(`  funding ${c.fundingAprPct.toFixed(1)}% apr  pctile ${num(c.fundingPctile)}  z ${num(c.fundingZ)}  OI pctile ${num(c.oiPctile)}  24h ${pct(c.ret24h)} z ${num(c.z24h)}  ${c.fires ? "FIRES" : ""}`);
}

async function replay(top: number) {
  const days = arg("--days") === undefined ? null : posInt("--days", 1);
  const source = arg("--source") ?? "candles";
  let streams: Map<string, RingPoint[]>;
  let end: number;
  let toleranceMs = 0;
  if (source === "candles") ({ end, streams } = await candleStreams({ top, spanMs: HL_MAX_CANDLES * GRID_MS }));
  else if (source === "snapshots") {
    if (!databaseUrl()) throw new Error("--source snapshots needs DATABASE_URL");
    end = Math.floor(Date.now() / GRID_MS) * GRID_MS;
    const all = snapshotStreams(await new PgPlatformStore().scanSnapshotsSince(new Date(end - scanRetentionDays() * DAY).toISOString()));
    const keep = new Set(selectUniverse([...all].map(([coin, pts]) => ({ coin, dayNtlVlm: pts.at(-1)!.dayNtlVlm })), { top, mine: [BTC_COIN] }).map((c) => c.coin));
    streams = new Map([...all].filter(([coin]) => keep.has(coin)));
    toleranceMs = SNAPSHOT_GRADE_TOLERANCE_MS;
  } else throw new Error(`unknown --source ${source} (candles | snapshots)`);
  const firsts = [...streams.values()].map((p) => p[0]!.ts);
  if (!firsts.length) throw new Error("no streams loaded");
  let from = Math.ceil((Math.min(...firsts) + EXTREME_MIN_HISTORY_MS) / GRID_MS) * GRID_MS;
  if (days != null) from = Math.max(from, end - days * DAY);
  const grid: number[] = [];
  for (let t = from; t <= end; t += GRID_MS) grid.push(t);
  const t0 = Date.now();
  const r = replayExtremes({ streams, grid, gradeToleranceMs: toleranceMs });
  log(`replayed ${grid.length} steps × ${streams.size} coins in ${Math.round((Date.now() - t0) / 1000)} s`);

  console.log(`extremes replay · ${source} · ${r.from ? new Date(r.from).toISOString() : "-"} -> ${r.to ? new Date(r.to).toISOString() : "-"} (${r.weeks.toFixed(1)} weeks) · ${streams.size} coins · cooldown 24h per key`);
  console.log("fade-side gross return (no fees, no funding); vs BTC = minus BTC's return over the same span (BTC's own events excluded)");
  for (const row of r.rows) {
    if (!row.evaluable) {
      console.log(`\n${row.kind}: not evaluable on this source: ${row.reason}`);
      continue;
    }
    console.log(`\n${row.kind}: ${row.events} events (${row.long} long, ${row.short} short), ${num(row.perWeek)}/week`);
    for (const h of row.horizons) console.log(`  ${h.horizon.padEnd(4)} abs  ${cell(h.abs)}\n       vsBTC ${cell(h.vsBtc)}`);
  }
  if (process.argv.includes("--events")) {
    console.log("\nevents:");
    for (const e of r.events) console.log(`  ${e.ts.slice(0, 16)} ${e.kind.padEnd(18)} ${e.side.padEnd(5)} ${e.line}`);
  }
}

/** The graded summary as a table: one row per group, raw and stopped per horizon (stopped differs only for takes). */
function scoreTable(rows: ExtremeSummaryRow[]): string[] {
  const short = (st: ReturnStats) => (st.n ? `n${st.n} ${Math.round(st.hitRate! * 100)}% med ${pct(st.median)} mean ${pct(st.mean)}` : "-");
  const lines = [`${"group".padEnd(24)} ${"n".padStart(3)} ${"grd".padStart(3)} ${"kill".padStart(5)}  ${["4h", "24h", "72h"].map((h) => h.padEnd(34)).join(" ")}`];
  for (const r of rows) {
    if (!r.n) continue;
    const kill = r.killHitRate == null ? "-" : `${Math.round(r.killHitRate * 100)}%`;
    lines.push(`${`${r.by}:${r.group}`.padEnd(24)} ${String(r.n).padStart(3)} ${String(r.graded).padStart(3)} ${kill.padStart(5)}  ${r.horizons.map((h) => short(h.raw).padEnd(34)).join(" ")}`);
    if (r.killHitRate != null) lines.push(`${"  stopped at kill".padEnd(24)} ${"".padStart(3)} ${"".padStart(3)} ${"".padStart(5)}  ${r.horizons.map((h) => short(h.stopped).padEnd(34)).join(" ")}`);
  }
  return lines;
}

async function score() {
  const days = posInt("--days", 30);
  if (!databaseUrl()) {
    console.error("extremes score reads stored events and scan_snapshots: set DATABASE_URL (or POSTGRES_URL) and rerun.");
    process.exitCode = 1;
    return;
  }
  const store = new PgPlatformStore();
  const now = Date.now();
  const since = new Date(now - Math.min(days, scanRetentionDays()) * DAY).toISOString();
  const { records, summary } = await gradedExtremes(store, await store.listExtremes({ since, limit: 500 }), now);
  console.log(`extremes score · events since ${since} · ${records.length} records · signed return in the graded direction from the verdict mark (else the event mark), gross`);
  if (!records.length) return console.log("no stored events in the window");
  for (const l of scoreTable(summary)) console.log(l);
}

async function main() {
  const cmd = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "scan";
  const top = posInt("--top", 30);
  if (cmd === "scan") await scan(top);
  else if (cmd === "show") {
    const coin = process.argv[3];
    if (!coin || coin.startsWith("--")) throw new Error("usage: bun run extremes show <COIN>");
    await show(coin);
  } else if (cmd === "replay") await replay(top);
  else if (cmd === "score") await score();
  else throw new Error(`unknown command ${cmd} (scan | show <COIN> | replay | score)`);
}

try {
  await main();
} finally {
  await releaseConnection();
}
