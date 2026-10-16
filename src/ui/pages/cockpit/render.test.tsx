import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LiqBoardResponse, LiqMap, LiqMapHistory, OpportunityDetail, PlatformHealth } from "../../../shared/platform";
import { ActionBar, OpportunityDetail as DetailView, RejectDialog, TicketDialog } from "./Detail";
import { OpportunityFeed, StatusPill, WarmingLine } from "./Feed";
import { CockpitHeader, HealthStrip } from "./Header";
import { CoverageLine, LiqBoard, LiqMapView } from "./LiqMap";

// Render-checks (react-dom/server, no jsdom), the TerminalTabs.test.tsx
// approach: copy and disabled states the brief pins (C3, C4, C5, C7).

const detail = (over: Partial<OpportunityDetail["ticket"]> = {}): OpportunityDetail => ({
  opportunity: {
    id: "00000000-0000-4000-8000-000000000001", coin: "HYPE", direction: "long", setupKind: "oi-accel", tradeType: "directional", status: "ready",
    score: 0.82, scoreVersion: "v1", netEdgeBps: 38, grossEdgeBps: 62, edgeBasis: "unvalidated", costs: { feeBps: 4.5, slippageBps: 11, fundingBps: 4, absorbableUsd: 84000 },
    tags: [], liquidityTier: 1, regime: "trend", invalidation: "close below 39.9", entryPx: 42.18, stopPx: 39.9, targetPx: 45, invalidationPx: 39.9,
    createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z", statusChangedAt: "2026-10-16T00:00:00Z", snoozedUntil: null, dedupeKey: "HYPE|long|oi-accel",
  },
  signals: [], bearCase: null, stats: null, risk: null,
  ticket: { side: "long", entryPx: 42.18, stopPx: 39.9, targetPx: 45, sizeUsd: 1500, sizeSource: "governor", ...over },
});
const noop = () => {};
const confirmBtn = (html: string) => (html.match(/<button[^>]*>(?:(?!<\/button>).)*CONFIRM(?:(?!<\/button>).)*<\/button>/g) ?? []).at(-1) ?? "";

describe("TicketDialog", () => {
  test("venue title, governor size, confirm enabled", () => {
    const html = renderToStaticMarkup(<TicketDialog detail={detail()} venue="paper" busy={false} error={null} stale={null} onConfirm={noop} onCancel={noop} />);
    expect(html).toContain("APPROVE — PAPER");
    expect(html).toContain("$1,500.00");
    expect(confirmBtn(html)).not.toContain('disabled=""');
  });
  test("no governor size → `size unavailable`, confirm disabled", () => {
    const html = renderToStaticMarkup(<TicketDialog detail={detail({ sizeUsd: null })} venue="testnet" busy={false} error={null} stale={null} onConfirm={noop} onCancel={noop} />);
    expect(html).toContain("APPROVE — TESTNET");
    expect(html).toContain("size unavailable");
    expect(confirmBtn(html)).toContain('disabled=""');
  });
  test("409 stale_feed: server string verbatim, confirm disabled, RETRY offered", () => {
    const html = renderToStaticMarkup(<TicketDialog detail={detail()} venue="paper" busy={false} error={null} stale="stale_feed: HYPE mid 41s old" onConfirm={noop} onCancel={noop} />);
    expect(html).toContain("stale_feed: HYPE mid 41s old");
    expect(html).toContain("RETRY");
    expect(confirmBtn(html)).toContain('disabled=""');
  });
});

test("RejectDialog: confirm disabled while the reason is blank", () => {
  const html = renderToStaticMarkup(<RejectDialog busy={false} error={null} onConfirm={noop} onCancel={noop} />);
  expect(html).toContain("REASON");
  expect(confirmBtn(html)).toContain('disabled=""');
});

test("ActionBar: approve disabled outside READY and when the governor blocks", () => {
  const props = { venue: "paper" as const, busy: false, error: null, hint: null, snoozeOpen: false, onApprove: noop, onReject: noop, onSnoozeMenu: noop, onSnooze: noop, onCloseSnooze: noop, onResearch: noop };
  const approveBtn = (html: string) => html.match(/<button[^>]*>APPROVE/)![0];
  expect(approveBtn(renderToStaticMarkup(<ActionBar {...props} status="ready" blockedReason={null} />))).not.toContain('disabled=""');
  expect(approveBtn(renderToStaticMarkup(<ActionBar {...props} status="calculated" blockedReason={null} />))).toContain("approve needs READY — status is CALC");
  expect(approveBtn(renderToStaticMarkup(<ActionBar {...props} status="ready" blockedReason="gross leverage above 3x" />))).toContain('title="gross leverage above 3x"');
});

