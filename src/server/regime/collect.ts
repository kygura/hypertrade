// The regime thesis's collectors (docs/REGIME.md): everything the thesis reads before the model searches the web on
// its own. Each one is keyless and optional; a failure is a note, never a failed run. The same collectors as
// tradespace's src/intel/collect.ts, wired to this repo's Hyperliquid contexts.
//   glassnode   the newest "Week On-chain" report and other posts from the last 8 days, full text (RSS, then the
//               Ghost sitemap, then this and last ISO week's URL guessed from the slug)
//   feeds       REGIME_FEEDS: more RSS/Atom feeds, comma-separated (recent items, summary only)
//   notion      a notes page (REGIME_NOTION_PAGE_ID with NOTION_TOKEN), counted as one light source
//   market      one data snapshot per source, for the numbers Glassnode's reports quote (docs/REGIME.md has the table):
//                 already in this repo: Hyperliquid funding/OI (routes/hl.ts), the macro radar (radar/macro.ts: Fed
//                 policy, yields, net liquidity, HY OAS, VIX/MOVE, DXY, Polymarket Fed odds), FOMC/CPI/NFP dates
//                 (intel/calendar.ts), the hl-cycles dashboard (as in routine/collect.ts), Deribit, Fear & Greed,
//                 DefiLlama, CoinGecko, Coinbase
//                 added: STH/LTH cost basis, STH-SOPR, NUPL, ETF flows (bitcoin-data.com, BGEOMETRICS_TOKEN optional);
//                 realized price, MVRV, exchange flows (CoinMetrics community, as lab/providers/cm.ts); Deribit skew;
//                 funding on Binance/Bybit/OKX, OI change (Binance), OKX liquidations; BTC book depth (Coinbase, HL);
//                 the week's US calendar with forecasts (ForexFactory)
import { hlInfo } from "../../shared/hl-client.js";
import type { AssetCtx } from "../../shared/types.js";
import {
  bgRows,
  bookDepth,
  cmValuation,
  depthLine,
  exchangeFlowRead,
  ONCHAIN_METRICS,
  onchainRead,
  optionSkew,
  valuationRead,
  type Level,
  type OnchainMetric,
  type OptionSummary,
  type Row,
} from "../../shared/regime/metrics.js";
import { calendarEvents } from "../intel/calendar.js";
import { CM_BASE } from "../lab/providers/cm.js";
import { collectMacro, macroLines } from "../radar/macro.js";
import { condenseHlCycles } from "../routine/collect.js";
import { urlKey } from "../../shared/regime/build.js";
import { hostOf, sourceFor } from "../../shared/regime/sources.js";
import { articleText, cleanUrl, pageTitle, parseFeed, sitemapUrls, weekOnchainSlug, type FeedItem } from "../../shared/regime/text.js";
import type { Evidence } from "../../shared/regime/types.js";

export type Fetch = typeof fetch;

