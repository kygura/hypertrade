// Coin drill-in: ATR, flow regime and trap diagnostics from desk/analytics,
// fed with candles and funding from the InfoSource. Every fetch degrades to
// "no data" rather than failing the whole view.
import { atr, classifyRegime, rallyDiagnostics, type RallyDiagnostics } from "../../../src/server/desk/analytics.js";
import type { AccountSnapshot, Candle, CoinView, FundingPoint, InfoSource, MarketRow } from "./types.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOW_HOURS = 24;

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

  const atr14 = atr(daily, 14);
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
