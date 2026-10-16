import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { OpportunityDetail } from "../../../shared/platform";
import { ActionBar, RejectDialog, TicketDialog } from "./Detail";
import { OpportunityFeed } from "./Feed";
import { CoverageLine } from "./LiqMap";

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
  const base = { ranked: [], snoozed: [], selectedId: null, status: "live" as const, tier: "all" as const, loading: false, offline: null, error: null, scanAgeSec: 10, hasRows: false, now: Date.now(), snoozedOpen: false, onToggleSnoozed: noop, onSelect: noop, onFilter: noop, onRetry: noop };
  test("empty, filter-empty, offline, stale", () => {
    expect(renderToStaticMarkup(<OpportunityFeed {...base} />)).toContain("nothing cleared the bar — the scanner runs every minute");
    expect(renderToStaticMarkup(<OpportunityFeed {...base} hasRows status="ready" />)).toContain("no READY opportunities");
    expect(renderToStaticMarkup(<OpportunityFeed {...base} offline="x" />)).toContain("platform API unreachable");
    expect(renderToStaticMarkup(<OpportunityFeed {...base} scanAgeSec={180} />)).toContain("scan 3m old — scores are frozen");
  });
});
