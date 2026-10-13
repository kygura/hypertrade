import { describe, expect, test } from "bun:test";
import {
  AlertFeedbackInputSchema,
  BriefSchema,
  HttpsUrlSchema,
  ManualPositionInputSchema,
  OrderIntentSchema,
  OrderPreviewRequestSchema,
  ScreenerDslSchema,
  ThesisCheckSchema,
  ThesisClaimSchema,
  ThesisSchema,
  toOrderVerdict,
  UserEdgeInputSchema,
  WatchInputSchema,
  WatchlistPutSchema,
} from "./intel.js";

const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => expect(s.safeParse(v).success).toBe(true);
const bad = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => expect(s.safeParse(v).success).toBe(false);

describe("ManualPositionInput", () => {
  test("applies defaults and round-trips", () => {
    const p = ManualPositionInputSchema.parse({ asset: "SOL", side: "long", size: 10, entryPx: 150, stopPx: 140 });
    expect(p).toEqual({ asset: "SOL", side: "long", size: 10, entryPx: 150, stopPx: 140, leverage: 1, venue: "manual" });
    expect(ManualPositionInputSchema.parse(p)).toEqual(p);
    ok(ManualPositionInputSchema, { asset: "xyz:TSLA", side: "short", size: 1, entryPx: 1, leverage: 50, venue: "binance" });
  });
  test("rejects bad values and unknown keys", () => {
    const base = { asset: "SOL", side: "long", size: 10, entryPx: 150 };
    bad(ManualPositionInputSchema, { ...base, size: 0 });
    bad(ManualPositionInputSchema, { ...base, entryPx: -1 });
    bad(ManualPositionInputSchema, { ...base, stopPx: 0 });
    bad(ManualPositionInputSchema, { ...base, leverage: 51 });
    bad(ManualPositionInputSchema, { ...base, leverage: 0.5 });
    bad(ManualPositionInputSchema, { ...base, side: "flat" });
    bad(ManualPositionInputSchema, { ...base, asset: "SOL; drop table" });
    bad(ManualPositionInputSchema, { ...base, asset: "../etc" });
    bad(ManualPositionInputSchema, { ...base, id: "x" });
  });
});

describe("watchlist", () => {
  test("defaults tags, rejects duplicates and unknown keys", () => {
    expect(WatchlistPutSchema.parse({ items: [{ asset: "BTC" }] })).toEqual({ items: [{ asset: "BTC", tags: [] }] });
    bad(WatchlistPutSchema, { items: [{ asset: "BTC" }, { asset: "BTC" }] });
    bad(WatchlistPutSchema, { items: [{ asset: "BTC", note: "x" }] });
  });
});

describe("screener DSL", () => {
  const base = { source: "snapshots", select: ["asset", "ts", "oi_usd"] };
  test("defaults and round-trips a valid query", () => {
    const d = ScreenerDslSchema.parse({
      ...base,
      filters: [{ col: "funding", op: ">", value: 0.0001 }, { col: "asset", op: "!=", value: "BTC" }],
      changes: [{ col: "oi_usd", window_h: 24, op: ">", pct: 10 }],
      assets: ["SOL", "kPEPE"],
      orderBy: { col: "oi_usd" },
    });
    expect(d.since_h).toBe(24);
    expect(d.limit).toBe(100);
    expect(d.orderBy).toEqual({ col: "oi_usd", dir: "desc" });
    expect(ScreenerDslSchema.parse(d)).toEqual(d);
    ok(ScreenerDslSchema, { source: "candles", select: ["coin", "c"], filters: [{ col: "tf", op: "=", value: "1h" }] });
    ok(ScreenerDslSchema, { source: "observations", select: ["series_id", "value"], filters: [{ col: "series_id", op: "=", value: "hl.oi.BTC" }] });
  });
  test("rejects columns outside the table allowlist and injection-ish names", () => {
    bad(ScreenerDslSchema, { ...base, select: ["price; drop table intel_snapshots"] });
    bad(ScreenerDslSchema, { ...base, select: ["rate"] }); // funding column on snapshots
    bad(ScreenerDslSchema, { ...base, select: ["pg_sleep(10)"] });
    bad(ScreenerDslSchema, { ...base, select: ['"asset"'] });
    bad(ScreenerDslSchema, { ...base, filters: [{ col: "price or 1=1", op: ">", value: 1 }] });
    bad(ScreenerDslSchema, { ...base, orderBy: { col: "random()" } });
    bad(ScreenerDslSchema, { ...base, changes: [{ col: "asset", window_h: 24, op: ">", pct: 1 }] });
    bad(ScreenerDslSchema, { ...base, source: "pg_user" });
  });
  test("rejects injection-ish filter values, bad ops and type mismatches", () => {
    bad(ScreenerDslSchema, { ...base, filters: [{ col: "asset", op: "=", value: "BTC' or '1'='1" }] });
    bad(ScreenerDslSchema, { ...base, filters: [{ col: "asset", op: "=", value: "BTC; --" }] });
    bad(ScreenerDslSchema, { ...base, filters: [{ col: "asset", op: "like", value: "%" }] });
    bad(ScreenerDslSchema, { ...base, filters: [{ col: "asset", op: ">", value: "A" }] });
    bad(ScreenerDslSchema, { ...base, filters: [{ col: "price", op: ">", value: "100" }] });
    bad(ScreenerDslSchema, { ...base, filters: [{ col: "ts", op: ">", value: 1 }] });
    bad(ScreenerDslSchema, { ...base, filters: [{ col: "price", op: ">", value: Number.NaN }] });
  });
  test("enforces limits, range and strictness", () => {
    bad(ScreenerDslSchema, { ...base, limit: 501 });
    bad(ScreenerDslSchema, { ...base, since_h: 2161 });
    bad(ScreenerDslSchema, { ...base, sql: "select 1" });
    bad(ScreenerDslSchema, { ...base, filters: [{ col: "price", op: ">", value: 1, raw: "x" }] });
    bad(ScreenerDslSchema, { source: "observations", select: ["value"], assets: ["BTC"] });
  });
});