test("CoverageLine: partial map below 25%", () => {
  const c = { trackedNotional: 18, oiNotional: 100, addresses: 4210, pollAgeP50Sec: 360, pollAgeP90Sec: 1440 };
  expect(renderToStaticMarkup(<CoverageLine coverage={{ ...c, ratio: 0.31 }} />)).not.toContain("PARTIAL MAP");
  const html = renderToStaticMarkup(<CoverageLine coverage={{ ...c, ratio: 0.18 }} />);
  expect(html).toContain("COVERAGE 18% OF OI · 4,210 ADDR · POLL p50 6M");
  expect(html).toContain("PARTIAL MAP");
});

describe("OpportunityFeed states (C7)", () => {
  const base = { ranked: [], snoozed: [], selectedId: null, status: "live" as const, tier: "all" as const, loading: false, offline: null, error: null, scanAgeSec: 10, hasRows: false, now: Date.now(), readyTtlMin: 60, snoozedOpen: false, onToggleSnoozed: noop, onSelect: noop, onFilter: noop, onRetry: noop };
  test("empty, filter-empty, offline, stale", () => {
    expect(renderToStaticMarkup(<OpportunityFeed {...base} />)).toContain("nothing cleared the bar — the scanner runs every minute");
    expect(renderToStaticMarkup(<OpportunityFeed {...base} hasRows status="ready" />)).toContain("no READY opportunities");
    expect(renderToStaticMarkup(<OpportunityFeed {...base} offline="x" />)).toContain("platform API unreachable");
    expect(renderToStaticMarkup(<OpportunityFeed {...base} scanAgeSec={180} />)).toContain("scan 3m old — scores are frozen");
  });
});

test("OpportunityFeed: an empty feed renders the empty slot (the board)", () => {
  const base = { ranked: [], snoozed: [], selectedId: null, status: "live" as const, tier: "all" as const, loading: false, offline: null, error: null, scanAgeSec: 10, hasRows: false, now: Date.now(), readyTtlMin: 60, snoozedOpen: false, onToggleSnoozed: noop, onSelect: noop, onFilter: noop, onRetry: noop };
  const html = renderToStaticMarkup(<OpportunityFeed {...base} emptySlot={<i>BOARD</i>} />);
  expect(html).toContain("FEED ─ BY SCORE");
  expect(html).toContain("<i>BOARD</i>");
});

test("StatusPill: failed has its own critical pill, not the gray reject one", () => {
  const failed = renderToStaticMarkup(<StatusPill status="failed" />);
  const rejected = renderToStaticMarkup(<StatusPill status="rejected" />);
  expect(failed).toContain("FAILED");
  expect(failed).toContain("badge--red");
  expect(rejected).toContain("badge--gray");
});

test("WarmingLine: visible under 60 min with no rows, hidden otherwise", () => {
  expect(renderToStaticMarkup(<WarmingLine scanHistoryMin={12.7} hasRows={false} />)).toContain("SCANNER WARMING UP — 12 of 60 MIN HISTORY");
  expect(renderToStaticMarkup(<WarmingLine scanHistoryMin={60} hasRows={false} />)).toBe("");
  expect(renderToStaticMarkup(<WarmingLine scanHistoryMin={12} hasRows />)).toBe("");
  expect(renderToStaticMarkup(<WarmingLine scanHistoryMin={null} hasRows={false} />)).toBe("");
});

describe("LiqBoard", () => {
  const cov = (ratio: number) => ({ trackedNotional: 1, oiNotional: 1, ratio, addresses: 10, pollAgeP50Sec: 60, pollAgeP90Sec: 120 });
  const cl = (distancePct: number, notionalUsd: number) => ({ priceLo: 99, priceHi: 100, distancePct, notionalUsd });
  const rows: LiqBoardResponse["rows"] = [
    { coin: "BTC", mark: 100_000, nearestLong: cl(1.2, 9_300_000), nearestShort: cl(2.5, 6_100_000), coverage: cov(0.31) },
    { coin: "SOL", mark: 150, nearestLong: cl(3, 1_000_000), nearestShort: null, coverage: cov(0.18) },
    { coin: "DOGE", mark: 0.2, nearestLong: cl(4, 500_000), nearestShort: cl(5, 400_000), coverage: cov(0.02) },
  ];
  const props = { loading: false, offline: null, error: null, selectedCoin: "BTC", onSelect: noop, onRetry: noop };
  test("rows with signed distance + notional; < 25% = ≥ and amber, < 5% = no clusters named", () => {
    const html = renderToStaticMarkup(<LiqBoard {...props} rows={rows} />);
    expect(html).toContain("LIQUIDATION BOARD");
    expect(html).toContain("−1.2%");
    expect(html).toContain("+2.5%");
    expect(html).toContain("$9.3M");
    expect(html).toContain("≥ $1M");
    expect(html).toContain("too little coverage to name clusters");
    expect(html).not.toContain("$500K");
    expect(html).toContain('aria-selected="true"');
  });
  test("skeleton, offline, error, empty", () => {
    expect(renderToStaticMarkup(<LiqBoard {...props} rows={null} loading />)).toContain("pulse");
    expect(renderToStaticMarkup(<LiqBoard {...props} rows={null} offline="platform API unreachable" />)).toContain("platform API unreachable");
    expect(renderToStaticMarkup(<LiqBoard {...props} rows={null} error="boom" />)).toContain("boom");
    expect(renderToStaticMarkup(<LiqBoard {...props} rows={[]} />)).toContain("no marks yet");
  });
});

