import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation, LLMProvider, StepResult } from "../llm/provider.js";
import { llmDeps } from "../intel/fixtures/emit-provider.js";
import { createRegimeRoutes } from "../routes/intel/regime.js";
import { RegimeFeedSchema } from "../../shared/regime/schema.js";
import type { Evidence } from "../../shared/regime/types.js";
import type { AssetCtx } from "../../shared/types.js";
import { collectGlassnode, collectMarket, collectNotion, oiChangeFrom } from "./collect.js";
import { seedRegime, updateRegime, type RegimeDeps, type SeedFile } from "./run.js";
import { REGIME_LOCK_STALE_MS, defaultRegimeStore, fileRegimeStore, memoryRegimeStore, type RegimeStore } from "./store.js";

// The regime thesis around the core (docs/REGIME.md): the store twins against one contract, the seed, a full rewrite
// through completeStructured against a scripted provider (hosted search results feed the URL check), the collectors
// against a fake fetch, and GET /api/intel/regime. No network, no database (pgRegimeStore shares the contract; its SQL
// runs against Postgres in the deployed workflow).

const NOW = new Date(Date.UTC(2026, 10, 19, 6, 53));
const iso = NOW.toISOString();
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const tmpFile = async () => {
  const d = await mkdtemp(join(tmpdir(), "regime-"));
  dirs.push(d);
  return join(d, "regime.json");
};

/** A made-up seed: the real one (his notes) never enters this public repo. */
const SEED: SeedFile = {
  created: "2026-11-18T12:00:00Z",
  phase: "Range low under test",
  stance: "defensive",
  conviction: "medium",
  tldr: "Price sits on a support block; flows are soft.",
  source_reads: [
    { source: "glassnode", name: "Glassnode", kind: "onchain_research", lean: 0, confidence: 0.8, claim: "Support meets capitulation.", url: "https://research.glassnode.com/the-week-onchain-week-46-2026/", as_of: "2026-11-17" },
    { source: "farside", name: "Farside", kind: "flows", lean: -1, confidence: 0.7, claim: "Outflows.", url: null, as_of: null },
  ],
  changelog: "Seeded.",
  history: [
    { created: "2026-11-11T12:00:00Z", version: 0, phase: "Floor giving way", stance: "neutral", conviction: "low", consensus: null, changelog: "Earlier notes." },
    { created: "2026-11-04T12:00:00Z", version: 0, phase: "Bottom-building", stance: "neutral", conviction: "low", consensus: null, changelog: "Older notes." },
  ],
};

const DRAFT = {
  phase: "Capitulation, base forming above $60K",
  stance: "defensive",
  conviction: "medium",
  tldr: "BTC holds the support block.",
  macro: "Yields high.",
  alts: "Washout.",
  key_levels: [{ metric: "STH cost basis", level: "$74.1K", price: 74100, meaning: "Bottom confirmation", status: "lost", sources: ["glassnode"], as_of: "2026-11-17" }],
  lines: [{ kind: "bear_trigger", text: "Daily close below $62K", price: 62000 }],
  scenarios: [{ name: "Base", probability: 0.6, path: "Hold", trigger: "Bids hold" }],
  source_reads: [
    { source: "glassnode", name: "Glassnode", kind: "onchain_research", lean: 0, confidence: 0.9, claim: "Capitulation meets support.", url: "https://research.glassnode.com/the-week-onchain-week-46-2026/", as_of: "2026-11-17" },
    { source: "web:farside.co.uk", name: "Farside", kind: "flows", lean: -1, confidence: 0.7, claim: "ETF outflows continue.", url: "https://farside.co.uk/btc/", as_of: "2026-11-18" },
    { source: "made-up", name: "Invented", kind: "analyst", lean: 2, confidence: 0.5, claim: "Up only.", url: "https://invented.example/x", as_of: null },
  ],
  agreement_notes: "Flows disagree with the on-chain tone.",
  catalysts: [],
  narratives: [],
  changes: [{ what: "Phase", from: "Range low under test", to: "Capitulation", because: "Glassnode Week 46", sources: ["glassnode"] }],
  changelog: "Downgraded on the breakdown.",
  source_urls: ["https://farside.co.uk/btc/", "https://never-seen.example/"],
};