describe("thesis checks", () => {
  test("accepts every catalog kind and rejects unknown ones", () => {
    ok(ThesisCheckSchema, { kind: "metric_threshold", series: "fred.DGS10", op: "<", value: 4.5 });
    ok(ThesisCheckSchema, { kind: "price_vs_level", asset: "BTC", op: ">=", level: 80000 });
    ok(ThesisCheckSchema, { kind: "funding_sign", asset: "ETH", sign: "negative" });
    ok(ThesisCheckSchema, { kind: "oi_change", asset: "SOL", window_h: 24, op: ">", pct: 5 });
    ok(ThesisCheckSchema, { kind: "event_exists", query: "ETF approval", since_h: 72 });
    ok(ThesisCheckSchema, { kind: "unknown" });
    bad(ThesisCheckSchema, { kind: "vibes" });
    bad(ThesisCheckSchema, { kind: "funding_sign", asset: "ETH", sign: "zero" });
    bad(ThesisCheckSchema, { kind: "metric_threshold", series: "x; drop", op: "<", value: 1 });
    bad(ThesisCheckSchema, { kind: "oi_change", asset: "SOL", window_h: 24, op: ">", pct: 5, extra: 1 });
  });
  test("claim carries an optional sourced evidence claim", () => {
    const claim = {
      kind: "claim",
      text: "BTC holds above 80k",
      check: { kind: "price_vs_level", asset: "BTC", op: ">", level: 80000 },
      status: "supported",
      evidence: { value: 83900, source: { label: "snapshot", url: "/markets/BTC" }, ts: "2026-10-13T00:00:00Z" },
    };
    ok(ThesisClaimSchema, claim);
    ok(ThesisClaimSchema, { kind: "assumption", text: "ETF flows stay positive", check: { kind: "unknown" }, status: "unknown" });
    bad(ThesisClaimSchema, { ...claim, kind: "guess" });
    bad(ThesisClaimSchema, { ...claim, evidence: { value: 1, source: { label: "x" } } });
    bad(ThesisClaimSchema, { kind: "claim", text: "x", check: { kind: "unknown" }, status: "maybe" });
    ok(ThesisSchema, {
      id: "t1", text: "BTC grinds up", assets: ["BTC"], claims: [claim], createdAt: "2026-10-13T00:00:00Z", checkedAt: null,
      invalidation: [{ text: "Daily close below 80k", status: "clear" }, { text: "Funding flips negative" }],
      wrongIf: [{ tag: "hypothesis", text: "Spot demand fades while OI keeps rising." }],
    });
  });
});

describe("order intent", () => {
  const intent = { asset: "ETH", side: "long", leverage: 3, size: { usd: 1000 }, entry: { type: "market" }, stop: { type: "pct", pct: 2 } };
  test("accepts each stop shape and round-trips", () => {
    expect(OrderIntentSchema.parse(intent)).toEqual(intent as never);
    for (const stop of [{ type: "price", px: 3000 }, { type: "prev_day_low" }, { type: "prev_day_high" }, { type: "atr_mult", mult: 1.5 }]) ok(OrderIntentSchema, { ...intent, stop });
    ok(OrderIntentSchema, { ...intent, size: { pctBook: 5 }, entry: { type: "limit", px: 3100 }, target: 3500 });
  });
  test("rejects out-of-range, ambiguous and unknown fields", () => {
    bad(OrderIntentSchema, { ...intent, leverage: 51 });
    bad(OrderIntentSchema, { ...intent, size: { usd: 1000, pctBook: 5 } });
    bad(OrderIntentSchema, { ...intent, size: { usd: -1 } });
    bad(OrderIntentSchema, { ...intent, entry: { type: "limit" } });
    bad(OrderIntentSchema, { ...intent, stop: { type: "none" } });
    bad(OrderIntentSchema, { ...intent, venue: "mainnet" });
    bad(OrderPreviewRequestSchema, { text: "long eth", intent });
    ok(OrderPreviewRequestSchema, { text: "long eth 3x, 1k, stop 2%" });
  });
});