describe("LiqMapView states (C7)", () => {
  const poll = <T,>(over: Partial<{ data: T | null; loading: boolean; offline: string | null; error: string | null; fetchedAt: number | null }>) => ({ data: null, loading: false, offline: null, error: null, fetchedAt: 1, refetch: noop, ...over });
  const now = Date.parse("2026-10-16T12:00:00Z");
  const map = (over: Partial<LiqMap> = {}): LiqMap => ({
    coin: "BTC", ts: new Date(now).toISOString(), mark: 100, bucketBps: 25,
    buckets: [{ idx: 1840, longUsd: 2e6, shortUsd: 0, priceLo: 98.5, priceHi: 98.7 }, { idx: 1846, longUsd: 0, shortUsd: 3e6, priceLo: 101.9, priceHi: 102.2 }],
    nearestClusters: { long: { priceLo: 98.5, priceHi: 98.7, distancePct: 1.3, notionalUsd: 2e6 }, short: { priceLo: 101.9, priceHi: 102.2, distancePct: 1.9, notionalUsd: 3e6 } },
    coverage: { trackedNotional: 1, oiNotional: 1, ratio: 0.4, addresses: 50, pollAgeP50Sec: 60, pollAgeP90Sec: 120 }, ...over,
  });
  const hist = (n: number): LiqMapHistory => ({ coin: "BTC", bucketBps: 25, snapshots: Array.from({ length: n }, (_, i) => ({ ts: new Date(now - i * 900_000).toISOString(), mark: 100, buckets: [] })) });
  const base = { coin: "BTC", coins: ["BTC", "ETH"], onCoin: noop, tracked: { count: 30, has: true }, wsMark: null, window: 24 as const, onWindow: noop, now };
  const render = (live: ReturnType<typeof poll<LiqMap | null>>, h: ReturnType<typeof poll<LiqMapHistory>> = poll<LiqMapHistory>({ data: hist(0) })) => renderToStaticMarkup(<LiqMapView {...base} live={live} hist={h} />);
  test("skeleton, offline, error, empty", () => {
    expect(render(poll({ loading: true, fetchedAt: null }))).toContain("pulse");
    expect(render(poll({ offline: "platform API unreachable" }))).toContain("platform API unreachable");
    expect(render(poll({ error: "bad gateway" }))).toContain("bad gateway");
    expect(render(poll({ data: map({ buckets: [] }) }))).toContain("no tracked positions on BTC yet");
  });
  test("data: picker, server clusters in the callouts; stale after 60 s", () => {
    const html = render(poll({ data: map() }));
    expect(html).toContain("LIQUIDATIONS · BTC");
    expect(html).toContain('aria-label="liquidation coin"');
    expect(html).toContain("SHORT CLUSTER $3M @");
    expect(html).toContain("+1.9%");
    expect(html).toContain("LONG CLUSTER $2M @");
    expect(html).toContain("−1.3%");
    expect(render(poll({ data: map({ ts: new Date(now - 180_000).toISOString() }) }))).toContain("liquidation map 3m old");
  });
  test("history empties: tracked coin builds, untracked coin says so with the board's count", () => {
    expect(render(poll({ data: map() }))).toContain("no snapshots yet — history builds every 15 min");
    expect(renderToStaticMarkup(<LiqMapView {...base} tracked={{ count: 25, has: false }} live={poll({ data: map() })} hist={poll({ data: hist(0) })} />)).toContain("top 25 coins by OI — BTC is not one");
  });
});