/** Answers every step by calling `emit` with `reply`, after reporting `searched` as hosted search results. */
class ScriptedProvider implements LLMProvider {
  readonly id = "anthropic" as const;
  readonly webSearch = true;
  readonly model = "claude-test";
  prompts: { system: string; user: string }[] = [];
  opts: unknown[] = [];
  constructor(
    private readonly reply: unknown,
    private readonly searched: string[] = [],
  ) {}
  start(system: string, _h: unknown[], question: string): Conversation {
    this.prompts.push({ system, user: question });
    const self = this;
    return {
      async step(_tools, hooks, opts): Promise<StepResult> {
        self.opts.push(opts);
        hooks.onSearchResults?.(self.searched.map((url) => ({ url, title: url })));
        return { stop: "tool_use", toolCalls: [{ id: "t1", name: "emit", input: self.reply }], usage: { input_tokens: 1000, output_tokens: 200 } };
      },
      addToolResults() {},
    };
  }
}

const REPORT: Evidence = { id: "glassnode:https://research.glassnode.com/the-week-onchain-week-46-2026", source: "glassnode", kind: "onchain_research", title: "Capitulation Meets Support", url: "https://research.glassnode.com/the-week-onchain-week-46-2026/", published: "2026-11-17T16:00:00.000Z", collected: iso, text: "Realized loss ".repeat(40) };
const SNAP: Evidence = { id: "fear-greed:2026-11-19", source: "fear-greed", kind: "sentiment", title: "Fear & Greed", url: null, published: iso, collected: iso, text: "Fear & Greed 11 (Extreme Fear)." };

const deps = (store: RegimeStore, provider: LLMProvider, evidence: Evidence[] = [REPORT, SNAP]): RegimeDeps => ({
  store,
  llm: llmDeps(provider),
  env: {},
  now: () => NOW,
  collect: async () => ({ evidence, notes: ["CoinGecko failed (429)."] }),
});

// ---------- store contract ----------

function behaves(name: string, make: () => Promise<RegimeStore>) {
  describe(`${name} store`, () => {
    test("seed, then versions and history newest first; refuses a second seed unless forced", async () => {
      const s = await make();
      expect(await s.thesis()).toBeNull();
      const t = await seedRegime(s, SEED, { now: NOW });
      expect(t).toMatchObject({ version: 1, model: "seed", phase: "Range low under test" });
      expect((await s.thesis())!.id).toBe(t.id);
      const h = await s.history();
      expect(h.map((x) => x.phase)).toEqual(["Range low under test", "Floor giving way", "Bottom-building"]);
      await expect(seedRegime(s, SEED, { now: NOW })).rejects.toThrow("already exists");
      const again = await seedRegime(s, SEED, { force: true, now: NOW });
      expect((await s.thesis())!.id).toBe(again.id);
      expect((await s.history()).length).toBe(4);
    });

    test("seen ids and the lock", async () => {
      const s = await make();
      await s.remember(["a", "b"], NOW);
      await s.remember(["b", "c"], NOW);
      expect([...(await s.seen())].sort()).toEqual(["a", "b", "c"]);
      expect(await s.lock(NOW)).toBe(true);
      expect(await s.lock(new Date(NOW.getTime() + 1000))).toBe(false);
      expect(await s.lock(new Date(NOW.getTime() + REGIME_LOCK_STALE_MS + 1))).toBe(true);
      await s.unlock();
      expect(await s.lock(NOW)).toBe(true);
    });
  });
}

behaves("memory", async () => memoryRegimeStore());
behaves("file", async () => fileRegimeStore(await tmpFile()));