describe("toOrderVerdict", () => {
  const v = { approved: true, reasons: [], warnings: [] as string[], equityUsd: 10_000, checkedAt: "2026-10-13T00:00:00.000Z" };
  test("approve, clip, reject", () => {
    expect(toOrderVerdict(v)).toMatchObject({ decision: "approve", approved: true });
    expect(toOrderVerdict(v).clip).toBeUndefined();
    const clipped = toOrderVerdict({ ...v, warnings: ["risk 2% clipped to the 0.5% per-trade limit: notional reduced"] });
    expect(clipped.decision).toBe("clip");
    expect(clipped.clip).toContain("clipped");
    expect(toOrderVerdict({ ...v, approved: false, reasons: ["kill switch on"] })).toMatchObject({ decision: "reject", reasons: ["kill switch on"] });
  });
});

describe("watches", () => {
  test("validates targets per kind", () => {
    ok(WatchInputSchema, { kind: "url", target: "https://docs.example.com/terms", label: "terms" });
    ok(WatchInputSchema, { kind: "evm_contract", target: "0x" + "a".repeat(40), chain: "ethereum", label: "proxy", asset: "ETH" });
    bad(WatchInputSchema, { kind: "url", target: "http://docs.example.com", label: "x" });
    bad(WatchInputSchema, { kind: "url", target: "https://127.0.0.1/admin", label: "x" });
    bad(WatchInputSchema, { kind: "url", target: "https://localhost/x", label: "x" });
    bad(WatchInputSchema, { kind: "url", target: "https://user:pw@example.com", label: "x" });
    bad(WatchInputSchema, { kind: "url", target: "https://example.com", chain: "ethereum", label: "x" });
    bad(WatchInputSchema, { kind: "evm_wallet", target: "0x123", chain: "ethereum", label: "x" });
    bad(WatchInputSchema, { kind: "evm_wallet", target: "0x" + "a".repeat(40), chain: "solana", label: "x" });
    bad(WatchInputSchema, { kind: "evm_wallet", target: "0x" + "a".repeat(40), label: "x" });
    bad(HttpsUrlSchema, "javascript:alert(1)");
    for (const u of ["https://localhost./x", "https://localhost../x", "https://box.internal./", "https://127.0.0.1./", "https://printer.lan./"]) bad(HttpsUrlSchema, u);
    ok(HttpsUrlSchema, "https://docs.example.com./terms");
  });
});

describe("misc request schemas", () => {
  test("feedback vote and user edge", () => {
    ok(AlertFeedbackInputSchema, { vote: -1 });
    bad(AlertFeedbackInputSchema, { vote: 0 });
    ok(UserEdgeInputSchema, { src: "Jito", dst: "SOL", type: "collateral" });
    bad(UserEdgeInputSchema, { src: "SOL", dst: "SOL", type: "direct" });
    bad(UserEdgeInputSchema, { src: "Jito", dst: "SOL", type: "vibes" });
    bad(UserEdgeInputSchema, { src: "Jito", dst: "SOL", type: "direct", origin: "seed" });
  });
  test("brief round-trips with claim lines", () => {
    const brief = {
      id: "b1",
      createdAt: "2026-10-13T12:00:00.000Z",
      surface: "ui",
      since: "2026-10-13T06:00:00.000Z",
      items: [{ asset: "SOL", metric: "oi_usd", held: true, from: 1e9, to: 1.2e9, delta: 20, deltaUnit: "pct", z: 2.4, materiality: 1.1, exposureWeight: 0.5, stopProximity: 1.4, stopDistPct: 3.1, stopDistAtr: 1.2, ts: "2026-10-13T12:00:00.000Z", baselineTs: "2026-10-13T06:00:00.000Z" }],
      alerts: [],
      catalysts: [],
      lines: [{ tag: "hypothesis", text: "Leverage is building into SOL." }],
      silent: false,
      threshold: { minZ: 2, pushMateriality: 0.35 },
      ingest: [{ source: "rss", ok: true, lastRunAt: "2026-10-13T11:45:00.000Z" }, { source: "telegram", ok: false, lastRunAt: null, error: "HTTP 403" }],
      diffedCount: 44,
      trace: { promptVersion: "brief.v1", tier: "strong", model: null, inputs: {}, output: null, usage: {}, ms: 0, dropped: 1, error: "LLM cap reached" },
    };
    expect(BriefSchema.parse(brief)).toEqual(brief as never);
    bad(BriefSchema, { ...brief, lines: [{ tag: "observed", text: "no source" }] });
  });
});