describe("OpportunityDetail states (C7)", () => {
  const p = { subStats: null, inFeed: true, mark: null, midAgeSec: null, onRetry: noop, onBack: noop, onResearch: noop, liqSlot: null, actionBar: null };
  test("skeleton, not found, offline, error, stale mid", () => {
    expect(renderToStaticMarkup(<DetailView {...p} detail={null} notFound={false} offline={null} error={null} />)).toContain("pulse");
    expect(renderToStaticMarkup(<DetailView {...p} detail={null} notFound offline={null} error={null} />)).toContain("opportunity not found");
    expect(renderToStaticMarkup(<DetailView {...p} detail={null} notFound={false} offline="x" error={null} />)).toContain("platform API unreachable");
    expect(renderToStaticMarkup(<DetailView {...p} detail={null} notFound={false} offline={null} error="boom" />)).toContain("boom");
    expect(renderToStaticMarkup(<DetailView {...p} detail={detail()} notFound={false} offline={null} error={null} midAgeSec={45} />)).toContain("live price 45s old — approve is blocked");
  });
  test("signals show VALUE and Z apart; regime/tier sub-rows; margin out of scope", () => {
    const stats = { setupKind: "oi-accel", horizon: "4h", regime: null, tier: null, n: 41, hitRate: 0.54, meanNet: 0.0021, ci95: [-0.0008, 0.005] as [number, number] };
    const d = { ...detail(), signals: [{ name: "ret15mZ", value: 0.012, z: 2.1 }], stats, risk: { before: { approved: true, reasons: [], warnings: [] }, after: { approved: true, reasons: [], warnings: [], sizing: { notionalUsd: 1500, grossLeverageAfter: 1.2, riskUsd: 50 } } } };
    const html = renderToStaticMarkup(<DetailView {...p} detail={d} subStats={{ regime: { ...stats, regime: "trend", n: 12 }, tier: null }} notFound={false} offline={null} error={null} />);
    expect(html).toContain("0.012");
    expect(html).toContain("+2.1");
    expect(html).toContain("REGIME trend");
    expect(html).not.toContain("TIER T1");
    expect(html).toContain("NOT DISTINGUISHABLE FROM ZERO");
    expect(html).toContain("gross leverage 1.20×");
    expect(html).toContain("margin use is not in the governor preview");
  });
});

describe("HealthStrip states (C7)", () => {
  const h: PlatformHealth = {
    ok: true, ts: "2026-10-16T12:00:00Z", store: "pg", loops: [], ws: { state: "open", lastMessageAgeSec: 2 }, scanAgeSec: 200,
    crawler: { pollsPerMin: 388, addresses: 9400 }, llmSpendUsdToday: 0.42,
  };
  const now = Date.parse("2026-10-16T12:00:00Z");
  test("skeleton, unreachable, runtime absent, items with LLM spend", () => {
    expect(renderToStaticMarkup(<HealthStrip health={null} loading offline={null} error={null} now={now} />)).toContain("pulse");
    expect(renderToStaticMarkup(<HealthStrip health={null} loading={false} offline="down" error={null} now={now} />)).toContain("HEALTH UNREACHABLE");
    expect(renderToStaticMarkup(<HealthStrip health={null} loading={false} offline={null} error="500" now={now} />)).toContain("HEALTH UNREACHABLE");
    expect(renderToStaticMarkup(<HealthStrip health={null} loading={false} offline={null} error={null} now={now} />)).toContain("platform loops not running");
    const html = renderToStaticMarkup(<HealthStrip health={h} loading={false} offline={null} error={null} now={now} />);
    expect(html).toContain("$0.42");
    expect(html).toContain("3M"); // scan 200 s, critical
    expect(html).toContain("critical");
  });
});

describe("Kill switch states (C7)", () => {
  const p = { venue: null, liveCount: 0, readyCount: 0, noDb: false, onKill: noop, onHelp: noop };
  const kill = (html: string) => html.match(/<button[^>]*>KILL/)?.[0] ?? "";
  const desk = (over: object) => ({ data: null, offline: null, error: null, ...over });
  test("loading: KILL disabled, venue pending; offline: DESK — instead of VENUE …", () => {
    const loading = renderToStaticMarkup(<CockpitHeader {...p} desk={desk({})} />);
    expect(kill(loading)).toContain('disabled=""');
    expect(loading).toContain("VENUE …");
    const off = renderToStaticMarkup(<CockpitHeader {...p} desk={desk({ offline: "api unreachable" })} />);
    expect(off).toContain("DESK —");
    expect(off).not.toContain("VENUE …");
    expect(kill(off)).toContain('disabled=""');
  });
  test("error verbatim under the header; killed shows KILLED + RESUME", () => {
    expect(renderToStaticMarkup(<CockpitHeader {...p} desk={desk({ error: "desk 500" })} />)).toContain("desk 500");
    const on = renderToStaticMarkup(<CockpitHeader {...p} venue="paper" desk={desk({ data: { live: false, killSwitch: { on: true, reason: "manual", at: null } } })} />);
    expect(on).toContain("KILLED");
    expect(on).toContain("RESUME");
  });
});
