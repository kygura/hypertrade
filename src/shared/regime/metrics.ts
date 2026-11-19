// Pure readers for the numbers Glassnode's reports lean on, so the thesis can check a report's figures against the
// same metrics from free sources: realized price and MVRV (CoinMetrics community), STH and LTH cost basis, STH-SOPR,
// NUPL and spot ETF flows (bitcoin-data.com), options skew (Deribit), and bid/ask depth near the mark (any L2 book).
// No fetching here: the collectors fetch, these turn the answers into a few numbers and one line of text.

export type Row = { t: number; v: number };

const DAY = 86_400_000;
const r2 = (x: number) => Math.round(x * 100) / 100;
const num = (x: unknown): number | null => {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
};
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The value at or just before `t` (rows ascending). */
export function valueAt(rows: Row[], t: number): number | null {
  let v: number | null = null;
  for (const r of rows) {
    if (r.t > t) break;
    v = r.v;
  }
  return v;
}

/** The last value, its day, and the values 7 and 30 days before it. */
export function seriesStats(rows: Row[]): { last: number; date: string; d7: number | null; d30: number | null } | null {
  const last = rows.at(-1);
  if (!last) return null;
  return { last: last.v, date: iso(last.t), d7: valueAt(rows, last.t - 7 * DAY), d30: valueAt(rows, last.t - 30 * DAY) };
}

/** Sum of the values over the last `days` days (inclusive of the last row's day). */
export function sumLast(rows: Row[], days: number): number | null {
  const last = rows.at(-1);
  if (!last) return null;
  const from = last.t - (days - 1) * DAY;
  return rows.filter((r) => r.t >= from).reduce((a, r) => a + r.v, 0);
}

// ---- bitcoin-data.com -----------------------------------------------------------------------------------------------

const BG_META = new Set(["d", "unixTs", "delayed", "time"]);

/** bitcoin-data.com history: [{d, unixTs, <metric>: "<decimal>"}], one value key per row. Ascending, one row a day. */
export function bgRows(json: unknown): Row[] {
  if (!Array.isArray(json)) throw new Error("bitcoin-data: expected an array");
  const byDay = new Map<number, number>();
  for (const row of json) {
    if (!isRecord(row)) continue;
    const sec = num(row.unixTs);
    const t = sec != null ? sec * 1000 : typeof row.d === "string" ? Date.parse(`${row.d}T00:00:00Z`) : NaN;
    const keys = Object.keys(row).filter((k) => !BG_META.has(k));
    if (!Number.isFinite(t) || keys.length !== 1) continue;
    const v = num(row[keys[0]!]);
    if (v != null) byDay.set(Math.floor(t / DAY) * DAY, v);
  }
  return [...byDay.entries()].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
}

/** The bitcoin-data.com metrics the thesis reads (one keyless call each; the free quota is about 15 calls a day). */
export const ONCHAIN_METRICS = ["sth-realized-price", "lth-realized-price", "sth-sopr", "nupl", "etf-flow-btc"] as const;
export type OnchainMetric = (typeof ONCHAIN_METRICS)[number];

/** One line and the numbers for the on-chain cost-basis read. `price` is BTC's mark, when known. */
export function onchainRead(series: Partial<Record<OnchainMetric, Row[]>>, price: number | null) {
  const s = Object.fromEntries(ONCHAIN_METRICS.map((m) => [m, seriesStats(series[m] ?? [])])) as Record<OnchainMetric, ReturnType<typeof seriesStats>>;
  const vs = (level: number | null | undefined) => (level && price ? r2((price / level - 1) * 100) : null);
  const parts: string[] = [];
  const sth = s["sth-realized-price"];
  const lth = s["lth-realized-price"];
  if (sth) parts.push(`STH realized price (short-term holder cost basis) $${Math.round(sth.last).toLocaleString("en-US")} on ${sth.date}${price ? ` (price ${vs(sth.last)}% vs it)` : ""}${sth.d30 ? `, $${Math.round(sth.d30).toLocaleString("en-US")} a month before` : ""}`);
  if (lth) parts.push(`LTH realized price $${Math.round(lth.last).toLocaleString("en-US")}${price ? ` (price ${vs(lth.last)}% vs it)` : ""}`);
  const sopr = s["sth-sopr"];
  if (sopr) parts.push(`STH-SOPR ${r2(sopr.last)} on ${sopr.date}${sopr.d7 != null ? ` (${r2(sopr.d7)} a week before)` : ""}; under 1 means short-term holders sell at a loss (capitulation)`);
  const nupl = s.nupl;
  if (nupl) parts.push(`NUPL ${r2(nupl.last)}${nupl.d30 != null ? ` (${r2(nupl.d30)} a month before)` : ""}`);
  const etf = series["etf-flow-btc"] ?? [];
  const e7 = sumLast(etf, 7);
  const e30 = sumLast(etf, 30);
  if (etf.length) parts.push(`US spot ETF net flow ${Math.round(etf.at(-1)!.v).toLocaleString("en-US")} BTC on ${iso(etf.at(-1)!.t)}, ${e7 != null ? Math.round(e7).toLocaleString("en-US") : "n/a"} BTC over 7 days, ${e30 != null ? Math.round(e30).toLocaleString("en-US") : "n/a"} over 30`);
  return {
    text: parts.length ? `${parts.join(". ")}.` : "",
    data: {
      sth_realized_price: sth ? Math.round(sth.last) : null,
      lth_realized_price: lth ? Math.round(lth.last) : null,
      price_vs_sth_pct: vs(sth?.last),
      sth_sopr: sopr ? r2(sopr.last) : null,
      nupl: nupl ? r2(nupl.last) : null,
      etf_flow_btc_7d: e7 != null ? Math.round(e7) : null,
      etf_flow_btc_30d: e30 != null ? Math.round(e30) : null,
      as_of: sth?.date ?? sopr?.date ?? null,
    } as Record<string, number | string | null>,
  };
}