/** fetch JSON with a timeout and one retry on 429/5xx/network error. */
export async function getJson<T>(url: string, init: RequestInit = {}, fetchFn: Fetch = fetch, attempt = 0): Promise<T> {
  let r: Response;
  try {
    r = await fetchFn(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    if (attempt === 0) return getJson<T>(url, init, fetchFn, 1);
    throw new Error(`${new URL(url).host}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!r.ok) {
    if ((r.status === 429 || r.status >= 500) && attempt === 0) return getJson<T>(url, init, fetchFn, 1);
    throw new Error(`${new URL(url).host} ${r.status}`);
  }
  return (await r.json()) as T;
}

export async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The perps the Hyperliquid snapshot reads. */
export const REGIME_COINS = ["BTC", "ETH", "SOL", "HYPE"] as const;

type Env = Record<string, string | undefined>;
const DAY = 86_400_000;
const UA = { "user-agent": "hypertrade-regime/1.0", accept: "text/html,application/xml,application/rss+xml,*/*" };
const TIMEOUT_MS = 20_000;
const r2 = (x: number) => Math.round(x * 100) / 100;

export const GLASSNODE_BASE = "https://research.glassnode.com";

export async function getText(url: string, fetchFn: Fetch = fetch, init: RequestInit = {}): Promise<string> {
  const r = await fetchFn(url, { ...init, headers: { ...UA, ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`${hostOf(url) ?? url} ${r.status}`);
  return r.text();
}

export const evidenceId = (source: string, url: string | null, at: string) => (url ? `${source}:${urlKey(url)}` : `${source}:${at.slice(0, 10)}`);

export type CollectResult = { evidence: Evidence[]; notes: string[] };
export type CollectDeps = {
  env: Env;
  now: number;
  fetchFn?: Fetch;
  /** Hyperliquid asset contexts (routes/hl.ts getCtxs in production). */
  ctxs?: () => Promise<AssetCtx[]>;
};

// ---- Glassnode ---------------------------------------------------------------------------------------------------

const isWeekly = (u: string) => /\/the-week-onchain-week-\d+-\d{4}\/?$/i.test(u);

async function glassnodeCandidates(fetchFn: Fetch, now: number, notes: string[]): Promise<FeedItem[]> {
  try {
    const items = parseFeed(await getText(`${GLASSNODE_BASE}/rss/`, fetchFn));
    if (items.length) return items;
    notes.push("Glassnode RSS was empty.");
  } catch (e) {
    notes.push(`Glassnode RSS failed (${e instanceof Error ? e.message : String(e)}).`);
  }
  try {
    const urls = sitemapUrls(await getText(`${GLASSNODE_BASE}/sitemap-posts.xml`, fetchFn)).filter(isWeekly);
    if (urls.length) return urls.slice(0, 3).map((url) => ({ title: "", url, published: null, summary: "" }));
    notes.push("Glassnode sitemap had no weekly reports.");
  } catch (e) {
    notes.push(`Glassnode sitemap failed (${e instanceof Error ? e.message : String(e)}).`);
  }
  // Last resort: guess the slug. Glassnode's number trails the ISO week it is published in by one (Week 46 came out on
  // Tuesday Nov 17, 2026, ISO week 47), so last week's number first, then this week's.
  return [now - 7 * DAY, now].map((t) => ({ title: "", url: `${GLASSNODE_BASE}/${weekOnchainSlug(t)}/`, published: null, summary: "" }));
}

export async function collectGlassnode(deps: CollectDeps): Promise<CollectResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const notes: string[] = [];
  const collected = new Date(deps.now).toISOString();
  const all = await glassnodeCandidates(fetchFn, deps.now, notes);
  // The newest weekly report, plus other posts from the last 8 days (at most 3 pages in all).
  const recent = (i: FeedItem) => !i.published || deps.now - Date.parse(i.published) < 8 * DAY;
  const weekly = all.filter((i) => isWeekly(i.url));
  const picks = [...weekly.slice(0, 1), ...all.filter((i) => !isWeekly(i.url) && recent(i)).slice(0, 2)];
  if (!weekly.length) notes.push("No Glassnode weekly report found.");
  const evidence: Evidence[] = [];
  for (const it of picks) {
    const r = await settle(getText(it.url, fetchFn));
    if (!r.ok) {
      notes.push(`Glassnode ${it.url} failed (${r.error}).`);
      continue;
    }
    const text = articleText(r.value);
    if (text.length < 400) {
      notes.push(`Glassnode ${it.url} had too little text to read.`);
      continue;
    }
    const url = cleanUrl(it.url);
    evidence.push({
      id: evidenceId("glassnode", url, collected),
      source: "glassnode",
      kind: "onchain_research",
      title: it.title || pageTitle(r.value) || "Glassnode report",
      url,
      published: it.published,
      collected,
      text,
    });
  }
  return { evidence, notes };
}

// ---- Other feeds -------------------------------------------------------------------------------------------------

export const feedList = (env: Env) =>
  (env.REGIME_FEEDS ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^https:\/\//i.test(s))
    .slice(0, 12);

export async function collectFeeds(deps: CollectDeps): Promise<CollectResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const notes: string[] = [];
  const evidence: Evidence[] = [];
  const collected = new Date(deps.now).toISOString();
  for (const feed of feedList(deps.env)) {
    const r = await settle(getText(feed, fetchFn));
    if (!r.ok) {
      notes.push(`Feed ${hostOf(feed)} failed (${r.error}).`);
      continue;
    }
    const items = parseFeed(r.value).filter((i) => !i.published || deps.now - Date.parse(i.published) < 8 * DAY).slice(0, 3);
    for (const it of items) {
      const url = cleanUrl(it.url);
      const def = sourceFor("", url);
      const source = def?.id ?? `web:${hostOf(url)}`;
      evidence.push({ id: evidenceId(source, url, collected), source, kind: def?.kind ?? "analyst", title: it.title, url, published: it.published, collected, text: it.summary || it.title });
    }
  }
  return { evidence, notes };
}

// ---- The Weekly Tape in Notion -----------------------------------------------------------------------------------

type NotionBlock = { id: string; type: string; has_children?: boolean; [k: string]: unknown };
const richText = (rt: unknown): string => (Array.isArray(rt) ? rt.map((t) => (t && typeof t === "object" ? String((t as { plain_text?: string }).plain_text ?? "") : "")).join("") : "");

function blockLine(b: NotionBlock): string {
  const body = b[b.type] as Record<string, unknown> | undefined;
  if (!body) return "";
  if (b.type === "table_row") return `| ${(Array.isArray(body.cells) ? body.cells : []).map(richText).join(" | ")} |`;
  const t = richText(body.rich_text);
  if (!t) return "";
  if (b.type.startsWith("heading_")) return `\n${"#".repeat(Number(b.type.slice(-1)) + 1)} ${t}`;
  if (b.type === "bulleted_list_item" || b.type === "numbered_list_item" || b.type === "to_do") return `- ${t}`;
  return t;
}

export async function notionText(token: string, pageId: string, fetchFn: Fetch = fetch, maxChars = 30_000): Promise<string> {
  const headers = { authorization: `Bearer ${token}`, "notion-version": "2022-06-28" };
  const lines: string[] = [];
  let size = 0;
  const walk = async (id: string, depth: number) => {
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) });
      const page = await getJson<{ results: NotionBlock[]; has_more: boolean; next_cursor: string | null }>(`https://api.notion.com/v1/blocks/${id}/children?${q}`, { headers }, fetchFn);
      for (const b of page.results) {
        const l = blockLine(b);
        if (l) {
          lines.push(l);
          size += l.length;
        }
        if (size > maxChars) return;
        if (b.has_children && depth < 3 && b.type !== "child_page" && b.type !== "child_database") await walk(b.id, depth + 1);
      }
      cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
    } while (cursor && size <= maxChars);
  };
  await walk(pageId.replace(/-/g, ""), 0);
  return lines.join("\n").trim().slice(0, maxChars);
}

/** A short stable hash so an edited page reads as new evidence and an unchanged one does not. */
export function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export async function collectNotion(deps: CollectDeps): Promise<CollectResult> {
  const token = deps.env.NOTION_TOKEN?.trim();
  const page = deps.env.REGIME_NOTION_PAGE_ID?.trim();
  if (!token || !page) return { evidence: [], notes: [] };
  const r = await settle(notionText(token, page, deps.fetchFn ?? fetch));
  if (!r.ok) return { evidence: [], notes: [`Notes page (Notion) failed (${r.error}).`] };
  if (!r.value) return { evidence: [], notes: ["Notes page (Notion) was empty or not shared with the integration."] };
  const collected = new Date(deps.now).toISOString();
  return {
    evidence: [{ id: `weekly-tape:${hash(r.value)}`, source: "weekly-tape", kind: "own_notes", title: "The Weekly Tape (own notes)", url: null, published: null, collected, text: r.value }],
    notes: [],
  };
}

// ---- Market snapshot ---------------------------------------------------------------------------------------------

type Snap = Omit<Evidence, "id" | "collected" | "published">;

async function deribit(fetchFn: Fetch, now: number): Promise<Snap> {
  const base = "https://www.deribit.com/api/v2/public";
  const [dvol, book] = await Promise.all([
    getJson<{ result: { data: [number, number, number, number, number][] } }>(`${base}/get_volatility_index_data?currency=BTC&start_timestamp=${now - 9 * DAY}&end_timestamp=${now}&resolution=86400`, {}, fetchFn),
    getJson<{ result: (OptionSummary & { instrument_name: string; open_interest: number })[] }>(`${base}/get_book_summary_by_currency?currency=BTC&kind=option`, {}, fetchFn),
  ]);
  const d = dvol.result.data;
  const last = d.at(-1)?.[4] ?? null;
  const weekAgo = d.length > 7 ? d.at(-8)![4] : d[0]?.[4] ?? null;
  let puts = 0;
  let calls = 0;
  const byStrike = new Map<string, number>();
  for (const o of book.result) {
    const m = /^BTC-([0-9A-Z]+)-(\d+)-([CP])$/.exec(o.instrument_name);
    if (!m) continue;
    if (m[3] === "P") puts += o.open_interest;
    else calls += o.open_interest;
    const k = `${m[2]}${m[3]}`;
    byStrike.set(k, (byStrike.get(k) ?? 0) + o.open_interest);
  }
  const top = [...byStrike.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${Number(k.slice(0, -1)) / 1000}K ${k.endsWith("P") ? "puts" : "calls"} ${Math.round(v).toLocaleString("en-US")} BTC`);
  const pc = calls > 0 ? r2(puts / calls) : null;
  const skew = optionSkew(book.result, now);
  return {
    source: "deribit",
    kind: "derivatives",
    title: "Deribit BTC options: DVOL, open interest and skew",
    url: null,
    text: `BTC DVOL ${last ?? "n/a"}${weekAgo != null && last != null ? ` (a week ago ${weekAgo})` : ""}. Option open interest put/call ${pc ?? "n/a"} (${Math.round(puts).toLocaleString("en-US")} BTC puts, ${Math.round(calls).toLocaleString("en-US")} BTC calls). Largest strikes: ${top.join("; ") || "n/a"}.${skew ? ` Skew: ${skew.text}` : ""}`,
    data: { dvol: last, dvol_week_ago: weekAgo, put_call_oi: pc, put_oi_btc: Math.round(puts), call_oi_btc: Math.round(calls), ...(skew?.data ?? {}) },
  };
}

async function fearGreed(fetchFn: Fetch): Promise<Snap> {
  const j = await getJson<{ data: { value: string; value_classification: string; timestamp: string }[] }>("https://api.alternative.me/fng/?limit=8", {}, fetchFn);
  const [now, , , , , , , wk] = j.data;
  return {
    source: "fear-greed",
    kind: "sentiment",
    title: "Crypto Fear & Greed Index",
    url: null,
    text: `Fear & Greed ${now?.value ?? "n/a"} (${now?.value_classification ?? "n/a"})${wk ? `, a week ago ${wk.value} (${wk.value_classification})` : ""}.`,
    data: { value: now ? Number(now.value) : null, week_ago: wk ? Number(wk.value) : null },
  };
}

async function stablecoins(fetchFn: Fetch): Promise<Snap> {
  const rows = await getJson<{ date: string; totalCirculatingUSD?: { peggedUSD?: number } }[]>("https://stablecoins.llama.fi/stablecoincharts/all", {}, fetchFn);
  const v = (i: number) => rows.at(i)?.totalCirculatingUSD?.peggedUSD ?? null;
  const now = v(-1);
  const pct = (then: number | null) => (now && then ? r2((now / then - 1) * 100) : null);
  const d7 = pct(v(-8));
  const d30 = pct(v(-31));
  const d90 = pct(v(-91));
  const date = rows.at(-1) ? new Date(Number(rows.at(-1)!.date) * 1000).toISOString().slice(0, 10) : null;
  return {
    source: "defillama",
    kind: "flows",
    title: "Stablecoin supply (DefiLlama)",
    url: null,
    text: `USD stablecoin supply $${now ? r2(now / 1e9) : "n/a"}B on ${date ?? "n/a"}: ${d7 ?? "n/a"}% over 7 days, ${d30 ?? "n/a"}% over 30, ${d90 ?? "n/a"}% over 90.`,
    data: { supply_usd_bn: now ? r2(now / 1e9) : null, change_7d_pct: d7, change_30d_pct: d30, change_90d_pct: d90, as_of: date },
  };
}

async function coingecko(fetchFn: Fetch): Promise<Snap> {
  const j = await getJson<{ data: { market_cap_percentage: Record<string, number>; total_market_cap: Record<string, number>; market_cap_change_percentage_24h_usd: number } }>("https://api.coingecko.com/api/v3/global", {}, fetchFn);
  const btc = j.data.market_cap_percentage.btc ?? null;
  const eth = j.data.market_cap_percentage.eth ?? null;
  const cap = j.data.total_market_cap.usd ?? null;
  return {
    source: "coingecko",
    kind: "sentiment",
    title: "Crypto market cap and dominance (CoinGecko)",
    url: null,
    text: `Total crypto market cap $${cap ? r2(cap / 1e12) : "n/a"}T (${r2(j.data.market_cap_change_percentage_24h_usd ?? 0)}% in 24 h). BTC dominance ${btc != null ? r2(btc) : "n/a"}%, ETH ${eth != null ? r2(eth) : "n/a"}%.`,
    data: { total_cap_usd_tn: cap ? r2(cap / 1e12) : null, btc_dominance_pct: btc != null ? r2(btc) : null, eth_dominance_pct: eth != null ? r2(eth) : null },
  };
}

async function coinbasePremium(fetchFn: Fetch, hlBtc: number | null): Promise<Snap> {
  const t = await getJson<{ price: string }>("https://api.exchange.coinbase.com/products/BTC-USD/ticker", {}, fetchFn);
  const cb = Number(t.price);
  const prem = hlBtc && cb ? r2((cb / hlBtc - 1) * 100) : null;
  return {
    source: "coinbase-premium",
    kind: "sentiment",
    title: "Coinbase BTC-USD vs Hyperliquid BTC perp",
    url: null,
    text: `Coinbase BTC-USD ${cb || "n/a"} vs Hyperliquid BTC perp mark ${hlBtc ?? "n/a"}: ${prem ?? "n/a"}% (a rough Coinbase premium; the perp carries its own basis).`,
    data: { coinbase: cb || null, hl_mark: hlBtc, premium_pct: prem },
  };
}

// ---- The metrics Glassnode quotes ---------------------------------------------------------------------------------

const BG_BASE = "https://bitcoin-data.com/v1";

/** STH/LTH cost basis, STH-SOPR, NUPL and ETF flows. Keyless quota is small (about 15 calls a day); a token lifts it. */
async function onchain(fetchFn: Fetch, env: Env, price: number | null): Promise<{ snap: Snap | null; notes: string[] }> {
  const token = env.BGEOMETRICS_TOKEN?.trim();
  const series: Partial<Record<OnchainMetric, Row[]>> = {};
  const notes: string[] = [];
  for (let i = 0; i < ONCHAIN_METRICS.length; i++) {
    const m = ONCHAIN_METRICS[i]!;
    let r: Response;
    try {
      r = await fetchFn(`${BG_BASE}/${m}${token ? `?token=${encodeURIComponent(token)}` : ""}`, { signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      notes.push(`bitcoin-data ${m} failed (${e instanceof Error ? e.message : String(e)}).`);
      continue;
    }
    if (r.status === 429) {
      notes.push(`bitcoin-data rate limited; missing ${ONCHAIN_METRICS.slice(i).join(", ")}.`);
      break;
    }
    if (!r.ok) {
      notes.push(`bitcoin-data ${m} ${r.status}.`);
      continue;
    }
    const rows = bgRows(await r.json());
    if (rows.length) series[m] = rows;
    else notes.push(`bitcoin-data ${m}: no rows.`);
  }
  const read = onchainRead(series, price);
  if (!read.text) return { snap: null, notes: notes.length ? notes : ["bitcoin-data returned nothing."] };
  return { snap: { source: "bitcoin-data", kind: "onchain_research", title: "On-chain cost basis: STH/LTH realized price, STH-SOPR, NUPL, ETF flows", url: null, text: read.text, data: read.data }, notes };
}

const CM = `${CM_BASE}?assets=btc&frequency=1d&page_size=45&paging_from=end`;

async function coinmetrics(fetchFn: Fetch): Promise<{ snap: Snap | null; notes: string[] }> {
  const notes: string[] = [];
  const [val, flow] = await Promise.all([
    settle(getJson<unknown>(`${CM}&metrics=PriceUSD,CapMrktCurUSD,CapMVRVCur`, {}, fetchFn)),
    settle(getJson<unknown>(`${CM}&metrics=FlowInExNtv,FlowOutExNtv`, {}, fetchFn)),
  ]);
  const v = val.ok ? valuationRead(cmValuation(val.value).rows) : null;
  if (!val.ok) notes.push(`CoinMetrics valuation failed (${val.error}).`);
  const f = flow.ok ? exchangeFlowRead(flow.value) : null;
  if (!f) notes.push(`CoinMetrics exchange flows unavailable${flow.ok ? "" : ` (${flow.error})`}; exchange flows come from web search only.`);
  if (!v?.text && !f) return { snap: null, notes };
  return {
    snap: { source: "coinmetrics", kind: "onchain_research", title: "Realized price, MVRV and exchange flows (CoinMetrics community)", url: null, text: [v?.text, f?.text].filter(Boolean).join(" "), data: { ...(v?.data ?? {}), ...(f?.data ?? {}) } },
    notes,
  };
}

const POSITIONING_COINS = ["BTC", "ETH"] as const;
const apr = (rate: number, hours: number) => (rate / hours) * 24 * 365 * 100;

async function binanceFunding(fetchFn: Fetch): Promise<Map<string, number>> {
  const [prem, info] = await Promise.all([
    getJson<Array<{ symbol: string; lastFundingRate: string }>>("https://fapi.binance.com/fapi/v1/premiumIndex", {}, fetchFn),
    getJson<Array<{ symbol: string; fundingIntervalHours: number }>>("https://fapi.binance.com/fapi/v1/fundingInfo", {}, fetchFn).catch(() => []),
  ]);
  const hours = new Map(info.map((x) => [x.symbol, x.fundingIntervalHours]));
  return new Map(prem.filter((p) => Number.isFinite(Number(p.lastFundingRate))).map((p) => [p.symbol, apr(Number(p.lastFundingRate), hours.get(p.symbol) ?? 8)]));
}

async function bybitFunding(fetchFn: Fetch): Promise<Map<string, number>> {
  const j = await getJson<{ result: { list: Array<{ symbol: string; fundingRate: string; fundingIntervalHour?: string }> } }>("https://api.bybit.com/v5/market/tickers?category=linear", {}, fetchFn);
  return new Map(j.result.list.filter((t) => t.fundingRate && Number.isFinite(Number(t.fundingRate))).map((t) => [t.symbol, apr(Number(t.fundingRate), Number(t.fundingIntervalHour) || 8)]));
}

type OkxWrap<T> = { code: string; msg?: string; data: T };
async function okx<T>(path: string, fetchFn: Fetch): Promise<T> {
  const r = await getJson<OkxWrap<T>>(`https://www.okx.com${path}`, {}, fetchFn);
  if (r.code !== "0") throw new Error(`okx ${r.code} ${r.msg ?? ""}`.trim());
  return r.data;
}

async function okxFunding(coin: string, fetchFn: Fetch): Promise<number> {
  const [d] = await okx<Array<{ fundingRate: string; fundingTime: string; nextFundingTime: string }>>(`/api/v5/public/funding-rate?instId=${coin}-USDT-SWAP`, fetchFn);
  if (!d) throw new Error("okx: no funding");
  return apr(Number(d.fundingRate), Math.round((Number(d.nextFundingTime) - Number(d.fundingTime)) / 3_600_000) || 8);
}

/** Filled liquidations OKX publishes for the coin's USDT swap over the last 24 h (or the span the feed covers). */
async function okxLiquidations(coin: string, mark: number, fetchFn: Fetch, now: number): Promise<{ hours: number; longUsd: number; shortUsd: number }> {
  const [inst, rows] = await Promise.all([
    okx<Array<{ ctVal: string }>>(`/api/v5/public/instruments?instType=SWAP&instId=${coin}-USDT-SWAP`, fetchFn),
    okx<Array<{ details: Array<{ posSide: string; side: string; sz: string; bkPx: string; ts: string }> }>>(`/api/v5/public/liquidation-orders?instType=SWAP&uly=${coin}-USDT&state=filled`, fetchFn),
  ]);
  const ctVal = Number(inst[0]?.ctVal) || 0;
  let longUsd = 0;
  let shortUsd = 0;
  let oldest = now;
  for (const d of rows)
    for (const x of d.details) {
      const ts = Number(x.ts);
      if (ts < now - DAY) continue;
      const usd = Number(x.sz) * ctVal * (Number(x.bkPx) || mark);
      // A liquidated long is closed by a sell.
      if (x.posSide === "long" || (x.posSide === "net" && x.side === "sell")) longUsd += usd;
      else shortUsd += usd;
      oldest = Math.min(oldest, ts);
    }
  return { hours: r2((now - oldest) / 3_600_000), longUsd, shortUsd };
}

/** OI change over `hours` from Binance's hourly history: the last point against the nearest one at or before. */
export function oiChangeFrom(points: Row[], hours: number): number | null {
  const last = points.at(-1);
  if (!last) return null;
  const target = last.t - hours * 3_600_000;
  const ref = [...points].reverse().find((p) => p.t <= target + 5 * 60_000);
  if (!ref || last.t - ref.t < hours * 3_600_000 * 0.8 || !ref.v) return null;
  return last.v / ref.v - 1;
}

async function binanceOi(coin: string, fetchFn: Fetch): Promise<Row[]> {
  const rows = await getJson<Array<{ sumOpenInterest: string; timestamp: number }>>(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${coin}USDT&period=1h&limit=170`, {}, fetchFn);
  return rows.map((r) => ({ t: r.timestamp, v: Number(r.sumOpenInterest) })).filter((p) => p.v > 0).sort((a, b) => a.t - b.t);
}

/** Funding by venue, OI change, liquidations for BTC and ETH. Binance and Bybit refuse some regions; each gap is skipped. */
async function positioning(fetchFn: Fetch, ctxs: AssetCtx[], now: number): Promise<Snap> {
  const [bin, byb] = await Promise.all([settle(binanceFunding(fetchFn)), settle(bybitFunding(fetchFn))]);
  const lines: string[] = [];
  const data: Record<string, number | null> = {};
  const pct = (x: number | null) => (x == null ? "n/a" : `${r2(x * 100)}%`);
  for (const coin of POSITIONING_COINS) {
    const ctx = ctxs.find((c) => c.name === coin);
    const [okf, liq, oi] = await Promise.all([settle(okxFunding(coin, fetchFn)), ctx ? settle(okxLiquidations(coin, ctx.markPx, fetchFn, now)) : Promise.resolve(null), settle(binanceOi(coin, fetchFn))]);
    const quotes: [string, number][] = [];
    if (ctx) quotes.push(["hyperliquid", ctx.funding * 24 * 365 * 100]);
    const b = bin.ok ? bin.value.get(`${coin}USDT`) : undefined;
    if (b != null) quotes.push(["binance", b]);
    const y = byb.ok ? byb.value.get(`${coin}USDT`) : undefined;
    if (y != null) quotes.push(["bybit", y]);
    if (okf.ok) quotes.push(["okx", okf.value]);
    const d1 = oi.ok ? oiChangeFrom(oi.value, 24) : null;
    const d7 = oi.ok ? oiChangeFrom(oi.value, 7 * 24 - 2) : null;
    const parts = [`funding ${quotes.map(([v, a]) => `${v} ${r2(a)}%`).join(", ") || "n/a"} APR`];
    if (d1 != null || d7 != null) parts.push(`OI ${pct(d1)} over 24 h, ${pct(d7)} over 7 days (binance)`);
    if (liq?.ok) parts.push(`OKX liquidations ${Math.round(liq.value.hours)} h: longs $${r2(liq.value.longUsd / 1e6)}M, shorts $${r2(liq.value.shortUsd / 1e6)}M`);
    lines.push(`${coin}: ${parts.join("; ")}`);
    const lc = coin.toLowerCase();
    data[`${lc}_funding_apr_mean`] = quotes.length ? r2(quotes.reduce((s, [, a]) => s + a, 0) / quotes.length) : null;
    data[`${lc}_oi_chg_24h_pct`] = d1 != null ? r2(d1 * 100) : null;
    data[`${lc}_oi_chg_7d_pct`] = d7 != null ? r2(d7 * 100) : null;
    data[`${lc}_liq_long_usd_m`] = liq?.ok ? r2(liq.value.longUsd / 1e6) : null;
    data[`${lc}_liq_short_usd_m`] = liq?.ok ? r2(liq.value.shortUsd / 1e6) : null;
  }
  return { source: "perp-positioning", kind: "derivatives", title: "Perp positioning: funding by venue, OI change, liquidations", url: null, text: `${lines.join(". ")}.`, data };
}

async function orderBooks(fetchFn: Fetch): Promise<Snap> {
  const [cb, hl] = await Promise.all([
    settle(getJson<{ bids: [string, string, number][]; asks: [string, string, number][] }>("https://api.exchange.coinbase.com/products/BTC-USD/book?level=2", {}, fetchFn)),
    settle(hlInfo<{ levels: [{ px: string; sz: string }[], { px: string; sz: string }[]] }>({ type: "l2Book", coin: "BTC", nSigFigs: 3 }, fetchFn)),
  ]);
  const lv = (rows: Array<[string, string, ...unknown[]]>): Level[] => rows.map((r) => [Number(r[0]), Number(r[1])] as Level).filter(([p, q]) => p > 0 && q > 0);
  const parts: string[] = [];
  const data: Record<string, number | null> = {};
  if (cb.ok) {
    const d = bookDepth(lv(cb.value.bids), lv(cb.value.asks));
    if (d) {
      parts.push(depthLine("Coinbase BTC-USD", d));
      for (const b of d.bands) data[`coinbase_bid_share_${b.pct}pct`] = b.bidShare;
      data.coinbase_bids_2pct_usd_m = r2(d.bands[1]!.bidUsd / 1e6);
    }
  }
  if (hl.ok) {
    const side = (x: { px: string; sz: string }[]): Level[] => x.map((l) => [Number(l.px), Number(l.sz)] as Level);
    const d = bookDepth(side(hl.value.levels[0]), side(hl.value.levels[1]), [0.01, 0.02]);
    if (d) {
      parts.push(depthLine("Hyperliquid BTC perp (20 levels, $100 buckets)", d));
      data.hl_bid_share_2pct = d.bands[1]!.bidShare;
    }
  }
  if (!parts.length) throw new Error(`no book (${[cb, hl].map((r) => (r.ok ? "empty" : r.error)).join("; ")})`);
  return { source: "orderbook", kind: "flows", title: "BTC order book depth near the mid (Coinbase, Hyperliquid)", url: null, text: `${parts.join(". ")}.`, data };
}

/** The macro radar's digest, as the routine reads it: one line per topic, each value dated, failed sources named. */
async function macroRadar(fetchFn: Fetch, now: number): Promise<Snap> {
  const m = await collectMacro(fetchFn, new Date(now));
  const lines = macroLines(m, new Date(now));
  const got = Object.keys(m.fred).length + Object.keys(m.yahoo).length + (m.tga ? 1 : 0) + (m.odds ? 1 : 0);
  if (!got) throw new Error(`every macro source failed (${m.gaps.length})`);
  return { source: "macro-radar", kind: "macro", title: "Macro radar: Fed policy, yields, liquidity, credit, volatility, the dollar, Fed odds", url: null, text: lines.join("\n") };
}

/** FOMC, CPI and NFP over the next three weeks from this repo's schedule, plus this week's US calendar with forecasts. */
async function macroCalendar(fetchFn: Fetch, now: number): Promise<Snap> {
  const own = calendarEvents(new Date(now), new Date(now))
    .filter((e) => e.scheduledAt && Date.parse(e.scheduledAt) < now + 21 * DAY)
    .map((e) => `${e.scheduledAt!.slice(0, 16).replace("T", " ")} UTC ${e.title}`);
  const ff = await settle(getJson<Array<{ title: string; country: string; date: string; impact: string; forecast?: string; previous?: string }>>("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {}, fetchFn));
  const week = ff.ok
    ? ff.value
        .filter((r) => r.country === "USD" && (r.impact === "High" || r.impact === "Medium"))
        .map((r) => ({ ...r, t: Date.parse(r.date) }))
        .filter((r) => Number.isFinite(r.t))
        .sort((a, b) => a.t - b.t)
        .slice(0, 14)
        .map((r) => `${new Date(r.t).toISOString().slice(0, 16).replace("T", " ")} UTC ${r.title} (${r.impact}${r.forecast ? `, forecast ${r.forecast}` : ""}${r.previous ? `, previous ${r.previous}` : ""})${r.t < now ? " [out]" : ""}`)
    : [];
  if (!own.length && !week.length) throw new Error(`no events${ff.ok ? "" : ` (${ff.error})`}`);
  const text = [own.length ? `Scheduled: ${own.join("; ")}.` : "", week.length ? `This week (US, high and medium impact): ${week.join("; ")}.` : ""].filter(Boolean).join(" ");
  return { source: "macro-calendar", kind: "macro", title: "US macro calendar", url: null, text };
}

export const HL_CYCLES_BASE = "https://hl-cycles-one.vercel.app/api";

/** The hl-cycles BTC regime dashboard the routine reads: regime state, cycle levels, compass. */
async function hlCycles(fetchFn: Fetch, now: number): Promise<Snap> {
  const [vector, health] = await Promise.all([getJson<unknown>(`${HL_CYCLES_BASE}/vector.json`, {}, fetchFn), getJson<unknown>(`${HL_CYCLES_BASE}/health.json`, {}, fetchFn).catch(() => null)]);
  const c = condenseHlCycles(vector, health, new Date(now));
  const parts: string[] = [];
  if (c.regime) parts.push(`Regime ${c.regime.state}${c.regime.since ? ` since ${c.regime.since}` : ""}${c.regime.allocation != null ? `, allocation ${c.regime.allocation}` : ""}`);
  if (c.levels.length) parts.push(`Levels: ${c.levels.map((l) => `${l.label} ${l.value}${l.distancePct != null ? ` (${r2(l.distancePct)}% away)` : ""}${l.status ? ` ${l.status}` : ""}`).join("; ")}`);
  if (c.compass) parts.push(`Compass ${c.compass.score ?? "n/a"} (${c.compass.band ?? "n/a"}; 7 d ${c.compass.d7 ?? "n/a"}, 30 d ${c.compass.d30 ?? "n/a"})`);
  if (!parts.length) throw new Error("empty vector");
  return {
    source: "hl-cycles",
    kind: "onchain_research",
    title: "hl-cycles BTC regime dashboard",
    url: null,
    text: `${parts.join(". ")}. As of ${c.asOf ?? "n/a"}${c.stale ? ` (STALE, last refresh ${c.lastRefreshAgeH} h ago)` : ""}.`,
    data: { regime: c.regime?.state ?? null, compass: c.compass?.score ?? null, as_of: c.asOf, stale: c.stale ? "yes" : "no" },
  };
}

function hyperliquid(ctxs: AssetCtx[]): Snap {
  const want = new Set<string>(REGIME_COINS);
  const lines = ctxs
    .filter((c) => want.has(c.name))
    .map((c) => {
      const move = c.prevDayPx > 0 ? r2((c.markPx / c.prevDayPx - 1) * 100) : null;
      return `${c.name} ${c.markPx} (${move ?? "n/a"}% 24 h), funding ${r2(c.funding * 24 * 365 * 100)}% APR, OI $${r2((c.openInterest * c.markPx) / 1e6)}M`;
    });
  return { source: "hyperliquid", kind: "derivatives", title: "Hyperliquid perps: price, funding, open interest", url: null, text: lines.join("; ") + "." };
}

export async function collectMarket(deps: CollectDeps): Promise<CollectResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const collected = new Date(deps.now).toISOString();
  const notes: string[] = [];
  const hl = deps.ctxs ? await settle(deps.ctxs()) : ({ ok: false, error: "no Hyperliquid source wired" } as const);
  const hlBtc = hl.ok ? (hl.value.find((c) => c.name === "BTC")?.markPx ?? null) : null;
  const jobs: [string, Promise<Snap>][] = [
    ["Deribit", deribit(fetchFn, deps.now)],
    ["Fear & Greed", fearGreed(fetchFn)],
    ["DefiLlama", stablecoins(fetchFn)],
    ["CoinGecko", coingecko(fetchFn)],
    ["Coinbase", coinbasePremium(fetchFn, hlBtc)],
    ["Order books", orderBooks(fetchFn)],
    ["Macro radar", macroRadar(fetchFn, deps.now)],
    ["Macro calendar", macroCalendar(fetchFn, deps.now)],
    ["hl-cycles", hlCycles(fetchFn, deps.now)],
    ...(hl.ok ? [["Perp positioning", positioning(fetchFn, hl.value, deps.now)] as [string, Promise<Snap>]] : []),
  ];
  // Settle every job now, so none rejects unobserved while an earlier one is awaited.
  const settled = jobs.map(([name, p]) => [name, settle(p)] as const);
  const metricJobs = Promise.all([onchain(fetchFn, deps.env, hlBtc), coinmetrics(fetchFn)]);
  const snaps: Snap[] = [];
  if (hl.ok) snaps.push(hyperliquid(hl.value));
  else notes.push(`Hyperliquid failed (${hl.error}).`);
  for (const [name, p] of settled) {
    const r = await p;
    if (r.ok) snaps.push(r.value);
    else notes.push(`${name} failed (${r.error}).`);
  }
  for (const m of await metricJobs) {
    if (m.snap) snaps.push(m.snap);
    notes.push(...m.notes);
  }
  return { evidence: snaps.map((s) => ({ ...s, id: evidenceId(s.source, null, collected), published: collected, collected })), notes };
}

/** Every collector, side by side. */
export async function collectAll(deps: CollectDeps): Promise<CollectResult> {
  const parts = await Promise.all([collectGlassnode(deps), collectFeeds(deps), collectNotion(deps), collectMarket(deps)]);
  return { evidence: parts.flatMap((p) => p.evidence), notes: parts.flatMap((p) => p.notes) };
}