describe("file store", () => {
  test("survives a new instance; a corrupt file throws and is left alone", async () => {
    const path = await tmpFile();
    await seedRegime(fileRegimeStore(path), SEED, { now: NOW });
    expect((await fileRegimeStore(path).thesis())!.phase).toBe("Range low under test");
    const bad = await tmpFile();
    await writeFile(bad, "{not json");
    await expect(fileRegimeStore(bad).thesis()).rejects.toThrow("corrupt");
  });

  test("defaultRegimeStore picks pg, file or memory from the environment", async () => {
    const path = await tmpFile();
    expect(defaultRegimeStore({ REGIME_STORE_FILE: path }).kind).toBe("file");
    expect(defaultRegimeStore({}).kind).toBe("memory");
    expect(defaultRegimeStore({ DATABASE_URL: "postgres://u@127.0.0.1:1/x" }).kind).toBe("pg");
  });
});

// ---------- rewrite ----------

describe("updateRegime", () => {
  test("reads the new report and the snapshot, keeps only URLs the run saw, saves v2; --if-new then skips", async () => {
    const store = memoryRegimeStore();
    await seedRegime(store, SEED, { now: new Date(NOW.getTime() - 3_600_000) });
    const p = new ScriptedProvider(DRAFT, ["https://farside.co.uk/btc/"]);
    const r = await updateRegime(deps(store, p));
    expect(r.status).toBe("written");
    if (r.status !== "written") return;
    expect(r.thesis).toMatchObject({ version: 2, model: "claude-test", phase: "Capitulation, base forming above $60K" });
    expect(r.thesis.evidence).toEqual([REPORT.id, SNAP.id]);
    expect(r.thesis.usage).toEqual({ input_tokens: 1000, output_tokens: 200, web_searches: 0 });
    expect(r.thesis.sources.map((l) => l.url).sort()).toEqual(["https://farside.co.uk/btc/", "https://research.glassnode.com/the-week-onchain-week-46-2026/"]);
    expect(r.thesis.source_reads.find((x) => x.source === "made-up")!.url).toBeNull();
    expect(r.thesis.consensus.reference).toEqual({ source: "glassnode", lean: 0 });
    // The prompt: the ask outside, the payload (previous thesis, report, notes) inside the untrusted block.
    const { system, user } = p.prompts[0]!;
    expect(system).toContain("<untrusted>");
    expect(user.startsWith("Rewrite the regime thesis")).toBe(true);
    expect(user).toContain("<untrusted>\n{");
    expect(user).toContain("Range low under test");
    expect(user).toContain("CoinGecko failed (429).");
    expect(p.opts[0]).toMatchObject({ webSearch: true, maxUses: 12 });
    expect((await store.versions()).map((v) => v.version)).toEqual([2, 1]);
    expect((await store.history())[0]!.changelog).toBe("Downgraded on the breakdown.");
    expect(await store.seen()).toEqual(new Set([REPORT.id]));
    expect(await store.lock(NOW)).toBe(true);
    await store.unlock();

    const again = await updateRegime(deps(store, new ScriptedProvider(DRAFT)), { ifNew: true });
    expect(again.status).toBe("skipped");
  });

  test("a draft that fails the schema twice fails closed and the previous version stands", async () => {
    const store = memoryRegimeStore();
    await seedRegime(store, SEED, { now: NOW });
    const r = await updateRegime(deps(store, new ScriptedProvider({ ...DRAFT, source_reads: [] })));
    expect(r.status).toBe("failed");
    expect((await store.thesis())!.version).toBe(1);
    expect(await store.lock(NOW)).toBe(true);
  });

  test("a held lock means no second run", async () => {
    const store = memoryRegimeStore();
    await store.lock(NOW);
    const r = await updateRegime(deps(store, new ScriptedProvider(DRAFT)));
    expect(r.status).toBe("locked");
  });
});

