// Coin drill-in: ATR, flow regime and trap diagnostics from desk/analytics,
// fed with candles and funding from the InfoSource. Every fetch degrades to
// "no data" rather than failing the whole view.
import { atr, classifyRegime, rallyDiagnostics, type RallyDiagnostics } from "../../../src/server/desk/analytics.js";
import type { AccountSnapshot, Candle, CoinView, FundingPoint, InfoSource, MarketRow } from "./types.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOW_HOURS = 24;

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/**
 * Up to `n` coins closest to `q`, case-insensitive: prefix either way, then substring,
 * then edit distance ≤ 2; ties by OI desc. Shared by the UI's unknown-coin hint and the agent tools.
 */
export function closestCoins(markets: MarketRow[], q: string, n = 3): string[] {
  const u = q.trim().toUpperCase();
  return markets
    .map((m) => {
      const c = m.coin.toUpperCase();
      const score = c.startsWith(u) || u.startsWith(c) ? 0 : c.includes(u) || u.includes(c) ? 1 : editDistance(c, u) <= 2 ? 2 : 9;
      return { coin: m.coin, score, oi: m.oiUsd };
    })
    .filter((x) => x.score < 9)
    .sort((a, b) => a.score - b.score || b.oi - a.oi)
    .slice(0, n)
    .map((x) => x.coin);
}

const sgn = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
const orEmpty = async <T>(p: Promise<T[]>): Promise<T[]> => p.catch(() => []);

/** Short human lines from one RallyDiagnostics: the read, the heaviest trap components, then the inputs behind them. */
export function diagnosticLines(d: RallyDiagnostics): string[] {
  const lines = [`${d.windowHours}h ${d.direction} ${sgn(d.priceChangePct)}%: ${d.label}${d.direction === "flat" ? "" : ` (trap score ${d.trapScore}/100)`}`, ...d.notes];
  for (const c of [...d.components].filter((x) => x.points > 0).sort((a, b) => b.points - a.points).slice(0, 3)) {
    lines.push(`${c.name} ${c.points}/${c.max}: ${c.note}`);
  }
  const bits: string[] = [];
  if (d.oiChangePct != null) bits.push(`OI ${sgn(d.oiChangePct)}%`);
  if (d.fundingAprWindow != null) bits.push(`window funding ${sgn(d.fundingAprWindow, 0)}% APR${d.fundingZ != null ? ` (z ${sgn(d.fundingZ)})` : ""}`);
  if (d.volumeRatio != null) bits.push(`volume ${d.volumeRatio}x prior window`);
  if (d.realizedVolAnn != null) bits.push(`realized vol ${d.realizedVolAnn.toFixed(0)}%`);
  if (bits.length) lines.push(bits.join(", "));
  return lines;
}

/**
 * `oi` is an optional OI (USD) history for this coin, ascending (the alert
 * engine keeps one). Without it the regime falls back to price and funding.
 */
export async function buildCoinView(
  info: InfoSource,
  market: MarketRow,
  account: AccountSnapshot | null,
  now = Date.now(),
  oi: Array<{ t: number; v: number }> = [],
): Promise<CoinView> {
  const [daily, hourly, funding]: [Candle[], Candle[], FundingPoint[]] = await Promise.all([
    orEmpty(info.candles(market.coin, "1d", now - 30 * DAY)),
    orEmpty(info.candles(market.coin, "1h", now - 3 * DAY)),
    orEmpty(info.fundingHistory(market.coin, now - 30 * DAY)),
  ]);

  // Completed bars only: today's partial candle would understate the range.
  const atr14 = atr(daily.filter((c) => c.t + DAY <= now), 14);
  const diagnostics: string[] = [];
  let regime: string | null = null;

  try {
    const d = rallyDiagnostics({
      coin: market.coin,
      windowHours: WINDOW_HOURS,
      candles: hourly,
      funding,
      oi: oi.length ? oi : [{ t: now, v: market.oiUsd }],
      now,
      ctx: { funding: market.fundingHourly, premium: market.premium ?? 0, markPx: market.markPx },
    });
    regime = d.regime;
    diagnostics.push(...diagnosticLines(d));
  } catch (err) {
    // Too little hourly history: classify from the 24h change and funding alone.
    regime = classifyRegime(market.dayChangePct, null, null, market.fundingAprPct);
    diagnostics.push(`no flow diagnostics (${err instanceof Error ? err.message : "hourly candles unavailable"}); regime from 24h change and funding only`);
  }
  if (atr14 == null) diagnostics.push("ATR14 unavailable: fewer than 15 daily candles");
  if (market.atOiCap) diagnostics.push("at its open-interest cap: new positions can only reduce");
  if (market.isDelisted) diagnostics.push("delisted");

  return { market, atr14, regime, diagnostics, position: account?.positions.find((p) => p.coin === market.coin) ?? null };
}