// ---- CoinMetrics community API --------------------------------------------------------------------------------------

/** `metrics=PriceUSD,CapMrktCurUSD,CapMVRVCur` rows. Realized cap is derived (mcap / MVRV): CapRealUSD is not on the community tier. */
export function cmValuation(json: unknown): { rows: Array<{ t: number; price: number; mcap: number; mvrv: number }> } {
  if (!isRecord(json) || !Array.isArray(json.data)) throw new Error("coinmetrics: unexpected response");
  const rows: Array<{ t: number; price: number; mcap: number; mvrv: number }> = [];
  for (const r of json.data) {
    if (!isRecord(r)) continue;
    const t = typeof r.time === "string" ? Date.parse(r.time) : NaN;
    const price = num(r.PriceUSD);
    const mcap = num(r.CapMrktCurUSD);
    const mvrv = num(r.CapMVRVCur);
    if (Number.isFinite(t) && price && mcap && mvrv) rows.push({ t, price, mcap, mvrv });
  }
  rows.sort((a, b) => a.t - b.t);
  return { rows };
}

/** Realized price and cap, MVRV, and the realized cap's change (net capital in or out at cost: a realized profit/loss gauge). */
export function valuationRead(rows: Array<{ t: number; price: number; mcap: number; mvrv: number }>) {
  const last = rows.at(-1);
  if (!last) return null;
  const realCap = (r: { mcap: number; mvrv: number }) => r.mcap / r.mvrv;
  const at = (days: number) => {
    const t = last.t - days * DAY;
    let hit: (typeof rows)[number] | null = null;
    for (const r of rows) if (r.t <= t) hit = r;
    return hit;
  };
  const supply = last.mcap / last.price;
  const realizedPrice = realCap(last) / supply;
  const w = at(7);
  const m = at(30);
  const chg = (then: (typeof rows)[number] | null) => (then ? r2(((realCap(last) - realCap(then)) / 1e9)) : null);
  const d7 = chg(w);
  const d30 = chg(m);
  return {
    text: `Realized price $${Math.round(realizedPrice).toLocaleString("en-US")}, MVRV ${r2(last.mvrv)}${m ? ` (${r2(m.mvrv)} a month before)` : ""} on ${iso(last.t)}. Realized cap $${r2(realCap(last) / 1e12)}T: ${d7 ?? "n/a"}B over 7 days, ${d30 ?? "n/a"}B over 30 (positive: coins moving at a profit, capital coming in; negative: realized losses).`,
    data: { realized_price: Math.round(realizedPrice), mvrv: r2(last.mvrv), mvrv_30d_ago: m ? r2(m.mvrv) : null, realized_cap_chg_7d_bn: d7, realized_cap_chg_30d_bn: d30, as_of: iso(last.t) } as Record<string, number | string | null>,
  };
}

/** `metrics=FlowInExNtv,FlowOutExNtv` rows: BTC sent to and from exchanges a day. Null when the tier does not serve them. */
export function exchangeFlowRead(json: unknown) {
  if (!isRecord(json) || !Array.isArray(json.data)) return null;
  const net: Row[] = [];
  for (const r of json.data) {
    if (!isRecord(r)) continue;
    const t = typeof r.time === "string" ? Date.parse(r.time) : NaN;
    const i = num(r.FlowInExNtv);
    const o = num(r.FlowOutExNtv);
    if (Number.isFinite(t) && i != null && o != null) net.push({ t, v: i - o });
  }
  net.sort((a, b) => a.t - b.t);
  if (!net.length) return null;
  const n7 = sumLast(net, 7);
  const n30 = sumLast(net, 30);
  return {
    text: `Exchange net flow ${n7 != null ? Math.round(n7).toLocaleString("en-US") : "n/a"} BTC over 7 days, ${n30 != null ? Math.round(n30).toLocaleString("en-US") : "n/a"} over 30 (positive: coins moving onto exchanges).`,
    data: { exchange_netflow_btc_7d: n7 != null ? Math.round(n7) : null, exchange_netflow_btc_30d: n30 != null ? Math.round(n30) : null } as Record<string, number | string | null>,
  };
}

