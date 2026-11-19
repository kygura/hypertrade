// The regime thesis's collectors (docs/REGIME.md): everything the thesis reads before the model searches the web on
// its own. Each one is keyless and optional; a failure is a note, never a failed run. The same collectors as
// tradespace's src/intel/collect.ts, wired to this repo's Hyperliquid contexts.
//   glassnode   the newest "Week On-chain" report and other posts from the last 8 days, full text (RSS, then the
//               Ghost sitemap, then this and last ISO week's URL guessed from the slug)
//   feeds       REGIME_FEEDS: more RSS/Atom feeds, comma-separated (recent items, summary only)
//   notion      a notes page (REGIME_NOTION_PAGE_ID with NOTION_TOKEN), counted as one light source
//   market      one data snapshot per source: Deribit DVOL and options OI, Fear & Greed, DefiLlama stablecoin supply,
//               CoinGecko dominance, Coinbase vs Hyperliquid BTC price, Hyperliquid funding/OI
import type { AssetCtx } from "../../shared/types.js";
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
    getJson<{ result: { instrument_name: string; open_interest: number }[] }>(`${base}/get_book_summary_by_currency?currency=BTC&kind=option`, {}, fetchFn),
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
  return {
    source: "deribit",
    kind: "derivatives",
    title: "Deribit BTC options: DVOL and open interest",
    url: null,
    text: `BTC DVOL ${last ?? "n/a"}${weekAgo != null && last != null ? ` (a week ago ${weekAgo})` : ""}. Option open interest put/call ${pc ?? "n/a"} (${Math.round(puts).toLocaleString("en-US")} BTC puts, ${Math.round(calls).toLocaleString("en-US")} BTC calls). Largest strikes: ${top.join("; ") || "n/a"}.`,
    data: { dvol: last, dvol_week_ago: weekAgo, put_call_oi: pc, put_oi_btc: Math.round(puts), call_oi_btc: Math.round(calls) },
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
  ];
  const snaps: Snap[] = [];
  if (hl.ok) snaps.push(hyperliquid(hl.value));
  else notes.push(`Hyperliquid failed (${hl.error}).`);
  for (const [name, p] of jobs) {
    const r = await settle(p);
    if (r.ok) snaps.push(r.value);
    else notes.push(`${name} failed (${r.error}).`);
  }
  return { evidence: snaps.map((s) => ({ ...s, id: evidenceId(s.source, null, collected), published: collected, collected })), notes };
}

/** Every collector, side by side. */
export async function collectAll(deps: CollectDeps): Promise<CollectResult> {
  const parts = await Promise.all([collectGlassnode(deps), collectFeeds(deps), collectNotion(deps), collectMarket(deps)]);
  return { evidence: parts.flatMap((p) => p.evidence), notes: parts.flatMap((p) => p.notes) };
}