// ---------- collectors against a fake fetch ----------

const fakeFetch = (routes: Record<string, string | object | number>) =>
  (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const v = key ? routes[key]! : 404;
    if (typeof v === "number") return new Response("no", { status: v });
    return new Response(typeof v === "string" ? v : JSON.stringify(v), { status: 200 });
  }) as unknown as typeof fetch;

describe("collectors", () => {
  const now = NOW.getTime();
  test("Glassnode: the weekly report from RSS, full text", async () => {
    const page = `<html><head><title>W46</title></head><body><article><p>${"Realized loss at cycle-low levels. ".repeat(20)}</p></article></body></html>`;
    const f = fakeFetch({
      "https://research.glassnode.com/rss/": `<rss><item><title>Capitulation Meets Support</title><link>https://research.glassnode.com/the-week-onchain-week-46-2026/</link><pubDate>Tue, 17 Nov 2026 16:00:00 GMT</pubDate></item></rss>`,
      "https://research.glassnode.com/the-week-onchain-week-46-2026/": page,
    });
    const r = await collectGlassnode({ env: {}, now, fetchFn: f });
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0]).toMatchObject({ source: "glassnode", title: "Capitulation Meets Support" });
  });

  test("Glassnode: RSS and sitemap down, the ISO-week guess", async () => {
    const f = fakeFetch({ "https://research.glassnode.com/the-week-onchain-week-46-2026/": `<article>${"Week report text. ".repeat(40)}</article>` });
    const r = await collectGlassnode({ env: {}, now: Date.UTC(2026, 10, 18), fetchFn: f });
    expect(r.evidence.map((e) => e.url)).toEqual(["https://research.glassnode.com/the-week-onchain-week-46-2026/"]);
    expect(r.notes.join(" ")).toContain("RSS failed");
  });

  test("market snapshot: each source a line, failures are notes", async () => {
    const f = fakeFetch({
      "https://www.deribit.com/api/v2/public/get_volatility_index_data": { result: { data: Array.from({ length: 9 }, (_, i) => [i, 50, 55, 45, 50 + i]) } },
      "https://www.deribit.com/api/v2/public/get_book_summary_by_currency": { result: [{ instrument_name: "BTC-27NOV26-60000-P", open_interest: 3000 }, { instrument_name: "BTC-27NOV26-80000-C", open_interest: 2000 }] },
      "https://api.alternative.me/fng/": { data: [{ value: "11", value_classification: "Extreme Fear", timestamp: "1" }, ...Array.from({ length: 7 }, () => ({ value: "26", value_classification: "Fear", timestamp: "0" }))] },
      "https://stablecoins.llama.fi/stablecoincharts/all": 500,
      "https://api.coingecko.com/api/v3/global": { data: { market_cap_percentage: { btc: 58.04, eth: 9.1 }, total_market_cap: { usd: 2.1e12 }, market_cap_change_percentage_24h_usd: -1.2 } },
      "https://api.exchange.coinbase.com/products/BTC-USD/ticker": { price: "62650" },
    });
    const ctxs = async () => [{ name: "BTC", markPx: 62700, prevDayPx: 63000, funding: 0.00001, openInterest: 1000 } as AssetCtx];
    const r = await collectMarket({ env: {}, now, fetchFn: f, ctxs });
    const by = Object.fromEntries(r.evidence.map((e) => [e.source, e]));
    expect(Object.keys(by).sort()).toEqual(["coinbase-premium", "coingecko", "deribit", "fear-greed", "hyperliquid", "macro-calendar", "perp-positioning"]);
    expect(by["perp-positioning"]!.text).toContain("BTC: funding hyperliquid 8.76% APR");
    expect(by.deribit!.data).toMatchObject({ dvol: 58, put_call_oi: 1.5 });
    expect(by.hyperliquid!.text).toContain("BTC 62700");
    expect(by["coinbase-premium"]!.data).toMatchObject({ premium_pct: -0.08 });
    expect(r.notes.join(" ")).toContain("DefiLlama failed");
  });

  test("market snapshot: the metrics Glassnode quotes, from free sources", async () => {
    const day = (i: number) => Date.UTC(2026, 9, 1) + i * 86_400_000;
    const bg = (key: string, v: (i: number) => number) => Array.from({ length: 40 }, (_, i) => ({ d: new Date(day(i)).toISOString().slice(0, 10), unixTs: String(day(i) / 1000), [key]: String(v(i)) }));
    const cm = (rows: Record<string, string>[]) => ({ data: rows.map((r, i) => ({ asset: "btc", time: new Date(day(i)).toISOString(), ...r })) });
    const hour = (i: number) => now - (169 - i) * 3_600_000;
    const f = fakeFetch({
      "https://bitcoin-data.com/v1/sth-realized-price": bg("sthRealizedPrice", () => 74100),
      "https://bitcoin-data.com/v1/lth-realized-price": bg("lthRealizedPrice", () => 38000),
      "https://bitcoin-data.com/v1/sth-sopr": bg("sthSopr", (i) => (i === 39 ? 0.97 : 1.01)),
      "https://bitcoin-data.com/v1/nupl": bg("nupl", () => 0.31),
      "https://bitcoin-data.com/v1/etf-flow-btc": bg("etfFlow", () => -500),
      "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&frequency=1d&page_size=45&paging_from=end&metrics=PriceUSD": cm(Array.from({ length: 40 }, () => ({ PriceUSD: "62000", CapMrktCurUSD: "1240000000000", CapMVRVCur: "1.24" }))),
      "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&frequency=1d&page_size=45&paging_from=end&metrics=FlowIn": 403,
      "https://api.exchange.coinbase.com/products/BTC-USD/book": { bids: [["62000", "10", 1], ["61000", "20", 1]], asks: [["62010", "5", 1], ["64000", "50", 1]] },
      "https://api.hyperliquid.xyz/info": { coin: "BTC", time: now, levels: [[{ px: "61900", sz: "30", n: 3 }], [{ px: "62100", sz: "10", n: 1 }]] },
      "https://fapi.binance.com/fapi/v1/premiumIndex": [{ symbol: "BTCUSDT", lastFundingRate: "0.0001" }],
      "https://fapi.binance.com/futures/data/openInterestHist": Array.from({ length: 170 }, (_, i) => ({ timestamp: hour(i), sumOpenInterest: i === 169 ? "110" : "100" })),
      "https://www.okx.com/api/v5/public/funding-rate": { code: "0", data: [{ fundingRate: "0.0002", fundingTime: String(now), nextFundingTime: String(now + 8 * 3_600_000) }] },
      "https://www.okx.com/api/v5/public/instruments": { code: "0", data: [{ ctVal: "0.01" }] },
      "https://www.okx.com/api/v5/public/liquidation-orders": { code: "0", data: [{ details: [{ posSide: "long", side: "sell", sz: "100", bkPx: "62000", ts: String(now - 3_600_000) }, { posSide: "short", side: "buy", sz: "50", bkPx: "62000", ts: String(now - 1_800_000) }] }] },
      "https://hl-cycles-one.vercel.app/api/vector.json": { asOf: now - 3_600_000, regime: { state: "bear_range", since: Date.UTC(2026, 9, 10), allocation: 0.3 }, levels: [{ key: "sth", label: "STH cost basis", value: 74100, distancePct: -16.3, status: "below" }], compass: { headline: { score: -0.4, band: "bearish", d7: -0.1, d30: -0.3 } } },
      "https://nfs.faireconomy.media/ff_calendar_thisweek.json": [{ title: "Core PCE Price Index m/m", country: "USD", date: "2026-11-25T08:30:00-05:00", impact: "High", forecast: "0.2%", previous: "0.3%" }, { title: "German Ifo", country: "EUR", date: "2026-11-24T04:00:00-05:00", impact: "High" }],
    });
    const ctxs = async () => [{ name: "BTC", markPx: 62000, prevDayPx: 63000, funding: 0.00001, openInterest: 1000 } as AssetCtx];
    const r = await collectMarket({ env: {}, now, fetchFn: f, ctxs });
    const by = Object.fromEntries(r.evidence.map((e) => [e.source, e]));
    expect(by["bitcoin-data"]!.data).toMatchObject({ sth_realized_price: 74100, lth_realized_price: 38000, sth_sopr: 0.97, nupl: 0.31, etf_flow_btc_7d: -3500 });
    expect(by.coinmetrics!.data).toMatchObject({ realized_price: 50000, mvrv: 1.24 });
    expect(r.notes.join(" ")).toContain("exchange flows unavailable");
    expect(by.orderbook!.data).toMatchObject({ coinbase_bids_2pct_usd_m: 1.84, hl_bid_share_2pct: 0.75 });
    expect(by["perp-positioning"]!.data).toMatchObject({ btc_oi_chg_24h_pct: 10, btc_oi_chg_7d_pct: 10, btc_liq_long_usd_m: 0.06, btc_liq_short_usd_m: 0.03 });
    expect(by["perp-positioning"]!.text).toContain("BTC: funding hyperliquid 8.76%, binance 10.95%, okx 21.9% APR");
    expect(by["hl-cycles"]!.text).toContain("Regime bear_range since 2026-10-10");
    expect(by["macro-calendar"]!.text).toContain("Core PCE Price Index m/m (High, forecast 0.2%, previous 0.3%)");
    expect(by["macro-calendar"]!.text).not.toContain("Ifo");
    expect(r.notes.join(" ")).toContain("Macro radar failed");
  });

  test("OI change: the last point against the nearest one a window back", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ t: i * 3_600_000, v: i === 29 ? 120 : 100 }));
    expect(oiChangeFrom(rows, 24)).toBeCloseTo(0.2);
    expect(oiChangeFrom(rows.slice(-10), 24)).toBeNull();
  });

  test("Notion: off without a token; the page's text when shared", async () => {
    expect(await collectNotion({ env: {}, now })).toEqual({ evidence: [], notes: [] });
    const f = fakeFetch({
      "https://api.notion.com/v1/blocks/abc/children": { results: [{ id: "h", type: "heading_1", heading_1: { rich_text: [{ plain_text: "Regime Read" }] } }, { id: "p", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Phase: breakdown." }] } }], has_more: false, next_cursor: null },
    });
    const r = await collectNotion({ env: { NOTION_TOKEN: "t", REGIME_NOTION_PAGE_ID: "abc" }, now, fetchFn: f });
    expect(r.evidence[0]).toMatchObject({ source: "weekly-tape", kind: "own_notes", url: null });
    expect(r.evidence[0]!.text).toBe("## Regime Read\nPhase: breakdown.");
  });
});

// ---------- the endpoint ----------

describe("GET /regime", () => {
  test("the feed, and the Markdown", async () => {
    const store = memoryRegimeStore();
    const app = createRegimeRoutes({ regime: () => store });
    const empty = RegimeFeedSchema.parse(await (await app.request("/regime")).json());
    expect(empty).toEqual({ persistent: false, thesis: null, history: [] });
    expect((await app.request("/regime?format=md")).status).toBe(404);
    await seedRegime(store, SEED, { now: NOW });
    const full = RegimeFeedSchema.parse(await (await app.request("/regime")).json());
    expect(full.thesis!.phase).toBe("Range low under test");
    expect(full.history).toHaveLength(3);
    const md = await app.request("/regime?format=md");
    expect(md.headers.get("content-type")).toContain("text/markdown");
    expect(await md.text()).toContain("# Regime thesis v1");
  });
});