// ---- Deribit options skew -------------------------------------------------------------------------------------------

const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/** "27NOV26" as the 08:00 UTC expiry. */
export function deribitExpiry(code: string): number | null {
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(code);
  if (!m || MONTHS[m[2]!] == null) return null;
  return Date.UTC(2000 + Number(m[3]), MONTHS[m[2]!]!, Number(m[1]), 8);
}

export type OptionSummary = { instrument_name: string; mark_iv?: number | null; underlying_price?: number | null; open_interest?: number };

/**
 * Skew on the expiry nearest 30 days out (at least 7): implied vol of the put about 10% below the forward minus the
 * call about 10% above it, in vol points (positive: downside protection costs more), with at-the-money vol.
 */
export function optionSkew(rows: OptionSummary[], now: number) {
  type Leg = { k: number; iv: number; u: number };
  const byExp = new Map<number, { P: Leg[]; C: Leg[] }>();
  for (const o of rows) {
    const m = /^BTC-([0-9A-Z]+)-(\d+)-([CP])$/.exec(o.instrument_name);
    const iv = num(o.mark_iv);
    const u = num(o.underlying_price);
    if (!m || !iv || !u) continue;
    const exp = deribitExpiry(m[1]!);
    if (exp == null || exp - now < 7 * DAY) continue;
    const e = byExp.get(exp) ?? { P: [], C: [] };
    e[m[3] as "P" | "C"].push({ k: Number(m[2]), iv, u });
    byExp.set(exp, e);
  }
  const exp = [...byExp.keys()].sort((a, b) => Math.abs(a - now - 30 * DAY) - Math.abs(b - now - 30 * DAY))[0];
  if (exp == null) return null;
  const { P, C } = byExp.get(exp)!;
  const all = [...P, ...C];
  if (!P.length || !C.length) return null;
  const u = all.map((x) => x.u).sort((a, b) => a - b)[Math.floor(all.length / 2)]!;
  const near = (legs: Leg[], k: number) => legs.reduce((a, b) => (Math.abs(b.k - k) < Math.abs(a.k - k) ? b : a));
  const put = near(P, u * 0.9);
  const call = near(C, u * 1.1);
  const atm = (near(P, u).iv + near(C, u).iv) / 2;
  const days = Math.round((exp - now) / DAY);
  const skew = r2(put.iv - call.iv);
  return {
    text: `${iso(exp)} expiry (${days} days): at-the-money implied vol ${r2(atm)}%, ${put.k / 1000}K put ${r2(put.iv)}% vs ${call.k / 1000}K call ${r2(call.iv)}%, skew ${skew > 0 ? "+" : ""}${skew} vol points toward ${skew >= 0 ? "puts" : "calls"}.`,
    data: { skew_expiry: iso(exp), skew_days: days, atm_iv: r2(atm), put_iv_10pct_otm: r2(put.iv), call_iv_10pct_otm: r2(call.iv), skew_put_minus_call: skew } as Record<string, number | string | null>,
  };
}

// ---- Order book depth -----------------------------------------------------------------------------------------------

export type Level = [price: number, size: number];

/** Resting bid and ask notional within each band of the mid, and the bid share of the two. */
export function bookDepth(bids: Level[], asks: Level[], bands = [0.01, 0.02, 0.05]) {
  const bb = bids.length ? Math.max(...bids.map((b) => b[0])) : null;
  const ba = asks.length ? Math.min(...asks.map((a) => a[0])) : null;
  if (bb == null || ba == null) return null;
  const mid = (bb + ba) / 2;
  return {
    mid,
    bands: bands.map((p) => {
      const bid = bids.filter(([px]) => px >= mid * (1 - p)).reduce((a, [px, sz]) => a + px * sz, 0);
      const ask = asks.filter(([px]) => px <= mid * (1 + p)).reduce((a, [px, sz]) => a + px * sz, 0);
      return { pct: p * 100, bidUsd: bid, askUsd: ask, bidShare: bid + ask > 0 ? r2(bid / (bid + ask)) : null };
    }),
  };
}

export function depthLine(venue: string, d: NonNullable<ReturnType<typeof bookDepth>>): string {
  return `${venue} mid ${Math.round(d.mid).toLocaleString("en-US")}: ${d.bands.map((b) => `within ${b.pct}% bids $${r2(b.bidUsd / 1e6)}M vs asks $${r2(b.askUsd / 1e6)}M`).join(", ")}`;
}
